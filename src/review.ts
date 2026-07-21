/**
 * The review sidecar store: explanations, captured decisions, review verdicts
 * and a glossary, all derived from the spec plus the discussion.
 *
 * spec-scope has no LLM. The in-loop agent produces the prose (via
 * `spec-scope explain`/`apply`) and this store only persists, validates and
 * hands it back. Every explanation and decision carries a `provenance` flag so
 * nothing invented is ever shown as fact — an `unstated` gap is an open
 * question, never a fabricated rationale.
 *
 * State lives in `<root>/.spec-scope/review.json`. Like the note store it
 * re-reads on every access and writes atomically under a cross-process lock, so
 * a second CLI invocation and the running review server stay honest about each
 * other's writes. The durability primitives are shared from `./jsonfile.js`.
 *
 * Two validation modes sit either side of the disk. Writes (`addDecision`,
 * `updateDecision`, `setStamp`, `applyBatch`) are a trust boundary — the browser
 * and a committed `review.json` both reach them — so they validate strictly and
 * throw on an unknown enum or over-long field. `load()` is lenient: it salvages a
 * partial or hostile file element by element and never throws a consumer.
 */

import path from 'node:path';

import { validateAuthoredMermaid } from './diagram.js';
import { newId } from './ids.js';
import { readJsonSafe, watchJsonDir, withFileLock, writeJsonAtomic } from './jsonfile.js';
import type {
  AuthoredDiagram,
  AuthoredDiagramType,
  Decision,
  DecisionStatus,
  DiagramSkip,
  Explanation,
  ExplanationKind,
  GlossaryTerm,
  Provenance,
  ReviewBatch,
  ReviewFile,
  ReviewStamp,
  ReviewVerdict,
  SourceRef,
} from './types.js';

const DIR_NAME = '.spec-scope';
const FILE_NAME = 'review.json';
const LOCK_SUFFIX = '.lock';

/** One atomic write fires several fs events (tmp create, rename); collapse them. */
const DEBOUNCE_MS = 50;

/** Length caps. Every write is a trust boundary, so strings are bounded. */
const MAX_TITLE = 200;
const MAX_PROSE = 8000;
const MAX_TERM = 120;
const MAX_ANCHOR = 512;
const MAX_LABEL = 512;
const MAX_AUTHOR = 64;
/** An authored diagram's one-line "why this earned a picture" note. */
const MAX_TRIGGER = 500;
/** Mermaid source cap; a diagram longer than this is almost certainly the wrong altitude. */
const MAX_MERMAID = 20000;

const DEFAULT_AUTHOR = 'human';

const PROVENANCES: readonly Provenance[] = ['grounded', 'inferred', 'unstated'];
const VERDICTS: readonly ReviewVerdict[] = ['understood', 'concern', 'blocking', 'approved'];
const EXPLANATION_KINDS: readonly ExplanationKind[] = ['summary', 'narration', 'glossary-def'];
const DECISION_STATUSES: readonly DecisionStatus[] = ['open', 'recorded', 'superseded'];
const AUTHORED_DIAGRAM_TYPES: readonly AuthoredDiagramType[] = [
  'sequence',
  'state',
  'er',
  'flowchart',
  'class',
];
const SOURCE_KINDS: readonly SourceRef['kind'][] = [
  'requirement',
  'scenario',
  'doc',
  'task',
  'note',
  'constitution',
];

type ChangeListener = () => void;

function nowIso(): string {
  return new Date().toISOString();
}

/* --------------------------------------------------------------- strict input */
/* These run on the write path and throw, so a bad browser POST or a hostile     */
/* `apply` file is rejected rather than persisted.                               */

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string (got ${value === null ? 'null' : typeof value})`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must be a non-empty string`);
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

