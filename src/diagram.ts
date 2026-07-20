/**
 * Diagram generation — the part of spec-scope that turns prose nobody reads into
 * pictures people argue about.
 *
 * Every function here is pure: model in, Mermaid source out. No fs, no clock, no
 * network. That keeps the whole feature testable with hand-built objects and lets
 * the server regenerate diagrams on every file change without caching worries.
 */

import type {
  DeltaKind,
  Diagram,
  DocKind,
  Requirement,
  Scenario,
  SpecDoc,
  SpecFlavor,
  SpecGroup,
  SpecModel,
  Step,
  StepKeyword,
} from './types.js';
import { diagramId, mermaidNodeId } from './ids.js';

/** Labels longer than this stop being readable in a rendered node. */
const MAX_LABEL = 90;
const ELLIPSIS = '…';
const MIDDOT = '·';
const CHECK = '✓';
/** Full-width semicolon: reads as a `;` but is not Mermaid's statement separator. */
const SEMICOLON = '；';

/** Participant used when a step names no actor of its own. */
const DEFAULT_ACTOR = 'User';
/** The always-present counterparty on the right-hand side of every sequence. */
const SYSTEM_ACTOR = 'System';

/**
 * Make arbitrary spec prose safe to drop into a Mermaid label or message.
 *
 * Order is load-bearing:
 *  1. `;` is neutralised first. Mermaid's sequence lexer treats a literal `;` as a
 *     statement separator, so prose containing one splits a `participant` line in
 *     half. It cannot be escaped as an entity (`#59;` still contains a `;`), so it
 *     becomes a full-width look-alike instead. This must run before step 2, which
 *     starts emitting entities that legitimately end in `;`.
 *  2. `#` before the remaining replacements: they all emit `#…;` entities, so
 *     escaping `#` afterwards would corrupt them into `#35;quot;`.
 *  3. `%` is entity-encoded so a literal `%%` in prose cannot open a comment and
 *     swallow the rest of the line; a backtick would otherwise flip a flowchart
 *     label into Mermaid's markdown-string mode.
 *
 * Truncation runs on the raw text rather than the escaped text, so a cut can never
 * land inside an entity and leave a dangling `#qu`. The escaped result may
 * therefore exceed MAX_LABEL characters — intact syntax beats an exact budget.
 */
