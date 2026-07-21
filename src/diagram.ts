/**
 * Diagram generation — the part of spec-scope that turns prose nobody reads into
 * pictures people argue about.
 *
 * Every function here is pure: model in, Mermaid source out. No fs, no clock, no
 * network. That keeps the whole feature testable with hand-built objects and lets
 * the server regenerate diagrams on every file change without caching worries.
 */

import type {
  AuthoredDiagramType,
  BlastGraph,
  BlastNode,
  DeltaKind,
  Diagram,
  DocKind,
  Requirement,
  ReviewStamp,
  ReviewVerdict,
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
 *  4. `<` `>` `&` are entity-encoded last (after `#`, so they are not double-
 *     escaped). With Mermaid's default htmlLabels, an unescaped `<img …>` in a
 *     requirement name would render as a real element in the page's DOM; encoded,
 *     Mermaid decodes each back to a literal character and inserts it as text.
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
    .replace(/\}/g, '#125;')
    .replace(/</g, '#60;')
    .replace(/>/g, '#62;')
    .replace(/&/g, '#38;');
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

/** A node's review state: a stamped verdict, or `unreviewed` when nothing touched it. */
type HeatState = ReviewVerdict | 'unreviewed';

/** Worst-wins ordering. blocking beats concern beats approved beats understood beats none. */
const HEAT_SEVERITY: Record<HeatState, number> = {
  unreviewed: 0,
  understood: 1,
  approved: 2,
  concern: 3,
  blocking: 4,
};

/** Emitted classDef order, worst first, so a reader scanning styles sees severity descend. */
const HEAT_STATES = ['blocking', 'concern', 'approved', 'understood', 'unreviewed'] as const;

/**
 * Colour is never the only signal (colour-blind readers, greyscale print): every
 * tinted label also carries a leading marker glyph. `unreviewed` gets none.
 */
const HEAT_MARKER: Record<HeatState, string> = {
  blocking: '! ',
  concern: '? ',
  approved: `${CHECK} `,
  understood: `${MIDDOT} `,
  unreviewed: '',
};

/** Palette echoes the delta/task styles so the two maps read as one family. */
const HEAT_STYLE: Record<HeatState, string> = {
  blocking: 'fill:#fce8e6,stroke:#d93025,color:#5c1611,stroke-dasharray: 4 3',
  concern: 'fill:#fef7e0,stroke:#f9ab00,color:#4d3800',
  approved: 'fill:#e6f4ea,stroke:#1e8e3e,color:#0b3d1c',
  understood: 'fill:#e8f0fe,stroke:#1a73e8,color:#0d3c78',
  unreviewed: 'fill:#f1f3f4,stroke:#9aa0a6,color:#202124',
};

/** The more severe of two states, so a requirement can roll up its scenarios. */
function worseState(a: HeatState, b: HeatState): HeatState {
  return HEAT_SEVERITY[a] >= HEAT_SEVERITY[b] ? a : b;
}

/**
 * The same doc → requirements → scenarios tree as `requirementMap`, but each node is
 * tinted by the WORST verdict stamped on it. A requirement rolls up the worst of its
 * own stamps and every scenario's; a scenario reflects only its own. Shares the
 * `requirement-map` kind (the union is fixed) but anchors on `${doc.id}#heat` so its
 * generated id can never collide with the plain map's.
 */
