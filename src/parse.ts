/**
 * Markdown -> SpecModel.
 *
 * Everything that knows about Markdown lives here. The scanner is a single pass
 * over the lines of one file and is deliberately marker-driven rather than
 * flavor-driven: a repo mid-migration holds both dialects, sometimes in the same
 * directory, and asking the caller which dialect a file is written in only moves
 * the guess somewhere less informed.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectProject, EXCLUDED_DIRS } from './detect.js';
import { docId, groupId, requirementId, scenarioId, slug, taskId } from './ids.js';
import type {
  DeltaKind,
  DocKind,
  Requirement,
  Scenario,
  SpecDoc,
  SpecFlavor,
  SpecGroup,
  SpecModel,
  Step,
  StepKeyword,
  Task,
} from './types.js';

/** Recursion limit for a recognised project; deep spec trees are pathological. */
const MAX_DEPTH_KNOWN = 12;
/** An unrecognised project is scanned shallowly — we are guessing, so guess cheaply. */
const MAX_DEPTH_UNKNOWN = 3;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A closing `#` run is stripped only when whitespace precedes it, so a trailing
// `#` that belongs to the text (`### Requirement: Support C#`) is kept.
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
// Any single non-`]` marker is a checkbox; only `x`/`X` count as done, so
// `- [~]`, `- [P]` and friends still render as (undone) tasks.
const CHECKBOX_RE = /^\[([^\]])\]\s*(.*)$/;
const DELTA_HEADING_RE = /^(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements?$/i;
const REQUIREMENT_HEADING_RE = /^Requirements?\s*:\s*(.+)$/i;
const SCENARIO_HEADING_RE = /^Scenarios?\s*:\s*(.+)$/i;
const STORY_HEADING_RE = /^user story\b/i;
const SPECKIT_REQ_SECTION_RE = /^(functional|non-functional|technical)?\s*requirements$/i;
const PRIORITY_SUFFIX_RE = /\s*\(\s*(?:priority|p)\s*[:=]?\s*[^)]*\)\s*$/i;
const AS_A_RE = /^as an?\s+[^,]+,\s*i\s+want\s+(?:to\s+)?(.+?)\s*(?:,\s*so that\b.*)?\.?$/i;
const TASK_ID_PREFIX_RE = /^(?:T|TASK[- ]?)\d{1,4}[.:)\]]?\s+/i;
/**
 * Keyword, optionally wrapped in the same emphasis marker on both sides.
 * The lookahead stands in for `\b`, which would reject `__WHEN__` — `_` counts
 * as a word character, so there is no boundary between the keyword and its
 * own underscore emphasis. It still rejects `Whenever` and `Butter`.
 */
const STEP_RE = /^(\*{1,2}|_{1,2})?(given|when|then|and|but)(?![a-z0-9])\s*:?\1?:?\s+(.+)$/i;

/** Name given to the synthetic requirement that adopts a scenario found before any real one. */
const UNATTACHED_REQUIREMENT = '(unattached)';

const DOC_KIND_BY_BASENAME: Readonly<Record<string, DocKind>> = {
  'spec.md': 'spec',
  'proposal.md': 'proposal',
  'plan.md': 'plan',
  'tasks.md': 'tasks',
  'design.md': 'design',
  'research.md': 'research',
  'constitution.md': 'constitution',
};