export function escapeMermaid(text: string): string {
  // tradeoff: blanket character substitution, not context-aware escaping. Ceiling:
  // `;` is replaced by a look-alike rather than preserved, and every `%` is encoded
  // even though only `%%` is dangerous. Upgrade path is escaping per target context
  // (quoted flowchart label vs. bare sequence message), which needs the call sites
  // to say which one they are — not worth it until a spec actually reads wrong.
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const clipped =
    collapsed.length > MAX_LABEL
      ? `${collapsed.slice(0, MAX_LABEL - 1).trimEnd()}${ELLIPSIS}`
      : collapsed;
  return clipped
    .replace(/;/g, SEMICOLON)
    .replace(/#/g, '#35;')
    .replace(/%/g, '#37;')
    .replace(/`/g, '#96;')
    .replace(/"/g, '#quot;')
    .replace(/\(/g, '#40;')
    .replace(/\)/g, '#41;')
    .replace(/\[/g, '#91;')
    .replace(/\]/g, '#93;')
    .replace(/\{/g, '#123;')
    .replace(/\}/g, '#125;');
}

/** A sequence-diagram lane: generated alias plus the human name it stands for. */
interface Participant {
  alias: string;
  label: string;
}

/**
 * Direction a step renders as. `AND`/`BUT` carry the previous value forward, which
 * is how "AND after a GIVEN is another precondition" falls out for free.
 */
type StepMode = 'note' | 'request' | 'response';

function nextMode(keyword: StepKeyword, current: StepMode): StepMode {
  switch (keyword) {
    case 'GIVEN':
      return 'note';
    case 'WHEN':
      return 'request';
    case 'THEN':
      return 'response';
    case 'AND':
    case 'BUT':
      return current;
  }
}

/** Each step's rendered direction, precomputed so lane decisions can see them all. */
function stepModes(steps: Step[]): StepMode[] {
  const modes: StepMode[] = [];
  let mode: StepMode = 'request';
  for (const step of steps) {
    mode = nextMode(step.keyword, mode);
    modes.push(mode);
  }
  return modes;
}

/** The declared lanes plus the two poles every message routes between. */
interface Lanes {
  participants: Participant[];
  /** Alias that unnamed requests originate from and named responses reply to. */
  client: string;
  /** Alias that unnamed responses originate from and named requests target. */
  service: string;
}

/**
 * The actor named on a step is the *sender* of that step's action, so lanes are the
 * named actors in first-appearance order plus at most two fallbacks:
 *
 *  - `User` when a *request* step (WHEN, or an AND/BUT inheriting request) spoke
 *    anonymously, or when no actor is named anywhere.
 *  - `System` when a *response* step (THEN, or an AND/BUT inheriting response) spoke
 *    anonymously, or to guarantee at least two lanes to draw a message between. Two
 *    or more named actors with every message annotated therefore get NO System lane.
 *
 * Declaring the fallbacks up front matters: Mermaid will invent an undeclared
 * participant, but it lands at the far right and wrecks the lane ordering.
 */
function resolveLanes(steps: Step[], modes: StepMode[]): Lanes {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const name = raw.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  for (const step of steps) {
    if (step.actor) push(step.actor);
  }

  const needsUser = names.length === 0 || steps.some((s, i) => modes[i] === 'request' && !s.actor);
  if (needsUser) push(DEFAULT_ACTOR);

  // Evaluated after the User lane so `< 2` counts every non-System lane.
  const needsSystem = steps.some((s, i) => modes[i] === 'response' && !s.actor) || names.length < 2;
  if (needsSystem) push(SYSTEM_ACTOR);

  const participants = names.map((label, i) => ({ alias: mermaidNodeId('A', i), label }));
  const fallback = participants[0]?.alias ?? mermaidNodeId('A', 0);
  const client = needsUser ? aliasFor(participants, DEFAULT_ACTOR) : fallback;
  const service = needsSystem
    ? aliasFor(participants, SYSTEM_ACTOR)
    : (participants.find((p) => p.alias !== client)?.alias ?? client);

  return { participants, client, service };
}

/** Resolve a human actor name to its lane alias, falling back to the first lane. */
function aliasFor(participants: Participant[], name: string): string {
  const key = name.trim().toLowerCase();
  const found = participants.find((p) => p.label.toLowerCase() === key);
  return found?.alias ?? participants[0]?.alias ?? mermaidNodeId('A', 0);
}

function makeDiagram(
  anchor: string,
  kind: Diagram['kind'],
  title: string,
  lines: string[]
): Diagram {
  return { id: diagramId(anchor, kind), title, kind, anchor, mermaid: lines.join('\n') };
}

/**
 * One `sequenceDiagram` per scenario — the headline feature. GIVEN becomes a note
 * because a precondition is not a message; WHEN is the request, THEN the response.
 */
export function scenarioSequence(scenario: Scenario, requirement: Requirement): Diagram {
  const modes = stepModes(scenario.steps);
  const { participants, client, service } = resolveLanes(scenario.steps, modes);
  const first = participants[0]?.alias ?? mermaidNodeId('A', 0);
  const last = participants[participants.length - 1]?.alias ?? first;
  // `Note over X,X` is degenerate; collapse it to a single-lane note.
  const span = first === last ? first : `${first},${last}`;
  const title = `${requirement.name} / ${scenario.name}`;

  const lines: string[] = [`%% ${escapeMermaid(title)}`, 'sequenceDiagram', '  autonumber'];
  for (const p of participants) {
    lines.push(`  participant ${p.alias} as ${escapeMermaid(p.label)}`);
  }

  if (scenario.steps.length === 0) {
    lines.push(`  Note over ${first}: no steps defined`);
    return makeDiagram(scenario.id, 'sequence', title, lines);
  }

  // The step's named actor is the sender; the reply goes back to whoever last asked.
  let lastRequester = client;
  scenario.steps.forEach((step, i) => {
    const mode = modes[i] ?? 'request';
    // An empty message body makes the Mermaid parser unhappy; give it something.
    const text = escapeMermaid(step.text) || ELLIPSIS;
    if (step.keyword === 'BUT') lines.push('  %% but');
    if (mode === 'note') {
      lines.push(`  Note over ${span}: ${text}`);
    } else if (mode === 'request') {
      const sender = step.actor ? aliasFor(participants, step.actor) : client;
      const recipient = sender === client ? service : client;
      lines.push(`  ${sender}->>${recipient}: ${text}`);
      lastRequester = sender;
    } else {
      const sender = step.actor ? aliasFor(participants, step.actor) : service;
      const recipient =
        sender !== lastRequester ? lastRequester : sender === client ? service : client;
      lines.push(`  ${sender}-->>${recipient}: ${text}`);
    }
  });

  return makeDiagram(scenario.id, 'sequence', title, lines);
}

const DELTA_CLASSES = ['added', 'modified', 'removed', 'renamed'] as const;
type DeltaClass = (typeof DELTA_CLASSES)[number];

const DELTA_CLASS: Record<DeltaKind, DeltaClass> = {
  ADDED: 'added',
  MODIFIED: 'modified',
  REMOVED: 'removed',
  RENAMED: 'renamed',
};

const DELTA_STYLE: Record<DeltaClass, string> = {
  added: 'fill:#e6f4ea,stroke:#1e8e3e,color:#0b3d1c',
  modified: 'fill:#fef7e0,stroke:#f9ab00,color:#4d3800',
  removed: 'fill:#fce8e6,stroke:#d93025,color:#5c1611,stroke-dasharray: 4 3',
  renamed: 'fill:#e8f0fe,stroke:#1a73e8,color:#0d3c78',
};

/**
 * Doc → requirements → scenarios as a left-to-right tree. Node ids are generated
 * ordinals, never derived from spec text, so a requirement called `end` or `graph`
 * cannot collide with Mermaid's own keywords.
 */
export function requirementMap(doc: SpecDoc): Diagram | null {
  if (doc.requirements.length === 0) return null;

  const title = `${doc.title} requirements`;
  const lines: string[] = [`%% ${escapeMermaid(title)}`, 'flowchart LR'];
  const used = new Set<DeltaClass>();
  let ordinal = 0;

  const docNode = mermaidNodeId('D', ordinal++);
  lines.push(`  ${docNode}[["${escapeMermaid(doc.title)}"]]`);

  for (const req of doc.requirements) {
    const reqNode = mermaidNodeId('R', ordinal++);
    const cls = req.delta ? DELTA_CLASS[req.delta] : undefined;
    if (cls) used.add(cls);
    lines.push(`  ${reqNode}["${escapeMermaid(req.name)}"]${cls ? `:::${cls}` : ''}`);
    lines.push(`  ${docNode} --> ${reqNode}`);

    for (const scn of req.scenarios) {
      const scnNode = mermaidNodeId('S', ordinal++);
      lines.push(`  ${scnNode}("${escapeMermaid(scn.name)}")`);
      lines.push(`  ${reqNode} --> ${scnNode}`);
    }
  }

  for (const cls of DELTA_CLASSES) {
    if (used.has(cls)) lines.push(`  classDef ${cls} ${DELTA_STYLE[cls]}`);
  }

  return makeDiagram(doc.id, 'requirement-map', title, lines);
}

const TASK_STYLE: Record<'done' | 'todo', string> = {
  done: 'fill:#e6f4ea,stroke:#1e8e3e,color:#0b3d1c',
  todo: 'fill:#f1f3f4,stroke:#9aa0a6,color:#202124',
};

/**
 * Checklist nesting as a top-down flow: top-level tasks chained in document order,
 * children hanging off their parent. Sections become subgraphs when present.
 */
export function taskFlow(doc: SpecDoc): Diagram | null {
  if (doc.tasks.length === 0) return null;

  const title = `${doc.title} tasks`;
  const lines: string[] = [`%% ${escapeMermaid(title)}`, 'flowchart TD'];

  // Node ids come from the array index, so duplicate task ids cannot alias a node.
  const nodeIds: string[] = [];
  const byTaskId = new Map<string, string>();
  for (const [i, task] of doc.tasks.entries()) {
    const node = mermaidNodeId('T', i);
    nodeIds.push(node);
    if (!byTaskId.has(task.id)) byTaskId.set(task.id, node);
  }

  const declare = (index: number, indent: string): string | null => {
    const task = doc.tasks[index];
    const node = nodeIds[index];
    if (!task || !node) return null;
    const cls = task.done ? 'done' : 'todo';
    const label = escapeMermaid(`${task.done ? `${CHECK} ` : ''}${task.text}`);
    return `${indent}${node}["${label}"]:::${cls}`;
  };

  // Bucket by section, remembering first-appearance order so output is stable.
  const order: string[] = [];
  const bySection = new Map<string, number[]>();
  doc.tasks.forEach((task, i) => {
    const key = task.section ?? '';
    let bucket = bySection.get(key);
    if (!bucket) {
      bucket = [];
      bySection.set(key, bucket);
      order.push(key);
    }
    bucket.push(i);
  });
  const hasSections = order.some((key) => key !== '');

  let sgOrdinal = 0;
  for (const key of order) {
    const indices = bySection.get(key) ?? [];
    const sectioned = hasSections && key !== '';
    if (sectioned) {
      lines.push(`  subgraph ${mermaidNodeId('SG', sgOrdinal++)}["${escapeMermaid(key)}"]`);
    }
    for (const i of indices) {
      const line = declare(i, sectioned ? '    ' : '  ');
      if (line) lines.push(line);
    }
    if (sectioned) lines.push('  end');
  }

  // Edges come after every declaration so they may cross subgraph boundaries.
  let previousTop: string | undefined;
  doc.tasks.forEach((task, i) => {
    const node = nodeIds[i];
    if (!node) return;
    const parent = task.parentId ? byTaskId.get(task.parentId) : undefined;
    if (parent && parent !== node) {
      lines.push(`  ${parent} --> ${node}`);
      return;
    }
    // Unknown parentId degrades to top-level rather than dropping the task.
    if (previousTop) lines.push(`  ${previousTop} --> ${node}`);
    previousTop = node;
  });

  lines.push(`  classDef done ${TASK_STYLE.done}`);
  lines.push(`  classDef todo ${TASK_STYLE.todo}`);

  return makeDiagram(doc.id, 'task-flow', title, lines);
}

/** Reading order of a group's documents, per workflow flavor. Unlisted kinds sort last. */
const DOC_ORDER: Record<SpecFlavor, DocKind[]> = {
  openspec: ['proposal', 'design', 'spec', 'tasks'],
  speckit: ['spec', 'plan', 'tasks'],
  unknown: ['proposal', 'spec', 'plan', 'design', 'tasks'],
};

/** `3 reqs · 12 tasks`, or empty when the doc is pure prose. */
function countBadge(doc: SpecDoc): string {
  const parts: string[] = [];
  const reqs = doc.requirements.length;
  const tasks = doc.tasks.length;
  if (reqs > 0) parts.push(`${reqs} ${reqs === 1 ? 'req' : 'reqs'}`);
  if (tasks > 0) parts.push(`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`);
  return parts.join(` ${MIDDOT} `);
}

/**
 * The group's documents laid out in the order a human is meant to read them.
 * A single-document group has no workflow to show, so it gets no diagram.
 */
export function groupOverview(group: SpecGroup, model: SpecModel): Diagram | null {
  const byId = new Map(model.docs.map((d) => [d.id, d]));
  const docs = group.docIds.map((id) => byId.get(id)).filter((d): d is SpecDoc => d !== undefined);
  if (docs.length < 2) return null;

  const order = DOC_ORDER[model.flavor];
  const rank = (doc: SpecDoc): number => {
    const i = order.indexOf(doc.kind);
    return i === -1 ? order.length : i;
  };
  const ordered = docs
    .map((doc, i) => ({ doc, i }))
    .sort((a, b) => rank(a.doc) - rank(b.doc) || a.i - b.i)
    .map((entry) => entry.doc);

  const title = `${group.name} overview`;
  const lines: string[] = [`%% ${escapeMermaid(title)}`, 'flowchart LR'];

  let previous: string | undefined;
  ordered.forEach((doc, i) => {
    const node = mermaidNodeId('N', i);
    const badge = countBadge(doc);
    const label = badge ? `${escapeMermaid(doc.title)}<br/>${badge}` : escapeMermaid(doc.title);
    lines.push(`  ${node}["${label}"]`);
    if (previous) lines.push(`  ${previous} --> ${node}`);
    previous = node;
  });

  return makeDiagram(group.id, 'overview', title, lines);
}

/**
 * Ids are slug-derived and therefore collidable (`a/b.md` and `a-b.md` slug alike).
 * Suffix an ordinal so the browser can key on `Diagram.id` without duplicates.
 */
function dedupeIds(diagrams: Diagram[]): Diagram[] {
  const seen = new Set<string>();
  return diagrams.map((diagram) => {
    if (!seen.has(diagram.id)) {
      seen.add(diagram.id);
      return diagram;
    }
    let n = 2;
    while (seen.has(`${diagram.id}-${n}`)) n += 1;
    const id = `${diagram.id}-${n}`;
    seen.add(id);
    return { ...diagram, id };
  });
}

/**
 * Every diagram the model supports, ordered coarse-to-fine: group overviews, then
 * requirement maps, task flows, and finally one sequence per scenario. The UI
 * renders them in this order, so it doubles as the table of contents.
 */
export function generateDiagrams(model: SpecModel): Diagram[] {
  const out: Diagram[] = [];

  for (const group of model.groups) {
    const diagram = groupOverview(group, model);
    if (diagram) out.push(diagram);
  }
  for (const doc of model.docs) {
    const diagram = requirementMap(doc);
    if (diagram) out.push(diagram);
  }
  for (const doc of model.docs) {
    const diagram = taskFlow(doc);
    if (diagram) out.push(diagram);
  }
  for (const doc of model.docs) {
    for (const req of doc.requirements) {
      for (const scenario of req.scenarios) out.push(scenarioSequence(scenario, req));
    }
  }

  return dedupeIds(out);
}