export function requirementHeatMap(doc: SpecDoc, stamps: ReviewStamp[]): Diagram | null {
  if (doc.requirements.length === 0) return null;

  // Worst verdict seen per anchor id. Absent id -> unreviewed at lookup time.
  const worstByAnchor = new Map<string, ReviewVerdict>();
  for (const stamp of stamps) {
    const current = worstByAnchor.get(stamp.anchor);
    if (!current || HEAT_SEVERITY[stamp.verdict] > HEAT_SEVERITY[current]) {
      worstByAnchor.set(stamp.anchor, stamp.verdict);
    }
  }
  const stateOf = (anchor: string): HeatState => worstByAnchor.get(anchor) ?? 'unreviewed';

  const title = `${doc.title} requirements — review heat map`;
  const lines: string[] = [`%% ${escapeMermaid(title)}`, 'flowchart LR'];
  const used = new Set<HeatState>();
  let ordinal = 0;

  const docNode = mermaidNodeId('D', ordinal++);
  lines.push(`  ${docNode}[["${escapeMermaid(doc.title)}"]]`);

  for (const req of doc.requirements) {
    const reqNode = mermaidNodeId('R', ordinal++);
    const scnStates = req.scenarios.map((scn) => stateOf(scn.id));
    const reqState = [stateOf(req.id), ...scnStates].reduce(worseState, 'unreviewed' as HeatState);
    used.add(reqState);
    lines.push(`  ${reqNode}["${HEAT_MARKER[reqState]}${escapeMermaid(req.name)}"]:::${reqState}`);
    lines.push(`  ${docNode} --> ${reqNode}`);

    req.scenarios.forEach((scn, i) => {
      const scnNode = mermaidNodeId('S', ordinal++);
      const scnState = scnStates[i] ?? 'unreviewed';
      used.add(scnState);
      lines.push(
        `  ${scnNode}("${HEAT_MARKER[scnState]}${escapeMermaid(scn.name)}"):::${scnState}`
      );
      lines.push(`  ${reqNode} --> ${scnNode}`);
    });
  }

  for (const state of HEAT_STATES) {
    if (used.has(state)) lines.push(`  classDef ${state} ${HEAT_STYLE[state]}`);
  }

  return makeDiagram(`${doc.id}#heat`, 'requirement-map', title, lines);
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
      for (const scenario of req.scenarios) {
        // tradeoff: a per-scenario sequence is derived noise unless the scenario has
        // real back-and-forth, so we gate on a <2-message-arrow floor. A step renders
        // as an ->>/-->> message only when its mode is request/response (WHEN/THEN, or
        // an AND/BUT inheriting one); a GIVEN — or an AND after a GIVEN — is a Note and
        // does not count. A GIVEN-only scenario or a single lone WHEN thus draws no
        // chart. We gate inclusion here only; scenarioSequence's output is unchanged.
        if (sequenceMessageCount(scenario) < 2) continue;
        out.push(scenarioSequence(scenario, req));
      }
    }
  }

  return dedupeIds(out);
}

/**
 * How many message arrows a scenario would render: every step whose computed mode is
 * a request or a response. GIVEN (and an AND/BUT inheriting the note direction) is a
 * `Note over`, not a message, so it never counts — which is exactly the <2-arrow
 * gate `generateDiagrams` uses to suppress a diagram not worth drawing.
 */
function sequenceMessageCount(scenario: Scenario): number {
  return stepModes(scenario.steps).filter((mode) => mode !== 'note').length;
}

/** Thick blue border marks the node the blast radius radiates from. */
const BLAST_ROOT_STYLE = 'fill:#e8f0fe,stroke:#1a73e8,stroke-width:3px,color:#0d3c78';

/**
 * Mermaid delimiters per node type: `[open, close]` wrapped around the escaped label.
 * requirement = rectangle, scenario = rounded, task = stadium. `constitution`/`doc`
 * are the "as-is" pair the contract leaves unspecified; we read that as "no bespoke
 * request-shape" and give them a hexagon (a governing clause) and a subroutine box
 * (matching `requirementMap`'s doc node) so every type still reads distinctly.
 */
// tradeoff: the doc/constitution shapes are our interpretation of "as-is", not a
// spec'd requirement. Upgrade path: pin them if the UI legend ever depends on shape.
const BLAST_SHAPE: Record<BlastNode['type'], readonly [string, string]> = {
  requirement: ['["', '"]'],
  scenario: ['("', '")'],
  task: ['(["', '"])'],
  doc: ['[["', '"]]'],
  constitution: ['{{"', '"}}'],
};

/**
 * A BlastGraph as a left-to-right flowchart: the root emphasised, structural edges
 * solid (`-->`), inferred (shared-term) edges dashed (`-.->`), node shape by type.
 * Node ids are generated ordinals — user text is never a Mermaid id. A root-only
 * (or even node-less) graph still renders a valid single-node flowchart.
 */
export function blastDiagram(graph: BlastGraph): Diagram {
  const rootLabel = graph.nodes.find((node) => node.id === graph.root)?.label;
  const title = rootLabel ? `Blast radius — ${rootLabel}` : 'Blast radius';
  const lines: string[] = [`%% ${escapeMermaid(title)}`, 'flowchart LR'];

  // Generated id per node position; first occurrence wins the edge lookup so a
  // duplicated model id can never make an edge point at the wrong declaration.
  const nodeIds: string[] = [];
  const idByNode = new Map<string, string>();
  graph.nodes.forEach((node, i) => {
    const id = mermaidNodeId('B', i);
    nodeIds.push(id);
    if (!idByNode.has(node.id)) idByNode.set(node.id, id);
  });

  // A node-less graph still has to be a syntactically valid flowchart.
  if (graph.nodes.length === 0) {
    lines.push('  B0["(empty)"]');
    return makeDiagram(`${graph.root}#blast`, 'overview', title, lines);
  }

  let usedRoot = false;
  graph.nodes.forEach((node, i) => {
    const nodeId = nodeIds[i] ?? mermaidNodeId('B', i);
    const [open, close] = BLAST_SHAPE[node.type];
    const isRoot = node.id === graph.root;
    if (isRoot) usedRoot = true;
    lines.push(`  ${nodeId}${open}${escapeMermaid(node.label)}${close}${isRoot ? ':::root' : ''}`);
  });

  for (const edge of graph.edges) {
    const from = idByNode.get(edge.from);
    const to = idByNode.get(edge.to);
    // tradeoff: an edge naming an undeclared node is dropped rather than letting
    // Mermaid invent a stray node. Upgrade path: surface it as a model warning.
    if (!from || !to) continue;
    lines.push(`  ${from} ${edge.kind === 'inferred' ? '-.->' : '-->'} ${to}`);
  }

  if (usedRoot) lines.push(`  classDef root ${BLAST_ROOT_STYLE}`);

  return makeDiagram(`${graph.root}#blast`, 'overview', title, lines);
}