/** Optional prose: absent -> `fallback`; present -> trimmed and length-capped (empty allowed). */
function optionalText(value: unknown, field: string, max: number, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string (got ${typeof value})`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function optionalAuthor(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_AUTHOR;
  return requireText(value, 'author', MAX_AUTHOR);
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of ${allowed.join('|')} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

function optionalProvenance(value: unknown, fallback: Provenance): Provenance {
  if (value === undefined || value === null) return fallback;
  return requireEnum(value, PROVENANCES, 'provenance');
}

/** Validates a `sources` array on the write path; an omitted array defaults to `[]`. */
function requireSources(value: unknown, field = 'sources'): SourceRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${field}[${i}] must be an object`);
    }
    const src = raw as Record<string, unknown>;
    const ref: SourceRef = {
      kind: requireEnum(src.kind, SOURCE_KINDS, `${field}[${i}].kind`),
      anchor: requireText(src.anchor, `${field}[${i}].anchor`, MAX_ANCHOR),
    };
    const label = optionalText(src.label, `${field}[${i}].label`, MAX_LABEL);
    if (label.length > 0) ref.label = label;
    const quote = optionalText(src.quote, `${field}[${i}].quote`, MAX_PROSE);
    if (quote.length > 0) ref.quote = quote;
    return ref;
  });
}

/** Validates a `string[]` field (e.g. decision options) on the write path. */
function requireStringArray(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, i) => requireText(item, `${field}[${i}]`, max));
}

/**
 * Builds a validated `Decision` from a full object (an `applyBatch` element). An
 * incoming id is honoured so the batch can upsert; an absent one is minted.
 */
function validateDecision(raw: unknown): Decision {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('decision must be an object');
  }
  const src = raw as Record<string, unknown>;
  const decision: Decision = {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : newId('dec', Date.now()),
    title: requireText(src.title, 'decision.title', MAX_TITLE),
    context: optionalText(src.context, 'decision.context', MAX_PROSE),
    options: requireStringArray(src.options, 'decision.options', MAX_PROSE),
    choice: requireText(src.choice, 'decision.choice', MAX_PROSE),
    tradeoffs: optionalText(src.tradeoffs, 'decision.tradeoffs', MAX_PROSE),
    consequence: optionalText(src.consequence, 'decision.consequence', MAX_PROSE),
    provenance: optionalProvenance(src.provenance, 'inferred'),
    sources: requireSources(src.sources, 'decision.sources'),
    status:
      src.status === undefined
        ? 'open'
        : requireEnum(src.status, DECISION_STATUSES, 'decision.status'),
    author: optionalAuthor(src.author),
    createdAt:
      typeof src.createdAt === 'string' && src.createdAt.length > 0 ? src.createdAt : nowIso(),
  };
  const threadNoteId = optionalText(src.threadNoteId, 'decision.threadNoteId', MAX_ANCHOR);
  if (threadNoteId.length > 0) decision.threadNoteId = threadNoteId;
  const updatedAt = src.updatedAt;
  if (typeof updatedAt === 'string' && updatedAt.length > 0) decision.updatedAt = updatedAt;
  return decision;
}

function validateExplanation(raw: unknown): Explanation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('explanation must be an object');
  }
  const src = raw as Record<string, unknown>;
  return {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : newId('exp', Date.now()),
    anchor: requireText(src.anchor, 'explanation.anchor', MAX_ANCHOR),
    anchorLabel: requireText(src.anchorLabel, 'explanation.anchorLabel', MAX_LABEL),
    kind: requireEnum(src.kind, EXPLANATION_KINDS, 'explanation.kind'),
    body: requireText(src.body, 'explanation.body', MAX_PROSE),
    provenance: requireEnum(src.provenance, PROVENANCES, 'explanation.provenance'),
    sources: requireSources(src.sources, 'explanation.sources'),
    specHash: optionalText(src.specHash, 'explanation.specHash', MAX_ANCHOR),
    author: optionalAuthor(src.author),
    createdAt:
      typeof src.createdAt === 'string' && src.createdAt.length > 0 ? src.createdAt : nowIso(),
  };
}