/** Windows gives us backslashes; every path in the model is POSIX. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

/** `add-passkey-login` -> `Add Passkey Login`, used when a doc has no `# ` heading. */
function prettifyBasename(base: string): string {
  const stem = base.replace(/\.md$/i, '');
  const words = stem.split(/[-_.\s]+/).filter(Boolean);
  if (words.length === 0) return stem || 'Untitled';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Removes `**bold**` / `__bold__` wrappers while keeping the words inside. */
function stripEmphasis(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
}

/**
 * Maps a file to the role it plays. Basename first because both workflows name
 * their files by role; the `openspec/specs/` fallback catches capability specs
 * that were named after the capability rather than `spec.md`.
 */
export function classifyDoc(relPath: string): DocKind {
  const posix = toPosix(relPath);
  const base = (posix.split('/').pop() ?? '').toLowerCase();
  const byName = DOC_KIND_BY_BASENAME[base];
  if (byName) return byName;
  if (/(^|\/)openspec\/specs\//.test(posix)) return 'spec';
  return 'other';
}

/**
 * Pulls `Actor: does thing` apart when the prefix reads like a participant name.
 *
 * tradeoff: this is positional, not semantic — it trusts a short colon-prefixed
 * head and nothing else, so `Note: the system retries` yields the actor `Note`.
 * The guards below (word count, no inner punctuation, no scheme separator) buy
 * most of the accuracy for none of the machinery. Upgrade path: collect the
 * actor vocabulary across the whole model in a first pass and only accept a
 * prefix that appears as an actor more than once.
 */
function extractActor(text: string): { actor?: string; text: string } {
  const colon = text.indexOf(':');
  if (colon < 1 || colon > 40) return { text };
  const head = text.slice(0, colon).trim();
  const rest = text.slice(colon + 1).trim();
  if (!rest || rest.startsWith('//')) return { text };
  // A participant name reads like a name: it starts capitalised (or with a
  // digit). Lowercase heads are prose — `the agent:` and `returns:` are not actors.
  if (!/^[A-Z0-9]/.test(head)) return { text };
  if (/[.,;!?/`*_[\]()]/.test(head)) return { text };
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return { text };
  return { actor: head, text: rest };
}

/**
 * Drops a trailing bold-only line such as `**Acceptance Criteria**`.
 *
 * Spec Kit labels the criteria list rather than giving it a heading, so the
 * label is the last prose line before the bullets that become a scenario.
 * Leaving it in strands a bold caption pointing at nothing once the bullets
 * have moved into the scenario, which reads as a bug in the export and the UI.
 */
function dropTrailingLabel(text: string): string {
  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  if (last !== undefined && /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$/.test(last)) {
    return lines.slice(0, -1).join('\n').trim();
  }
  return text;
}

/** Indentation width in columns, counting a tab as one nesting level. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === '\t' ? 2 : 1;
  return width;
}

interface FenceState {
  char: string;
  length: number;
}

/**
 * Scans one Markdown file into a `SpecDoc`.
 *
 * Pure: no filesystem, no clock, no shared state. Duplicate slugs are resolved
 * here (`-2`, `-3`, …) so ids stay unique inside a document; `parseProject`
 * re-derives the matching warnings rather than having this function return them,
 * which keeps the signature honest about being a pure transform.
 */
export function parseMarkdown(markdown: string, relPath: string): SpecDoc {
  const posixPath = toPosix(relPath);
  const id = docId(posixPath);
  const kind = classifyDoc(posixPath);
  // A leading BOM would hide the first heading from the line scanner; drop it for
  // scanning only, leaving `markdown` verbatim for the UI to render.
  const scanSource = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const lines = scanSource.split(/\r?\n/);
  // YAML front matter (`---` on line 1 through the next `---`) is skipped so a `#`
  // comment inside it is not read as the title. Lines stay in place — only the
  // scan start moves — so 1-based line numbers keep pointing at the real source.
  let scanStart = 0;
  if (lines[0] === '---') {
    for (let j = 1; j < lines.length; j += 1) {
      if (lines[j] === '---') {
        scanStart = j + 1;
        break;
      }
    }
  }

  const requirements: Requirement[] = [];
  const tasks: Task[] = [];
  let title = '';

  let fence: FenceState | null = null;
  let currentDelta: DeltaKind | undefined;
  let currentSection: string | undefined;
  let inSpeckitReqSection = false;

  let currentReq: Requirement | undefined;
  let currentReqLevel = 0;
  let currentScenario: Scenario | undefined;
  let collectingText = false;
  let textLines: string[] = [];

  const reqSlugCounts = new Map<string, number>();
  let scenarioSlugCounts = new Map<string, number>();
  const taskStack: Array<{ id: string; depth: number }> = [];
  let taskIndex = 0;

  // Indented-code-block tracking. An indented block opens with 4 spaces or a tab
  // after a blank line, unless a list is open at a shallower indent (then the line
  // is nested list content, not code). Like fences, its lines are never spec syntax.
  let lastLineBlank = true;
  let inIndentedCode = false;
  let lastListIndent = -1;

  function flushText(): void {
    if (currentReq && collectingText) {
      currentReq.text = dropTrailingLabel(textLines.join('\n').trim());
    }
    collectingText = false;
    textLines = [];
  }

  function closeRequirement(): void {
    flushText();
    currentReq = undefined;
    currentReqLevel = 0;
    currentScenario = undefined;
  }

  function openRequirement(name: string, line: number, level: number): void {
    closeRequirement();
    const base = slug(name);
    const seen = reqSlugCounts.get(base) ?? 0;
    reqSlugCounts.set(base, seen + 1);
    // Second and later collisions get their ordinal folded into the slug source
    // so the id is stable as long as the ordering is.
    const idSource = seen === 0 ? name : `${base}-${seen + 1}`;
    const req: Requirement = {
      id: requirementId(id, idSource),
      name,
      text: '',
      scenarios: [],
      line,
    };
    if (currentDelta) req.delta = currentDelta;
    requirements.push(req);
    currentReq = req;
    currentReqLevel = level;
    scenarioSlugCounts = new Map();
    collectingText = true;
    textLines = [];
  }

  function openScenario(name: string, line: number): void {
    if (!currentReq) return;
    flushText();
    const base = slug(name);
    const seen = scenarioSlugCounts.get(base) ?? 0;
    scenarioSlugCounts.set(base, seen + 1);
    const idSource = seen === 0 ? name : `${base}-${seen + 1}`;
    const scenario: Scenario = {
      id: scenarioId(currentReq.id, idSource),
      name,
      steps: [],
      line,
    };
    currentReq.scenarios.push(scenario);
    currentScenario = scenario;
  }

  for (let i = scanStart; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const lineNo = i + 1;
    const prevBlank = lastLineBlank;
    lastLineBlank = raw.trim() === '';

    // Fences first: everything below is a false positive inside one.
    const fenceMatch = FENCE_RE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '';
      const char = marker.charAt(0);
      if (fence === null) {
        fence = { char, length: marker.length };
        continue;
      }
      // A fence closes only on its own character, at least as long, nothing after.
      const bare = (fenceMatch[2] ?? '').trim() === '';
      if (char === fence.char && marker.length >= fence.length && bare) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;

    // Indented code block: 4 spaces or a tab after a blank line, its lines skipped
    // like a fence's. It does not open when a list is already open at a shallower
    // indent, because then the indented line is nested list content, not code.
    if (inIndentedCode) {
      if (lastLineBlank || /^(?: {4}|\t)/.test(raw)) continue;
      inIndentedCode = false;
    } else if (prevBlank && /^(?: {4}|\t)/.test(raw)) {
      const width = indentWidth(raw.slice(0, raw.length - raw.trimStart().length));
      if (!(lastListIndent >= 0 && lastListIndent < width)) {
        inIndentedCode = true;
        continue;
      }
    }

    const heading = HEADING_RE.exec(raw);
    if (heading) {
      lastListIndent = -1;
      const level = (heading[1] ?? '').length;
      const text = (heading[2] ?? '').trim();
      currentSection = text;
      if (level === 1 && !title) title = text;

      const delta = DELTA_HEADING_RE.exec(text);
      if (delta) {
        closeRequirement();
        currentDelta = (delta[1] ?? '').toUpperCase() as DeltaKind;
        inSpeckitReqSection = false;
        continue;
      }

      // OpenSpec `### Requirement: Name` is checked before the generic Spec Kit
      // rule: OpenSpec specs also carry a `## Requirements` heading, and running
      // both rules would count every OpenSpec requirement twice.
      const reqHeading = level >= 2 ? REQUIREMENT_HEADING_RE.exec(text) : null;
      if (reqHeading) {
        openRequirement((reqHeading[1] ?? '').trim(), lineNo, level);
        continue;
      }

      const scnHeading = level >= 3 ? SCENARIO_HEADING_RE.exec(text) : null;
      if (scnHeading) {
        // A scenario before any requirement is adopted by a synthetic one rather
        // than dropped; parseProject re-derives the warning from its name.
        if (!currentReq) openRequirement(UNATTACHED_REQUIREMENT, lineNo, Math.max(level - 1, 2));
        openScenario((scnHeading[1] ?? '').trim(), lineNo);
        continue;
      }

      if (STORY_HEADING_RE.test(text)) {
        inSpeckitReqSection = false;
        openRequirement(text.replace(PRIORITY_SUFFIX_RE, '').trim(), lineNo, level);
        continue;
      }

      // Only level-3 headings under a Spec Kit `## Requirements` section are
      // requirements; a deeper `##### Implementation notes` is an ordinary sub-heading.
      if (level === 3 && inSpeckitReqSection) {
        openRequirement(text, lineNo, level);
        continue;
      }

      if (level === 2) {
        currentDelta = undefined;
        inSpeckitReqSection = SPECKIT_REQ_SECTION_RE.test(text);
      }
      if (currentReq && level <= currentReqLevel) closeRequirement();
      continue;
    }

    const item = LIST_ITEM_RE.exec(raw);
    if (item) {
      const indent = item[1] ?? '';
      const content = (item[2] ?? '').trim();
      lastListIndent = indentWidth(indent);

      const checkbox = CHECKBOX_RE.exec(content);
      if (checkbox) {
        const depth = Math.floor(indentWidth(indent) / 2);
        while (taskStack.length > 0) {
          const top = taskStack[taskStack.length - 1];
          if (top && top.depth >= depth) taskStack.pop();
          else break;
        }
        const parent = taskStack[taskStack.length - 1];
        const visible = stripEmphasis((checkbox[2] ?? '').trim())
          .replace(TASK_ID_PREFIX_RE, '')
          .trim();
        const task: Task = {
          id: taskId(id, taskIndex),
          text: visible,
          done: (checkbox[1] ?? ' ').toLowerCase() === 'x',
          depth,
          line: lineNo,
        };
        if (parent) task.parentId = parent.id;
        if (currentSection) task.section = currentSection;
        tasks.push(task);
        taskStack.push({ id: task.id, depth });
        taskIndex += 1;
        if (collectingText) textLines.push(raw);
        continue;
      }

      const step = STEP_RE.exec(content);
      if (step && currentReq) {
        // Spec Kit writes acceptance criteria as bare bullets under a story, with
        // no scenario heading to hang them on; synthesise one on first sight.
        if (!currentScenario) openScenario('Acceptance', lineNo);
        if (currentScenario) {
          const keyword = (step[2] ?? '').toUpperCase() as StepKeyword;
          const { actor, text: body } = extractActor(stripEmphasis((step[3] ?? '').trim()));
          const parsed: Step = { keyword, text: body, line: lineNo };
          if (actor) parsed.actor = actor;
          currentScenario.steps.push(parsed);
          continue;
        }
      }

      const story = AS_A_RE.exec(stripEmphasis(content));
      if (story) {
        openRequirement(capitalise((story[1] ?? '').trim()), lineNo, currentReqLevel || 2);
        textLines.push(raw);
        continue;
      }
    }

    // A non-blank, unindented, non-list line ends any open list: later indented
    // content is then separated by a paragraph and reads as code, not a nested item.
    if (!lastLineBlank && !/^[ \t]/.test(raw)) lastListIndent = -1;
    if (collectingText) textLines.push(raw);
  }

  flushText();

  return {
    id,
    path: posixPath,
    title: title || prettifyBasename(posixPath.split('/').pop() ?? posixPath),
    kind,
    requirements,
    tasks,
    markdown,
  };
}

interface GroupSlot {
  path: string;
  name: string;
  kind: SpecGroup['kind'];
  archived: boolean;
}

/** Which group a file belongs to, from its path alone. `null` means the root group. */
function groupSlotFor(relPath: string, flavor: SpecFlavor): GroupSlot | null {
  const seg = relPath.split('/');

  if (flavor === 'openspec' && seg[0] === 'openspec') {
    if (seg[1] === 'changes') {
      // `changes/archive/<name>/…` nests one level deeper; the literal `archive`
      // segment is a bucket, never a change of its own.
      const archivedName = seg[2] === 'archive' && seg.length >= 5 ? seg[3] : undefined;
      if (archivedName) {
        return {
          path: `openspec/changes/archive/${archivedName}`,
          name: archivedName,
          kind: 'change',
          archived: true,
        };
      }
      const changeName = seg[2] !== 'archive' && seg.length >= 4 ? seg[2] : undefined;
      if (changeName) {
        return {
          path: `openspec/changes/${changeName}`,
          name: changeName,
          kind: 'change',
          archived: false,
        };
      }
    }
    const capability = seg[1] === 'specs' && seg.length >= 4 ? seg[2] : undefined;
    if (capability) {
      return {
        path: `openspec/specs/${capability}`,
        name: capability,
        kind: 'capability',
        archived: false,
      };
    }
  }

  const feature =
    flavor === 'speckit' && seg[0] === 'specs' && seg.length >= 3 ? seg[1] : undefined;
  if (feature) {
    return { path: `specs/${feature}`, name: feature, kind: 'feature', archived: false };
  }

  return null;
}

/** Recursively collect `.md` files, skipping symlinks and the excluded directories. */
async function collectMarkdown(dir: string, maxDepth: number, out: Set<string>): Promise<void> {
  async function walk(current: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // tradeoff: symlinks are skipped outright rather than resolved and range
      // checked against the root. A spec tree that leans on links is rare enough
      // to be worth the false negative. Upgrade path: realpath + containment test.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // Named excludes plus any dot-directory (build caches, VCS, editor state),
        // except `.specify/`, which is a Spec Kit marker that holds real specs.
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.specify') continue;
        if (depth + 1 < maxDepth) await walk(full, depth + 1);
        continue;
      }
      if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) out.add(full);
    }
  }
  await walk(dir, 0);
}

/** Re-derives the problems worth surfacing from an already-parsed document. */
function collectDocWarnings(doc: SpecDoc, warnings: string[]): void {
  const reqSlugs = new Map<string, number>();
  for (const req of doc.requirements) {
    const base = slug(req.name);
    reqSlugs.set(base, (reqSlugs.get(base) ?? 0) + 1);

    if (req.name === UNATTACHED_REQUIREMENT) {
      warnings.push(
        `${doc.path}:${req.line} scenario appears before any requirement; attached to a synthetic "${UNATTACHED_REQUIREMENT}" requirement`
      );
    }

    const scnSlugs = new Map<string, number>();
    for (const scenario of req.scenarios) {
      const scnBase = slug(scenario.name);
      scnSlugs.set(scnBase, (scnSlugs.get(scnBase) ?? 0) + 1);
      if (scenario.steps.length === 0) {
        warnings.push(
          `${doc.path}:${scenario.line} scenario "${scenario.name}" has no steps; no sequence diagram will be generated`
        );
      }
    }
    for (const [base, count] of scnSlugs) {
      if (count > 1) {
        warnings.push(
          `${doc.path} requirement "${req.name}" has ${count} scenarios sharing the id "${base}"; the duplicates were suffixed`
        );
      }
    }
  }
  for (const [base, count] of reqSlugs) {
    if (count > 1) {
      warnings.push(
        `${doc.path} has ${count} requirements sharing the id "${base}"; the duplicates were suffixed`
      );
    }
  }
}

/**
 * Re-prefixes a document's id and every id derived from it (requirements,
 * scenarios, tasks) after a cross-document collision. Every child id begins with
 * the doc id, so swapping that prefix keeps them internally consistent and unique.
 */
function reassignDocId(doc: SpecDoc, newId: string): void {
  const oldId = doc.id;
  const reprefix = (childId: string): string => newId + childId.slice(oldId.length);
  doc.id = newId;
  for (const req of doc.requirements) {
    req.id = reprefix(req.id);
    for (const scenario of req.scenarios) scenario.id = reprefix(scenario.id);
  }
  for (const task of doc.tasks) task.id = reprefix(task.id);
}

/**
 * Reads a whole project into the model the rest of spec-scope consumes.
 *
 * Every problem short of "cannot detect a root" is non-fatal and lands in
 * `warnings`: a review tool that refuses to render because one file is
 * unreadable is worse than one that renders the other forty and says so.
 */
export async function parseProject(dir: string): Promise<SpecModel> {
  const { root, flavor, specDirs } = await detectProject(dir);
  const warnings: string[] = [];

  const files = new Set<string>();
  const maxDepth = flavor === 'unknown' ? MAX_DEPTH_UNKNOWN : MAX_DEPTH_KNOWN;
  for (const specDir of specDirs) {
    await collectMarkdown(specDir, maxDepth, files);
  }

  const docs: SpecDoc[] = [];
  const seenDocIds = new Map<string, string>();

  for (const file of [...files].sort()) {
    const relPath = toPosix(path.relative(root, file));
    let markdown: string;
    try {
      markdown = await readFile(file, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`${relPath} could not be read: ${reason}`);
      continue;
    }
    const doc = parseMarkdown(markdown, relPath);
    const clash = seenDocIds.get(doc.id);
    if (clash !== undefined) {
      const original = doc.id;
      let ordinal = 2;
      while (seenDocIds.has(`${original}-${ordinal}`)) ordinal += 1;
      reassignDocId(doc, `${original}-${ordinal}`);
      warnings.push(
        `${relPath} shares the document id "${original}" with ${clash}; reassigned to "${doc.id}"`
      );
    }
    seenDocIds.set(doc.id, relPath);
    collectDocWarnings(doc, warnings);
    docs.push(doc);
  }

  docs.sort((a, b) => a.path.localeCompare(b.path));

  const rootGroup: SpecGroup = {
    id: groupId('root'),
    name: 'Project',
    kind: 'root',
    path: '',
    docIds: [],
    archived: false,
  };
  const groups = new Map<string, SpecGroup>([[rootGroup.id, rootGroup]]);

  for (const doc of docs) {
    const slot = groupSlotFor(doc.path, flavor);
    let group = rootGroup;
    if (slot) {
      const id = groupId(slot.path);
      const existing = groups.get(id);
      if (existing) {
        group = existing;
      } else {
        group = {
          id,
          name: slot.name,
          kind: slot.kind,
          path: slot.path,
          docIds: [],
          archived: slot.archived,
        };
        groups.set(id, group);
      }
    }
    group.docIds.push(doc.id);
    doc.groupId = group.id;
  }

  if (docs.length === 0) {
    const where = specDirs.map((d) => toPosix(path.relative(root, d)) || '.').join(', ');
    warnings.push(`no Markdown files found under ${where}`);
  }

  const ordered = [...groups.values()]
    .filter((g) => g.docIds.length > 0)
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return a.path.localeCompare(b.path);
    });

  return { root, flavor, groups: ordered, docs, warnings };
}
