/*
 * spec-scope review UI.
 *
 * Vanilla ES2020, no build step, no framework, no network beyond this origin.
 * One `state` object holds everything; render functions read it and rebuild the
 * DOM they own. There is no diffing and no virtual DOM — spec trees are small
 * and a full re-render is easier to reason about than a stale-node bug.
 */

'use strict';

// ---------------------------------------------------------------- state

const THEME_KEY = 'spec-scope:theme';
const DARK_QUERY = window.matchMedia('(prefers-color-scheme: dark)');

const state = {
  /** @type {any} SpecModel from /api/model */
  model: null,
  /** @type {any[]} Diagram[] */
  diagrams: [],
  /** @type {any[]} Note[] */
  notes: [],
  /** @type {any} ReviewFile from /api/review */
  review: null,
  /** @type {any[]} ExplainTask[] from /api/explain */
  explainTasks: [],
  /** Derived indexes over the review layer, rebuilt whenever review data lands. */
  reviewIndex: null,
  docId: null,
  anchor: null,
  anchorLabel: '',
  filter: '',
  /** 'doc' | 'decisions' | 'changes' | 'glossary' */
  view: 'doc',
  /**
   * Reading density. 'digest' (default) collapses each requirement to a
   * summary-first card and hides formal text + diagrams behind one click;
   * 'full' expands every card and shows the formal text.
   */
  density: 'digest',
  /** Anchors whose card the reviewer expanded by hand, so it survives a re-render. */
  expandedCards: new Set(),
  /** 'auto' | 'light' | 'dark' */
  theme: 'auto',
  /** Monotonic counter so every mermaid render gets a fresh element id. */
  diagramSeq: 0,
  /** Incremented per renderDoc so a slow diagram cannot land in a stale view. */
  renderSeq: 0,
  /** Per-note signature (status:replyCount) so only what changed flashes on a live update. */
  noteSig: new Map(),
  /** Note ids that changed since the last render, consumed by renderPanel to flash them. */
  changedNoteIds: new Set(),
  /** False until the first notes render, so the initial load never flashes everything. */
  notesPainted: false,
};

const DENSITY_KEY = 'spec-scope:density';

/** Monotonic id source for card detail regions, so aria-controls has a real target. */
let detailSeq = 0;

const els = {};

