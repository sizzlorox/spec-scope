/**
 * Shared data model for spec-scope.
 *
 * Everything downstream — diagram generation, the browser UI, the discussion
 * store and the tech-doc exporter — reads this model and nothing else. Parsing
 * is the only place that knows about Markdown.
 */

/** Which spec-driven workflow a project uses. */
export type SpecFlavor = 'openspec' | 'speckit' | 'unknown';

/** Role a Markdown file plays inside a spec workflow. */
export type DocKind =
  'spec' | 'proposal' | 'plan' | 'tasks' | 'design' | 'research' | 'constitution' | 'other';

/** OpenSpec delta markers (`## ADDED Requirements`, …). */
export type DeltaKind = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

/** Gherkin-ish keywords recognised in scenario steps. */
export type StepKeyword = 'GIVEN' | 'WHEN' | 'THEN' | 'AND' | 'BUT';

/** A single line of a scenario. */
export interface Step {
  keyword: StepKeyword;
  /**
   * Explicit actor, when the step is written as `**WHEN** Actor: does thing`.
   * Undefined means the renderer falls back to its default participants.
   */
  actor?: string;
  text: string;
  /** 1-based line number in the source document. */
  line: number;
}

/** A concrete example attached to a requirement. */
export interface Scenario {
  id: string;
  name: string;
  steps: Step[];
  line: number;
}

/** A single requirement, optionally carrying an OpenSpec delta marker. */
export interface Requirement {
  id: string;
  name: string;
  delta?: DeltaKind;
  /** Prose between the requirement heading and its first scenario. */
  text: string;
  scenarios: Scenario[];
  line: number;
}

/** A checklist entry from a `tasks.md`. */
export interface Task {
  id: string;
  text: string;
  done: boolean;
  /** Nesting level, 0 for top-level bullets. */
  depth: number;
  /** `id` of the parent task, when nested. */
  parentId?: string;
  /** Section heading the task lives under, when present. */
  section?: string;
  line: number;
}

/** One Markdown file in the spec tree. */
export interface SpecDoc {
  id: string;
  /** POSIX-style path relative to the project root. */
  path: string;
  title: string;
  kind: DocKind;
  /** `id` of the owning group, when the file lives in a change/feature folder. */
  groupId?: string;
  requirements: Requirement[];
  tasks: Task[];
  /** Original Markdown, kept so the UI can render prose faithfully. */
  markdown: string;
}

/** A logical unit of work: an OpenSpec change, a Spec Kit feature, a capability. */
export interface SpecGroup {
  id: string;
  name: string;
  kind: 'change' | 'feature' | 'capability' | 'root';
  /** POSIX-style path relative to the project root. */
  path: string;
  /** `SpecDoc.id` values, in reading order. */
  docIds: string[];
  archived: boolean;
}

/** Everything spec-scope knows about a project. */
export interface SpecModel {
  /** Absolute path to the project root. */
  root: string;
  flavor: SpecFlavor;
  groups: SpecGroup[];
  docs: SpecDoc[];
  /** Non-fatal problems encountered while reading the tree. */
  warnings: string[];
}

/** Kinds of diagram spec-scope derives from the model. */
export type DiagramKind = 'sequence' | 'requirement-map' | 'task-flow' | 'overview';

/** A generated Mermaid diagram, ready to render. */
export interface Diagram {
  id: string;
  title: string;
  kind: DiagramKind;
  /** `SpecDoc.id`, `Requirement.id`, `Scenario.id` or `SpecGroup.id`. */
  anchor: string;
  /** Mermaid source. Always self-contained and already escaped. */
  mermaid: string;
}

/** How a discussion note is meant to be acted on. */
export type NoteKind = 'question' | 'change' | 'resolve';

export type NoteStatus = 'open' | 'resolved';