function validateGlossary(raw: unknown): GlossaryTerm {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('glossary term must be an object');
  }
  const src = raw as Record<string, unknown>;
  const defined = src.defined !== false;
  return {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : newId('term', Date.now()),
    term: requireText(src.term, 'glossary.term', MAX_TERM),
    // A term flagged undefined carries no definition; a defined one must have prose.
    definition: defined
      ? requireText(src.definition, 'glossary.definition', MAX_PROSE)
      : optionalText(src.definition, 'glossary.definition', MAX_PROSE),
    provenance: requireEnum(src.provenance, PROVENANCES, 'glossary.provenance'),
    sources: requireSources(src.sources, 'glossary.sources'),
    defined,
    author: optionalAuthor(src.author),
    createdAt:
      typeof src.createdAt === 'string' && src.createdAt.length > 0 ? src.createdAt : nowIso(),
  };
}

/**
 * Builds a validated `AuthoredDiagram` from a batch element. Beyond the usual
 * string/enum checks, the Mermaid source must pass `validateAuthoredMermaid` for
 * its declared type — the validator's `error` is surfaced verbatim so the agent
 * can fix the exact problem (wrong header for the type, too few / too many nodes).
 */
function validateDiagram(raw: unknown): AuthoredDiagram {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('diagram must be an object');
  }
  const src = raw as Record<string, unknown>;
  const type = requireEnum(src.type, AUTHORED_DIAGRAM_TYPES, 'diagram.type');
  const mermaid = requireText(src.mermaid, 'diagram.mermaid', MAX_MERMAID);
  const validation = validateAuthoredMermaid(mermaid, type);
  if (!validation.ok) {
    throw new Error(`diagram mermaid is invalid: ${validation.error}`);
  }
  return {
    id: typeof src.id === 'string' && src.id.length > 0 ? src.id : newId('diag', Date.now()),
    title: requireText(src.title, 'diagram.title', MAX_TITLE),
    type,
    anchor: requireText(src.anchor, 'diagram.anchor', MAX_ANCHOR),
    anchorLabel: requireText(src.anchorLabel, 'diagram.anchorLabel', MAX_LABEL),
    covers: requireStringArray(src.covers, 'diagram.covers', MAX_ANCHOR),
    mermaid,
    trigger: requireText(src.trigger, 'diagram.trigger', MAX_TRIGGER),
    provenance: requireEnum(src.provenance, PROVENANCES, 'diagram.provenance'),
    sources: requireSources(src.sources, 'diagram.sources'),
    specHash: optionalText(src.specHash, 'diagram.specHash', MAX_ANCHOR),
    author: optionalAuthor(src.author),
    createdAt:
      typeof src.createdAt === 'string' && src.createdAt.length > 0 ? src.createdAt : nowIso(),
  };
}

/** Builds a validated `DiagramSkip` — "this doc was reviewed, no diagram warranted". */
function validateDiagramSkip(raw: unknown): DiagramSkip {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('diagram skip must be an object');
  }
  const src = raw as Record<string, unknown>;
  const skip: DiagramSkip = {
    anchor: requireText(src.anchor, 'diagramSkip.anchor', MAX_ANCHOR),
    specHash: optionalText(src.specHash, 'diagramSkip.specHash', MAX_ANCHOR),
    author: optionalAuthor(src.author),
    createdAt:
      typeof src.createdAt === 'string' && src.createdAt.length > 0 ? src.createdAt : nowIso(),
  };
  const reason = optionalText(src.reason, 'diagramSkip.reason', MAX_PROSE);
  if (reason.length > 0) skip.reason = reason;
  return skip;
}

/* ----------------------------------------------------------- lenient salvage */
/* These run in `load()` and never throw: a partial or hand-edited review.json   */
/* is repaired element by element, unusable elements dropped.                    */

function coerceString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

function coerceId(value: unknown, prefix: string): string {
  return typeof value === 'string' && value.length > 0 ? value : newId(prefix, Date.now());
}

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

/** Salvages a `sources` array, dropping any element that cannot be a `SourceRef`. */
function coerceSources(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];
  const out: SourceRef[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const src = raw as Record<string, unknown>;
    const ref: SourceRef = {
      kind: coerceEnum(src.kind, SOURCE_KINDS, 'doc'),
      anchor: coerceString(src.anchor, ''),
    };
    if (typeof src.label === 'string') ref.label = src.label;
    if (typeof src.quote === 'string') ref.quote = src.quote;
    out.push(ref);
  }
  return out;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (typeof item === 'number' && Number.isFinite(item)) out.push(String(item));
  }
  return out;
}