function cacheElements() {
  const ids = [
    'flavor-badge',
    'theme-toggle',
    'help-toggle',
    'help-popover',
    'help-close',
    'howto-toggle',
    'agent-waiting',
    'agent-count',
    'filter',
    'tree',
    'doc',
    'panel-anchor',
    'notes',
    'composer',
    'composer-kind',
    'composer-body',
    'toast',
    'tab-doc',
    'tab-decisions',
    'tab-changes',
    'tab-glossary',
    'openq-toggle',
    'openq-count',
    'density-toggle',
    'modal',
    'modal-title',
    'modal-close',
    'modal-body',
  ];
  for (const id of ids) {
    els[camel(id)] = document.getElementById(id);
  }
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------- helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(label, className) {
  const node = el('button', className, label);
  node.type = 'button';
  return node;
}

/** Anchors are hierarchical (`doc:x/req:y/scn:z`); match on segment boundaries. */
function isUnder(anchor, prefix) {
  return anchor === prefix || anchor.startsWith(prefix + '/');
}

function openCountFor(prefix) {
  let n = 0;
  for (const note of state.notes) {
    if (note.status === 'open' && isUnder(note.anchor, prefix)) n += 1;
  }
  return n;
}

function noteBadge(count) {
  // Text, not a coloured dot: the count must survive greyscale and screen readers.
  return el('span', 'badge badge-notes', `${count} note${count === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------- provenance + verdicts

/*
 * The honesty rule made visual. Every explanation, decision and glossary term
 * shows where it stands relative to the spec, and colour is never the only cue:
 * each chip carries a glyph and a lowercase word, and a title tooltip explains it.
 */
const PROVENANCE = {
  grounded: {
    glyph: '◆',
    label: 'grounded',
    title: 'Grounded — restates the spec or a discussion thread, with sources to check.',
  },
  inferred: {
    glyph: '~',
    label: 'inferred',
    title: "Inferred — the agent's reading, shown as a claim you can dispute.",
  },
  unstated: {
    glyph: '?',
    label: 'unstated',
    title: 'Unstated — the spec does not state this. An open question, never a fact.',
  },
};

/** A small, reusable, accessible provenance chip. */
function provenanceBadge(provenance) {
  const meta = PROVENANCE[provenance] || PROVENANCE.inferred;
  const chip = el('span', `prov prov-${provenance in PROVENANCE ? provenance : 'inferred'}`);
  chip.append(el('span', 'prov-glyph', meta.glyph));
  chip.append(el('span', null, meta.label));
  chip.title = meta.title;
  chip.setAttribute('aria-label', `provenance: ${meta.title}`);
  return chip;
}

const VERDICTS = {
  understood: { glyph: '·', label: 'understood' },
  approved: { glyph: '✓', label: 'approved' },
  concern: { glyph: '?', label: 'concern' },
  blocking: { glyph: '!', label: 'blocking' },
};

/** Worst-wins severity so a requirement can roll up its scenarios' verdicts. */
const VERDICT_SEVERITY = { understood: 1, approved: 2, concern: 3, blocking: 4 };

function verdictChip(verdict) {
  const meta = VERDICTS[verdict];
  if (!meta) return el('span', 'verdict-chip', verdict);
  const chip = el('span', `verdict-chip verdict-${verdict}`);
  chip.append(el('span', 'verdict-glyph', meta.glyph));
  chip.append(el('span', null, meta.label));
  return chip;
}

/** `doc:X/req:Y/scn:Z` -> `doc:X`. The doc id never contains an internal slash. */
function docIdOf(anchor) {
  return String(anchor || '').split('/')[0];
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

let toastTimer = null;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

/**
 * A brief highlight so a change that arrives from the agent visibly lands. Uses
 * box-shadow (not background) so it never fights a card's own fill, and reduced-
 * motion users see nothing (the global media query zeroes the animation).
 */
function flashNode(node) {
  if (!node || !node.classList) return;
  node.classList.remove('just-updated');
  void node.offsetWidth; // restart the animation if it is mid-flight
  node.classList.add('just-updated');
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- sanitising

/*
 * marked does NOT sanitise — its `sanitize` option was removed and is absent
 * from the vendored v15 build. A spec file is untrusted input (it arrives from
 * a repo, possibly a fork or an agent), so we parse to an inert <template>,
 * scrub it, and only then attach it to the live document. Nothing is ever
 * assigned to innerHTML on an attached node.
 */

const BLOCKED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'BASE',
  'FORM',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  // A nested <template> holds its children in a separate fragment the
  // TreeWalker never visits, so it cannot be scrubbed — drop it outright.
  'TEMPLATE',
  // SVG animation can retarget an attribute to a javascript: URL after scrub.
  'ANIMATE',
  'ANIMATETRANSFORM',
  'SET',
]);

const URL_ATTRS = new Set([
  'href',
  'src',
  'srcset',
  'xlink:href',
  'action',
  'formaction',
  'poster',
  'background',
  'data',
]);

function isSafeUrl(value) {
  // Strip control characters and whitespace first: a split `java<LF>script:` is
  // a URL the browser will happily follow, so matching them here is the point.
  // Filtered by codepoint rather than a regex range, which keeps literal
  // control characters out of this source file where tooling mangles them.
  const v = [...String(value)]
    .filter((ch) => ch.codePointAt(0) > 0x20)
    .join('')
    .toLowerCase();
  if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return false;
  if (v.startsWith('data:')) return v.startsWith('data:image/');
  return true;
}

function scrub(root) {
  // `*` matches every descendant element in document order and across
  // namespaces, and querySelectorAll returns a static list — so removing nodes
  // while iterating it is safe.
  for (const node of root.querySelectorAll('*')) {
    // HTML elements report an uppercase tagName, but SVG/MathML elements keep
    // the author's case — `<svg><script>` reports "script". Without this
    // normalisation an SVG-namespaced script slips straight through the set.
    const tag = String(node.tagName).toUpperCase();

    // Task-list checkboxes carry real meaning, so keep them (inert) rather than
    // dropping them with the other form controls.
    if (tag === 'INPUT') {
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (type !== 'checkbox') {
        node.remove();
        continue;
      }
      for (const attr of [...node.attributes]) {
        if (!['type', 'checked'].includes(attr.name.toLowerCase())) {
          node.removeAttribute(attr.name);
        }
      }
      node.setAttribute('disabled', '');
      node.setAttribute('aria-label', node.hasAttribute('checked') ? 'done' : 'not done');
      continue;
    }

    if (BLOCKED_TAGS.has(tag)) {
      node.remove();
      continue;
    }

    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      // `style` goes too: the CSP allows inline styles, so a crafted style
      // attribute could overlay the real UI.
      if (name.startsWith('on') || name === 'style') {
        node.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.has(name) && !isSafeUrl(attr.value)) node.removeAttribute(attr.name);
    }

    if (tag === 'A' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer nofollow');
      node.setAttribute('target', '_blank');
    }
  }
}

/** Markdown -> scrubbed DocumentFragment, safe to append. */
function renderMarkdown(markdown) {
  const template = document.createElement('template');
  try {
    template.innerHTML = marked.parse(String(markdown || ''), { gfm: true });
  } catch (err) {
    return el('p', 'diagram-error', `Markdown failed to parse: ${err.message}`);
  }
  scrub(template.content);
  return template.content;
}

// ---------------------------------------------------------------- data

async function loadModel() {
  const data = await api('/api/model');
  state.model = data.model;
  state.diagrams = data.diagrams || [];
}

async function loadNotes() {
  const data = await api('/api/notes');
  state.notes = data.notes || [];
}

async function loadReview() {
  const data = await api('/api/review');
  state.review = data.review || {
    decisions: [],
    stamps: [],
    explanations: [],
    glossary: [],
    diagrams: [],
    diagramSkips: [],
  };
}

async function loadExplain() {
  const data = await api('/api/explain');
  state.explainTasks = data.tasks || [];
}

/**
 * Builds the indexes the doc view reads: explanations by anchor+kind, which
 * anchors are stale or unexplained (from /api/explain — the only honest staleness
 * signal in the browser), and the worst verdict stamped on each anchor.
 */
function buildReviewIndex() {
  const review = state.review || {};
  const explanations = new Map();
  for (const exp of review.explanations || []) {
    explanations.set(`${exp.anchor}\u0000${exp.kind}`, exp);
  }

  const stale = new Set();
  const missing = new Set();
  for (const task of state.explainTasks || []) {
    if (task.kind !== 'summary' && task.kind !== 'narration') continue;
    if (task.reason === 'stale') stale.add(task.anchor);
    else if (task.reason === 'missing') missing.add(task.anchor);
  }

  // Worst-wins per anchor, matching the server's HEAT_SEVERITY ordering, so a
  // 'blocking' from any author can never be hidden behind a later 'approved'.
  const stampByAnchor = new Map();
  for (const stamp of review.stamps || []) {
    const prev = stampByAnchor.get(stamp.anchor);
    if (!prev || VERDICT_SEVERITY[stamp.verdict] > VERDICT_SEVERITY[prev.verdict]) {
      stampByAnchor.set(stamp.anchor, stamp);
    }
  }

  // Agent-authored diagrams and the "no diagram warranted" skips, keyed by the doc
  // id they were authored for; plus the outstanding per-doc `diagram` explain task,
  // which is the browser's only honest signal of a doc's diagram state (stale /
  // missing). The doc structural hash cannot be recomputed here, so we trust the
  // task the server already derived from it.
  const diagramsByAnchor = new Map();
  for (const diagram of review.diagrams || []) {
    const list = diagramsByAnchor.get(diagram.anchor) || [];
    list.push(diagram);
    diagramsByAnchor.set(diagram.anchor, list);
  }
  const diagramSkipByAnchor = new Map();
  for (const skip of review.diagramSkips || []) {
    diagramSkipByAnchor.set(skip.anchor, skip);
  }
  const diagramTaskByAnchor = new Map();
  for (const task of state.explainTasks || []) {
    if (task.kind === 'diagram') diagramTaskByAnchor.set(task.anchor, task);
  }

  state.reviewIndex = {
    explanations,
    stale,
    missing,
    stampByAnchor,
    diagramsByAnchor,
    diagramSkipByAnchor,
    diagramTaskByAnchor,
  };
}

/** The agent-authored diagrams for a doc, in the order they were applied. */
function authoredDiagramsFor(docId) {
  const index = state.reviewIndex;
  return index ? index.diagramsByAnchor.get(docId) || [] : [];
}

/** The outstanding per-doc `diagram` explain task, if the doc's diagram state is stale/missing. */
function diagramTaskFor(docId) {
  const index = state.reviewIndex;
  return index ? index.diagramTaskByAnchor.get(docId) || null : null;
}

/** The agent's recorded "no diagram warranted" for a doc, if any. */
function diagramSkipFor(docId) {
  const index = state.reviewIndex;
  return index ? index.diagramSkipByAnchor.get(docId) || null : null;
}

function explanationFor(anchor, kind) {
  const index = state.reviewIndex;
  return index ? index.explanations.get(`${anchor}\u0000${kind}`) || null : null;
}

function verdictFor(anchor) {
  const index = state.reviewIndex;
  const stamp = index ? index.stampByAnchor.get(anchor) : null;
  return stamp ? stamp.verdict : null;
}

/** The honest gaps: unstated explanations, undefined terms, blocking/concern stamps. */
function openQuestions() {
  const review = state.review || {};
  const items = [];
  for (const exp of review.explanations || []) {
    if (exp.provenance === 'unstated') {
      items.push({
        group: 'unstated',
        anchor: exp.anchor,
        label: exp.anchorLabel,
        detail: exp.body,
      });
    }
  }
  for (const term of review.glossary || []) {
    if (!term.defined) {
      items.push({
        group: 'undefined',
        anchor: null,
        label: term.term,
        detail: 'used, never defined',
      });
    }
  }
  for (const stamp of review.stamps || []) {
    if (stamp.verdict === 'blocking' || stamp.verdict === 'concern') {
      items.push({
        group: stamp.verdict,
        anchor: stamp.anchor,
        label: stamp.anchorLabel,
        detail: stamp.note || '',
      });
    }
  }
  return items;
}

function currentDoc() {
  if (!state.model) return null;
  return state.model.docs.find((d) => d.id === state.docId) || null;
}

// ---------------------------------------------------------------- tree

function docMatchesFilter(doc) {
  if (!state.filter) return true;
  const needle = state.filter.toLowerCase();
  return (
    String(doc.title).toLowerCase().includes(needle) ||
    String(doc.path).toLowerCase().includes(needle)
  );
}

function renderTree() {
  els.tree.replaceChildren();
  if (!state.model) return;

  const byId = new Map(state.model.docs.map((d) => [d.id, d]));
  const seen = new Set();
  const sections = [];

  for (const group of state.model.groups || []) {
    const docs = (group.docIds || [])
      .map((id) => byId.get(id))
      .filter((d) => d && docMatchesFilter(d));
    for (const id of group.docIds || []) seen.add(id);
    if (docs.length) sections.push({ group, docs });
  }

  const loose = state.model.docs.filter((d) => !seen.has(d.id) && docMatchesFilter(d));
  if (loose.length) sections.push({ group: null, docs: loose });

  if (!sections.length) {
    els.tree.append(el('p', 'empty', state.filter ? 'No documents match.' : 'No documents found.'));
    return;
  }

  for (const section of sections) {
    els.tree.append(treeSection(section.group, section.docs));
  }
}

function treeSection(group, docs) {
  const wrap = el('div', 'tree-group');
  const head = el('div', 'tree-group-name');
  head.append(el('span', null, group ? group.name : 'Other documents'));
  if (group) {
    if (group.archived) head.append(el('span', 'badge badge-quiet', 'archived'));
    const count = openCountFor(group.id);
    if (count) head.append(noteBadge(count));
  }
  wrap.append(head);

  for (const doc of docs) {
    wrap.append(treeItem(doc));
    // The descriptive outline: when a doc is selected, list its requirements as
    // sub-nodes, each deep-linking to (and expanding) its card, with scent badges.
    if (doc.id === state.docId && (doc.requirements || []).length) {
      wrap.append(reqSubtree(doc));
    }
  }
  return wrap;
}

function treeItem(doc) {
  const item = button('', 'tree-doc');
  item.append(el('span', 'tree-doc-title', doc.title));
  if (doc.kind && doc.kind !== 'other') item.append(el('span', 'badge badge-quiet', doc.kind));
  const count = openCountFor(doc.id);
  if (count) item.append(noteBadge(count));
  item.setAttribute('aria-current', String(doc.id === state.docId));
  item.title = doc.path;
  item.addEventListener('click', () => {
    void selectDoc(doc.id);
  });
  return item;
}

/** The selected doc's requirements as a descriptive, badged outline of deep links. */
function reqSubtree(doc) {
  const wrap = el('div', 'tree-reqs');
  for (const req of doc.requirements || []) {
    const item = button('', 'tree-req');
    item.append(el('span', 'tree-req-name', req.name));
    const scn = (req.scenarios || []).length;
    if (scn) item.append(el('span', 'badge badge-quiet', String(scn)));
    if (req.delta) {
      const delta = el('span', 'badge badge-delta', req.delta);
      delta.dataset.delta = req.delta;
      item.append(delta);
    }
    const notes = openCountFor(req.id);
    if (notes) item.append(noteBadge(notes));
    const verdict = verdictFor(req.id);
    if (verdict) item.dataset.verdict = verdict;
    item.setAttribute('aria-current', String(req.id === state.anchor));
    item.title = req.name;
    item.addEventListener('click', () => void gotoAnchor(req.id, `${doc.title} › ${req.name}`));
    wrap.append(item);
  }
  return wrap;
}

// ---------------------------------------------------------------- anchors

/**
 * The anchor "hit" for a requirement or scenario — the same shape the old
 * heading-decorator produced, but read straight from the model instead of matched
 * against rendered headings. `explainKind` is the plain companion an anchor owns:
 * a requirement's `summary`, a scenario's step-by-step `narration`.
 */
function reqHit(doc, req) {
  return {
    anchor: req.id,
    name: req.name,
    label: `${doc.title} › ${req.name}`,
    explainKind: 'summary',
    delta: req.delta || null,
  };
}

function scnHit(doc, req, scn) {
  return {
    anchor: scn.id,
    name: scn.name,
    label: `${doc.title} › ${req.name} › ${scn.name}`,
    explainKind: 'narration',
    delta: null,
  };
}

/**
 * The selectable, badged heading for an anchor. Carries the same `.anchor-head`
 * contract the rest of the app queries on: `data-anchor`, an `.anchor-select`
 * button that opens discussion, note/delta scent badges, and the `data-selected`
 * / `data-verdict` state attributes updateAnchorHighlight and the review repaint
 * read back. Built from the model, so the descriptive name is the heading — never
 * "Requirement 4".
 */
function anchorHead(hit, tag) {
  const head = el(tag || 'h3', 'anchor-head');
  head.dataset.anchor = hit.anchor;

  const select = button(hit.name, 'anchor-select');
  select.setAttribute('aria-label', `Discuss ${hit.name}`);
  select.addEventListener('click', () => selectAnchor(hit.anchor, hit.label));
  head.append(select);

  if (hit.delta) {
    const delta = el('span', 'badge badge-delta', hit.delta);
    delta.dataset.delta = hit.delta;
    head.append(delta);
  }
  const count = openCountFor(hit.anchor);
  if (count) head.append(noteBadge(count));
  if (state.anchor === hit.anchor) head.dataset.selected = 'true';

  const verdict = verdictFor(hit.anchor);
  if (verdict) head.dataset.verdict = verdict;
  return head;
}

/**
 * The block that hangs under an anchored heading: the per-anchor action bar
 * (verdict + Ask/Request change/Affects/Copy) and the plain-language companion
 * with its provenance. Keeps the `.anchor-extra` contract the SSE review repaint
 * (`refreshReviewInDoc`) rebuilds in place.
 */
function anchorExtra(hit) {
  const extra = el('div', 'anchor-extra');
  extra.dataset.anchor = hit.anchor;
  extra.dataset.explainKind = hit.explainKind;
  extra.dataset.anchorLabel = hit.label;

  extra.append(actionBar(hit.anchor, hit.label));
  extra.append(plainCompanion(hit.anchor, hit.explainKind, hit.label));
  return extra;
}

/** CSS.escape shim for our anchor ids (which contain `:` and `/`). */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * A small, persistent "AI" affordance. Every plain companion, glossary definition
 * and decision is agent-authored, not source-of-truth spec text; this mark plus the
 * left rule / tint make that unmissable, so a reviewer never mistakes the two.
 */
function aiMark() {
  const mark = el('span', 'ai-mark', 'AI');
  mark.title = 'Written by the agent, not the spec. Check its provenance.';
  mark.setAttribute('aria-label', 'agent-authored');
  return mark;
}

/**
 * The plain-language companion for one anchor. Grounded honesty throughout: if an
 * explanation exists we show it with its provenance (and a stale flag when
 * /api/explain reports the spec changed under it); if none exists we show a quiet,
 * non-nagging pull hint — never invented prose.
 */
function plainCompanion(anchor, kind, label) {
  const explanation = explanationFor(anchor, kind);
  const noun = kind === 'narration' ? 'scenario' : 'requirement';

  // Missing summary: it is already on the agent's `explain` list, so the honest
  // copy says so — the button is a way to prioritise or add detail, not the only
  // path. Posting it queues a real request the in-loop agent will pick up.
  if (!explanation) {
    const hint = el('div', 'plain-layer plain-hint');
    const hintHead = el('div', 'plain-head');
    hintHead.append(aiMark());
    hintHead.append(el('span', 'plain-label', 'Not yet explained'));
    hint.append(hintHead);
    hint.append(
      el(
        'div',
        'plain-hint-line',
        `Not yet explained. The agent will summarize this ${noun}; ` +
          'request to prioritise or add detail.'
      )
    );
    const actions = el('div', 'plain-actions');
    const request = button('Request explanation', 'plain-action');
    request.addEventListener(
      'click',
      () =>
        void requestFromPlain(
          request,
          anchor,
          label,
          'question',
          `Please write a plain-language summary of this ${noun}.`
        )
    );
    actions.append(request);
    hint.append(actions);
    return hint;
  }

  // An `unstated` body is a gap, not a settled fact: relabel it "Open question"
  // and frame the body as the question it is, matching how the glossary treats
  // undefined terms. A confident, fact-shaped sentence must never read as a
  // real summary just because the small provenance chip says otherwise.
  const unstated = explanation.provenance === 'unstated';
  const heading = unstated ? 'Open question' : kind === 'narration' ? 'Narration' : 'Plain summary';

  const box = el('div', unstated ? 'plain-layer plain-unstated' : 'plain-layer');
  const head = el('div', 'plain-head');
  head.append(aiMark());
  head.append(el('span', 'plain-label', heading));
  head.append(provenanceBadge(explanation.provenance));
  const index = state.reviewIndex;
  const stale = !!(index && index.stale.has(anchor));
  if (stale) {
    const badge = el('span', 'badge badge-stale', 'stale');
    badge.title = 'The spec changed since this was written. Re-run spec-scope explain.';
    head.append(badge);
  }
  box.append(head);

  // textContent, never innerHTML: review content is untrusted (a committed
  // review.json on a public repo is attacker-controlled).
  const body = unstated ? `The spec does not state this — ${explanation.body}` : explanation.body;
  box.append(el('div', 'plain-body', body));

  const sources = sourceList(explanation.sources);
  if (sources) box.append(sources);

  // Make every AI claim interactive: refresh a stale one, dispute an inferred
  // reading, or just ask about a grounded/unstated companion. Each is one click.
  const actions = el('div', 'plain-actions');
  if (stale) {
    const refresh = button('Request refresh', 'plain-action');
    refresh.addEventListener(
      'click',
      () =>
        void requestFromPlain(
          refresh,
          anchor,
          label,
          'change',
          'This explanation is stale — please rewrite it for the current spec text.'
        )
    );
    actions.append(refresh);
  }
  if (explanation.provenance === 'inferred') {
    const dispute = button('Dispute / ask', 'plain-action');
    dispute.addEventListener(
      'click',
      () => void requestFromPlain(dispute, anchor, label, 'question', 'Is this reading correct?')
    );
    actions.append(dispute);
  } else {
    const ask = button('Ask about this', 'link plain-ask');
    ask.addEventListener('click', () => startComposer(anchor, label, 'question'));
    actions.append(ask);
  }
  if (actions.childElementCount) box.append(actions);
  return box;
}

/** Source references as deep-links back into the doc, with any quoted fragment. */
function sourceList(sources) {
  if (!Array.isArray(sources) || !sources.length) return null;
  const wrap = el('div', 'plain-sources');
  wrap.append(el('span', 'plain-label', 'Sources'));
  for (const source of sources) {
    wrap.append(sourceRef(source));
  }
  return wrap;
}

function sourceRef(source) {
  const item = el('span', 'source-ref');
  const label = source.label || source.anchor || source.kind;
  if (source.anchor && /\/req:|\/scn:/.test(source.anchor)) {
    const link = button(label, 'source-link');
    link.addEventListener('click', () => void gotoAnchor(source.anchor, label));
    item.append(link);
  } else {
    item.append(el('span', null, label));
  }
  if (source.quote) item.append(el('span', 'source-quote', source.quote));
  return item;
}

// ---------------------------------------------------------------- review stamps

const VERDICT_ORDER = ['understood', 'concern', 'blocking', 'approved'];

/**
 * The per-anchor action bar: a persistent verdict chip (always visible, so review
 * state reads at a glance) plus a light row of actions — Ask, Request change, a
 * four-way verdict group, Affects, Copy link — that the CSS reveals on hover or
 * keyboard focus. Every action is a real <button> in the tab order, so the bar is
 * fully operable from the keyboard even while it reads as quiet.
 */
function actionBar(anchor, label) {
  const bar = el('div', 'anchor-bar');

  // Always visible: the current verdict, so a stamped anchor never looks blank.
  const chipSlot = el('span', 'anchor-bar-verdict');
  const current = verdictFor(anchor);
  if (current) chipSlot.append(verdictChip(current));
  bar.append(chipSlot);

  const actions = el('div', 'anchor-bar-actions');

  const ask = actionButton('Ask', '?', `Ask the agent a question about ${label}`);
  ask.addEventListener('click', () => startComposer(anchor, label, 'question'));
  actions.append(ask);

  const change = actionButton('Request change', '✎', `Request a change to ${label}`);
  change.addEventListener('click', () => startComposer(anchor, label, 'change'));
  actions.append(change);

  actions.append(verdictGroup(anchor, label));

  const affects = actionButton('Affects', '❋', `Show what ${label} affects`);
  affects.addEventListener('click', () => void openBlast(anchor, label));
  actions.append(affects);

  const copy = actionButton('Copy link', '⧉', `Copy a link to ${label}`);
  copy.addEventListener('click', () => void copyAnchorLink(anchor));
  actions.append(copy);

  bar.append(actions);
  return bar;
}

/** A compact icon+label action button; the label is the signal, the glyph decorative. */
function actionButton(label, glyph, aria) {
  const node = button('', 'abtn');
  if (glyph) node.append(el('span', 'abtn-glyph', glyph));
  node.append(el('span', null, label));
  if (aria) node.setAttribute('aria-label', aria);
  return node;
}

/**
 * The four verdicts as a one-click toggle group. Clicking a verdict upserts the
 * stamp; clicking the one already set clears it (DELETE), so the group both sets
 * and unsets. `aria-pressed` carries the active state for assistive tech, and each
 * chip keeps its glyph + word so colour is never the only signal.
 */
function verdictGroup(anchor, label) {
  const current = verdictFor(anchor);
  const group = el('div', 'verdict-group');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `Verdict for ${label}`);
  for (const verdict of VERDICT_ORDER) {
    const item = button('', 'verdict-btn');
    item.append(verdictChip(verdict));
    const active = current === verdict;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-pressed', String(active));
    item.title = active ? `Clear ${VERDICTS[verdict].label}` : `Mark ${VERDICTS[verdict].label}`;
    item.addEventListener('click', () => {
      if (verdictFor(anchor) === verdict) {
        const stamp = state.reviewIndex && state.reviewIndex.stampByAnchor.get(anchor);
        if (stamp) void clearStamp(stamp.id);
      } else {
        void setStamp(anchor, label, verdict);
      }
    });
    group.append(item);
  }
  return group;
}

/** Selects the anchor, opens the discussion composer pre-set to a kind, and focuses it. */
function startComposer(anchor, label, kind) {
  selectAnchor(anchor, label);
  if (els.composerKind) els.composerKind.value = kind;
  els.composerBody.focus();
}

/** Copies a deep link to an anchor; the boot hash-handler makes the link navigable. */
async function copyAnchorLink(anchor) {
  const url = `${location.origin}${location.pathname}#anchor=${enc(anchor)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    toast(`Copy this link: ${url}`);
  }
}

/**
 * Posts a canned request note from the plain layer and swaps the trigger for a
 * quiet "requested" acknowledgement. Honest about the loop: the note queues for
 * the in-loop agent, which fills the gap and pushes a live update back here.
 */
async function requestFromPlain(trigger, anchor, label, kind, body) {
  trigger.disabled = true;
  try {
    await postJson('/api/notes', { anchor, anchorLabel: label || anchor, kind, body });
    await refreshNotes();
    const done = el('span', 'plain-requested');
    done.append(el('span', 'abtn-glyph', '⏳'));
    done.append(el('span', null, 'Requested — the agent will fill this in.'));
    trigger.replaceWith(done);
    toast('Request sent to the agent');
  } catch (err) {
    trigger.disabled = false;
    toast(`Could not send request: ${err.message}`);
  }
}

async function setStamp(anchor, anchorLabel, verdict) {
  try {
    await postJson('/api/stamps', { anchor, anchorLabel, verdict });
    await refreshReview();
    toast(`Marked ${VERDICTS[verdict].label}`);
  } catch (err) {
    toast(`Could not stamp: ${err.message}`);
  }
}

async function clearStamp(id) {
  try {
    await api(`/api/stamps/${enc(id)}`, { method: 'DELETE' });
    await refreshReview();
    toast('Verdict cleared');
  } catch (err) {
    toast(`Could not clear: ${err.message}`);
  }
}

function updateAnchorHighlight() {
  for (const heading of els.doc.querySelectorAll('.anchor-head')) {
    heading.dataset.selected = String(heading.dataset.anchor === state.anchor);
  }
}

/** Repaint note badges in place, so a notes event does not rebuild the doc. */
function refreshBadges() {
  for (const heading of els.doc.querySelectorAll('.anchor-head')) {
    // The doc header reuses `.anchor-head` purely for its flex layout and owns
    // no anchor. Without this guard its badge would be stripped and never
    // restored, because openCountFor(undefined) always counts zero.
    if (!heading.dataset.anchor) continue;
    for (const badge of heading.querySelectorAll('.badge-notes')) badge.remove();
    const count = openCountFor(heading.dataset.anchor);
    if (count) heading.append(noteBadge(count));
  }
  renderTree();
}

// ---------------------------------------------------------------- diagrams

function diagramsForDoc(doc) {
  const own = state.diagrams.filter((d) => isUnder(d.anchor, doc.id));
  if (!doc.groupId) return own;
  // Group-level overviews would otherwise repeat on every doc in the group.
  const group = (state.model.groups || []).find((g) => g.id === doc.groupId);
  const isFirst = group && (group.docIds || [])[0] === doc.id;
  if (!isFirst) return own;
  return [...state.diagrams.filter((d) => d.anchor === doc.groupId), ...own];
}

function diagramCard(diagram) {
  const card = el('section', 'diagram');

  const head = el('div', 'diagram-head');
  head.append(el('span', 'diagram-title', diagram.title));
  const actions = el('div', 'diagram-actions');
  const toggle = button('Show source');
  const copy = button('Copy');
  actions.append(toggle, copy);
  head.append(actions);

  const body = el('div', 'diagram-body');
  // Tag the slot so a stamp change can find and re-render the heat map in place,
  // even when this card first rendered as the plain map with zero stamps.
  if (diagram.kind) body.dataset.diagramKind = diagram.kind;
  if (diagram.anchor) body.dataset.diagramAnchor = diagram.anchor;
  body.append(el('p', 'empty', 'Rendering…'));

  const source = el('pre', 'diagram-source');
  source.append(el('code', null, diagram.mermaid));
  source.hidden = true;

  let sourceVisible = false;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    sourceVisible = !sourceVisible;
    source.hidden = !sourceVisible;
    body.hidden = sourceVisible;
    toggle.textContent = sourceVisible ? 'Show diagram' : 'Show source';
    toggle.setAttribute('aria-expanded', String(sourceVisible));
  });
  copy.addEventListener('click', () => {
    void copyText(diagram.mermaid, copy, source);
  });

  card.append(head, body, source);
  return { card, body };
}

