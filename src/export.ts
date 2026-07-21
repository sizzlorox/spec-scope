/**
 * Single-file tech-doc exporter.
 *
 * The output is the artifact a team actually reviews: one `.html` with every
 * diagram, requirement and open discussion note baked in, plus the Mermaid and
 * Marked bundles inlined so it renders with the network disabled and prints to
 * PDF without a server.
 *
 * `renderTechDoc` takes everything it needs as arguments so the whole document
 * can be asserted against in a unit test; `exportTechDoc` is the only part that
 * touches the filesystem.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { changeEntries } from './changes.js';
import { generateDiagrams, requirementHeatMap } from './diagram.js';
import { docStructureSource, requirementSource, scenarioSource, specHash } from './hash.js';
import { NoteStore } from './notes.js';
import { parseProject } from './parse.js';
import { ReviewStore } from './review.js';
import type {
  AuthoredDiagram,
  AuthoredDiagramType,
  ChangeEntry,
  Decision,
  DeltaKind,
  Diagram,
  DiagramKind,
  Explanation,
  ExplanationKind,
  GlossaryTerm,
  Note,
  Provenance,
  Requirement,
  ReviewFile,
  ReviewStamp,
  ReviewVerdict,
  Scenario,
  SourceRef,
  SpecDoc,
  SpecGroup,
  SpecModel,
} from './types.js';
import { readVendor } from './vendor.js';

export interface ExportOptions {
  root: string;
  out?: string;
  includeNotes?: boolean;
}

/* -------------------------------------------------------------------------- */
/* escaping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The single escaping choke point. Spec content is untrusted input, so every
 * model-derived string reaches the document through here — the only exception
 * is prose, which is handed to Marked as *text* and rendered client-side with
 * raw-HTML passthrough disabled.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Neutralise a `</script` sequence inside JavaScript being inlined into a
 * `<script>` element. The HTML tokenizer ends a script at that byte sequence
 * regardless of JS syntax, and `<\/script` is an identical string/regex literal
 * to the engine, so the rewrite is safe for minified bundles.
 *
 * tradeoff: handles the closing-tag case only, not the Annex-B `<!--` script
 * escaping states. Both vendored bundles are single-line minified builds where
 * that cannot bite; revisit if we ever inline hand-written sources.
 */
function inlineScriptSource(source: string): string {
  return source.replace(/<\/(script)/gi, '<\\/$1');
}

/* -------------------------------------------------------------------------- */
/* model helpers                                                               */
/* -------------------------------------------------------------------------- */

interface ModelCounts {
  groups: number;
  docs: number;
  requirements: number;
  scenarios: number;
  tasksDone: number;
  tasksTotal: number;
}

function countModel(model: SpecModel): ModelCounts {
  const counts: ModelCounts = {
    groups: model.groups.length,
    docs: model.docs.length,
    requirements: 0,
    scenarios: 0,
    tasksDone: 0,
    tasksTotal: 0,
  };
  for (const doc of model.docs) {
    counts.requirements += doc.requirements.length;
    for (const req of doc.requirements) counts.scenarios += req.scenarios.length;
    counts.tasksTotal += doc.tasks.length;
    for (const task of doc.tasks) if (task.done) counts.tasksDone += 1;
  }
  return counts;
}

/** Diagrams keyed by the model id they hang off, so lookup stays O(1) per section. */
function indexDiagrams(diagrams: Diagram[]): Map<string, Diagram[]> {
  const index = new Map<string, Diagram[]>();
  for (const diagram of diagrams) {
    const bucket = index.get(diagram.anchor);
    if (bucket) bucket.push(diagram);
    else index.set(diagram.anchor, [diagram]);
  }
  return index;
}

function pickDiagram(
  index: Map<string, Diagram[]>,
  anchor: string,
  kind: DiagramKind
): Diagram | undefined {
  return index.get(anchor)?.find((d) => d.kind === kind);
}

/* -------------------------------------------------------------------------- */
/* review-layer coercion                                                       */
/*                                                                             */
/* review.json is untrusted: a hand-edited or half-written file can reach the  */
/* exporter with a missing field or a wrong type. `ReviewStore.load()` already */
/* salvages it, but `renderTechDoc` may be handed a raw ReviewFile in a test,  */
/* so every review-derived value is coerced here at the boundary — a bad field */
/* degrades gracefully instead of throwing (`renderProse` calls `.trim()`).    */
/* -------------------------------------------------------------------------- */

const PROVENANCES: readonly Provenance[] = ['grounded', 'inferred', 'unstated'];
const DELTAS: readonly DeltaKind[] = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'];

/** The default review when `renderTechDoc` is called without one (the legacy 4-arg form). */
const EMPTY_REVIEW: ReviewFile = {
  version: 1,
  decisions: [],
  stamps: [],
  explanations: [],
  glossary: [],
  diagrams: [],
  diagramSkips: [],
};

/** Human-readable meaning of each provenance flag, shown as the badge tooltip. */
const PROVENANCE_TITLE: Record<Provenance, string> = {
  grounded: 'Restates spec or discussion text — has sources to check.',
  inferred: "The agent's reading of the spec; a claim, shown as one.",
  unstated: 'The spec does not state this — an open question, not a fact.',
};

const DIAGRAM_TYPES: readonly AuthoredDiagramType[] = [
  'sequence',
  'state',
  'er',
  'flowchart',
  'class',
];

/** Badge label for each authored-diagram type ('er' reads better upper-cased). */
const DIAGRAM_TYPE_LABEL: Record<AuthoredDiagramType, string> = {
  sequence: 'sequence',
  state: 'state',
  er: 'ER',
  flowchart: 'flowchart',
  class: 'class',
};

/** Known type -> its badge label; an unknown (hand-edited) type falls back to its raw text. */
function diagramTypeLabel(type: unknown): string {
  return DIAGRAM_TYPES.includes(type as AuthoredDiagramType)
    ? DIAGRAM_TYPE_LABEL[type as AuthoredDiagramType]
    : str(type).trim();
}

/** Coerce any value to a string so the escaper and Marked never see a non-string. */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function coerceProvenance(value: unknown): Provenance {
  return PROVENANCES.includes(value as Provenance) ? (value as Provenance) : 'inferred';
}

function coerceDelta(value: unknown): DeltaKind {
  return DELTAS.includes(value as DeltaKind) ? (value as DeltaKind) : 'MODIFIED';
}

