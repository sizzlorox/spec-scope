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
import { generateDiagrams } from './diagram.js';
import { NoteStore } from './notes.js';
import { parseProject } from './parse.js';
import type {
  Diagram,
  DiagramKind,
  Note,
  Requirement,
  Scenario,
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

function renderScenario(scenario: Scenario, index: Map<string, Diagram[]>): string {
  const diagram = pickDiagram(index, scenario.id, 'sequence');
  return [
    `<section class="scenario" id="${escapeHtml(scenario.id)}">`,
    `<h5 class="scenario-title">${escapeHtml(scenario.name)}</h5>`,
    '<div class="scenario-body">',
    renderSteps(scenario),
    renderDiagram(diagram),
    '</div>',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderRequirement(req: Requirement, index: Map<string, Diagram[]>): string {
  const badge = req.delta
    ? `<span class="badge badge-${escapeHtml(req.delta.toLowerCase())}">${escapeHtml(
        req.delta
      )}</span>`
    : '';
  const parts = [
    `<section class="requirement" id="${escapeHtml(req.id)}">`,
    `<h4 class="requirement-title">${badge}<span>${escapeHtml(req.name)}</span></h4>`,
    renderProse(req.text),
  ];
  for (const scenario of req.scenarios) parts.push(renderScenario(scenario, index));
  parts.push('</section>');
  return parts.filter(Boolean).join('\n');
}

function renderDoc(doc: SpecDoc, index: Map<string, Diagram[]>): string {
  const parts = [
    `<section class="doc" id="${escapeHtml(doc.id)}">`,
    `<h3 class="doc-title">${escapeHtml(doc.title)}</h3>`,
    `<p class="doc-meta"><span class="badge badge-kind">${escapeHtml(
      doc.kind
    )}</span><code>${escapeHtml(doc.path)}</code></p>`,
    renderProse(doc.markdown),
    renderDiagram(pickDiagram(index, doc.id, 'requirement-map')),
    renderDiagram(pickDiagram(index, doc.id, 'task-flow')),
  ];
  if (doc.requirements.length > 0) {
    parts.push('<div class="requirements">');
    for (const req of doc.requirements) parts.push(renderRequirement(req, index));
    parts.push('</div>');
  }
  parts.push('</section>');
  return parts.filter(Boolean).join('\n');
}

function renderGroup(group: SpecGroup, docs: SpecDoc[], index: Map<string, Diagram[]>): string {
  const archived = group.archived ? '<span class="badge badge-archived">archived</span>' : '';
  const parts = [
    `<section class="group" id="${escapeHtml(group.id)}">`,
    `<h2 class="group-title">${escapeHtml(group.name)}${archived}</h2>`,
    `<p class="group-meta"><span class="badge badge-kind">${escapeHtml(
      group.kind
    )}</span><code>${escapeHtml(group.path)}</code></p>`,
    renderDiagram(pickDiagram(index, group.id, 'overview')),
  ];
  for (const doc of docs) parts.push(renderDoc(doc, index));
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
  figure.diagram, .scenario, .requirement, .note, .stats li, pre { break-inside: avoid; page-break-inside: avoid; }
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
  vendor: { mermaid: string; marked: string }
): string {
  const project = basename(model.root) || 'spec-scope';
  const counts = countModel(model);
  const index = indexDiagrams(diagrams);
  const docsById = new Map(model.docs.map((doc) => [doc.id, doc]));

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

  const tocItems: string[] = [];
  const bodyItems: string[] = [];
  for (const group of model.groups) {
    const docs = docsForGroup(group);
    tocItems.push(tocEntry(group.id, group.name, 'toc-group', tocForDocs(docs)));
    bodyItems.push(renderGroup(group, docs, index));
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
        ...orphans.map((doc) => renderDoc(doc, index)),
        '</section>',
      ].join('\n')
    );
  }

  const appendix = renderNotesAppendix(notes);
  if (appendix) {
    tocItems.push('<li class="toc-group"><a href="#appendix-notes">Open discussion notes</a></li>');
  }

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
    warnings,
    '</section>',
    '<nav class="toc" id="toc">',
    '<h2>Contents</h2>',
    tocItems.length > 0 ? `<ul>\n${tocItems.join('\n')}\n</ul>` : '<p>No specifications found.</p>',
    '</nav>',
    ...bodyItems,
    appendix,
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

  const [mermaid, marked] = await Promise.all([readVendor('mermaid'), readVendor('marked')]);
  const html = renderTechDoc(model, diagrams, notes, { mermaid, marked });

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