async function copyText(text, trigger, fallbackNode) {
  const original = trigger.textContent;
  try {
    await navigator.clipboard.writeText(text);
    trigger.textContent = 'Copied';
  } catch {
    // The clipboard API needs a secure context; http://127.0.0.1 qualifies in
    // Chrome and Firefox but not everywhere. Select the text so Ctrl+C works.
    fallbackNode.hidden = false;
    const range = document.createRange();
    range.selectNodeContents(fallbackNode);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    trigger.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => {
    trigger.textContent = original;
  }, 1800);
}

/** Renders one diagram; a failure becomes an inline card, never a blank page. */
async function drawDiagram(container, diagram) {
  const id = `mmd-${(state.diagramSeq += 1)}`;
  try {
    const result = await mermaid.render(id, diagram.mermaid);
    container.replaceChildren();
    // Trusted: this SVG is mermaid's own output from our generated source, and
    // mermaid runs with securityLevel 'strict'.
    container.innerHTML = result.svg;
  } catch (err) {
    container.replaceChildren();
    const box = el('div', 'diagram-error');
    box.append(el('strong', null, 'Diagram failed to render.'));
    box.append(el('div', null, (err && err.message) || String(err)));
    box.append(el('div', null, 'Use “Show source” to inspect the Mermaid definition.'));
    container.append(box);
  } finally {
    // mermaid leaves a scratch node behind when a parse throws. On success the
    // rendered SVG's root element carries this same `id` and now lives INSIDE the
    // container, so we must only remove scratch nodes that landed elsewhere —
    // otherwise this loop deletes the diagram we just inserted and cards go blank.
    for (const orphan of [document.getElementById(id), document.getElementById(`d${id}`)]) {
      if (orphan && !container.contains(orphan)) orphan.remove();
    }
  }
}

// ---------------------------------------------------------------- authored diagrams

/*
 * The high-value diagrams the in-loop agent authored (a state machine, an ER, an
 * endpoint sequence) — the agent's judgement, not a mechanical per-scenario reflex.
 * They render prominently right below the doc digest, with the AI treatment (left
 * rule + "AI" mark), a typed badge, provenance, a stale marker driven by the
 * server's `diagram` explain task, and the one-line trigger that earned them.
 */

/** Type badge metadata: a glyph + a word, so the type reads without relying on colour. */
const DIAGRAM_TYPE_META = {
  state: { glyph: '◉', label: 'state' },
  er: { glyph: '▤', label: 'ER' },
  sequence: { glyph: '⇄', label: 'sequence' },
  flowchart: { glyph: '◇', label: 'flowchart' },
  class: { glyph: '❏', label: 'class' },
};

/** A small, accessible diagram-type chip; colour is redundant to the glyph + label. */
function diagramTypeBadge(type) {
  const known = Object.prototype.hasOwnProperty.call(DIAGRAM_TYPE_META, type);
  const meta = known ? DIAGRAM_TYPE_META[type] : { glyph: '◆', label: String(type || 'diagram') };
  const chip = el('span', `diagram-type diagram-type-${known ? type : 'other'}`);
  chip.append(el('span', 'diagram-type-glyph', meta.glyph));
  chip.append(el('span', null, meta.label));
  chip.title = `Authored ${meta.label} diagram`;
  chip.setAttribute('aria-label', `diagram type: ${meta.label}`);
  return chip;
}

/**
 * One authored diagram as a card: an AI-marked caption (type + provenance + stale
 * badges + title), the Mermaid rendered through the shared `drawDiagram` path (so a
 * bad diagram becomes an inline error card, never a blank page), Show source / Copy,
 * and the one-line trigger in muted text. Returns the card and its render slot.
 */
function authoredDiagramCard(diagram, stale) {
  const card = el('section', 'diagram diagram-authored');
  if (stale) card.dataset.stale = 'true';

  const head = el('div', 'diagram-head diagram-authored-head');
  const caption = el('div', 'diagram-caption');
  caption.append(aiMark());
  caption.append(diagramTypeBadge(diagram.type));
  caption.append(provenanceBadge(diagram.provenance));
  if (stale) {
    const badge = el('span', 'badge badge-stale', 'stale');
    badge.title =
      'The spec structure changed after this diagram was drawn. Re-run spec-scope explain.';
    caption.append(badge);
  }
  // textContent, never innerHTML: a review.json title is untrusted (a public repo's
  // committed review is attacker-controlled), so a <script> in it stays inert.
  caption.append(el('span', 'diagram-title', diagram.title));
  head.append(caption);

  const actions = el('div', 'diagram-actions');
  const toggle = button('Show source');
  const copy = button('Copy');
  actions.append(toggle, copy);
  head.append(actions);

  const body = el('div', 'diagram-body');
  body.append(el('p', 'empty', 'Rendering…'));

  const source = el('pre', 'diagram-source');
  source.append(el('code', null, diagram.mermaid));
  source.hidden = true;

  let sourceVisible = false;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    sourceVisible = !sourceVisible;
    source.hidden = !sourceVisible;
    body.hidden = sourceVisible;
    toggle.textContent = sourceVisible ? 'Show diagram' : 'Show source';
    toggle.setAttribute('aria-expanded', String(sourceVisible));
  });
  copy.addEventListener('click', () => {
    void copyText(diagram.mermaid, copy, source);
  });

  card.append(head, body);
  const trigger = String(diagram.trigger || '').trim();
  if (trigger) {
    const why = el('p', 'diagram-trigger');
    why.append(el('span', 'diagram-trigger-label', 'Why'));
    why.append(el('span', null, trigger));
    card.append(why);
  }
  card.append(source);
  return { card, body };
}

