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