function normalizeDecision(raw: unknown): Decision | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const decision: Decision = {
    id: coerceId(src.id, 'dec'),
    title: coerceString(src.title, ''),
    context: coerceString(src.context, ''),
    options: coerceStringArray(src.options),
    choice: coerceString(src.choice, ''),
    tradeoffs: coerceString(src.tradeoffs, ''),
    consequence: coerceString(src.consequence, ''),
    provenance: coerceEnum(src.provenance, PROVENANCES, 'inferred'),
    sources: coerceSources(src.sources),
    status: coerceEnum(src.status, DECISION_STATUSES, 'open'),
    author: coerceString(src.author, DEFAULT_AUTHOR),
    createdAt: coerceString(src.createdAt, ''),
  };
  if (typeof src.threadNoteId === 'string') decision.threadNoteId = src.threadNoteId;
  if (typeof src.updatedAt === 'string') decision.updatedAt = src.updatedAt;
  return decision;
}

function normalizeStamp(raw: unknown): ReviewStamp | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const anchor = coerceString(src.anchor, '');
  const stamp: ReviewStamp = {
    id: coerceId(src.id, 'stamp'),
    anchor,
    anchorLabel: coerceString(src.anchorLabel, anchor),
    // An unreadable verdict defaults to `concern`: flag for attention, never
    // silently approve.
    verdict: coerceEnum(src.verdict, VERDICTS, 'concern'),
    author: coerceString(src.author, DEFAULT_AUTHOR),
    createdAt: coerceString(src.createdAt, ''),
  };
  if (typeof src.note === 'string') stamp.note = src.note;
  return stamp;
}

function normalizeExplanation(raw: unknown): Explanation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const anchor = coerceString(src.anchor, '');
  return {
    id: coerceId(src.id, 'exp'),
    anchor,
    anchorLabel: coerceString(src.anchorLabel, anchor),
    kind: coerceEnum(src.kind, EXPLANATION_KINDS, 'summary'),
    body: coerceString(src.body, ''),
    provenance: coerceEnum(src.provenance, PROVENANCES, 'inferred'),
    sources: coerceSources(src.sources),
    specHash: coerceString(src.specHash, ''),
    author: coerceString(src.author, DEFAULT_AUTHOR),
    createdAt: coerceString(src.createdAt, ''),
  };
}

function normalizeGlossary(raw: unknown): GlossaryTerm | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  return {
    id: coerceId(src.id, 'term'),
    term: coerceString(src.term, ''),
    definition: coerceString(src.definition, ''),
    provenance: coerceEnum(src.provenance, PROVENANCES, 'inferred'),
    sources: coerceSources(src.sources),
    defined: src.defined !== false,
    author: coerceString(src.author, DEFAULT_AUTHOR),
    createdAt: coerceString(src.createdAt, ''),
  };
}

function normalizeDiagram(raw: unknown): AuthoredDiagram | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const anchor = coerceString(src.anchor, '');
  // A salvaged diagram never throws a renderer: an unreadable type falls back to
  // `flowchart` and a non-string mermaid is coerced, not dropped, so the record
  // stays a valid `AuthoredDiagram`. (Bad Mermaid is caught on the write path.)
  return {
    id: coerceId(src.id, 'diag'),
    title: coerceString(src.title, ''),
    type: coerceEnum(src.type, AUTHORED_DIAGRAM_TYPES, 'flowchart'),
    anchor,
    anchorLabel: coerceString(src.anchorLabel, anchor),
    covers: coerceStringArray(src.covers),
    mermaid: coerceString(src.mermaid, ''),
    trigger: coerceString(src.trigger, ''),
    provenance: coerceEnum(src.provenance, PROVENANCES, 'inferred'),
    sources: coerceSources(src.sources),
    specHash: coerceString(src.specHash, ''),
    author: coerceString(src.author, DEFAULT_AUTHOR),
    createdAt: coerceString(src.createdAt, ''),
  };
}