/**
 * The quiet, honest pull affordance for a doc that has an outstanding `diagram`
 * task and no authored diagram yet: the agent decides whether the structure earns
 * one, and draws it or records that prose is clearer. A request queues a real note
 * anchored to the doc, exactly like the plain-layer "Request explanation" button.
 */
function needsDiagramAffordance(doc) {
  const box = el('div', 'diagram-needed');
  const head = el('div', 'plain-head');
  head.append(aiMark());
  head.append(el('span', 'plain-label', 'No authored diagram yet'));
  box.append(head);
  box.append(
    el(
      'div',
      'plain-hint-line',
      'No authored diagram yet — the agent decides whether this document’s structure ' +
        'warrants one (a state machine, a data model, an endpoint flow) and draws it, ' +
        'or records that prose is clearer.'
    )
  );
  const actions = el('div', 'plain-actions');
  const request = button('Request a diagram', 'plain-action');
  request.addEventListener(
    'click',
    () =>
      void requestFromPlain(
        request,
        doc.id,
        doc.title,
        'question',
        'Please review this document for a diagram-worthy structure and author one if warranted.'
      )
  );
  actions.append(request);
  box.append(actions);
  return box;
}

/** A tiny, non-nagging note for a doc the agent judged needs no diagram. */
function diagramSkipNote(skip) {
  const note = el('div', 'diagram-skip-note');
  note.append(el('span', 'diagram-skip-glyph', '¶'));
  const reason = String(skip.reason || '').trim();
  note.append(
    el(
      'span',
      null,
      reason ? `Prose only — no diagram needed (${reason}).` : 'Prose only — no diagram needed.'
    )
  );
  return note;
}

/**
 * A cheap change signature over a doc's authored-diagram state, so a live review
 * event (which fires on every verdict stamp too) only re-renders these diagrams when
 * their content, provenance, staleness or the pending task actually changed — never
 * on an unrelated stamp.
 */
function authoredDiagramSignature(doc) {
  const authored = authoredDiagramsFor(doc.id);
  const task = diagramTaskFor(doc.id);
  const skip = diagramSkipFor(doc.id);
  const parts = authored.map(
    (d) =>
      `${d.id}:${d.specHash}:${d.provenance}:${d.type}:${String(d.title).length}:${String(d.trigger).length}:${String(d.mermaid).length}`
  );
  parts.push(`task:${task ? task.reason : ''}`);
  parts.push(`skip:${skip ? skip.specHash : ''}`);
  return parts.join('|');
}

/**
 * The authored-diagrams block for a doc, or null when there is nothing to show (no
 * authored diagram, no pending task, no skip). Authored diagrams render eagerly and
 * sequentially — they are few and high-value, so unlike the derived maps they are
 * not hidden behind a disclosure — guarded by `seq` so a slow render can never land
 * in a view a newer render replaced. A stale authored diagram renders WITH its stale
 * marker; only a doc with none falls through to the affordance or the skip note.
 */
function authoredDiagramsSection(doc, seq) {
  const authored = authoredDiagramsFor(doc.id);
  const task = diagramTaskFor(doc.id);
  const skip = diagramSkipFor(doc.id);
  const stale = !!(task && task.reason === 'stale');

  if (!authored.length && !task && !skip) return null;

  const section = el('section', 'authored-diagrams');
  section.dataset.sig = authoredDiagramSignature(doc);

  const head = el('div', 'authored-diagrams-head');
  head.append(el('h3', null, 'Diagrams'));
  const eyebrow = el('span', 'authored-eyebrow');
  eyebrow.append(aiMark());
  eyebrow.append(el('span', null, 'authored by the agent'));
  head.append(eyebrow);
  section.append(head);

  if (authored.length) {
    const holder = el('div', 'authored-diagrams-holder');
    section.append(holder);
    const cards = [];
    for (const diagram of authored) {
      const { card, body } = authoredDiagramCard(diagram, stale);
      holder.append(card);
      cards.push({ body, diagram });
    }
    // Sequential on purpose: mermaid mutates shared document state per render.
    void (async () => {
      for (const entry of cards) {
        if (seq !== state.renderSeq) return; // a newer render took over
        await drawDiagram(entry.body, entry.diagram);
      }
    })();
  } else if (task) {
    section.append(needsDiagramAffordance(doc));
  } else if (skip) {
    section.append(diagramSkipNote(skip));
  }
  return section;
}

/**
 * In-place live refresh of the authored-diagrams block for the current doc, so an
 * agent that just authored (or updated) one appears with a flash, without rebuilding
 * `#doc`. Sig-gated so the common case — an unrelated stamp firing a review event —
 * does nothing and the mermaid SVGs are not needlessly re-rendered.
 */
function refreshAuthoredDiagrams(doc) {
  const seq = state.renderSeq;
  const old = els.doc.querySelector('.authored-diagrams');
  const sig = authoredDiagramSignature(doc);
  if (old && old.dataset.sig === sig) return;
  const fresh = authoredDiagramsSection(doc, seq);
  if (old && fresh) {
    old.replaceWith(fresh);
    flashNode(fresh);
  } else if (old && !fresh) {
    old.remove();
  } else if (fresh) {
    // Newly appeared (first authored diagram / task): slot it right below the digest
    // card, falling back to just under the doc header.
    const digest = els.doc.querySelector('.digest-card');
    const header = els.doc.querySelector('.doc-header');
    const anchor = digest || header;
    if (anchor) anchor.after(fresh);
    else els.doc.append(fresh);
    flashNode(fresh);
  }
}

// ---------------------------------------------------------------- hover-sync

/**
 * Each step's Given/When/Then lane plus its 0-based sequence-message ordinal (-1 when
 * the step is a GIVEN note with no arrow). This is the SAME rule the server's diagram
 * generator uses (src/diagram.ts stepModes): GIVEN=note→given lane, WHEN=request→when
 * lane, THEN=response→then lane, and AND/BUT carry the previous step's lane forward
 * (so an AND after a GIVEN stays a precondition). Computed from the parsed model, so
 * the browser never re-derives which bullet is a step, and the ordinals line up with
 * the arrows the server emits.
 */
function stepLaneInfo(steps) {
  const out = [];
  let lane = 'when'; // matches the server's initial 'request' mode
  let ordinal = 0;
  for (const step of steps || []) {
    const keyword = String(step.keyword || '').toUpperCase();
    if (keyword === 'GIVEN') lane = 'given';
    else if (keyword === 'WHEN') lane = 'when';
    else if (keyword === 'THEN') lane = 'then';
    // AND/BUT inherit the current lane.
    const isMessage = lane !== 'given';
    out.push({ lane, msgIndex: isMessage ? ordinal++ : -1 });
  }
  return out;
}

/**
 * Links a scenario's Given/When/Then step rows to its rendered sequence diagram:
 * hovering a message row highlights the matching autonumbered arrow, and vice-versa.
 * The rows and their message ordinals come from the authoritative parsed model
 * (`stepLaneInfo`), so the Nth message row maps to the Nth arrow; if the message-row
 * count and the rendered arrow count disagree the mapping is uncertain, so nothing is
 * wired rather than a wrong arrow.
 */
function wireScenarioHover(container, stepRows) {
  const svg = container.querySelector('svg');
  if (!svg || !stepRows.length) return;
  const messages = [...svg.querySelectorAll('.messageText')];
  if (messages.length !== stepRows.length) return;

  stepRows.forEach(({ el: row, msgIndex }) => {
    const msg = messages[msgIndex];
    if (!msg) return;
    const on = () => {
      row.classList.add('step-active');
      msg.classList.add('msg-active');
    };
    const off = () => {
      row.classList.remove('step-active');
      msg.classList.remove('msg-active');
    };
    row.addEventListener('mouseenter', on);
    row.addEventListener('mouseleave', off);
    msg.addEventListener('mouseenter', on);
    msg.addEventListener('mouseleave', off);
  });
}

// ---------------------------------------------------------------- heat map

/**
 * Swaps the plain requirement map for the server-rendered heat map once any stamp
 * exists. The heat map is tinted by anchor id server-side (never re-derived from node
 * label text, which collides on same-named requirements), so it cannot fabricate a
 * verdict on a node the reviewer never stamped. Every other diagram passes through.
 */
async function resolveDiagram(diagram, doc) {
  if (diagram.kind !== 'requirement-map' || diagram.anchor !== doc.id) return diagram;
  const stamps = (state.review && state.review.stamps) || [];
  if (!stamps.length) return diagram;
  try {
    const data = await api(`/api/heatmap?doc=${enc(doc.id)}`);
    if (data && typeof data.mermaid === 'string' && data.mermaid) {
      return { ...diagram, mermaid: data.mermaid };
    }
  } catch {
    // Server unreachable or errored: fall back to the plain map.
  }
  return diagram;
}

/**
 * Re-renders the requirement-map slot after a stamp change, without rebuilding the
 * doc. With stamps it fetches the freshly tinted server heat map; with none it
 * restores the plain map, so clearing the last stamp reverts the tint.
 */
async function refreshHeatMap(slot, doc) {
  const stamps = (state.review && state.review.stamps) || [];
  if (!stamps.length) {
    const plain = state.diagrams.find((d) => d.kind === 'requirement-map' && d.anchor === doc.id);
    if (plain) await drawDiagram(slot, { mermaid: plain.mermaid });
    return;
  }
  try {
    const data = await api(`/api/heatmap?doc=${enc(doc.id)}`);
    if (data && typeof data.mermaid === 'string' && data.mermaid) {
      await drawDiagram(slot, { mermaid: data.mermaid });
    }
  } catch {
    // Keep the current render on a transient failure.
  }
}

// ---------------------------------------------------------------- document

async function renderDoc() {
  const seq = (state.renderSeq += 1);
  const doc = currentDoc();
  els.doc.replaceChildren();

  if (!doc) {
    // Warnings first, unconditionally: for an empty project the only signal is a
    // warning like "no Markdown files found under .", and the old early return
    // dropped it, leaving a dead "select a document" page with nothing to select.
    if (state.model && state.model.warnings && state.model.warnings.length) {
      els.doc.append(warningsBox(state.model.warnings));
    }
    if (!state.model || !state.model.docs.length) {
      els.doc.append(emptyStateBox());
    } else {
      els.doc.append(el('p', 'empty', 'Select a document from the sidebar.'));
    }
    return;
  }

  if (state.model.warnings && state.model.warnings.length) {
    els.doc.append(warningsBox(state.model.warnings));
  }

  const header = el('div', 'doc-header');
  header.append(el('h2', null, doc.title));
  header.append(el('div', 'doc-path', doc.path));
  if (doc.kind && doc.kind !== 'other') {
    const meta = el('div', 'doc-header-meta');
    meta.append(el('span', 'badge badge-quiet', doc.kind));
    header.append(meta);
  }
  els.doc.append(header);

  // Docs exist but nothing has been summarized yet: a friendly, honest nudge to
  // ask the agent to prepare the review — never a button that pretends to run AI.
  if (!reviewHasContent()) els.doc.append(reviewOnboarding());

  // BLUF: the at-a-glance digest a scanner reads before any formal text.
  const digest = docDigestCard(doc);
  if (digest) els.doc.append(digest);

  // The agent's authored diagrams (the high-value ones) sit prominently right below
  // the digest — above the requirement cards, distinct from the derived maps that
  // live behind an on-demand disclosure at the foot of the doc.
  const authoredSection = authoredDiagramsSection(doc, seq);
  if (authoredSection) els.doc.append(authoredSection);

  const requirements = doc.requirements || [];
  if (requirements.length) {
    // Human-authored intro prose (a Purpose / overview) is normative context, not
    // AI, and the parser does not fold it into any req.text — render it once, up
    // front, so nothing is lost.
    const intro = docIntro(doc);
    if (intro) els.doc.append(intro);

    const list = el('div', 'req-cards');
    let prevDelta = null;
    for (const req of requirements) {
      if (req.delta && req.delta !== prevDelta) list.append(deltaGroupLabel(req.delta));
      if (req.delta) prevDelta = req.delta;
      list.append(requirementCard(doc, req));
    }
    els.doc.append(list);
  } else {
    // A pure-prose doc (proposal / plan / design / tasks) has no requirements to
    // card up: render its Markdown faithfully, exactly as before.
    const body = el('article', 'doc-body');
    body.append(renderMarkdown(doc.markdown));
    els.doc.append(body);
  }

  // Diagrams are an on-demand layer: the structural maps (requirement / heat map,
  // task flow, group overview) live behind one disclosure so Digest mode does not
  // dump them; the per-scenario sequences live inside their scenario cards.
  const docDiagrams = diagramsForDoc(doc).filter((d) => d.kind !== 'sequence');
  if (docDiagrams.length) els.doc.append(docDiagramsSection(doc, docDiagrams, seq));
}