export interface Reply {
  id: string;
  body: string;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** A human comment attached to some part of the spec. */
export interface Note {
  id: string;
  /** `SpecDoc.id`, `Requirement.id`, `Scenario.id` or `SpecGroup.id`. */
  anchor: string;
  /** Human-readable breadcrumb for the anchor, so notes survive spec edits. */
  anchorLabel: string;
  kind: NoteKind;
  body: string;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  status: NoteStatus;
  /** ISO-8601 timestamp, set when `status` becomes `resolved`. */
  resolvedAt?: string;
  replies: Reply[];
}

/** On-disk shape of `.spec-scope/notes.json`. */
export interface NotesFile {
  version: 1;
  notes: Note[];
}

/* -------------------------------------------------------------------------- */
/* Review layer                                                                */
/*                                                                             */
/* Everything below is *derived* from the spec plus the discussion — plain    */
/* explanations, captured decisions, review verdicts, a glossary. spec-scope  */
/* has no LLM of its own; the in-loop agent produces the prose (via           */
/* `spec-scope explain`/`apply`) and the tool renders it. The provenance flag */
/* keeps that honest: nothing invented is ever shown as fact.                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a piece of explanation stands relative to the source.
 * - `grounded`  — restates spec text or a discussion thread (has `sources`).
 * - `inferred`  — the agent's reading; a claim, shown as one, disputable.
 * - `unstated`  — the honest gap; the UI turns this into an open question.
 */
export type Provenance = 'grounded' | 'inferred' | 'unstated';

/** A citation back to the material that grounds an explanation or decision. */
export interface SourceRef {
  kind: 'requirement' | 'scenario' | 'doc' | 'task' | 'note' | 'constitution';
  /** Id of the referenced thing (or a free label for a constitution clause). */
  anchor: string;
  label?: string;
  /** The exact fragment quoted, so a reader can check the paraphrase. */
  quote?: string;
}

export type ExplanationKind = 'summary' | 'narration' | 'glossary-def';

/**
 * A plain-language companion for a requirement or scenario (or a glossary
 * definition). Rendered beside the formal text, never replacing it.
 */
export interface Explanation {
  id: string;
  /** `Requirement.id`, `Scenario.id`, or a glossary term slug. */
  anchor: string;
  anchorLabel: string;
  kind: ExplanationKind;
  body: string;
  provenance: Provenance;
  sources: SourceRef[];
  /**
   * Hash of the source text this explains, at the time it was written. When it
   * no longer matches the current text, the explanation is shown as stale
   * rather than quietly lying. See `specHash` in `src/hash.ts`.
   */
  specHash: string;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

export type DecisionStatus = 'open' | 'recorded' | 'superseded';

/**
 * A captured decision: what was chosen, what was traded away, and the receipt.
 * Born from a resolved discussion thread (`threadNoteId`) or swept from the spec.
 */
export interface Decision {
  id: string;
  title: string;
  context: string;
  /** Alternatives that were on the table; may be empty. */
  options: string[];
  choice: string;
  /** What accepting this choice gives up. */
  tradeoffs: string;
  consequence: string;
  provenance: Provenance;
  sources: SourceRef[];
  /** The resolved `Note.id` this was distilled from, when applicable. */
  threadNoteId?: string;
  status: DecisionStatus;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  updatedAt?: string;
}

/** A reviewer's verdict on one requirement/scenario — the heat-map input. */
export type ReviewVerdict = 'understood' | 'concern' | 'blocking' | 'approved';

export interface ReviewStamp {
  id: string;
  anchor: string;
  anchorLabel: string;
  verdict: ReviewVerdict;
  note?: string;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** A domain term with its definition, or flagged as used-but-undefined. */
export interface GlossaryTerm {
  id: string;
  term: string;
  /** Empty when `defined` is false. */
  definition: string;
  provenance: Provenance;
  sources: SourceRef[];
  /** False = the spec uses this term but never defines it -> open question. */
  defined: boolean;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * Diagram types the agent authors when a structure warrants one. Distinct from
 * the code-`derived` {@link DiagramKind}: these require judgement about what the
 * spec means, which only the in-loop agent has.
 *
 * - `sequence`  — an interaction/endpoint lifecycle across ≥2 participants.
 * - `state`     — one entity moving through named states (draft → published → …).
 * - `er`        — a data model: entities and their relationships.
 * - `flowchart` — a process with branching or a decision flow.
 * - `class`     — module/component structure within one unit.
 */
export type AuthoredDiagramType = 'sequence' | 'state' | 'er' | 'flowchart' | 'class';

/**
 * A diagram the agent authored because a spec structure earned one — the right
 * type at the right altitude (one state machine per entity, one ER for the data
 * model), not a per-scenario reflex. Stored in `review.json` and rendered like an
 * explanation, with the same provenance and staleness discipline.
 */
export interface AuthoredDiagram {
  id: string;
  title: string;
  type: AuthoredDiagramType;
  /** The primary anchor it hangs off — usually a `SpecDoc.id` or `SpecGroup.id`. */
  anchor: string;
  anchorLabel: string;
  /** The anchors this diagram consolidates (requirements/scenarios/entities it spans). */
  covers: string[];
  /** Mermaid source authored by the agent. Validated on `apply`. */
  mermaid: string;
  /** Which signal made this diagram worth drawing — for trust and for tuning. */
  trigger: string;
  provenance: Provenance;
  sources: SourceRef[];
  /** Hash of the covered structural text; drives staleness like an explanation. */
  specHash: string;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * A record that the agent reviewed a document for diagram-worthy structure and
 * judged that **none** was warranted — so `explain` stops asking. Prose is the
 * honest default; this makes "no diagram" an explicit, staleness-tracked decision
 * rather than an omission.
 */
export interface DiagramSkip {
  /** The `SpecDoc.id` (or group id) reviewed. */
  anchor: string;
  /** Hash of the doc's structural text at review time; a change re-opens the task. */
  specHash: string;
  /** Optional one-line reason ("all scenarios are single-step lookups"). */
  reason?: string;
  author: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** On-disk shape of `.spec-scope/review.json`. */
export interface ReviewFile {
  version: 1;
  decisions: Decision[];
  stamps: ReviewStamp[];
  explanations: Explanation[];
  glossary: GlossaryTerm[];
  diagrams: AuthoredDiagram[];
  diagramSkips: DiagramSkip[];
}

/** One edge of a blast-radius subgraph. */
export interface BlastEdge {
  from: string;
  to: string;
  /** `structural` = a real model edge; `inferred` = shared-term guess (dashed). */
  kind: 'structural' | 'inferred';
  reason?: string;
}

export interface BlastNode {
  id: string;
  label: string;
  type: 'requirement' | 'scenario' | 'task' | 'doc' | 'constitution';
}

/** What a change to one requirement reaches downstream. */
export interface BlastGraph {
  root: string;
  nodes: BlastNode[];
  edges: BlastEdge[];
}

/** A spec change, rendered from an OpenSpec delta marker, with receipts. */
export interface ChangeEntry {
  anchor: string;
  requirement: string;
  delta: DeltaKind;
  /** Mechanical prose — never stands alone; carries the quoted fragments. */
  summary: string;
  before?: string;
  after?: string;
}

/** One unit of work in the list `spec-scope explain` hands the in-loop agent. */
export interface ExplainTask {
  kind: 'summary' | 'narration' | 'glossary' | 'decision' | 'diagram';
  anchor: string;
  anchorLabel: string;
  /** `missing` = never explained; `stale` = the spec changed under it. */
  reason: 'missing' | 'stale';
  /**
   * For `summary`/`narration` tasks, the hash of the current source text; for a
   * `diagram` task, the hash of the doc's structural text. The agent copies this
   * verbatim into the `specHash` of the explanation / authored diagram / skip it
   * writes, so the result matches the spec and is not reported stale next run.
   * Empty for `glossary`/`decision` tasks, which pin to no source text.
   */
  specHash: string;
  /** What to produce and the provenance / worthiness rule to follow. */
  hint: string;
}

/** Batch the agent hands back via `spec-scope apply` after generating content. */
export interface ReviewBatch {
  explanations?: Explanation[];
  decisions?: Decision[];
  glossary?: GlossaryTerm[];
  diagrams?: AuthoredDiagram[];
  diagramSkips?: DiagramSkip[];
}