/* -------------------------------------------------------------------------- */
/* Authored-diagram validation                                                */
/*                                                                             */
/* The in-loop agent authors the high-value diagrams (state/er/sequence/…);   */
/* spec-scope validates them before storing so a malformed or trivial one is  */
/* caught with an actionable message instead of a blank render. Pure and      */
/* synchronous — it renders nothing and never throws.                         */
/* -------------------------------------------------------------------------- */

/** Verdict on an agent-authored Mermaid diagram. */
export type DiagramValidation = { ok: true } | { ok: false; error: string };

/** Below this many distinct nodes a diagram is not worth drawing over prose. */
const MIN_DIAGRAM_NODES = 3;
/** Above this many distinct nodes a diagram stops rendering legibly. */
const MAX_DIAGRAM_NODES = 24;

/** The header Mermaid requires for each authored type. */
const AUTHORED_HEADER: Record<AuthoredDiagramType, RegExp> = {
  sequence: /^sequenceDiagram\b/,
  state: /^stateDiagram(-v2)?\b/,
  er: /^erDiagram\b/,
  flowchart: /^(flowchart|graph)\b/,
  class: /^classDiagram\b/,
};

/** How the expected header reads in an error message. */
const AUTHORED_HEADER_LABEL: Record<AuthoredDiagramType, string> = {
  sequence: 'sequenceDiagram',
  state: 'stateDiagram-v2 (or stateDiagram)',
  er: 'erDiagram',
  flowchart: 'flowchart <dir> (or graph <dir>)',
  class: 'classDiagram',
};

/** Trimmed, non-blank, non-`%%`-comment lines — the meaningful body of the source. */
function meaningfulLines(mermaid: string): string[] {
  return mermaid
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('%%'));
}

/** Sequence-arrow forms, longest first so alternation is greedy the right way. */
const SEQUENCE_ARROW = /^(\w+)\s*(?:-->>|->>|--x|-x|--\)|-\)|-->|->)\s*(\w+)/;

/**
 * Distinct `participant`/`actor` aliases; when none are declared, the distinct
 * endpoints of message arrows. Aliases (not human labels) are what Mermaid draws.
 */
function countSequenceNodes(body: string[]): number {
  const ids = new Set<string>();
  for (const line of body) {
    const decl = /^(?:participant|actor)\s+([^\s:]+)/.exec(line);
    if (decl && decl[1]) ids.add(decl[1]);
  }
  if (ids.size > 0) return ids.size;
  for (const line of body) {
    const arrow = SEQUENCE_ARROW.exec(line);
    if (arrow && arrow[1] && arrow[2]) {
      ids.add(arrow[1]);
      ids.add(arrow[2]);
    }
  }
  return ids.size;
}

/** Distinct state tokens on either side of a `-->`, ignoring the `[*]` pseudo-state. */
function countStateNodes(body: string[]): number {
  const ids = new Set<string>();
  for (const line of body) {
    const at = line.indexOf('-->');
    if (at < 0) continue;
    const left = line.slice(0, at).trim().split(/\s+/).pop();
    const rightToken = line
      .slice(at + 3)
      .trim()
      .split(':')[0];
    const right = rightToken ? rightToken.trim().split(/\s+/)[0] : undefined;
    for (const token of [left, right]) {
      if (token && token !== '[*]') ids.add(token);
    }
  }
  return ids.size;
}

/**
 * Entity names: a `NAME {` attribute block, plus both endpoints of a relationship
 * line (`NAME ||--o{ NAME : label`) — whose cardinality glyph always contains `--`.
 */
