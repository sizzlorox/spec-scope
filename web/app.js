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
  docId: null,
  anchor: null,
  anchorLabel: '',
  filter: '',
  /** 'auto' | 'light' | 'dark' */
  theme: 'auto',
  /** Monotonic counter so every mermaid render gets a fresh element id. */
  diagramSeq: 0,
  /** Incremented per renderDoc so a slow diagram cannot land in a stale view. */
  renderSeq: 0,
};

const els = {};

function cacheElements() {
  const ids = [
    'flavor-badge',
    'theme-toggle',
    'help-toggle',
    'help-popover',
    'help-close',
    'filter',
    'tree',
    'doc',
    'panel-anchor',
    'notes',
    'composer',
    'composer-kind',
    'composer-body',
    'toast',
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

// ---------------------------------------------------------------- anchors

function normalizeKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function anchorIndex(doc) {
  const entries = [];
  for (const req of doc.requirements || []) {
    entries.push({
      key: normalizeKey(req.name),
      anchor: req.id,
      label: `${doc.title} › ${req.name}`,
      // OpenSpec delta marker (ADDED/MODIFIED/…). The heading text alone does
      // not say whether a requirement is new or being changed.
      delta: req.delta || null,
    });
    for (const scenario of req.scenarios || []) {
      entries.push({
        key: normalizeKey(scenario.name),
        anchor: scenario.id,
        label: `${doc.title} › ${req.name} › ${scenario.name}`,
      });
    }
  }
  return entries.filter((e) => e.key);
}

/** Below this length a containment match is noise rather than a signal. */
const MIN_LOOSE_KEY = 4;

/**
 * Binds requirement/scenario anchors to the headings marked renders.
 *
 * Two passes, because headings in the source often carry a prefix the parser
 * strips ("### Requirement: Login" -> name "Login"). Exact matches are claimed
 * first across the whole document; otherwise an early, loosely-matching heading
 * could steal an anchor whose exact heading appears further down.
 */
function decorateAnchors(container, doc) {
  const entries = anchorIndex(doc);
  if (!entries.length) return;

  const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  const keyed = headings.map((node) => ({ node, key: normalizeKey(node.textContent || '') }));
  const takenAnchors = new Set();
  const doneHeadings = new Set();

  for (const { node, key } of keyed) {
    const hit = entries.find((e) => e.key === key && !takenAnchors.has(e.anchor));
    if (!hit) continue;
    takenAnchors.add(hit.anchor);
    doneHeadings.add(node);
    decorateHeading(node, hit);
  }

  for (const { node, key } of keyed) {
    if (doneHeadings.has(node) || key.length < MIN_LOOSE_KEY) continue;
    const hit = entries
      .filter(
        (e) =>
          !takenAnchors.has(e.anchor) &&
          e.key.length >= MIN_LOOSE_KEY &&
          (key.includes(e.key) || e.key.includes(key))
      )
      .sort((a, b) => b.key.length - a.key.length)[0];
    if (!hit) continue;
    takenAnchors.add(hit.anchor);
    decorateHeading(node, hit);
  }
}

function decorateHeading(heading, hit) {
  // tradeoff: the heading is flattened to plain text, so inline markup inside a
  // requirement heading (code spans, emphasis) renders unstyled. Upgrade path:
  // move the existing child nodes into the button instead of copying the text.
  const text = heading.textContent || '';
  heading.replaceChildren();
  heading.classList.add('anchor-head');
  heading.dataset.anchor = hit.anchor;

  const select = button(text, 'anchor-select');
  select.setAttribute('aria-label', `Discuss ${text}`);
  select.addEventListener('click', () => selectAnchor(hit.anchor, hit.label));
  heading.append(select);

  if (hit.delta) heading.append(el('span', 'badge badge-delta', hit.delta));
  const count = openCountFor(hit.anchor);
  if (count) heading.append(noteBadge(count));
  if (state.anchor === hit.anchor) heading.dataset.selected = 'true';
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
  const meta = el('div', 'anchor-head');
  if (doc.kind) meta.append(el('span', 'badge badge-quiet', doc.kind));
  const tasks = doc.tasks || [];
  if (tasks.length) {
    const done = tasks.filter((t) => t.done).length;
    meta.append(el('span', 'badge badge-quiet', `${done}/${tasks.length} tasks done`));
  }
  const docNotes = openCountFor(doc.id);
  if (docNotes) meta.append(noteBadge(docNotes));
  header.append(meta);
  els.doc.append(header);

  const body = el('article', 'doc-body');
  body.append(renderMarkdown(doc.markdown));
  decorateAnchors(body, doc);
  els.doc.append(body);

  const diagrams = diagramsForDoc(doc);
  if (!diagrams.length) return;

  const section = el('section', 'diagrams');
  section.append(el('h3', null, 'Generated diagrams'));
  const cards = [];
  for (const diagram of diagrams) {
    const { card, body: slot } = diagramCard(diagram);
    section.append(card);
    cards.push({ slot, diagram });
  }
  els.doc.append(section);

  // Sequential on purpose: mermaid mutates shared document state per render.
  for (const entry of cards) {
    if (seq !== state.renderSeq) return; // a newer render took over
    await drawDiagram(entry.slot, entry.diagram);
  }
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
    return;
  }
  for (const note of list) els.notes.append(noteCard(note));
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
  els.notes.setAttribute('aria-busy', 'true');
  try {
    await loadNotes();
    renderPanel();
    refreshBadges();
  } finally {
    els.notes.setAttribute('aria-busy', 'false');
  }
}

// ---------------------------------------------------------------- selection

async function selectDoc(id) {
  state.docId = id;
  state.anchor = null;
  state.anchorLabel = '';
  renderTree();
  renderPanel();
  await renderDoc();
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
  if (rerenderDiagrams) await renderDoc();
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

/** Re-fetch the model but keep the reviewer where they were. */
async function refreshModel() {
  const scrollTop = els.doc.scrollTop;
  const { docId, anchor, anchorLabel } = state;
  try {
    await loadModel();
  } catch (err) {
    toast(`Could not reload specs: ${err.message}`);
    return;
  }
  state.docId = state.model.docs.some((d) => d.id === docId) ? docId : firstDocId();
  state.anchor = anchor;
  state.anchorLabel = anchorLabel;
  renderTree();
  renderPanel();
  await renderDoc();
  els.doc.scrollTop = scrollTop;
  toast('Specs reloaded');
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('model', () => void refreshModel());
  source.addEventListener('notes', () => void refreshNotes());
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
  await applyTheme(false);
  wireEvents();

  try {
    await Promise.all([loadModel(), loadNotes()]);
  } catch (err) {
    els.doc.replaceChildren(el('p', 'diagram-error', `Could not load the project: ${err.message}`));
    return;
  }

  els.flavorBadge.textContent = state.model.flavor || 'unknown';
  state.docId = firstDocId();
  renderTree();
  renderPanel();
  await renderDoc();
  connectEvents();
}

void boot();