/** A scannable group label (ADDED / MODIFIED / …) shown when a delta section starts. */
function deltaGroupLabel(delta) {
  const label = el('div', 'delta-group-label');
  const badge = el('span', 'badge badge-delta', delta);
  badge.dataset.delta = delta;
  label.append(badge);
  label.append(el('span', 'delta-group-word', `${delta.toLowerCase()} requirements`));
  return label;
}

/** True when a requirement card should render expanded (Full mode, or opened by hand). */
function isCardExpanded(anchor) {
  return state.density === 'full' || state.expandedCards.has(anchor);
}

/**
 * A requirement as a summary-first, one-click card. The FACE — always visible —
 * carries the descriptive heading, scent badges (scenario count, delta, notes,
 * verdict), the per-anchor action bar and the plain-language summary with its
 * provenance (or the honest "not yet explained" affordance). The formal requirement
 * text and the scenarios (as Given/When/Then lanes) sit one click behind, built
 * eagerly but hidden, so every existing query and the SSE repaint work in either
 * state. Disclosure is capped at ONE level: scenarios show inline when the card opens.
 */
function requirementCard(doc, req) {
  const hit = reqHit(doc, req);
  const card = el('section', 'req-card');
  card.dataset.anchor = req.id;
  const expanded = isCardExpanded(req.id);
  card.dataset.expanded = String(expanded);

  const head = anchorHead(hit, 'h3');
  const scenarios = req.scenarios || [];
  if (scenarios.length) {
    head.append(
      el(
        'span',
        'badge badge-quiet',
        `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`
      )
    );
  }
  card.append(head);
  card.append(anchorExtra(hit));

  // Detail (formal text + scenarios), built now, revealed on expand.
  const detail = el('div', 'req-detail');
  detail.id = `req-detail-${(detailSeq += 1)}`;
  detail.hidden = !expanded;
  if (req.text) detail.append(formalTextBlock(req.text));
  for (const scn of scenarios) detail.append(scenarioBlock(doc, req, scn));

  const toggle = button('', 'req-disclosure');
  toggle.setAttribute('aria-controls', detail.id);
  const setLabel = (open) => {
    const tail = scenarios.length
      ? ` & ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`
      : '';
    toggle.textContent = open ? 'Hide formal text' : `Show formal text${tail}`;
    toggle.setAttribute('aria-expanded', String(open));
  };
  setLabel(expanded);
  toggle.addEventListener('click', () => {
    const open = detail.hidden;
    detail.hidden = !open;
    card.dataset.expanded = String(open);
    if (open) state.expandedCards.add(req.id);
    else state.expandedCards.delete(req.id);
    setLabel(open);
  });

  card.append(toggle, detail);
  return card;
}

/** The normative requirement text — source-of-truth, styled distinctly from AI prose. */
function formalTextBlock(markdown) {
  const box = el('div', 'req-formal');
  const tag = el('span', 'req-formal-tag', 'Spec text');
  tag.title = 'The exact requirement text from the spec — the source of truth.';
  box.append(tag);
  const body = el('div', 'doc-body req-formal-body');
  body.append(renderMarkdown(markdown));
  box.append(body);
  return box;
}

/**
 * One scenario inside an expanded card: its selectable heading + action bar +
 * narration companion, then its steps as Given/When/Then lanes, then an on-demand
 * sequence diagram. Kept attached to its requirement (never detached) and given no
 * collapse of its own, so the whole scenario reads at one disclosure level.
 */
function scenarioBlock(doc, req, scn) {
  const hit = scnHit(doc, req, scn);
  const block = el('section', 'scenario');
  block.dataset.anchor = scn.id;

  block.append(anchorHead(hit, 'h4'));
  block.append(anchorExtra(hit));

  const { lanes, stepRows } = gwtLanes(scn.steps || []);
  block.append(lanes);

  const diagram = state.diagrams.find((d) => d.kind === 'sequence' && d.anchor === scn.id);
  if (diagram && (scn.steps || []).length) block.append(scenarioDiagram(diagram, stepRows));

  return block;
}

/**
 * A scenario's steps as three labeled lanes — Given (preconditions), When (triggers),
 * Then (outcomes) — with the keyword as the visual anchor. Lane assignment follows the
 * server's step modes exactly (`stepLaneInfo`), and each message row carries its arrow
 * ordinal for hover-sync. Returns the lanes element and the tagged rows.
 */
function gwtLanes(steps) {
  const info = stepLaneInfo(steps);
  const lanes = el('div', 'gwt');
  const shells = { given: laneShell('Given'), when: laneShell('When'), then: laneShell('Then') };
  const stepRows = [];

  steps.forEach((step, i) => {
    const { lane, msgIndex } = info[i];
    const row = el('div', 'gwt-step');
    row.append(el('span', 'gwt-kw', String(step.keyword || '').toUpperCase()));
    if (step.actor) row.append(el('span', 'gwt-actor', step.actor));
    row.append(el('span', 'gwt-text', step.text));
    if (msgIndex >= 0) {
      row.dataset.msgIndex = String(msgIndex);
      row.classList.add('step-li');
      stepRows.push({ el: row, msgIndex });
    }
    shells[lane].body.append(row);
  });

  for (const key of ['given', 'when', 'then']) {
    if (shells[key].body.childElementCount) lanes.append(shells[key].wrap);
  }
  if (!lanes.childElementCount) lanes.append(el('p', 'empty', 'No steps defined.'));
  return { lanes, stepRows };
}

function laneShell(label) {
  const wrap = el('div', `gwt-lane gwt-${label.toLowerCase()}`);
  wrap.append(el('div', 'gwt-lane-label', label));
  const body = el('div', 'gwt-lane-body');
  wrap.append(body);
  return { wrap, body };
}

/**
 * A scenario's sequence diagram, rendered on demand — never dumped by default. On
 * first reveal it draws the diagram (reusing the diagram card's Show source / Copy)
 * and wires hover-sync between the Given/When/Then rows and the arrows.
 */
function scenarioDiagram(diagram, stepRows) {
  const wrap = el('div', 'scenario-diagram');
  const toggle = button('Show diagram', 'scenario-diagram-toggle');
  toggle.setAttribute('aria-expanded', 'false');
  const holder = el('div', 'scenario-diagram-holder');
  holder.hidden = true;
  let built = false;
  toggle.addEventListener('click', async () => {
    const open = holder.hidden;
    holder.hidden = !open;
    toggle.textContent = open ? 'Hide diagram' : 'Show diagram';
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !built) {
      built = true;
      const { card, body } = diagramCard(diagram);
      holder.append(card);
      await drawDiagram(body, diagram);
      wireScenarioHover(body, stepRows);
    }
  });
  wrap.append(toggle, holder);
  return wrap;
}

/**
 * The doc-level digest card: a BLUF header a scanner reads first — an optional
 * agent-authored overview (badged AI), the counts, the review roll-up, and the doc's
 * open questions. Returns null when a pure-prose doc has nothing to say, so a bare
 * proposal renders exactly as before. Holds the single `.review-summary` in the DOM,
 * which `refreshReviewInDoc` re-tints live.
 */
function docDigestCard(doc) {
  const requirements = doc.requirements || [];
  const tasks = doc.tasks || [];
  const scenarioCount = requirements.reduce(
    (n, r) => n + (r.scenarios ? r.scenarios.length : 0),
    0
  );
  const openQs = docOpenQuestions(doc);
  const overview = explanationFor(doc.id, 'summary');
  if (!requirements.length && !tasks.length && !openQs.length && !overview) return null;

  const card = el('section', 'digest-card');
  const head = el('div', 'digest-head');
  head.append(el('span', 'digest-eyebrow', 'At a glance'));
  card.append(head);

  if (overview) {
    const box = el('div', 'plain-layer digest-overview');
    const h = el('div', 'plain-head');
    h.append(aiMark());
    h.append(el('span', 'plain-label', 'Overview'));
    h.append(provenanceBadge(overview.provenance));
    box.append(h);
    box.append(el('div', 'plain-body', overview.body));
    card.append(box);
  }

  const counts = el('div', 'digest-counts');
  if (requirements.length) {
    counts.append(
      digestStat(
        String(requirements.length),
        requirements.length === 1 ? 'requirement' : 'requirements'
      )
    );
    counts.append(
      digestStat(String(scenarioCount), scenarioCount === 1 ? 'scenario' : 'scenarios')
    );
  }
  if (tasks.length) {
    const done = tasks.filter((t) => t.done).length;
    counts.append(digestStat(`${done}/${tasks.length}`, 'tasks done'));
  }
  if (counts.childElementCount) card.append(counts);

  const summary = reviewSummary(doc);
  if (summary.childElementCount) card.append(summary);

  const oq = digestOpenQuestions(openQs);
  if (oq) card.append(oq);

  return card;
}

function digestStat(value, label) {
  const stat = el('div', 'digest-stat');
  stat.append(el('span', 'digest-stat-value', value));
  stat.append(el('span', 'digest-stat-label', label));
  return stat;
}

/** The open questions that live under this doc — deep links a scanner can jump to. */
function docOpenQuestions(doc) {
  return openQuestions().filter((item) => item.anchor && isUnder(item.anchor, doc.id));
}

function digestOpenQuestions(items) {
  if (!items.length) return null;
  const box = el('div', 'digest-openq');
  box.append(el('span', 'plain-label', `Open questions (${items.length})`));
  const list = el('ul', 'digest-openq-list');
  for (const item of items) {
    const li = el('li');
    if (item.anchor && /\/req:|\/scn:/.test(item.anchor)) {
      const link = button(item.label, 'oq-anchor');
      link.addEventListener('click', () => void gotoAnchor(item.anchor, item.label));
      li.append(link);
    } else {
      li.append(el('span', null, item.label));
    }
    if (item.detail) li.append(el('span', 'source-quote', item.detail));
    list.append(li);
  }
  box.append(list);
  return box;
}

/**
 * The Markdown that precedes the first requirement — a Purpose / overview section —
 * rendered as normative context. The doc's own title heading is dropped (it is in the
 * header) and a trailing lone "Requirements" section heading is trimmed so it does not
 * dangle. Returns null when there is no intro prose.
 */