function countErNodes(body: string[]): number {
  const ids = new Set<string>();
  for (const line of body) {
    const block = /^(\w+)\s*\{/.exec(line);
    if (block && block[1]) ids.add(block[1]);
    const rel = /^(\w+)\s+\S*--\S*\s+(\w+)/.exec(line);
    if (rel && rel[1] && rel[2]) {
      ids.add(rel[1]);
      ids.add(rel[2]);
    }
  }
  return ids.size;
}

/** Keywords that are syntax, never node ids, in flowchart/class diagrams. */
const NODE_KEYWORDS = new Set([
  'flowchart',
  'graph',
  'subgraph',
  'end',
  'classDef',
  'class',
  'style',
  'linkStyle',
  'direction',
  'click',
  'namespace',
  'note',
  'cssClass',
  'callback',
  'link',
  'LR',
  'TD',
  'TB',
  'RL',
  'BT',
]);

/** Remove quoted strings, `|edge labels|`, and bracket/paren/brace shape bodies. */
function stripLabels(line: string): string {
  let out = line.replace(/"[^"]*"/g, ' ').replace(/\|[^|]*\|/g, ' ');
  let previous = '';
  while (out !== previous) {
    previous = out;
    out = out
      .replace(/\[[^[\]]*\]/g, ' ')
      .replace(/\([^()]*\)/g, ' ')
      .replace(/\{[^{}]*\}/g, ' ');
  }
  return out;
}

/** Bare identifier tokens left once labels and all punctuation are stripped. */
function tokenIds(line: string): string[] {
  return stripLabels(line)
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => /^[A-Za-z_]\w*$/.test(token) && !NODE_KEYWORDS.has(token));
}

/**
 * Distinct flowchart node ids: the id before a shape opener and the bare ids on
 * either side of an edge. Labels are stripped first so a word inside `["…"]` is
 * never mistaken for an id; a trailing `:::styleClass` is dropped before counting.
 */
function countFlowchartNodes(body: string[]): number {
  const ids = new Set<string>();
  for (const line of body) {
    const beforeStyle = line.split(':::')[0] ?? line;
    for (const id of tokenIds(beforeStyle)) ids.add(id);
  }
  return ids.size;
}

/**
 * Distinct class ids: the subject id starting a line (a declaration, a `Name : member`
 * definition, or a relationship's left side) and the id after a relation operator on
 * the right. `{ … }` member blocks are skipped so member names never count as classes.
 */
function countClassNodes(body: string[]): number {
  const ids = new Set<string>();
  let depth = 0;
  for (const line of body) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (depth > 0) {
      depth += opens - closes;
      continue;
    }
    const beforeMembers = line.split(':')[0] ?? line;
    for (const id of tokenIds(beforeMembers)) ids.add(id);
    depth += opens - closes;
  }
  return ids.size;
}

/**
 * Distinct-node count per type — a deliberately loose heuristic used only to gate
 * the floor and ceiling, never to render. It leans toward over-counting so a real
 * diagram is not failed at the floor; the 24-node ceiling is generous enough that a
 * small over-count near it is harmless. See each `count*Nodes` for the per-type rule.
 */
function countAuthoredNodes(type: AuthoredDiagramType, body: string[]): number {
  switch (type) {
    case 'sequence':
      return countSequenceNodes(body);
    case 'state':
      return countStateNodes(body);
    case 'er':
      return countErNodes(body);
    case 'flowchart':
      return countFlowchartNodes(body);
    case 'class':
      return countClassNodes(body);
  }
}

/**
 * Validate an agent-authored Mermaid diagram before it is stored. Rejects, with an
 * actionable message, a source that is empty, carries the wrong header for its type,
 * is too trivial to earn a diagram (< {@link MIN_DIAGRAM_NODES} nodes), or is too
 * dense to read (> {@link MAX_DIAGRAM_NODES} nodes). Never throws.
 */
export function validateAuthoredMermaid(
  mermaid: string,
  type: AuthoredDiagramType
): DiagramValidation {
  const lines = meaningfulLines(mermaid);
  const header = lines[0];
  if (header === undefined) {
    return {
      ok: false,
      error: `Diagram is empty. Provide Mermaid source beginning with "${AUTHORED_HEADER_LABEL[type]}".`,
    };
  }
  if (!AUTHORED_HEADER[type].test(header)) {
    return {
      ok: false,
      error: `Expected a ${type} diagram to begin with "${AUTHORED_HEADER_LABEL[type]}", but the first line is "${header}". Fix the header, or change the diagram type to match its body.`,
    };
  }

  const count = countAuthoredNodes(type, lines.slice(1));
  if (count < MIN_DIAGRAM_NODES) {
    return {
      ok: false,
      error: `This ${type} diagram has only ${count} distinct node${count === 1 ? '' : 's'}; a diagram earns its place at ${MIN_DIAGRAM_NODES}+. Say this in prose or a table, or record a diagramSkip instead.`,
    };
  }
  if (count > MAX_DIAGRAM_NODES) {
    return {
      ok: false,
      error: `This ${type} diagram has ${count} distinct nodes (limit ${MAX_DIAGRAM_NODES}); it will not render legibly. Split it into focused diagrams — one per subsystem, entity, or endpoint.`,
    };
  }
  return { ok: true };
}