function normalizeDiagramSkip(raw: unknown): DiagramSkip | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const skip: DiagramSkip = {
    anchor: coerceString(src.anchor, ''),
    specHash: coerceString(src.specHash, ''),
    author: coerceString(src.author, DEFAULT_AUTHOR),
    createdAt: coerceString(src.createdAt, ''),
  };
  if (typeof src.reason === 'string') skip.reason = src.reason;
  return skip;
}

/** Salvages every element of `value`, counting drops via `onDrop`. */
function normalizeArray<T>(
  value: unknown,
  normalize: (raw: unknown) => T | null,
  onDrop: () => void
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const raw of value) {
    const item = normalize(raw);
    if (item === null) onDrop();
    else out.push(item);
  }
  return out;
}

/** Reads and writes `<projectRoot>/.spec-scope/review.json`. */
export class ReviewStore {
  /** Absolute path to the review file. It may not exist yet. */
  readonly file: string;

  /** Non-fatal problems worth showing the user, e.g. a quarantined bad file. */
  readonly warnings: string[] = [];

  private readonly dir: string;
  private readonly lockPath: string;
  private readonly listeners = new Set<ChangeListener>();

  /** Serialises writes so two rapid POSTs cannot read-modify-write over each other. */
  private tail: Promise<unknown> = Promise.resolve();

  private watchHandle: { close(): void } | null = null;
  private watcherStarted = false;
  private debounce: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(projectRoot: string) {
    this.dir = path.join(path.resolve(projectRoot), DIR_NAME);
    this.file = path.join(this.dir, FILE_NAME);
    this.lockPath = `${this.file}${LOCK_SUFFIX}`;
  }

  /**
   * Current on-disk state. A missing file is an empty review; a corrupt file is
   * quarantined by `readJsonSafe`; a partial or hand-edited one is salvaged
   * element by element so a consumer never sees a record that would throw.
   */
  async load(): Promise<ReviewFile> {
    const { data, warnings } = await readJsonSafe<{
      decisions?: unknown;
      stamps?: unknown;
      explanations?: unknown;
      glossary?: unknown;
      diagrams?: unknown;
      diagramSkips?: unknown;
    }>(this.file, {});
    for (const warning of warnings) {
      if (!this.warnings.includes(warning)) this.warnings.push(warning);
    }

    let dropped = 0;
    const onDrop = (): void => {
      dropped += 1;
    };
    const decisions = normalizeArray(data.decisions, normalizeDecision, onDrop);
    const stamps = normalizeArray(data.stamps, normalizeStamp, onDrop);
    const explanations = normalizeArray(data.explanations, normalizeExplanation, onDrop);
    const glossary = normalizeArray(data.glossary, normalizeGlossary, onDrop);
    // Back-compat: a review.json written before diagrams existed has neither key;
    // `normalizeArray` treats an absent (non-array) value as `[]`, so old files load clean.
    const diagrams = normalizeArray(data.diagrams, normalizeDiagram, onDrop);
    const diagramSkips = normalizeArray(data.diagramSkips, normalizeDiagramSkip, onDrop);

    if (dropped > 0) {
      const msg = `${FILE_NAME} contained ${dropped} unreadable ${
        dropped === 1 ? 'entry that was' : 'entries that were'
      } skipped.`;
      if (!this.warnings.includes(msg)) this.warnings.push(msg);
    }
    return { version: 1, decisions, stamps, explanations, glossary, diagrams, diagramSkips };
  }

  // ------------------------------------------------------------- decisions

  async listDecisions(opts?: { status?: DecisionStatus }): Promise<Decision[]> {
    const { decisions } = await this.load();
    const status = opts?.status;
    return status === undefined ? decisions : decisions.filter((d) => d.status === status);
  }