function docIntro(doc) {
  const requirements = doc.requirements || [];
  if (!requirements.length) return null;
  const firstLine = requirements[0].line;
  if (!firstLine || firstLine < 2) return null;
  const lines = String(doc.markdown || '').split(/\r?\n/);

  let start = 0;
  if ((lines[0] || '').trim() === '---') {
    for (let j = 1; j < lines.length; j += 1) {
      if ((lines[j] || '').trim() === '---') {
        start = j + 1;
        break;
      }
    }
  }
  const slice = lines.slice(start, firstLine - 1);
  while (slice.length && slice[0].trim() === '') slice.shift();
  if (slice.length && /^#\s+/.test(slice[0])) slice.shift(); // the doc title heading
  while (slice.length && slice[slice.length - 1].trim() === '') slice.pop();
  const lastHeading = slice.length ? /^#{1,6}\s+(.*)$/.exec(slice[slice.length - 1]) : null;
  if (lastHeading && /requirements?\s*$/i.test(lastHeading[1].trim())) slice.pop();

  const md = slice.join('\n').trim();
  if (!md) return null;
  const box = el('div', 'doc-intro doc-body');
  box.append(renderMarkdown(md));
  return box;
}

/**
 * The doc's structural diagrams behind one disclosure, rendered lazily. In Digest
 * mode they stay collapsed (no cognitive-load dump); in Full mode they open and draw
 * on render. The heat-map re-tint (`refreshReviewInDoc`) finds its slot only once
 * built, and is safely skipped while collapsed.
 */
function docDiagramsSection(doc, diagrams, seq) {
  const section = el('section', 'diagrams');
  const head = el('div', 'diagrams-head');
  const heading = el('div', 'diagrams-heading');
  heading.append(el('h3', null, 'Generated diagrams'));
  // Set apart from the authored ones above: these are mechanical, derived from the
  // spec structure, not the agent's judgement.
  heading.append(el('span', 'diagrams-derived-note', 'derived from the spec'));
  head.append(heading);
  const toggle = button('Show diagrams', 'diagrams-toggle');
  head.append(toggle);
  section.append(head);

  const holder = el('div', 'diagrams-holder');
  section.append(holder);

  let built = false;
  const build = async () => {
    if (built) return;
    built = true;
    // Resolve the requirement map to the server heat map (when stamped) before the
    // cards are built, so the rendered SVG and the "Show source" text agree.
    const resolved = [];
    for (const diagram of diagrams) resolved.push(await resolveDiagram(diagram, doc));
    if (seq !== state.renderSeq) return; // a newer render took over during the fetch
    const cards = [];
    for (const diagram of resolved) {
      const { card, body } = diagramCard(diagram);
      holder.append(card);
      cards.push({ body, diagram });
    }
    // Sequential on purpose: mermaid mutates shared document state per render.
    for (const entry of cards) {
      if (seq !== state.renderSeq) return;
      await drawDiagram(entry.body, entry.diagram);
    }
  };

  const open = state.density === 'full';
  holder.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? 'Hide diagrams' : 'Show diagrams';
  toggle.addEventListener('click', async () => {
    const show = holder.hidden;
    holder.hidden = !show;
    toggle.textContent = show ? 'Hide diagrams' : 'Show diagrams';
    toggle.setAttribute('aria-expanded', String(show));
    if (show) await build();
  });
  if (open) void build();

  return section;
}

/**
 * A one-line review-progress readout for the current doc: how many of its
 * requirements and scenarios sit at each verdict, and how many are untouched.
 */
function reviewSummary(doc) {
  const anchors = [];
  for (const req of doc.requirements || []) {
    anchors.push(req.id);
    for (const scn of req.scenarios || []) anchors.push(scn.id);
  }
  const wrap = el('div', 'review-summary');
  if (!anchors.length) return wrap;

  const counts = { approved: 0, understood: 0, concern: 0, blocking: 0 };
  let unreviewed = 0;
  for (const anchor of anchors) {
    const verdict = verdictFor(anchor);
    if (verdict && verdict in counts) counts[verdict] += 1;
    else unreviewed += 1;
  }

  wrap.append(el('span', 'plain-label', 'Review'));
  let any = false;
  for (const verdict of ['approved', 'understood', 'concern', 'blocking']) {
    if (!counts[verdict]) continue;
    any = true;
    const chip = verdictChip(verdict);
    chip.append(el('span', null, ` ${counts[verdict]}`));
    wrap.append(chip);
  }
  wrap.append(el('span', null, `${unreviewed} unreviewed`));
  if (!any && !unreviewed) wrap.replaceChildren();
  return wrap;
}

function warningsBox(warnings) {
  const box = el('div', 'warnings');
  box.append(
    el('strong', null, `${warnings.length} parser warning${warnings.length === 1 ? '' : 's'}`)
  );
  const list = el('ul');
  for (const warning of warnings.slice(0, 10)) list.append(el('li', null, warning));
  box.append(list);
  return box;
}

/**
 * Onboarding shown when the project has zero docs: without it an empty or
 * non-spec folder rendered a dead prompt with nothing to select. Explains what
 * was scanned (the accompanying warnings box names the folder) and the two
 * layouts spec-scope recognises, so the user can tell whether they pointed it at
 * the wrong directory.
 */
function emptyStateBox() {
  // Reuses `.doc-body` for typography (headings, lists, code, links) since the
  // empty state has no stylesheet rules of its own.
  const box = el('div', 'empty-state doc-body');
  box.append(el('h2', null, 'No specifications found'));
  box.append(
    el(
      'p',
      null,
      'spec-scope scanned this folder but found no Markdown spec files. It looks for ' +
        'one of two layouts:'
    )
  );

  const list = el('ul');
  const openspec = el('li');
  openspec.append(el('strong', null, 'OpenSpec'));
  openspec.append(el('span', null, ' — an '));
  openspec.append(el('code', null, 'openspec/'));
  openspec.append(el('span', null, ' directory holding your specs and changes.'));
  list.append(openspec);

  const speckit = el('li');
  speckit.append(el('strong', null, 'Spec Kit'));
  speckit.append(el('span', null, ' — a '));
  speckit.append(el('code', null, '.specify/'));
  speckit.append(el('span', null, ' directory, or '));
  speckit.append(el('code', null, 'specs/NNN-slug/spec.md'));
  speckit.append(el('span', null, ' feature folders.'));
  list.append(speckit);
  box.append(list);

  box.append(
    el(
      'p',
      null,
      'Point spec-scope at the repository root that contains one of those, then reload.'
    )
  );

  const docsLine = el('p', null, 'See the ');
  const link = el('a', null, 'spec-scope README');
  link.href = 'https://github.com/sizzlorox/spec-scope#readme';
  link.rel = 'noopener noreferrer nofollow';
  link.target = '_blank';
  docsLine.append(link);
  docsLine.append(el('span', null, ' for the full layout details.'));
  box.append(docsLine);

  return box;
}

/** True once the agent has produced any review content for this project. */
function reviewHasContent() {
  const review = state.review || {};
  return !!(
    (review.explanations && review.explanations.length) ||
    (review.decisions && review.decisions.length) ||
    (review.glossary && review.glossary.length) ||
    (review.stamps && review.stamps.length)
  );
}

/**
 * Shown at the top of a doc when the spec is loaded but no review content exists
 * yet: what the review will hold, and the exact commands to ask the agent to
 * prepare it. Deliberately no action button — spec-scope has no AI of its own;
 * the copyable commands make honest that a human's agent does the work.
 */
function reviewOnboarding() {
  const box = el('div', 'review-cta');
  box.append(el('div', 'review-cta-title', 'This spec hasn’t been summarized yet'));
  box.append(
    el(
      'p',
      'review-cta-body',
      'Plain-language summaries, a glossary and the decision ledger appear here once your ' +
        'agent prepares the review. Ask the agent watching this project to run:'
    )
  );

  const command =
    'spec-scope explain\n# the agent writes the explanations, then:\nspec-scope apply -';
  const pre = el('pre', 'review-cta-cmd');
  const code = el('code', null, command);
  pre.append(code);
  box.append(pre);

  const copy = button('Copy commands');
  copy.addEventListener('click', () => void copyText(command, copy, pre));
  box.append(copy);

  box.append(
    el(
      'p',
      'review-cta-note',
      'Or, if your agent has the spec-scope skill, just say: “prepare the spec-scope review.” ' +
        'Nothing here runs the AI — this page only shows what your agent produces.'
    )
  );
  return box;
}

// ---------------------------------------------------------------- notes panel

const KIND_LABELS = {
  question: 'Question',
  change: 'Change request',
  resolve: 'Resolve',
};

function renderPanel() {
  els.panelAnchor.textContent = state.anchor
    ? state.anchorLabel || state.anchor
    : 'Nothing selected — showing every note.';
  els.composer.hidden = !state.anchor;

  const list = state.anchor
    ? state.notes.filter((n) => n.anchor === state.anchor)
    : state.notes.slice();
  list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  els.notes.replaceChildren();
  if (!list.length) {
    els.notes.append(
      el(
        'p',
        'empty',
        state.anchor
          ? 'No notes here yet. Add the first one below.'
          : 'No notes yet. Click a requirement or scenario heading to start one.'
      )
    );
    state.changedNoteIds = new Set();
    return;
  }
  // Flash only the cards whose note changed since the last live update, so an
  // agent reply visibly lands without every card blinking on an unrelated refresh.
  const changed = state.changedNoteIds || new Set();
  const flashing = [];
  for (const note of list) {
    const card = noteCard(note);
    if (changed.has(note.id)) flashing.push(card);
    els.notes.append(card);
  }
  for (const card of flashing) flashNode(card);
  state.changedNoteIds = new Set();
}

/**
 * Diffs the freshly loaded notes against the previous render so a live update
 * flashes only what actually changed. On the first paint nothing flashes; the
 * signatures simply become the baseline for the next diff.
 */
function diffNoteSignatures() {
  const firstPaint = !state.notesPainted;
  const changed = new Set();
  for (const note of state.notes) {
    const sig = `${note.status}:${(note.replies || []).length}`;
    if (!firstPaint && state.noteSig.get(note.id) !== sig) changed.add(note.id);
    state.noteSig.set(note.id, sig);
  }
  state.changedNoteIds = changed;
  state.notesPainted = true;
}

function noteCard(note) {
  const card = el('article', 'note');
  card.dataset.kind = note.kind;
  card.dataset.status = note.status;

  const meta = el('div', 'note-meta');
  meta.append(el('span', 'badge', KIND_LABELS[note.kind] || note.kind));
  meta.append(el('span', 'badge', note.status === 'resolved' ? 'Resolved' : 'Open'));
  meta.append(el('span', null, note.author || 'anonymous'));
  meta.append(el('span', null, formatTime(note.createdAt)));
  card.append(meta);

  if (!state.anchor) {
    card.append(el('div', 'panel-anchor', note.anchorLabel || note.anchor));
  }

  card.append(el('div', 'note-body', note.body));

  if (note.replies && note.replies.length) {
    const replies = el('ul', 'replies');
    for (const reply of note.replies) {
      const item = el('li');
      const rmeta = el('div', 'note-meta');
      rmeta.append(el('span', null, reply.author || 'anonymous'));
      rmeta.append(el('span', null, formatTime(reply.createdAt)));
      item.append(rmeta, el('div', 'reply-body', reply.body));
      replies.append(item);
    }
    card.append(replies);
  }

  card.append(replyForm(note));

  const actions = el('div', 'note-actions');
  if (note.status === 'open') {
    const resolve = button('Resolve');
    resolve.addEventListener(
      'click',
      () => void act(`/api/notes/${enc(note.id)}/resolve`, 'Resolved')
    );
    actions.append(resolve);
  } else {
    const reopen = button('Reopen');
    reopen.addEventListener(
      'click',
      () => void act(`/api/notes/${enc(note.id)}/reopen`, 'Reopened')
    );
    actions.append(reopen);
  }
  const remove = button('Delete', 'link');
  remove.addEventListener('click', () => void deleteNote(note));
  actions.append(remove);
  card.append(actions);

  return card;
}

function replyForm(note) {
  const form = el('form', 'reply-form');
  const input = el('textarea');
  input.rows = 1;
  input.placeholder = 'Reply…';
  input.setAttribute('aria-label', 'Reply to this note');
  const send = el('button', null, 'Reply');
  send.type = 'submit';
  form.append(input, send);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    try {
      await postJson(`/api/notes/${enc(note.id)}/replies`, { body });
      input.value = '';
      await refreshNotes();
      toast('Reply added');
    } catch (err) {
      toast(`Could not reply: ${err.message}`);
    }
  });
  return form;
}

function enc(id) {
  return encodeURIComponent(id);
}

async function act(path, message) {
  try {
    await api(path, { method: 'POST' });
    await refreshNotes();
    toast(message);
  } catch (err) {
    toast(`Failed: ${err.message}`);
  }
}

async function deleteNote(note) {
  if (!window.confirm('Delete this note and its replies?')) return;
  try {
    await api(`/api/notes/${enc(note.id)}`, { method: 'DELETE' });
    await refreshNotes();
    toast('Note deleted');
  } catch (err) {
    toast(`Could not delete: ${err.message}`);
  }
}

async function refreshNotes() {
  const scrollTop = els.notes.scrollTop;
  els.notes.setAttribute('aria-busy', 'true');
  try {
    await loadNotes();
    diffNoteSignatures();
    renderPanel();
    refreshBadges();
    updateWaitingIndicator();
  } finally {
    els.notes.setAttribute('aria-busy', 'false');
    els.notes.scrollTop = scrollTop;
  }
}

// ---------------------------------------------------------------- views

const VIEW_TABS = ['doc', 'decisions', 'changes', 'glossary'];

function updateTabs() {
  for (const view of VIEW_TABS) {
    const btn = els[camel(`tab-${view}`)];
    if (btn) btn.setAttribute('aria-current', view === state.view ? 'page' : 'false');
  }
}

/** Renders whichever top-level view is active into the centre column. */
async function renderMain() {
  if (state.view === 'doc') return renderDoc();
  els.doc.replaceChildren();
  els.doc.scrollTop = 0;
  if (state.view === 'decisions') renderDecisions();
  else if (state.view === 'changes') await renderChanges();
  else if (state.view === 'glossary') renderGlossary();
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  updateTabs();
  void renderMain();
}

function emptyReviewBox(title, detail) {
  const box = el('div', 'plain-layer');
  box.append(el('div', 'plain-label', title));
  box.append(el('div', 'plain-body', detail));
  return box;
}

// ------------------------------------------------ decision ledger

function renderDecisions() {
  const view = el('div', 'review-view');
  view.append(el('h2', null, 'Decision ledger'));
  const decisions = (state.review && state.review.decisions) || [];

  if (!decisions.length) {
    view.append(
      emptyReviewBox(
        'No decisions captured yet',
        'A decision records a choice the team made: its context, the options weighed, ' +
          'what was chosen, and what that trades away. Decisions accrue as the team ' +
          'resolves open questions — the in-loop agent distils a resolved thread into a ' +
          'decision, then `spec-scope apply` records it here.'
      )
    );
    els.doc.append(view);
    return;
  }

  view.append(
    el(
      'p',
      'view-intro',
      `${decisions.length} decision${decisions.length === 1 ? '' : 's'} recorded.`
    )
  );
  for (const decision of decisions) view.append(decisionCard(decision));
  els.doc.append(view);
}

function decisionCard(decision) {
  const card = el('article', 'decision-card');

  const head = el('div', 'decision-head');
  head.append(el('span', 'decision-title', decision.title));
  head.append(provenanceBadge(decision.provenance));
  if (decision.status) head.append(el('span', 'badge badge-quiet', decision.status));
  card.append(head);

  if (decision.context) card.append(decisionField('Context', decision.context));
  if (Array.isArray(decision.options) && decision.options.length) {
    card.append(decisionOptions(decision.options));
  }
  if (decision.choice) card.append(decisionField('Choice', decision.choice));
  if (decision.tradeoffs) {
    const field = decisionField('We gave up', decision.tradeoffs);
    field.classList.add('decision-tradeoffs');
    card.append(field);
  }
  if (decision.consequence) card.append(decisionField('Consequence', decision.consequence));

  const sources = sourceList(decision.sources);
  if (sources) card.append(sources);
  return card;
}