/** Key an explanation by anchor + kind, matching how `applyBatch` upserts them. */
function explanationKey(anchor: string, kind: ExplanationKind): string {
  return `${anchor}\n${kind}`;
}

/**
 * Everything the fragment renderers need to reach the review layer, threaded so
 * a requirement can inline its summary and a doc can pick the heat map. Built
 * once per document from the (already coerced) review arrays.
 */
interface RenderCtx {
  index: Map<string, Diagram[]>;
  /** Explanations keyed by `explanationKey(anchor, kind)`; first write wins. */
  explanations: Map<string, Explanation>;
  /** Agent-authored diagrams keyed by the anchor (doc/group id) they hang off. */
  authored: Map<string, AuthoredDiagram[]>;
  stamps: ReviewStamp[];
  /** Tint requirement maps by verdict once any stamp exists. */
  useHeatMap: boolean;
}

/* -------------------------------------------------------------------------- */
/* fragment rendering                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Markdown is emitted as escaped *text* and upgraded in place by the inlined
 * Marked bundle. Without scripting the reader still sees the source, which is
 * a far better failure mode than an empty section.
 */
function renderProse(markdown: string): string {
  if (!markdown.trim()) return '';
  return `<div class="prose" data-md>${escapeHtml(markdown)}</div>`;
}

function renderDiagram(diagram: Diagram | undefined): string {
  if (!diagram) return '';
  return [
    `<figure class="diagram" id="${escapeHtml(diagram.id)}">`,
    `<figcaption>${escapeHtml(diagram.title)}</figcaption>`,
    `<pre class="mermaid">${escapeHtml(diagram.mermaid)}</pre>`,
    '</figure>',
  ].join('\n');
}

/**
 * A diagram the in-loop agent authored (the high-value ones), rendered like an
 * explanation: type + provenance badges, a stale marker when the doc structure
 * drifted under it, and the same inline `pre.mermaid` path the derived diagrams
 * use so the offline bundle renders it.
 *
 * trust boundary: the title/trigger are untrusted spec-adjacent text and go
 * through `escapeHtml`, but the Mermaid *source* is emitted as-is — it was
 * validated by `apply`, so it is trusted the way the vendored bundles are, and
 * gets the same `</script`-only neutralisation. That is weaker than the derived
 * path's full escape (a hostile `</pre>` would break out), a deliberate call
 * that rests on the apply-time validation; do not widen it here.
 */