  async addDecision(input: {
    title: string;
    context?: string;
    options?: string[];
    choice: string;
    tradeoffs?: string;
    consequence?: string;
    provenance?: Provenance;
    sources?: SourceRef[];
    threadNoteId?: string;
    author?: string;
  }): Promise<Decision> {
    if (typeof input !== 'object' || input === null) {
      throw new Error('addDecision() requires an object with title and choice');
    }
    // Validate before the write queue so a bad request never blocks a good one.
    const decision: Decision = {
      id: newId('dec', Date.now()),
      title: requireText(input.title, 'title', MAX_TITLE),
      context: optionalText(input.context, 'context', MAX_PROSE),
      options: requireStringArray(input.options, 'options', MAX_PROSE),
      choice: requireText(input.choice, 'choice', MAX_PROSE),
      tradeoffs: optionalText(input.tradeoffs, 'tradeoffs', MAX_PROSE),
      consequence: optionalText(input.consequence, 'consequence', MAX_PROSE),
      provenance: optionalProvenance(input.provenance, 'inferred'),
      sources: requireSources(input.sources),
      status: 'open',
      author: optionalAuthor(input.author),
      createdAt: nowIso(),
    };
    const threadNoteId = optionalText(input.threadNoteId, 'threadNoteId', MAX_ANCHOR);
    if (threadNoteId.length > 0) decision.threadNoteId = threadNoteId;

    return this.mutate((file) => {
      file.decisions.push(decision);
      return decision;
    });
  }

  async updateDecision(
    id: string,
    patch: Partial<Omit<Decision, 'id' | 'createdAt'>>
  ): Promise<Decision> {
    if (typeof id !== 'string' || id.length === 0) throw new Error('updateDecision() needs an id');
    if (typeof patch !== 'object' || patch === null) throw new Error('patch must be an object');

    // Pre-validate every supplied field (pure value checks) before the write queue.
    const clean: Partial<Decision> = {};
    if ('title' in patch) clean.title = requireText(patch.title, 'title', MAX_TITLE);
    if ('context' in patch) clean.context = optionalText(patch.context, 'context', MAX_PROSE);
    if ('options' in patch) clean.options = requireStringArray(patch.options, 'options', MAX_PROSE);
    if ('choice' in patch) clean.choice = requireText(patch.choice, 'choice', MAX_PROSE);
    if ('tradeoffs' in patch) {
      clean.tradeoffs = optionalText(patch.tradeoffs, 'tradeoffs', MAX_PROSE);
    }
    if ('consequence' in patch) {
      clean.consequence = optionalText(patch.consequence, 'consequence', MAX_PROSE);
    }
    if ('provenance' in patch) {
      clean.provenance = requireEnum(patch.provenance, PROVENANCES, 'provenance');
    }
    if ('sources' in patch) clean.sources = requireSources(patch.sources);
    if ('status' in patch) clean.status = requireEnum(patch.status, DECISION_STATUSES, 'status');
    if ('author' in patch) clean.author = optionalAuthor(patch.author);
    // An empty threadNoteId clears the link rather than storing a blank string.
    let clearThread = false;
    if ('threadNoteId' in patch) {
      const t = optionalText(patch.threadNoteId, 'threadNoteId', MAX_ANCHOR);
      if (t.length > 0) clean.threadNoteId = t;
      else clearThread = true;
    }

    return this.mutate((file) => {
      const decision = file.decisions.find((d) => d.id === id);
      if (decision === undefined) throw new Error(`No decision with id '${id}'`);
      Object.assign(decision, clean);
      if (clearThread) delete decision.threadNoteId;
      decision.updatedAt = nowIso();
      return decision;
    });
  }

  async removeDecision(id: string): Promise<void> {
    await this.mutate((file) => {
      const index = file.decisions.findIndex((d) => d.id === id);
      if (index < 0) throw new Error(`No decision with id '${id}'`);
      file.decisions.splice(index, 1);
    });
  }

  // ------------------------------------------------------------- stamps

  async listStamps(): Promise<ReviewStamp[]> {
    return (await this.load()).stamps;
  }