function decisionField(label, value) {
  const field = el('div', 'decision-field');
  field.append(el('span', 'field-label', label));
  field.append(el('span', 'field-value', value));
  return field;
}

function decisionOptions(options) {
  const field = el('div', 'decision-field');
  field.append(el('span', 'field-label', 'Considered'));
  const list = el('ul');
  for (const option of options) list.append(el('li', null, option));
  field.append(list);
  return field;
}

// ------------------------------------------------ what changed

async function renderChanges() {
  const view = el('div', 'review-view');
  view.append(el('h2', null, 'What changed'));

  let changes = [];
  try {
    const data = await api('/api/changes');
    changes = data.changes || [];
  } catch (err) {
    view.append(el('p', 'diagram-error', `Could not load changes: ${err.message}`));
    els.doc.append(view);
    return;
  }

  if (!changes.length) {
    view.append(
      emptyReviewBox(
        'No spec changes',
        'This view lists requirement-level deltas (ADDED / MODIFIED / REMOVED / RENAMED) ' +
          'drawn from OpenSpec change files. None are present in the current spec.'
      )
    );
    els.doc.append(view);
    return;
  }

  view.append(
    el('p', 'view-intro', `${changes.length} requirement delta${changes.length === 1 ? '' : 's'}.`)
  );
  for (const change of changes) view.append(changeEntry(change));
  els.doc.append(view);
}

function changeEntry(change) {
  const card = el('article', 'change-entry');
  const head = el('div', 'change-head');
  const link = button(change.requirement, 'source-link');
  link.addEventListener('click', () => void gotoAnchor(change.anchor, change.requirement));
  head.append(link);
  const delta = el('span', 'badge badge-delta', change.delta);
  delta.dataset.delta = change.delta;
  head.append(delta);
  card.append(head);

  if (change.summary) card.append(el('p', 'change-prose', change.summary));

  const hasBefore = typeof change.before === 'string' && change.before.length > 0;
  const hasAfter = typeof change.after === 'string' && change.after.length > 0;
  if (hasBefore || hasAfter) {
    const ba = el('div', 'change-ba');
    if (hasBefore) ba.append(baSlot('Before', change.before));
    else if (change.delta === 'MODIFIED')
      ba.append(baSlot('Before', 'No prior text recorded.', true));
    if (hasAfter) ba.append(baSlot('After', change.after));
    card.append(ba);
  }
  return card;
}

function baSlot(label, text, muted) {
  const slot = el('div', 'ba-slot');
  slot.append(el('div', 'ba-label', label));
  const body = el('div', 'ba-text', text);
  if (muted) body.style.color = 'var(--text-faint)';
  slot.append(body);
  return slot;
}

// ------------------------------------------------ glossary

function renderGlossary() {
  const view = el('div', 'review-view');
  view.append(el('h2', null, 'Glossary'));
  const glossary = (state.review && state.review.glossary) || [];

  if (!glossary.length) {
    view.append(
      emptyReviewBox(
        'No glossary terms yet',
        'The glossary collects domain terms the spec uses. Defined terms carry a grounded ' +
          'definition and its sources; terms the spec uses but never defines are kept as open ' +
          'questions rather than being given an invented meaning.'
      )
    );
    els.doc.append(view);
    return;
  }

  view.append(el('p', 'view-intro', `${glossary.length} term${glossary.length === 1 ? '' : 's'}.`));
  for (const term of glossary) view.append(glossaryTerm(term));
  els.doc.append(view);
}

function glossaryTerm(term) {
  const card = el('article', 'glossary-term');
  const head = el('div', 'glossary-head');
  head.append(el('span', 'glossary-term-name', term.term));
  head.append(provenanceBadge(term.provenance));
  card.append(head);

  if (term.defined && term.definition) {
    card.append(el('div', 'glossary-def', term.definition));
  } else {
    card.append(el('div', 'glossary-open', 'Used, never defined — open question.'));
  }
  const sources = sourceList(term.sources);
  if (sources) card.append(sources);
  return card;
}

// ------------------------------------------------ deep-link

/** Jump to a requirement/scenario anchor from a source link, switching to Doc view. */
async function gotoAnchor(anchor, label) {
  closeModal();
  const docId = docIdOf(anchor);
  const known = state.model && state.model.docs.some((d) => d.id === docId);
  if (!known) {
    toast('That source is not in a loaded document.');
    return;
  }
  const needRender = state.view !== 'doc' || state.docId !== docId;
  state.view = 'doc';
  updateTabs();
  state.docId = docId;
  if (needRender) {
    renderTree();
    await renderDoc();
  }
  selectAnchor(anchor, label || anchor);
  // A collapsed card has no layout, so a scenario's heading cannot be scrolled to
  // and its hover-sync never wires. Expand the containing card first.
  expandCardContaining(anchor);
  const heading = els.doc.querySelector(`.anchor-head[data-anchor="${cssEscape(anchor)}"]`);
  if (heading) heading.scrollIntoView({ block: 'center' });
}

/**
 * Opens the requirement card that holds an anchor (the requirement itself or one of
 * its scenarios), so a deep-link into a collapsed card in Digest mode reveals its
 * target rather than silently no-opping.
 */
function expandCardContaining(anchor) {
  const head = els.doc.querySelector(`.anchor-head[data-anchor="${cssEscape(anchor)}"]`);
  const card = head ? head.closest('.req-card') : null;
  if (!card) return;
  const detail = card.querySelector('.req-detail');
  const toggle = card.querySelector('.req-disclosure');
  if (!detail || !detail.hidden) return;
  detail.hidden = false;
  card.dataset.expanded = 'true';
  if (card.dataset.anchor) state.expandedCards.add(card.dataset.anchor);
  if (toggle) {
    toggle.textContent = 'Hide formal text';
    toggle.setAttribute('aria-expanded', 'true');
  }
}

// ------------------------------------------------ blast radius

async function openBlast(anchor, label) {
  const body = el('div');
  const legend = el('div', 'legend');
  legend.append(legendItem(false, 'solid — structural edge'));
  legend.append(legendItem(true, 'dashed — inferred / lexical guess'));
  body.append(legend);
  const slot = el('div', 'diagram-body');
  slot.append(el('p', 'empty', 'Computing blast radius…'));
  body.append(slot);
  openModal(`Affects: ${label}`, body);

  try {
    const data = await api(`/api/blast?anchor=${enc(anchor)}`);
    // Reuse drawDiagram so the orphan-cleanup fix (never delete the fresh SVG) holds.
    await drawDiagram(slot, { mermaid: data.mermaid });
  } catch (err) {
    slot.replaceChildren(
      el('p', 'diagram-error', `Could not compute blast radius: ${err.message}`)
    );
  }
}

function legendItem(dashed, text) {
  const item = el('span', 'legend-line');
  item.append(el('span', `legend-swatch${dashed ? ' dashed' : ''}`));
  item.append(el('span', null, text));
  return item;
}

// ------------------------------------------------ open questions

function updateOpenQCount() {
  const count = openQuestions().length;
  els.openqCount.textContent = String(count);
  els.openqCount.dataset.empty = String(count === 0);
  els.openqToggle.setAttribute('aria-label', `Open questions: ${count}`);
}

function openQuestionsModal() {
  const items = openQuestions();
  const body = el('div');
  if (!items.length) {
    body.append(
      el(
        'p',
        'empty',
        'No open questions. Every explanation is grounded or inferred, every term is ' +
          'defined, and nothing is stamped blocking or concern.'
      )
    );
    openModal('Open questions', body);
    return;
  }
  const groups = [
    ['blocking', 'Blocking'],
    ['concern', 'Concern'],
    ['unstated', 'Unstated rationale'],
    ['undefined', 'Undefined terms'],
  ];
  for (const [key, title] of groups) {
    const groupItems = items.filter((i) => i.group === key);
    if (!groupItems.length) continue;
    const group = el('div', 'oq-group');
    group.append(el('h3', null, `${title} (${groupItems.length})`));
    for (const item of groupItems) group.append(oqItem(item));
    body.append(group);
  }
  openModal('Open questions', body);
}

function oqItem(entry) {
  const item = el('div', 'oq-item');
  if (entry.anchor && /\/req:|\/scn:/.test(entry.anchor)) {
    const link = button(entry.label, 'oq-anchor');
    link.addEventListener('click', () => void gotoAnchor(entry.anchor, entry.label));
    item.append(link);
  } else {
    item.append(el('span', null, entry.label));
  }
  if (entry.detail) item.append(el('span', 'source-quote', entry.detail));
  return item;
}

// ------------------------------------------------ waiting for the agent

/** Open notes are requests waiting to be picked up by an agent on `spec-scope poll`. */
function openNotesCount() {
  let n = 0;
  for (const note of state.notes) if (note.status === 'open') n += 1;
  return n;
}

/** Keeps the header "for the agent" indicator in sync with the open-note count. */
function updateWaitingIndicator() {
  const count = openNotesCount();
  els.agentCount.textContent = String(count);
  els.agentWaiting.dataset.empty = String(count === 0);
  els.agentWaiting.setAttribute(
    'aria-label',
    `${count} request${count === 1 ? '' : 's'} waiting for the agent`
  );
}

/** Lists the open notes waiting for the agent, honest about how they get picked up. */
function waitingModal() {
  const open = state.notes
    .filter((note) => note.status === 'open')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const body = el('div');
  const intro = el('p', 'modal-intro', 'These requests are waiting for an agent running ');
  intro.append(el('code', null, 'spec-scope poll'));
  intro.append(
    el(
      'span',
      null,
      '. When it responds, this page updates live — you don’t run the AI, the loop does.'
    )
  );
  body.append(intro);

  if (!open.length) {
    body.append(
      el(
        'p',
        'empty',
        'Nothing waiting. Ask a question or request a change to send work to the agent.'
      )
    );
    openModal('Waiting for the agent', body);
    return;
  }
  for (const note of open) body.append(waitingItem(note));
  openModal('Waiting for the agent', body);
}

function waitingItem(note) {
  const item = el('div', 'oq-item');
  const head = el('div', 'oq-item-head');
  head.append(el('span', 'badge', KIND_LABELS[note.kind] || note.kind));
  const label = note.anchorLabel || note.anchor;
  if (note.anchor && /\/req:|\/scn:/.test(note.anchor)) {
    const link = button(label, 'oq-anchor');
    link.addEventListener('click', () => void gotoAnchor(note.anchor, label));
    head.append(link);
  } else {
    head.append(el('span', null, label));
  }
  item.append(head);
  // textContent path: a note body/label is untrusted, so it stays inert here too.
  if (note.body) item.append(el('span', 'source-quote', note.body));
  return item;
}

// ------------------------------------------------ how to review

/** The reviewer's field guide: the actions, the provenance badges, and the loop. */
function howToModal() {
  const body = el('div', 'howto');

  body.append(el('h3', null, 'What you can do'));
  const actions = el('dl', 'howto-list');
  const addAction = (term, desc) => {
    actions.append(el('dt', null, term));
    actions.append(el('dd', null, desc));
  };
  addAction('Ask', 'Post a question about a requirement or scenario for the agent to answer.');
  addAction('Request change', 'Ask the agent to edit the spec text here.');
  addAction(
    'Verdict',
    'Stamp understood, concern, blocking or approved. Click the active one again to clear it.'
  );
  addAction('Affects', 'See the blast radius — what else a change here touches.');
  addAction(
    'Request explanation',
    'On an unexplained item, ask the agent to write a plain-language summary.'
  );
  body.append(actions);

  body.append(el('h3', null, 'Reading the digest'));
  const reading = el('dl', 'howto-list');
  const addReading = (term, desc) => {
    reading.append(el('dt', null, term));
    reading.append(el('dd', null, desc));
  };
  addReading(
    'Digest ⇄ Full',
    'Digest leads with each requirement’s one-line summary; Full expands every card and shows the formal text. The spec text is always one click away.'
  );
  addReading(
    'Show formal text',
    'Expand a card to read the exact requirement text and its scenarios as Given / When / Then lanes, with an on-demand sequence diagram.'
  );
  body.append(reading);

  body.append(el('h3', null, 'Provenance badges'));
  const prov = el('div', 'howto-prov');
  const addProv = (name, desc) => {
    const row = el('div', 'howto-prov-row');
    row.append(provenanceBadge(name));
    row.append(el('span', null, desc));
    prov.append(row);
  };
  addProv('grounded', 'Restates the spec, with sources you can check.');
  addProv('inferred', 'The agent’s reading — a claim you can dispute.');
  addProv('unstated', 'The spec never states this. An open question, never invented.');
  body.append(prov);

  body.append(el('h3', null, 'The agent loop'));
  const loop = el('p', 'howto-note', 'Your requests go to the AI agent watching this review via ');
  loop.append(el('code', null, 'spec-scope poll'));
  loop.append(
    el(
      'span',
      null,
      '. When it responds — a summary, a reply, a decision — this page updates live. ' +
        'spec-scope itself has no AI; the loop does the thinking.'
    )
  );
  body.append(loop);

  body.append(el('h3', null, 'Keyboard shortcuts'));
  const keys = el('dl', 'howto-list');
  const addKey = (key, desc) => {
    const dt = el('dt');
    dt.append(el('kbd', null, key));
    keys.append(dt);
    keys.append(el('dd', null, desc));
  };
  addKey('/', 'Focus the document filter');
  addKey('Esc', 'Close a dialog, or clear the current selection');
  addKey('?', 'Toggle the shortcuts help');
  const dt = el('dt');
  dt.append(el('kbd', null, 'Ctrl/Cmd'));
  dt.append(el('span', null, ' + '));
  dt.append(el('kbd', null, 'Enter'));
  keys.append(dt);
  keys.append(el('dd', null, 'Submit the note or reply you are typing'));
  body.append(keys);

  openModal('How to review', body);
}

