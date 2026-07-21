/**
 * Blast radius — "if I touch this, what else has to be re-checked?"
 *
 * Pure over the model: an anchor (requirement or scenario id) in, a small
 * subgraph out. Two edge classes with very different trust levels:
 *
 *  - `structural` (solid): a real relationship the model records — a requirement
 *    owns its scenarios, and a task in the same document names the requirement or
 *    lives under its section. These are facts.
 *  - `inferred` (dashed): a lexical guess — another requirement/scenario or a
 *    constitution clause shares a significant domain term with the root. This is a
 *    hint for a human to confirm, never a claim.
 *
 * Keeping the two kinds visually and semantically distinct is the whole point:
 * the reader must never mistake a shared-word coincidence for a wired dependency.
 */

import { slug } from './ids.js';
import type {
  BlastEdge,
  BlastGraph,
  BlastNode,
  Requirement,
  Scenario,
  SpecDoc,
  SpecModel,
  Task,
} from './types.js';

/**
 * A common word must not detonate the graph: a term like "data" could touch half
 * the spec. Cap the dashed edges and let document order decide which survive.
 */
const INFERRED_CAP = 12;

/** Shortest token worth treating as a domain term; below this it is noise. */
const MIN_TERM_LEN = 4;

/**
 * Function words and spec boilerplate that carry no domain signal. Kept
 * deliberately generic ("system", "user", "feature") because those words appear
 * in nearly every requirement and would otherwise link everything to everything.
 */
const STOPWORDS = new Set([
  'this',
  'that',
  'these',
  'those',
  'then',
  'than',
  'with',
  'from',
  'have',
  'will',
  'shall',
  'must',
  'should',
  'would',
  'could',
  'into',
  'onto',
  'over',
  'under',
  'when',
  'where',
  'which',
  'what',
  'while',
  'your',
  'yours',
  'their',
  'they',
  'them',
  'been',
  'were',
  'also',
  'such',
  'only',
  'each',
  'every',
  'some',
  'many',
  'more',
  'most',
  'less',
  'both',
  'either',
  'about',
  'after',
  'before',
  'because',
  'between',
  'within',
  'without',
  'again',
  'other',
  'another',
  'being',
  'same',
  'different',
  'using',
  'used',
  'uses',
  'make',
  'makes',
  'made',
  'give',
  'gives',
  'given',
  'take',
  'takes',
  'taken',
  'does',
  'done',
  'need',
  'needs',
  'able',
  'system',
  'user',
  'users',
  'support',
  'supports',
  'provide',
  'provides',
  'ensure',
  'ensures',
  'allow',
  'allows',
  'case',
  'cases',
  'item',
  'items',
  'value',
  'values',
  'thing',
  'things',
  'part',
  'parts',
  'feature',
  'features',
  'requirement',
  'requirements',
  'scenario',
  'scenarios',
  'section',
]);