  /** Upsert: one stamp per (anchor, author). A repeat updates the verdict in place. */
  async setStamp(input: {
    anchor: string;
    anchorLabel: string;
    verdict: ReviewVerdict;
    note?: string;
    author?: string;
  }): Promise<ReviewStamp> {
    if (typeof input !== 'object' || input === null) {
      throw new Error('setStamp() requires an object with anchor, anchorLabel and verdict');
    }
    const anchor = requireText(input.anchor, 'anchor', MAX_ANCHOR);
    const anchorLabel = requireText(input.anchorLabel, 'anchorLabel', MAX_LABEL);
    const verdict = requireEnum(input.verdict, VERDICTS, 'verdict');
    const note = optionalText(input.note, 'note', MAX_PROSE);
    const author = optionalAuthor(input.author);

    return this.mutate((file) => {
      const existing = file.stamps.find((s) => s.anchor === anchor && s.author === author);
      if (existing !== undefined) {
        existing.verdict = verdict;
        existing.anchorLabel = anchorLabel;
        if (note.length > 0) existing.note = note;
        else delete existing.note;
        return existing;
      }
      const stamp: ReviewStamp = {
        id: newId('stamp', Date.now()),
        anchor,
        anchorLabel,
        verdict,
        author,
        createdAt: nowIso(),
      };
      if (note.length > 0) stamp.note = note;
      file.stamps.push(stamp);
      return stamp;
    });
  }

  async removeStamp(id: string): Promise<void> {
    await this.mutate((file) => {
      const index = file.stamps.findIndex((s) => s.id === id);
      if (index < 0) throw new Error(`No stamp with id '${id}'`);
      file.stamps.splice(index, 1);
    });
  }

  // ------------------------------------------------------------- explanations & glossary

  async listExplanations(opts?: {
    kind?: ExplanationKind;
    anchor?: string;
  }): Promise<Explanation[]> {
    const { explanations } = await this.load();
    const kind = opts?.kind;
    const anchor = opts?.anchor;
    return explanations.filter(
      (e) =>
        (kind === undefined || e.kind === kind) && (anchor === undefined || e.anchor === anchor)
    );
  }

  async listGlossary(): Promise<GlossaryTerm[]> {
    return (await this.load()).glossary;
  }

  // ------------------------------------------------------------- diagrams

  async listDiagrams(): Promise<AuthoredDiagram[]> {
    return (await this.load()).diagrams;
  }

  async listDiagramSkips(): Promise<DiagramSkip[]> {
    return (await this.load()).diagramSkips;
  }