/** Reads `#anchor=<id>` from the URL and jumps there, so a copied link navigates. */
function handleInitialHash() {
  const match = /^#anchor=(.+)$/.exec(location.hash || '');
  if (!match) return;
  const anchor = decodeURIComponent(match[1]);
  void gotoAnchor(anchor, anchor);
}

// ------------------------------------------------ modal

let modalReturnFocus = null;

function openModal(title, node) {
  els.modalTitle.textContent = title;
  els.modalBody.replaceChildren(node);
  els.modal.hidden = false;
  modalReturnFocus = document.activeElement;
  els.modalClose.focus();
}

function closeModal() {
  if (els.modal.hidden) return;
  els.modal.hidden = true;
  els.modalBody.replaceChildren();
  if (modalReturnFocus && typeof modalReturnFocus.focus === 'function') modalReturnFocus.focus();
  modalReturnFocus = null;
}

// ------------------------------------------------ review refresh

/** Reload the review layer after a change, then repaint without losing place. */
async function refreshReview() {
  try {
    await Promise.all([loadReview(), loadExplain()]);
  } catch (err) {
    toast(`Could not reload review: ${err.message}`);
    return;
  }
  buildReviewIndex();
  updateOpenQCount();
  if (state.view === 'doc') refreshReviewInDoc();
  else void renderMain();
}

/**
 * In-place review repaint for the doc view: rebuild each anchor's verdict chip and
 * plain companion, the digest card (overview, roll-up, open questions), and re-tint
 * the requirement map — without rebuilding `#doc`, so scroll, selection, card
 * expansion, hover-sync and open diagrams all survive a stamp click (which fires a
 * review event on every press).
 */
function refreshReviewInDoc() {
  // The onboarding CTA is only true while the review is empty; once content lands
  // via SSE, drop it in place rather than leaving a stale "not summarized" nudge.
  if (reviewHasContent()) {
    const cta = els.doc.querySelector('.review-cta');
    if (cta) cta.remove();
  }
  for (const extra of els.doc.querySelectorAll('.anchor-extra')) {
    const anchor = extra.dataset.anchor;
    const kind = extra.dataset.explainKind;
    const label = extra.dataset.anchorLabel;

    const oldBar = extra.querySelector('.anchor-bar');
    if (oldBar) {
      const oldVerdict = oldBar.querySelector('.anchor-bar-verdict').textContent;
      const bar = actionBar(anchor, label);
      oldBar.replaceWith(bar);
      const chip = bar.querySelector('.anchor-bar-verdict');
      if (chip.textContent && chip.textContent !== oldVerdict) flashNode(chip);
    }
    const oldPlain = extra.querySelector('.plain-layer');
    if (oldPlain) {
      const plain = plainCompanion(anchor, kind, label);
      const changed = oldPlain.textContent !== plain.textContent;
      oldPlain.replaceWith(plain);
      if (changed) flashNode(plain);
    }

    const heading = els.doc.querySelector(`.anchor-head[data-anchor="${cssEscape(anchor)}"]`);
    if (heading) {
      const verdict = verdictFor(anchor);
      if (verdict) heading.dataset.verdict = verdict;
      else delete heading.dataset.verdict;
    }
  }

  const doc = currentDoc();
  if (!doc) return;
  // The digest holds the single `.review-summary` plus the open-questions list, both
  // of which move on a stamp; rebuild it in place (a doc with requirements always
  // has a digest, so this only ever refreshes, never inserts).
  const oldDigest = els.doc.querySelector('.digest-card');
  if (oldDigest) {
    const fresh = docDigestCard(doc);
    if (fresh) oldDigest.replaceWith(fresh);
  }

  // Authored diagrams can arrive live (an agent just drew one) or go stale under a
  // spec edit; refresh them after the digest so a newly appeared block slots right
  // below it. Sig-gated, so an unrelated stamp does not re-render mermaid.
  refreshAuthoredDiagrams(doc);

  // Re-render the requirement map from the server so a new (or cleared) stamp
  // re-tints by anchor id. Found by the slot tag set at card-build time, so it
  // works even when the map first rendered plain (zero stamps).
  const mapSlot = els.doc.querySelector(
    `.diagram-body[data-diagram-kind="requirement-map"][data-diagram-anchor="${cssEscape(doc.id)}"]`
  );
  if (mapSlot) void refreshHeatMap(mapSlot, doc);
}

// ------------------------------------------------ reading density

function loadDensity() {
  try {
    const stored = window.localStorage.getItem(DENSITY_KEY);
    if (stored === 'digest' || stored === 'full') state.density = stored;
  } catch {
    // storage unavailable; default to digest
  }
}

function applyDensityLabel() {
  const full = state.density === 'full';
  els.densityToggle.textContent = full ? 'Density: Full' : 'Density: Digest';
  els.densityToggle.setAttribute('aria-pressed', String(full));
  els.densityToggle.setAttribute(
    'aria-label',
    `Reading density: ${state.density}. Click to switch to ${full ? 'digest' : 'full'}.`
  );
}

function toggleDensity() {
  state.density = state.density === 'full' ? 'digest' : 'full';
  try {
    window.localStorage.setItem(DENSITY_KEY, state.density);
  } catch {
    // ignore
  }
  applyDensityLabel();
  if (state.view === 'doc') void renderDoc();
}

// ---------------------------------------------------------------- selection

async function selectDoc(id) {
  state.docId = id;
  state.anchor = null;
  state.anchorLabel = '';
  if (state.view !== 'doc') {
    state.view = 'doc';
    updateTabs();
  }
  renderTree();
  renderPanel();
  await renderMain();
  els.doc.scrollTop = 0;
  els.doc.focus();
}

function selectAnchor(anchor, label) {
  state.anchor = anchor;
  state.anchorLabel = label;
  updateAnchorHighlight();
  renderPanel();
}

function clearSelection() {
  state.anchor = null;
  state.anchorLabel = '';
  updateAnchorHighlight();
  renderPanel();
}

// ---------------------------------------------------------------- theme

function resolvedTheme() {
  if (state.theme === 'light' || state.theme === 'dark') return state.theme;
  return DARK_QUERY.matches ? 'dark' : 'light';
}

/**
 * Mermaid bakes its theme in at initialize() time, so a theme change has to
 * re-initialise AND re-render every diagram — a CSS variable swap alone would
 * leave already-rendered SVGs in the old palette.
 */
async function applyTheme(rerenderDiagrams) {
  const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  els.themeToggle.textContent = `Theme: ${state.theme}`;
  els.themeToggle.setAttribute('aria-label', `Theme: ${state.theme}. Click to change.`);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: resolved === 'dark' ? 'dark' : 'base',
  });
  if (rerenderDiagrams) await renderMain();
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(state.theme) + 1) % order.length];
  state.theme = next;
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage can be unavailable (private mode); the toggle still works per-session.
  }
  void applyTheme(true);
}

function loadTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'auto') state.theme = stored;
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- help + keys

function toggleHelp(force) {
  const show = force === undefined ? els.helpPopover.hidden : force;
  els.helpPopover.hidden = !show;
  els.helpToggle.setAttribute('aria-expanded', String(show));
  if (show) els.helpClose.focus();
  else els.helpToggle.focus();
}

function isTyping() {
  const active = document.activeElement;
  if (!active) return false;
  return (
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.tagName === 'SELECT' ||
    active.isContentEditable === true
  );
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    if (!els.modal.hidden) return closeModal();
    if (!els.helpPopover.hidden) return toggleHelp(false);
    if (isTyping()) return document.activeElement.blur();
    return clearSelection();
  }
  // Never steal a keystroke from a field the reviewer is typing in.
  if (isTyping() || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '/') {
    event.preventDefault();
    els.filter.focus();
    els.filter.select();
    return;
  }
  if (event.key === '?') {
    event.preventDefault();
    toggleHelp();
  }
}

// ---------------------------------------------------------------- live updates

/** Re-fetch the model (and the review layer keyed to it) without losing place. */
async function refreshModel() {
  const scrollTop = els.doc.scrollTop;
  const { docId, anchor, anchorLabel } = state;
  try {
    await loadModel();
    // Anchors can move under a spec edit, so the review index must be rebuilt too.
    await Promise.all([loadReview(), loadExplain()]);
  } catch (err) {
    toast(`Could not reload specs: ${err.message}`);
    return;
  }
  buildReviewIndex();
  updateOpenQCount();
  state.docId = state.model.docs.some((d) => d.id === docId) ? docId : firstDocId();
  state.anchor = anchor;
  state.anchorLabel = anchorLabel;
  renderTree();
  renderPanel();
  await renderMain();
  els.doc.scrollTop = scrollTop;
  toast('Specs reloaded');
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('model', () => void refreshModel());
  source.addEventListener('notes', () => void refreshNotes());
  source.addEventListener('review', () => void refreshReview());
  // EventSource reconnects on its own; surfacing every blip would be noise.
}

function firstDocId() {
  if (!state.model) return null;
  for (const group of state.model.groups || []) {
    const id = (group.docIds || [])[0];
    if (id && state.model.docs.some((d) => d.id === id)) return id;
  }
  const first = state.model.docs[0];
  return first ? first.id : null;
}

// ---------------------------------------------------------------- wiring

function wireEvents() {
  els.filter.addEventListener('input', () => {
    state.filter = els.filter.value.trim();
    renderTree();
  });

  els.themeToggle.addEventListener('click', cycleTheme);
  els.helpToggle.addEventListener('click', () => toggleHelp());
  els.helpClose.addEventListener('click', () => toggleHelp(false));
  document.addEventListener('keydown', onKeydown);

  for (const view of VIEW_TABS) {
    const btn = els[camel(`tab-${view}`)];
    if (btn) btn.addEventListener('click', () => setView(view));
  }
  els.densityToggle.addEventListener('click', toggleDensity);
  els.openqToggle.addEventListener('click', openQuestionsModal);
  els.agentWaiting.addEventListener('click', waitingModal);
  els.howtoToggle.addEventListener('click', howToModal);
  window.addEventListener('hashchange', handleInitialHash);
  els.modalClose.addEventListener('click', closeModal);
  // A click on the backdrop (outside the card) dismisses the modal.
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) closeModal();
  });

  DARK_QUERY.addEventListener('change', () => {
    if (state.theme === 'auto') void applyTheme(true);
  });

  els.composerBody.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.anchor) return;
    const body = els.composerBody.value.trim();
    if (!body) return;
    try {
      await postJson('/api/notes', {
        anchor: state.anchor,
        anchorLabel: state.anchorLabel || state.anchor,
        kind: els.composerKind.value,
        body,
      });
      els.composerBody.value = '';
      await refreshNotes();
      toast('Note added');
    } catch (err) {
      toast(`Could not add note: ${err.message}`);
    }
  });
}

async function boot() {
  cacheElements();

  if (typeof marked === 'undefined' || typeof mermaid === 'undefined') {
    els.doc.replaceChildren(
      el('p', 'diagram-error', 'Bundled marked/mermaid failed to load. Restart spec-scope.')
    );
    return;
  }

  loadTheme();
  loadDensity();
  applyDensityLabel();
  updateTabs();
  await applyTheme(false);
  wireEvents();

  try {
    await Promise.all([loadModel(), loadNotes(), loadReview(), loadExplain()]);
  } catch (err) {
    els.doc.replaceChildren(el('p', 'diagram-error', `Could not load the project: ${err.message}`));
    return;
  }

  buildReviewIndex();
  updateOpenQCount();
  diffNoteSignatures();
  updateWaitingIndicator();
  els.flavorBadge.textContent = state.model.flavor || 'unknown';
  state.docId = firstDocId();
  renderTree();
  renderPanel();
  await renderMain();
  handleInitialHash();
  connectEvents();
}

void boot();