function renderAuthoredDiagram(diagram: AuthoredDiagram, stale: boolean): string {
  const typeLabel = diagramTypeLabel(diagram.type);
  const typeBadge = typeLabel
    ? `<span class="badge badge-diagram-type" title="Authored ${escapeHtml(
        typeLabel
      )} diagram">${escapeHtml(typeLabel)}</span>`
    : '';
  const staleBadge = stale
    ? '<span class="badge badge-stale" title="The spec structure changed after this diagram was drawn — re-check it.">stale</span>'
    : '';
  const title = escapeHtml(str(diagram.title)) || '(untitled diagram)';
  const trigger = str(diagram.trigger).trim();
  const triggerHtml = trigger ? `<p class="diagram-trigger">${escapeHtml(trigger)}</p>` : '';
  return [
    `<figure class="diagram diagram-authored${stale ? ' is-stale' : ''}" id="${escapeHtml(
      str(diagram.id)
    )}">`,
    `<figcaption>${typeBadge}${provenanceBadge(diagram.provenance)}${staleBadge}<span class="diagram-title">${title}</span></figcaption>`,
    `<pre class="mermaid">${inlineScriptSource(str(diagram.mermaid))}</pre>`,
    triggerHtml,
    '</figure>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderSteps(scenario: Scenario): string {
  if (scenario.steps.length === 0) return '';
  const items = scenario.steps.map((step) => {
    const keyword = `<span class="kw kw-${escapeHtml(step.keyword.toLowerCase())}">${escapeHtml(
      step.keyword
    )}</span>`;
    const actor = step.actor ? `<span class="actor">${escapeHtml(step.actor)}</span>` : '';
    return `<li class="step">${keyword}${actor}<span class="step-text">${escapeHtml(
      step.text
    )}</span></li>`;
  });
  return `<ol class="steps">\n${items.join('\n')}\n</ol>`;
}

/** The provenance flag as an escaped badge with an explanatory tooltip. */
function provenanceBadge(provenance: Provenance): string {
  const p = coerceProvenance(provenance);
  return `<span class="badge badge-prov badge-${p}" title="${escapeHtml(
    PROVENANCE_TITLE[p]
  )}">${p}</span>`;
}

/** Citations back to the spec/discussion, so a reader can check the paraphrase. */
function renderSources(sources: SourceRef[] | undefined): string {
  const list = Array.isArray(sources) ? sources : [];
  const items: string[] = [];
  for (const source of list) {
    if (source === null || typeof source !== 'object') continue;
    const anchor = str(source.anchor).trim();
    const kind = str(source.kind).trim() || 'ref';
    const label = str(source.label).trim() || anchor || kind;
    // Internal anchors only; an unresolved one is a harmless dead scroll target.
    const link = anchor
      ? `<a href="#${escapeHtml(anchor)}">${escapeHtml(label)}</a>`
      : `<span>${escapeHtml(label)}</span>`;
    const quote = str(source.quote).trim();
    const q = quote ? `<q class="src-quote">${escapeHtml(quote)}</q>` : '';
    items.push(
      `<li class="source"><span class="src-kind">${escapeHtml(kind)}</span>${link}${q}</li>`
    );
  }
  if (items.length === 0) return '';
  return `<ul class="sources">\n${items.join('\n')}\n</ul>`;
}

/**
 * A plain-language explanation shown beside the formal text. `stale` is set when
 * the source hash no longer matches, so an out-of-date paraphrase is flagged
 * rather than presented as current.
 */
function renderExplanation(explanation: Explanation, stale: boolean, variant: string): string {
  const staleBadge = stale
    ? '<span class="badge badge-stale" title="The spec text changed after this was written — re-check it.">stale</span>'
    : '';
  const body = renderProse(str(explanation.body));
  if (!body) return '';
  return [
    `<div class="explanation explanation-${variant}${stale ? ' is-stale' : ''}">`,
    `<p class="explanation-meta">${provenanceBadge(explanation.provenance)}${staleBadge}</p>`,
    body,
    renderSources(explanation.sources),
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderScenario(scenario: Scenario, ctx: RenderCtx): string {
  const diagram = pickDiagram(ctx.index, scenario.id, 'sequence');
  const narration = ctx.explanations.get(explanationKey(scenario.id, 'narration'));
  const narrationBlock = narration
    ? renderExplanation(
        narration,
        str(narration.specHash) !==
          specHash(
            scenarioSource(
              scenario.name,
              scenario.steps.map((step) => step.text)
            )
          ),
        'narration'
      )
    : '';
  return [
    `<section class="scenario" id="${escapeHtml(scenario.id)}">`,
    `<h5 class="scenario-title">${escapeHtml(scenario.name)}</h5>`,
    '<div class="scenario-body">',
    renderSteps(scenario),
    renderDiagram(diagram),
    '</div>',
    narrationBlock,
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderRequirement(req: Requirement, ctx: RenderCtx): string {
  const badge = req.delta
    ? `<span class="badge badge-${escapeHtml(req.delta.toLowerCase())}">${escapeHtml(
        req.delta
      )}</span>`
    : '';
  const summary = ctx.explanations.get(explanationKey(req.id, 'summary'));
  const summaryBlock = summary
    ? renderExplanation(
        summary,
        str(summary.specHash) !==
          specHash(
            requirementSource(
              req.name,
              req.text,
              req.scenarios.map((scenario) => scenario.name)
            )
          ),
        'summary'
      )
    : '';
  const parts = [
    `<section class="requirement" id="${escapeHtml(req.id)}">`,
    `<h4 class="requirement-title">${badge}<span>${escapeHtml(req.name)}</span></h4>`,
    renderProse(req.text),
    summaryBlock,
  ];
  for (const scenario of req.scenarios) parts.push(renderScenario(scenario, ctx));
  parts.push('</section>');
  return parts.filter(Boolean).join('\n');
}

function renderDoc(doc: SpecDoc, ctx: RenderCtx): string {
  // When any verdict has been stamped, tint the requirement map by severity;
  // otherwise fall back to the plain structural map.
  // tradeoff: `useHeatMap` is a whole-review flag, so a doc with no stamps of its
  // own still renders an all-grey heat map (losing the plain map's delta tints)
  // once any sibling doc is stamped. Ceiling: per-doc stamp presence. Upgrade
  // path: switch on `ctx.stamps.some((s) => anchors of this doc include s.anchor)`.
  const map = ctx.useHeatMap
    ? (requirementHeatMap(doc, ctx.stamps) ?? undefined)
    : pickDiagram(ctx.index, doc.id, 'requirement-map');
  // The agent-authored diagrams anchored to this doc, up front and staleness-
  // checked against the doc's current structure — a DiagramSkip produces none.
  const authored = ctx.authored.get(doc.id) ?? [];
  let authoredBlocks: string[] = [];
  if (authored.length > 0) {
    const docHash = specHash(docStructureSource(doc));
    authoredBlocks = authored.map((d) => renderAuthoredDiagram(d, str(d.specHash) !== docHash));
  }
  const parts = [
    `<section class="doc" id="${escapeHtml(doc.id)}">`,
    `<h3 class="doc-title">${escapeHtml(doc.title)}</h3>`,
    `<p class="doc-meta"><span class="badge badge-kind">${escapeHtml(
      doc.kind
    )}</span><code>${escapeHtml(doc.path)}</code></p>`,
    renderProse(doc.markdown),
    ...authoredBlocks,
    renderDiagram(map),
    renderDiagram(pickDiagram(ctx.index, doc.id, 'task-flow')),
  ];
  if (doc.requirements.length > 0) {
    parts.push('<div class="requirements">');
    for (const req of doc.requirements) parts.push(renderRequirement(req, ctx));
    parts.push('</div>');
  }
  parts.push('</section>');
  return parts.filter(Boolean).join('\n');
}

function renderGroup(group: SpecGroup, docs: SpecDoc[], ctx: RenderCtx): string {
  const archived = group.archived ? '<span class="badge badge-archived">archived</span>' : '';
  const parts = [
    `<section class="group" id="${escapeHtml(group.id)}">`,
    `<h2 class="group-title">${escapeHtml(group.name)}${archived}</h2>`,
    `<p class="group-meta"><span class="badge badge-kind">${escapeHtml(
      group.kind
    )}</span><code>${escapeHtml(group.path)}</code></p>`,
    renderDiagram(pickDiagram(ctx.index, group.id, 'overview')),
  ];
  for (const doc of docs) parts.push(renderDoc(doc, ctx));
  parts.push('</section>');
  return parts.filter(Boolean).join('\n');
}

/* -------------------------------------------------------------------------- */
/* table of contents                                                           */
/* -------------------------------------------------------------------------- */

function tocEntry(id: string, label: string, cls: string, children: string): string {
  const link = `<a href="#${escapeHtml(id)}">${escapeHtml(label)}</a>`;
  return `<li class="${cls}">${link}${children}</li>`;
}

function tocForDocs(docs: SpecDoc[]): string {
  if (docs.length === 0) return '';
  const items = docs.map((doc) => {
    const reqItems = doc.requirements.map((req) => {
      const scnItems = req.scenarios.map((scn) => tocEntry(scn.id, scn.name, 'toc-scenario', ''));
      const scnList = scnItems.length > 0 ? `<ul>\n${scnItems.join('\n')}\n</ul>` : '';
      return tocEntry(req.id, req.name, 'toc-requirement', scnList);
    });
    const reqList = reqItems.length > 0 ? `<ul>\n${reqItems.join('\n')}\n</ul>` : '';
    return tocEntry(doc.id, doc.title, 'toc-doc', reqList);
  });
  return `<ul>\n${items.join('\n')}\n</ul>`;
}

/* -------------------------------------------------------------------------- */
/* notes appendix                                                              */
/* -------------------------------------------------------------------------- */

function renderNote(note: Note): string {
  const replies = note.replies.map(
    (reply) =>
      `<li class="reply"><span class="reply-author">${escapeHtml(
        reply.author
      )}</span><time>${escapeHtml(reply.createdAt)}</time>${renderProse(reply.body)}</li>`
  );
  const replyList = replies.length > 0 ? `<ul class="replies">\n${replies.join('\n')}\n</ul>` : '';
  return [
    `<article class="note" id="note-${escapeHtml(note.id)}">`,
    `<p class="note-meta"><span class="badge badge-${escapeHtml(note.kind)}">${escapeHtml(
      note.kind
    )}</span><span class="note-author">${escapeHtml(note.author)}</span><time>${escapeHtml(
      note.createdAt
    )}</time></p>`,
    renderProse(note.body),
    replyList,
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderNotesAppendix(notes: Note[]): string {
  const open = notes.filter((note) => note.status === 'open');
  if (open.length === 0) return '';

  // Grouped by anchor so a reviewer reads every question about one requirement
  // together instead of chasing them through creation order.
  const byAnchor = new Map<string, Note[]>();
  for (const note of open) {
    const bucket = byAnchor.get(note.anchor);
    if (bucket) bucket.push(note);
    else byAnchor.set(note.anchor, [note]);
  }

  const blocks: string[] = [];
  for (const [anchor, group] of byAnchor) {
    const label = group[0]?.anchorLabel ?? anchor;
    blocks.push(
      [
        '<section class="note-group">',
        `<h3 class="note-anchor"><a href="#${escapeHtml(anchor)}">${escapeHtml(label)}</a></h3>`,
        ...group.map(renderNote),
        '</section>',
      ].join('\n')
    );
  }

  return [
    '<section class="appendix" id="appendix-notes">',
    `<h2>Open discussion notes <span class="count">${open.length}</span></h2>`,
    ...blocks,
    '</section>',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* review-layer sections                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The plain-language lead: a short prose briefing stitched from the `summary`
 * explanations. Omitted entirely when none exist, so a spec with no summaries
 * never grows an empty section. The per-requirement summaries (badged and
 * staleness-checked) still appear inline in the body — this is the digest.
 */
function renderOverview(explanations: Explanation[]): string {
  // `unstated` summaries are honest gaps, not statements of fact: they belong in
  // Open questions (badged), never in the plain-prose lead where the badge is lost.
  const summaries = explanations.filter(
    (e) =>
      e.kind === 'summary' && coerceProvenance(e.provenance) !== 'unstated' && str(e.body).trim()
  );
  if (summaries.length === 0) return '';
  const blocks = summaries.map((e) => {
    const anchor = str(e.anchor).trim();
    const label = str(e.anchorLabel).trim();
    const lead =
      label && anchor
        ? `<p class="overview-lead"><a href="#${escapeHtml(anchor)}">${escapeHtml(label)}</a></p>`
        : label
          ? `<p class="overview-lead">${escapeHtml(label)}</p>`
          : '';
    return `<div class="overview-item">${lead}${renderProse(str(e.body))}</div>`;
  });
  return [
    '<section class="overview" id="overview">',
    '<h2>Overview</h2>',
    ...blocks,
    '</section>',
  ].join('\n');
}

/** One recorded decision: its receipt, provenance-badged, with source links. */
function renderDecision(decision: Decision): string {
  const title = escapeHtml(str(decision.title)) || '(untitled decision)';
  const rows: string[] = [];
  const prose = (label: string, value: unknown): void => {
    const html = renderProse(str(value));
    if (html) rows.push(`<div class="decision-field"><dt>${label}</dt><dd>${html}</dd></div>`);
  };

  prose('Context', decision.context);

  const options = Array.isArray(decision.options) ? decision.options : [];
  const optionItems = options
    .map((option) => str(option).trim())
    .filter((option) => option.length > 0)
    .map((option) => `<li>${escapeHtml(option)}</li>`);
  if (optionItems.length > 0) {
    rows.push(
      `<div class="decision-field"><dt>Options</dt><dd><ul class="options">${optionItems.join(
        ''
      )}</ul></dd></div>`
    );
  }

  prose('Choice', decision.choice);
  prose('Tradeoffs', decision.tradeoffs);
  prose('Consequence', decision.consequence);

  return [
    `<article class="decision" id="decision-${escapeHtml(str(decision.id))}">`,
    `<h3 class="decision-title">${provenanceBadge(decision.provenance)}<span>${title}</span></h3>`,
    rows.length > 0 ? `<dl class="decision-body">\n${rows.join('\n')}\n</dl>` : '',
    renderSources(decision.sources),
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The Decision Ledger: every *recorded* decision. Open decisions are still under
 * debate and superseded ones are history, so neither belongs in the finalized
 * story; both are excluded here (open ones surface via their discussion notes).
 */
function renderDecisionLedger(decisions: Decision[]): string {
  const recorded = decisions.filter((d) => d.status === 'recorded');
  if (recorded.length === 0) return '';
  return [
    '<section class="appendix decisions" id="decision-ledger">',
    `<h2>Decision ledger <span class="count">${recorded.length}</span></h2>`,
    ...recorded.map(renderDecision),
    '</section>',
  ].join('\n');
}

/**
 * The honest gaps, gathered in one place: `blocking`/`concern` verdicts, the
 * `unstated` explanations (where the agent refused to invent a rationale), and
 * every glossary term the spec uses but never defines. Each is framed as an open
 * question, never a fabricated answer. Omitted when there is nothing to raise.
 */
function renderOpenQuestions(
  explanations: Explanation[],
  glossary: GlossaryTerm[],
  stamps: ReviewStamp[]
): string {
  const flagged = stamps
    .filter((s) => s.verdict === 'blocking' || s.verdict === 'concern')
    .sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === 'blocking' ? -1 : 1));
  const unstated = explanations.filter((e) => coerceProvenance(e.provenance) === 'unstated');
  const undefinedTerms = glossary.filter((g) => g.defined === false && str(g.term).trim());

  if (flagged.length + unstated.length + undefinedTerms.length === 0) return '';

  const items: string[] = [];

  for (const stamp of flagged) {
    const verdict: ReviewVerdict = stamp.verdict === 'blocking' ? 'blocking' : 'concern';
    const anchor = str(stamp.anchor).trim();
    const label = str(stamp.anchorLabel).trim() || anchor || '(unlabelled)';
    const link = anchor
      ? `<a href="#${escapeHtml(anchor)}">${escapeHtml(label)}</a>`
      : `<span>${escapeHtml(label)}</span>`;
    const note = str(stamp.note).trim();
    const noteHtml = note ? renderProse(note) : '';
    items.push(
      `<li class="oq oq-${verdict}"><span class="badge badge-${verdict}">${verdict}</span>${link}${noteHtml}</li>`
    );
  }

  for (const e of unstated) {
    const anchor = str(e.anchor).trim();
    const label = str(e.anchorLabel).trim();
    const head = anchor
      ? `<a href="#${escapeHtml(anchor)}">${escapeHtml(label || anchor)}</a>`
      : label
        ? `<span>${escapeHtml(label)}</span>`
        : '';
    items.push(
      `<li class="oq oq-unstated"><span class="badge badge-unstated">unstated</span>${head}${renderProse(
        str(e.body)
      )}</li>`
    );
  }

  for (const term of undefinedTerms) {
    items.push(
      `<li class="oq oq-term"><span class="badge badge-unstated">undefined term</span><strong>${escapeHtml(
        str(term.term)
      )}</strong> — used in the spec but never defined.</li>`
    );
  }

  return [
    '<section class="appendix open-questions" id="open-questions">',
    `<h2>Open questions <span class="count">${items.length}</span></h2>`,
    `<ul class="oq-list">\n${items.join('\n')}\n</ul>`,
    '</section>',
  ].join('\n');
}

/** The Changes appendix: one entry per delta, with the before/after quoted verbatim. */
function renderChangeEntry(change: ChangeEntry): string {
  const delta = coerceDelta(change.delta);
  const badge = `<span class="badge badge-${delta.toLowerCase()}">${delta}</span>`;
  const anchor = str(change.anchor).trim();
  const name = escapeHtml(str(change.requirement)) || '(unnamed requirement)';
  const heading = anchor ? `<a href="#${escapeHtml(anchor)}">${name}</a>` : `<span>${name}</span>`;
  const quote = (label: string, value: unknown): string => {
    const text = str(value).trim();
    return text
      ? `<div class="change-side"><h4>${label}</h4><blockquote class="change-quote">${escapeHtml(
          text
        )}</blockquote></div>`
      : '';
  };
  return [
    `<article class="change" id="change-${escapeHtml(anchor)}">`,
    `<h3 class="change-title">${badge}${heading}</h3>`,
    `<p class="change-summary">${escapeHtml(str(change.summary))}</p>`,
    quote('Before', change.before),
    quote('After', change.after),
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderChangesAppendix(changes: ChangeEntry[]): string {
  if (changes.length === 0) return '';
  return [
    '<section class="appendix changes-appendix" id="appendix-changes">',
    `<h2>Changes <span class="count">${changes.length}</span></h2>`,
    ...changes.map(renderChangeEntry),
    '</section>',
  ].join('\n');
}

/** The Glossary appendix: defined terms only — undefined ones are open questions. */
function renderGlossaryAppendix(glossary: GlossaryTerm[]): string {
  const defined = glossary.filter((g) => g.defined !== false && str(g.term).trim());
  if (defined.length === 0) return '';
  const items = defined.map((term) => {
    const definition = renderProse(str(term.definition));
    return [
      `<div class="glossary-term" id="term-${escapeHtml(str(term.id))}">`,
      `<dt>${escapeHtml(str(term.term))}${provenanceBadge(term.provenance)}</dt>`,
      `<dd>${definition}${renderSources(term.sources)}</dd>`,
      '</div>',
    ].join('\n');
  });
  return [
    '<section class="appendix glossary" id="appendix-glossary">',
    `<h2>Glossary <span class="count">${defined.length}</span></h2>`,
    `<dl class="glossary-list">\n${items.join('\n')}\n</dl>`,
    '</section>',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* static assets                                                               */
/* -------------------------------------------------------------------------- */

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --bg-soft: #f6f7f9;
  --bg-code: #f0f2f5;
  --fg: #1b1f24;
  --fg-muted: #5b6572;
  --border: #d8dee6;
  --accent: #2f6feb;
  --added: #1a7f37;
  --modified: #9a6700;
  --removed: #cf222e;
  --renamed: #6639ba;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1319;
    --bg-soft: #161b22;
    --bg-code: #1b222c;
    --fg: #e6edf3;
    --fg-muted: #9aa7b4;
    --border: #2b3440;
    --accent: #6ea8fe;
    --added: #56d364;
    --modified: #e3b341;
    --removed: #ff7b72;
    --renamed: #d2a8ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.page { max-width: 62rem; margin: 0 auto; padding: 0 1.5rem 6rem; }
header.chrome {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  gap: 1rem;
  align-items: baseline;
  padding: 0.75rem 1.5rem;
  background: var(--bg-soft);
  border-bottom: 1px solid var(--border);
}
header.chrome strong { font-size: 0.95rem; }
header.chrome a { margin-left: auto; font-size: 0.85rem; }
a { color: var(--accent); }
h1, h2, h3, h4, h5 { line-height: 1.25; }
h1 { font-size: 2rem; margin: 2rem 0 0.5rem; }
h2 { font-size: 1.5rem; margin: 2.5rem 0 0.75rem; padding-top: 0.5rem; border-top: 2px solid var(--border); }
h3 { font-size: 1.2rem; margin: 1.75rem 0 0.5rem; }
h4 { font-size: 1.05rem; margin: 1.5rem 0 0.4rem; }
h5 { font-size: 0.95rem; margin: 1rem 0 0.35rem; color: var(--fg-muted); }
code, pre { font-family: ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, monospace; }
code { background: var(--bg-code); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }
pre { background: var(--bg-code); padding: 0.85rem 1rem; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border); padding: 0.4rem 0.6rem; text-align: left; }
blockquote { margin: 0.75rem 0; padding-left: 1rem; border-left: 3px solid var(--border); color: var(--fg-muted); }
img { max-width: 100%; }

.cover { padding: 2.5rem 0 1.5rem; border-bottom: 1px solid var(--border); }
.cover .subtitle { color: var(--fg-muted); margin: 0.25rem 0 1.5rem; }
.stats { display: flex; flex-wrap: wrap; gap: 0.75rem; list-style: none; padding: 0; margin: 0; }
.stats li {
  min-width: 7rem;
  padding: 0.6rem 0.9rem;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.stats .n { display: block; font-size: 1.4rem; font-weight: 600; }
.stats .k { font-size: 0.8rem; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }

nav.toc { margin: 2rem 0; }
nav.toc ul { list-style: none; margin: 0; padding-left: 1rem; }
nav.toc > ul { padding-left: 0; }
nav.toc li { margin: 0.15rem 0; }
nav.toc a { text-decoration: none; }
nav.toc a:hover { text-decoration: underline; }
.toc-group > a { font-weight: 600; }
.toc-doc > a { font-weight: 500; }
.toc-requirement > a, .toc-scenario > a { color: var(--fg-muted); font-size: 0.92rem; }

.badge {
  display: inline-block;
  margin-right: 0.5rem;
  padding: 0.08em 0.5em;
  border-radius: 999px;
  border: 1px solid currentColor;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  vertical-align: middle;
}
.badge-added { color: var(--added); }
.badge-modified { color: var(--modified); }
.badge-removed { color: var(--removed); }
.badge-renamed { color: var(--renamed); }
.badge-kind, .badge-archived { color: var(--fg-muted); }
.badge-question { color: var(--accent); }
.badge-change { color: var(--modified); }
.badge-resolve { color: var(--added); }

/* Provenance: grounded = has receipts, inferred = a claim, unstated = a gap. */
.badge-grounded { color: var(--added); }
.badge-inferred { color: var(--accent); }
.badge-unstated { color: var(--removed); }
.badge-stale { color: var(--modified); }
.badge-understood { color: var(--accent); }
.badge-approved { color: var(--added); }
.badge-concern { color: var(--modified); }
.badge-blocking { color: var(--removed); }

.review-tally { margin: 1rem 0 0; color: var(--fg-muted); font-size: 0.9rem; font-variant-numeric: tabular-nums; }

.overview .overview-item { margin: 1rem 0; }
.overview-lead { margin: 0 0 0.25rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; }
.overview-lead a { color: var(--fg-muted); text-decoration: none; }

/* The plain-language companion beside a requirement/scenario. */
.explanation { margin: 0.75rem 0; padding: 0.6rem 0.85rem; background: var(--bg-soft); border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; }
.explanation.is-stale { border-left-color: var(--modified); }
.explanation-meta { margin: 0 0 0.4rem; }
.explanation .prose > :first-child { margin-top: 0; }

.decision { margin: 1.25rem 0; padding: 0.85rem 1rem; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; }
.decision-title { margin: 0 0 0.5rem; font-size: 1.1rem; }
.decision-body { margin: 0; display: grid; gap: 0.5rem; }
.decision-field { margin: 0; }
.decision-field dt { font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); }
.decision-field dd { margin: 0.1rem 0 0; }
.options { margin: 0.1rem 0 0; padding-left: 1.25rem; }

.sources { list-style: none; margin: 0.5rem 0 0; padding: 0; font-size: 0.85rem; }
.source { margin: 0.2rem 0; display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline; }
.src-kind { font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); }
.src-quote { color: var(--fg-muted); font-style: italic; }

.oq-list { list-style: none; margin: 0; padding: 0; }
.oq { margin: 0.6rem 0; padding: 0.5rem 0.75rem; background: var(--bg-soft); border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; }
.oq-blocking { border-left-color: var(--removed); }
.oq-concern { border-left-color: var(--modified); }
.oq-unstated, .oq-term { border-left-color: var(--accent); }
.oq .prose { margin-top: 0.3rem; }

.change { margin: 1.25rem 0; }
.change-title { font-size: 1.1rem; }
.change-summary { color: var(--fg-muted); margin: 0.25rem 0; }
.change-side { margin: 0.5rem 0; }
.change-side h4 { margin: 0 0 0.2rem; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fg-muted); }
.change-quote { margin: 0; padding: 0.5rem 0.75rem; background: var(--bg-code); border-left: 3px solid var(--border); border-radius: 4px; white-space: pre-wrap; }

.glossary-list { margin: 0; }
.glossary-term { margin: 0.9rem 0; }
.glossary-term dt { font-weight: 600; }
.glossary-term dd { margin: 0.2rem 0 0; }

.doc-meta, .group-meta { margin: 0 0 1rem; color: var(--fg-muted); font-size: 0.9rem; }
.requirement { margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid var(--border); }
.scenario { margin: 1rem 0; }
.scenario-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; }
@media (min-width: 60rem) {
  .scenario-body { grid-template-columns: minmax(0, 20rem) minmax(0, 1fr); align-items: start; }
}
.steps { list-style: none; margin: 0; padding: 0; }
.step { display: flex; gap: 0.5rem; padding: 0.2rem 0; font-size: 0.92rem; }
.kw { flex: 0 0 3.4rem; font-weight: 700; font-size: 0.75rem; letter-spacing: 0.04em; padding-top: 0.15em; }
.kw-given { color: var(--fg-muted); }
.kw-when { color: var(--accent); }
.kw-then { color: var(--added); }
.kw-and, .kw-but { color: var(--modified); }
.actor { font-weight: 600; margin-right: 0.35rem; }

figure.diagram { margin: 1rem 0; padding: 0.75rem; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; }
figure.diagram figcaption { margin-bottom: 0.5rem; font-size: 0.8rem; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }

/* The agent-authored diagrams: accent-flagged, title left readable (not uppercased). */
figure.diagram.diagram-authored { border-left: 3px solid var(--accent); }
figure.diagram.diagram-authored.is-stale { border-left-color: var(--modified); }
.diagram-authored figcaption { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: baseline; text-transform: none; letter-spacing: normal; }
.diagram-authored .diagram-title { font-weight: 600; color: var(--fg); }
.badge-diagram-type { color: var(--accent); }
.diagram-trigger { margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--fg-muted); }
pre.mermaid { background: none; padding: 0; margin: 0; overflow-x: auto; text-align: center; white-space: pre; }
pre.mermaid svg { max-width: 100%; height: auto; }

.prose[data-md] { white-space: pre-wrap; }
.prose[data-md].rendered { white-space: normal; }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }

.appendix { margin-top: 3rem; }
.note-group { margin: 1.5rem 0; }
.note-anchor { font-size: 1rem; }
.note { margin: 0.75rem 0; padding: 0.75rem 1rem; background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; }
.note-meta { margin: 0 0 0.5rem; font-size: 0.82rem; color: var(--fg-muted); }
.note-author, .reply-author { font-weight: 600; margin-right: 0.5rem; }
.note-meta time, .reply time { font-variant-numeric: tabular-nums; }
.replies { list-style: none; margin: 0.75rem 0 0; padding-left: 1rem; border-left: 2px solid var(--border); }
.reply { margin: 0.5rem 0; font-size: 0.92rem; }
.count { font-size: 0.8rem; color: var(--fg-muted); }
.warnings { margin: 1rem 0; padding: 0.75rem 1rem; border: 1px solid var(--modified); border-radius: 8px; }
.warnings summary { cursor: pointer; color: var(--modified); font-weight: 600; }

@media print {
  header.chrome, .toplink { display: none !important; }
  body { background: #fff; color: #000; font-size: 11pt; }
  .page { max-width: none; padding: 0; }
  a { color: #000; text-decoration: none; }
  .prose a[href^="http"]::after { content: ' (' attr(href) ')'; font-size: 0.85em; color: #444; word-break: break-all; }
  .group { break-before: page; page-break-before: always; }
  .group:first-of-type { break-before: auto; page-break-before: auto; }
  figure.diagram, .scenario, .requirement, .note, .stats li, pre,
  .decision, .change, .explanation, .oq, .glossary-term { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, h4, h5 { break-after: avoid; page-break-after: avoid; }
  nav.toc { break-after: page; page-break-after: always; }
}
`;

/**
 * Client-side upgrade pass: render Markdown prose and Mermaid sources that were
 * emitted as inert escaped text. Written with `String.raw` so the regexes keep
 * their backslashes.
 */
const BOOTSTRAP = String.raw`
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Spec prose is untrusted: only same-document, web and mail targets survive.
  function safeHref(href) {
    var h = String(href == null ? '' : href).trim();
    return /^(https?:\/\/|mailto:|#|\/|\.{1,2}\/)/i.test(h) ? h : '#';
  }

  function renderProse() {
    var nodes = document.querySelectorAll('.prose[data-md]');
    if (!window.marked || typeof marked.parse !== 'function') return;
    var options = { gfm: true, breaks: false };
    if (typeof marked.Renderer === 'function') {
      var r = new marked.Renderer();
      // Raw HTML in a spec is shown, never executed.
      r.html = function (token) {
        return esc(typeof token === 'string' ? token : token && token.text);
      };
      r.link = function (token) {
        var href = esc(safeHref(token && token.href));
        var body = this.parser ? this.parser.parseInline(token.tokens || []) : esc(token && token.text);
        return '<a href="' + href + '" rel="nofollow noopener noreferrer">' + body + '</a>';
      };
      // tradeoff: a one-file doc can never load an external image, so images
      // degrade to their alt text. Upgrade path is inlining them as data URIs.
      r.image = function (token) {
        return '<span class="img-alt">' + esc((token && (token.text || token.href)) || 'image') + '</span>';
      };
      options.renderer = r;
    }
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      try {
        el.innerHTML = marked.parse(el.textContent || '', options);
        el.classList.add('rendered');
      } catch (err) {
        /* leave the raw Markdown in place */
      }
    }
  }

  function renderDiagrams() {
    if (!window.mermaid || typeof mermaid.initialize !== 'function') return;
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    });
    try {
      var run = mermaid.run({ querySelector: 'pre.mermaid' });
      if (run && typeof run.catch === 'function') run.catch(function () {});
    } catch (err) {
      /* a malformed diagram must not take the document down */
    }
  }

  function boot() {
    renderProse();
    renderDiagrams();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
`;

/* -------------------------------------------------------------------------- */
/* document assembly                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the complete self-contained document.
 *
 * tradeoff: reads the wall clock once, for the "generated" line on the cover,
 * because the agreed signature has nowhere to inject a timestamp. Every other
 * byte is a function of the arguments. Upgrade path is an options bag carrying
 * `now` if a test ever needs to pin it.
 */
export function renderTechDoc(
  model: SpecModel,
  diagrams: Diagram[],
  notes: Note[],
  vendor: { mermaid: string; marked: string },
  review: ReviewFile = EMPTY_REVIEW,
  changes: ChangeEntry[] = []
): string {
  const project = basename(model.root) || 'spec-scope';
  const counts = countModel(model);
  const index = indexDiagrams(diagrams);
  const docsById = new Map(model.docs.map((doc) => [doc.id, doc]));

  // review.json is untrusted: guard the whole object and every array so a
  // hand-edited file with a missing field renders a degraded section, not a throw.
  const safeReview = review && typeof review === 'object' ? review : EMPTY_REVIEW;
  const decisions = Array.isArray(safeReview.decisions) ? safeReview.decisions : [];
  const stamps = Array.isArray(safeReview.stamps) ? safeReview.stamps : [];
  const explanations = Array.isArray(safeReview.explanations) ? safeReview.explanations : [];
  const glossary = Array.isArray(safeReview.glossary) ? safeReview.glossary : [];
  // Authored diagrams and "no diagram" skips ride in on the same review object;
  // skips need no rendering (they simply mean this doc gets no authored block).
  const authoredDiagrams = Array.isArray(safeReview.diagrams) ? safeReview.diagrams : [];
  const changeList = Array.isArray(changes) ? changes : [];

  // Explanations keyed by anchor + kind for O(1) inline lookup; first write wins.
  const explanationsByKey = new Map<string, Explanation>();
  for (const explanation of explanations) {
    if (explanation === null || typeof explanation !== 'object') continue;
    const kind = explanation.kind;
    if (kind !== 'summary' && kind !== 'narration' && kind !== 'glossary-def') continue;
    const key = explanationKey(str(explanation.anchor), kind);
    if (!explanationsByKey.has(key)) explanationsByKey.set(key, explanation);
  }

  // Authored diagrams keyed by the anchor (doc/group id) they hang off.
  const authoredByAnchor = new Map<string, AuthoredDiagram[]>();
  for (const diagram of authoredDiagrams) {
    if (diagram === null || typeof diagram !== 'object') continue;
    const anchor = str(diagram.anchor).trim();
    if (!anchor) continue;
    const bucket = authoredByAnchor.get(anchor);
    if (bucket) bucket.push(diagram);
    else authoredByAnchor.set(anchor, [diagram]);
  }

  const ctx: RenderCtx = {
    index,
    explanations: explanationsByKey,
    authored: authoredByAnchor,
    stamps,
    useHeatMap: stamps.length > 0,
  };

  const docsForGroup = (group: SpecGroup): SpecDoc[] => {
    const out: SpecDoc[] = [];
    for (const id of group.docIds) {
      const doc = docsById.get(id);
      if (doc) out.push(doc);
    }
    return out;
  };

  const claimed = new Set<string>();
  for (const group of model.groups) {
    for (const id of group.docIds) if (docsById.has(id)) claimed.add(id);
  }
  const orphans = model.docs.filter((doc) => !claimed.has(doc.id));

  // Review-layer sections, each self-omitting when empty so nothing hollow ships.
  const overviewSection = renderOverview(explanations);
  const ledgerSection = renderDecisionLedger(decisions);
  const openQuestionsSection = renderOpenQuestions(explanations, glossary, stamps);
  const changesSection = renderChangesAppendix(changeList);
  const glossarySection = renderGlossaryAppendix(glossary);
  const notesAppendix = renderNotesAppendix(notes);

  const tocItems: string[] = [];
  const bodyItems: string[] = [];

  // Front matter, in document order, each entry emitted only alongside its section.
  if (overviewSection) tocItems.push('<li class="toc-group"><a href="#overview">Overview</a></li>');
  if (ledgerSection) {
    tocItems.push('<li class="toc-group"><a href="#decision-ledger">Decision ledger</a></li>');
  }
  if (openQuestionsSection) {
    tocItems.push('<li class="toc-group"><a href="#open-questions">Open questions</a></li>');
  }

  for (const group of model.groups) {
    const docs = docsForGroup(group);
    tocItems.push(tocEntry(group.id, group.name, 'toc-group', tocForDocs(docs)));
    bodyItems.push(renderGroup(group, docs, ctx));
  }
  if (orphans.length > 0) {
    // Docs no group claimed still have to be reachable from the contents.
    tocItems.push(
      `<li class="toc-group"><a href="#ungrouped">Ungrouped documents</a>${tocForDocs(
        orphans
      )}</li>`
    );
    bodyItems.push(
      [
        '<section class="group" id="ungrouped">',
        '<h2 class="group-title">Ungrouped documents</h2>',
        ...orphans.map((doc) => renderDoc(doc, ctx)),
        '</section>',
      ].join('\n')
    );
  }

  // Appendices, again only linked when present.
  if (changesSection)
    tocItems.push('<li class="toc-group"><a href="#appendix-changes">Changes</a></li>');
  if (glossarySection) {
    tocItems.push('<li class="toc-group"><a href="#appendix-glossary">Glossary</a></li>');
  }
  if (notesAppendix) {
    tocItems.push('<li class="toc-group"><a href="#appendix-notes">Open discussion notes</a></li>');
  }

  const recordedDecisions = decisions.filter((d) => d != null && d.status === 'recorded').length;
  const openQuestionCount =
    explanations.filter((e) => e != null && coerceProvenance(e.provenance) === 'unstated').length +
    glossary.filter((g) => g != null && g.defined === false).length +
    stamps.filter((s) => s != null && (s.verdict === 'blocking' || s.verdict === 'concern')).length;
  const reviewTally = `<p class="review-tally">${openQuestionCount} open question${
    openQuestionCount === 1 ? '' : 's'
  } · ${recordedDecisions} recorded decision${recordedDecisions === 1 ? '' : 's'}</p>`;

  const warnings =
    model.warnings.length > 0
      ? [
          '<details class="warnings">',
          `<summary>${model.warnings.length} parser warning${
            model.warnings.length === 1 ? '' : 's'
          }</summary>`,
          '<ul>',
          ...model.warnings.map((w) => `<li>${escapeHtml(w)}</li>`),
          '</ul>',
          '</details>',
        ].join('\n')
      : '';

  const stat = (n: string | number, k: string): string =>
    `<li><span class="n">${escapeHtml(String(n))}</span><span class="k">${escapeHtml(k)}</span></li>`;

  const title = `${project} — spec tech doc`;

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="spec-scope">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body id="top">',
    '<header class="chrome">',
    `<strong>${escapeHtml(project)}</strong>`,
    `<span>${escapeHtml(model.flavor)}</span>`,
    '<a href="#toc">Contents</a>',
    '</header>',
    '<div class="page">',
    '<section class="cover">',
    `<h1>${escapeHtml(project)}</h1>`,
    `<p class="subtitle">Spec review pack · ${escapeHtml(
      model.flavor
    )} · generated ${escapeHtml(new Date().toISOString())}</p>`,
    '<ul class="stats">',
    stat(counts.groups, 'groups'),
    stat(counts.docs, 'documents'),
    stat(counts.requirements, 'requirements'),
    stat(counts.scenarios, 'scenarios'),
    stat(`${counts.tasksDone}/${counts.tasksTotal}`, 'tasks done'),
    '</ul>',
    reviewTally,
    warnings,
    '</section>',
    '<nav class="toc" id="toc">',
    '<h2>Contents</h2>',
    tocItems.length > 0 ? `<ul>\n${tocItems.join('\n')}\n</ul>` : '<p>No specifications found.</p>',
    '</nav>',
    overviewSection,
    ledgerSection,
    openQuestionsSection,
    ...bodyItems,
    changesSection,
    glossarySection,
    notesAppendix,
    '<p class="toplink"><a href="#top">Back to top</a></p>',
    '</div>',
    `<script>${inlineScriptSource(vendor.mermaid)}</script>`,
    `<script>${inlineScriptSource(vendor.marked)}</script>`,
    `<script>${BOOTSTRAP}</script>`,
    '</body>',
    '</html>',
  ]
    .filter((part) => part !== '')
    .join('\n');

  return `${html}\n`;
}

/* -------------------------------------------------------------------------- */
/* filesystem entry point                                                      */
/* -------------------------------------------------------------------------- */

/** Parse, diagram, collect notes and write the tech doc. Returns the path written. */
export async function exportTechDoc(opts: ExportOptions): Promise<string> {
  const root = resolve(opts.root);
  const model = await parseProject(root);
  const diagrams = generateDiagrams(model);

  let notes: Note[] = [];
  if (opts.includeNotes !== false) {
    const store = new NoteStore(model.root);
    try {
      notes = await store.list({ status: 'open' });
    } finally {
      store.close();
    }
  }

  // The review sidecar loads leniently: a missing file is an empty review, a
  // corrupt one is quarantined, so an export never fails on the review layer.
  const reviewStore = new ReviewStore(model.root);
  let review: ReviewFile;
  try {
    review = await reviewStore.load();
  } finally {
    reviewStore.close();
  }
  const changes = changeEntries(model);

  const [mermaid, marked] = await Promise.all([readVendor('mermaid'), readVendor('marked')]);
  const html = renderTechDoc(model, diagrams, notes, { mermaid, marked }, review, changes);

  const project = basename(model.root) || 'spec-scope';
  const target = opts.out
    ? isAbsolute(opts.out)
      ? opts.out
      : resolve(process.cwd(), opts.out)
    : resolve(model.root, `${project}.techdoc.html`);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html, 'utf8');
  return target;
}