  /**
   * The agent's write path. Upserts explanations by (anchor, kind), glossary by
   * term, decisions by id, diagrams by id and diagram-skips by anchor (a new id
   * when absent). Validates the whole batch up front — one bad element (including
   * a diagram whose Mermaid fails `validateAuthoredMermaid`) rejects the write, so
   * a partial batch never lands.
   *
   * Diagrams and skips are two sides of one decision and supersede each other:
   * authoring a diagram for anchor X clears any "no diagram" skip for X, and a
   * skip for X removes every prior diagram anchored at X. A supersede removal is
   * counted as neither an add nor an update; only the batch's own elements are.
   * Within a single batch, diagrams apply before skips, so a skip for X wins over
   * a diagram for X handed in together.
   */
  async applyBatch(batch: ReviewBatch): Promise<{ added: number; updated: number }> {
    if (typeof batch !== 'object' || batch === null)
      throw new Error('applyBatch() needs an object');

    // Validate everything before touching the write queue: the write is all-or-nothing.
    const explanations = (batch.explanations ?? []).map(validateExplanation);
    const decisions = (batch.decisions ?? []).map(validateDecision);
    const glossary = (batch.glossary ?? []).map(validateGlossary);
    const diagrams = (batch.diagrams ?? []).map(validateDiagram);
    const diagramSkips = (batch.diagramSkips ?? []).map(validateDiagramSkip);

    return this.mutate((file) => {
      let added = 0;
      let updated = 0;

      for (const exp of explanations) {
        const idx = file.explanations.findIndex(
          (e) => e.anchor === exp.anchor && e.kind === exp.kind
        );
        if (idx >= 0) {
          const prev = file.explanations[idx];
          // Keep the original id, replace the content.
          file.explanations[idx] = { ...exp, id: prev?.id ?? exp.id };
          updated += 1;
        } else {
          file.explanations.push(exp);
          added += 1;
        }
      }

      for (const dec of decisions) {
        const idx = file.decisions.findIndex((d) => d.id === dec.id);
        if (idx >= 0) {
          const prev = file.decisions[idx];
          file.decisions[idx] = {
            ...dec,
            createdAt: prev?.createdAt ?? dec.createdAt,
            updatedAt: nowIso(),
          };
          updated += 1;
        } else {
          file.decisions.push(dec);
          added += 1;
        }
      }

      for (const term of glossary) {
        const idx = file.glossary.findIndex((g) => g.term === term.term);
        if (idx >= 0) {
          const prev = file.glossary[idx];
          file.glossary[idx] = { ...term, id: prev?.id ?? term.id };
          updated += 1;
        } else {
          file.glossary.push(term);
          added += 1;
        }
      }

      for (const dgm of diagrams) {
        // Authoring a diagram supersedes a prior "no diagram warranted" skip for
        // the same anchor: the agent changed its mind toward a picture.
        const skipIdx = file.diagramSkips.findIndex((s) => s.anchor === dgm.anchor);
        if (skipIdx >= 0) file.diagramSkips.splice(skipIdx, 1);

        const idx = file.diagrams.findIndex((d) => d.id === dgm.id);
        if (idx >= 0) {
          const prev = file.diagrams[idx];
          // Keep the original authoring time; the id is the match key already.
          file.diagrams[idx] = { ...dgm, createdAt: prev?.createdAt ?? dgm.createdAt };
          updated += 1;
        } else {
          file.diagrams.push(dgm);
          added += 1;
        }
      }

      for (const skip of diagramSkips) {
        // A skip for anchor X asserts none is warranted, so any diagram anchored
        // at X is now stale intent and is removed (the agent changed its mind).
        for (let i = file.diagrams.length - 1; i >= 0; i -= 1) {
          if (file.diagrams[i]?.anchor === skip.anchor) file.diagrams.splice(i, 1);
        }

        const idx = file.diagramSkips.findIndex((s) => s.anchor === skip.anchor);
        if (idx >= 0) {
          file.diagramSkips[idx] = skip;
          updated += 1;
        } else {
          file.diagramSkips.push(skip);
          added += 1;
        }
      }

      return { added, updated };
    });
  }

  // ------------------------------------------------------------- change feed

  /**
   * Subscribes to review changes from this process *and* from other processes.
   * The listener takes no arguments — it is a "something changed" signal the SSE
   * feed relays. Returns an unsubscribe function; call `close()` to release the
   * watcher.
   */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    this.ensureWatcher();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Releases the watcher and any pending timer. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounce !== null) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.watchHandle?.close();
    this.watchHandle = null;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Runs `fn` after every previously queued operation, whether those succeeded
   * or failed. The chain is isolated from rejections so a rejected validation or
   * an unknown-id update cannot poison later writes or surface as an unhandled
   * rejection.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Read-modify-write under the queue, notifying listeners only after a durable
   * write. The `tail` chain serialises this process's writes; the lock file
   * serialises against other processes and the running server sharing the file.
   */
  private mutate<T>(apply: (file: ReviewFile) => T): Promise<T> {
    return this.run(() =>
      withFileLock(this.lockPath, async () => {
        const file = await this.load();
        const result = apply(file);
        await writeJsonAtomic(this.file, file);
        this.emit();
        return result;
      })
    );
  }

  private emit(): void {
    // Copy first: a listener may unsubscribe itself.
    for (const listener of [...this.listeners]) listener();
  }

  private ensureWatcher(): void {
    if (this.closed || this.watcherStarted) return;
    this.watcherStarted = true;
    // Only react to review.json-family events, so a sibling notes.json write in
    // the same `.spec-scope` directory cannot spuriously fire the review feed.
    this.watchHandle = watchJsonDir(this.dir, () => this.scheduleReload(), FILE_NAME);
  }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.load().then(
        () => {
          if (!this.closed) this.emit();
        },
        () => undefined
      );
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }
}