/** Split prose into lowercase alphanumeric words. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Significant, deduped domain terms of a name, in first-appearance order. */
function orderedTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    if (token.length < MIN_TERM_LEN || STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** The slug fragment an id ends with: `doc:x/req:add-passkey-login` -> `add-passkey-login`. */
function idFragment(id: string): string {
  const seg = id.split('/').pop() ?? id;
  const colon = seg.indexOf(':');
  return colon >= 0 ? seg.slice(colon + 1) : seg;
}

/** True when `needle` appears as a contiguous run of whole words inside `hay`. */
function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Why a task counts as structurally touched by a requirement/scenario, or null.
 *
 * Three routes, strongest first: the task text names the target verbatim (its id
 * fragment, i.e. its slugged name, as a contiguous phrase); the task shares every
 * significant term of a multi-word name; or the task sits under a section whose
 * heading is the target's name. Single common words never qualify on their own —
 * that is the "distinctive multi-word token" rule, and it is what keeps a task
 * called "write tests" from linking to every requirement mentioning "tests".
 */
function taskTouches(task: Task, targetName: string, targetId: string): string | null {
  // The two contract conditions are kept apart: the text-reference routes read
  // only `task.text`, and the section route reads only `task.section`, so a task
  // qualifies for the reason it actually meets rather than by leakage between them.
  const words = tokenize(task.text);
  const fragTokens = idFragment(targetId).split('-').filter(Boolean);
  // Require a multi-token phrase: a one-word name (Support, Export, Search) would
  // otherwise link every task that merely contains that word as a solid, factual
  // edge — the exact single-common-word coincidence this rule exists to forbid.
  if (fragTokens.length >= 2 && containsRun(words, fragTokens)) {
    return `task names "${targetName}"`;
  }

  const terms = orderedTerms(targetName);
  const present = new Set(words);
  if (terms.length >= 2 && terms.every((t) => present.has(t))) {
    return `task shares the terms of "${targetName}"`;
  }

  if (task.section && slug(task.section) === slug(targetName)) {
    return `task under section "${task.section}"`;
  }
  return null;
}

interface Located {
  doc: SpecDoc;
  req: Requirement;
  scn?: Scenario;
}

/** Find the anchored requirement or scenario and the document it lives in. */
function locate(model: SpecModel, anchor: string): Located | null {
  for (const doc of model.docs) {
    for (const req of doc.requirements) {
      if (req.id === anchor) return { doc, req };
      for (const scn of req.scenarios) {
        if (scn.id === anchor) return { doc, req, scn };
      }
    }
  }
  return null;
}

/** A candidate the root might share a domain term with. */
interface Candidate {
  id: string;
  name: string;
  type: BlastNode['type'];
}

/**
 * Everything the inferred pass may link to: requirements and scenarios from
 * ordinary docs, plus one clause per heading of every constitution document.
 *
 * Constitution headings are read straight from `doc.markdown` (a model field, so
 * still pure — no I/O) because a real `constitution.md` writes its rules as
 * `## Article`/`### Principle`, which the requirement parser does not pick up; a
 * constitution doc therefore usually has zero parsed requirements. Reading its
 * headings is what makes "constitution clauses sharing a term" non-vacuous.
 */
function inferredCandidates(model: SpecModel): Candidate[] {
  const out: Candidate[] = [];
  const headingRe = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;
  for (const doc of model.docs) {
    if (doc.kind === 'constitution') {
      let ordinal = 0;
      for (const line of doc.markdown.split(/\r?\n/)) {
        const match = headingRe.exec(line);
        const text = (match?.[1] ?? '').trim();
        if (!text) continue;
        out.push({
          id: `${doc.id}#clause:${slug(text)}-${ordinal}`,
          name: text,
          type: 'constitution',
        });
        ordinal += 1;
      }
      continue;
    }
    for (const req of doc.requirements) {
      out.push({ id: req.id, name: req.name, type: 'requirement' });
      for (const scn of req.scenarios) {
        out.push({ id: scn.id, name: scn.name, type: 'scenario' });
      }
    }
  }
  return out;
}

/**
 * The subgraph a change to `anchor` reaches. Never throws: an unknown anchor
 * yields an empty graph rooted at the id the caller passed, so a stale link in
 * the UI degrades to "nothing to show" rather than a crash.
 *
 * tradeoff: term matching is lexical, not semantic — it compares whole words, so
 * "auth" and "authentication" do not match and "order" (the noun) matches "order"
 * (sort). The dashed styling and the cap keep the false positives cheap. Upgrade
 * path is a stemmer plus a curated domain vocabulary, or real embeddings; not
 * worth it until a reviewer complains the guesses are noise.
 */
export function blastRadius(model: SpecModel, anchor: string): BlastGraph {
  const located = locate(model, anchor);
  if (!located) return { root: anchor, nodes: [], edges: [] };

  const nodes = new Map<string, BlastNode>();
  const edges: BlastEdge[] = [];
  const edgeKeys = new Set<string>();

  const addNode = (id: string, label: string, type: BlastNode['type']): void => {
    if (!nodes.has(id)) nodes.set(id, { id, label, type });
  };
  const addEdge = (from: string, to: string, kind: BlastEdge['kind'], reason: string): void => {
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind, reason });
  };

  const { doc, req, scn } = located;
  const rootIsScenario = scn !== undefined;
  const rootId = rootIsScenario ? scn.id : req.id;
  const rootName = rootIsScenario ? scn.name : req.name;
  addNode(rootId, rootName, rootIsScenario ? 'scenario' : 'requirement');

  // Structural edges — the model's own wiring.
  if (rootIsScenario) {
    // Show the owning requirement as context: it is the scenario's container.
    addNode(req.id, req.name, 'requirement');
    addEdge(req.id, scn.id, 'structural', 'scenario of requirement');
  } else {
    for (const child of req.scenarios) {
      addNode(child.id, child.name, 'scenario');
      addEdge(req.id, child.id, 'structural', 'scenario of requirement');
    }
  }
  for (const task of doc.tasks) {
    const reason = taskTouches(task, rootName, rootId);
    if (!reason) continue;
    addNode(task.id, task.text, 'task');
    addEdge(rootId, task.id, 'structural', reason);
  }

  // Inferred edges — shared-term guesses, dashed, capped.
  const rootTerms = new Set(orderedTerms(rootName));
  if (rootTerms.size > 0) {
    let drawn = 0;
    for (const cand of inferredCandidates(model)) {
      if (drawn >= INFERRED_CAP) break;
      if (cand.id === anchor || nodes.has(cand.id)) continue;
      const shared = orderedTerms(cand.name).find((t) => rootTerms.has(t));
      if (!shared) continue;
      addNode(cand.id, cand.name, cand.type);
      addEdge(rootId, cand.id, 'inferred', `shares "${shared}"`);
      drawn += 1;
    }
  }

  return { root: rootId, nodes: [...nodes.values()], edges };
}
