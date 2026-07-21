/**
 * `renderTechDoc` is exercised as a pure function: a hand-built model, one
 * diagram, one note and two tiny stub strings standing in for the real Mermaid
 * and Marked bundles. No filesystem, no network.
 *
 * The suite also covers the export/notes CLI contract at the edges that only
 * show up against the disk: `exportTechDoc`'s opt-out `includeNotes`, the
 * `export --no-notes` flag end-to-end, and the `notes` command staying alive on
 * a hostile `notes.json`. Those tests use a temp project and the built CLI.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { changeEntries } from '../src/changes.js';
import { formatNote, printNotes } from '../src/cli.js';
import { exportTechDoc, renderTechDoc } from '../src/export.js';
import { docStructureSource, requirementSource, scenarioSource, specHash } from '../src/hash.js';
import { diagramId, docId, groupId, requirementId, scenarioId } from '../src/ids.js';
import { NoteStore } from '../src/notes.js';
import { ReviewStore } from '../src/review.js';
import type {
  AuthoredDiagram,
  ChangeEntry,
  Decision,
  Diagram,
  DiagramSkip,
  Explanation,
  GlossaryTerm,
  Note,
  ReviewFile,
  ReviewStamp,
  SpecDoc,
  SpecGroup,
  SpecModel,
} from '../src/types.js';

const XSS = '<script>alert(1)</script>';

const DOC_PATH = 'specs/auth/spec.md';
const D_ID = docId(DOC_PATH);
const G_ID = groupId('specs/auth');
const R_ID = requirementId(D_ID, `Login ${XSS}`);
const S_ID = scenarioId(R_ID, 'Happy path');

/** Stub bundles: one carries a `</script>` so the inlining escape is observable. */
const VENDOR = {
  mermaid: 'window.__MERMAID_STUB__ = "</script>";',
  marked: 'window.__MARKED_STUB__ = 1;',
};

function buildModel(): SpecModel {
  const doc: SpecDoc = {
    id: D_ID,
    path: DOC_PATH,
    title: 'Authentication',
    kind: 'spec',
    groupId: G_ID,
    markdown: `# Authentication\n\nProse with an injection attempt: ${XSS}\n`,
    tasks: [
      { id: `${D_ID}/task:0`, text: 'Write the spec', done: true, depth: 0, line: 1 },
      { id: `${D_ID}/task:1`, text: 'Implement it', done: false, depth: 0, line: 2 },
    ],
    requirements: [
      {
        id: R_ID,
        name: `Login ${XSS}`,
        delta: 'ADDED',
        text: 'The system SHALL authenticate a user.',
        line: 3,
        scenarios: [
          {
            id: S_ID,
            name: 'Happy path',
            line: 5,
            steps: [
              { keyword: 'GIVEN', text: 'a registered user', line: 6 },
              { keyword: 'WHEN', actor: 'User', text: 'they submit valid credentials', line: 7 },
              { keyword: 'THEN', text: 'a session is created', line: 8 },
            ],
          },
        ],
      },
    ],
  };

  const group: SpecGroup = {
    id: G_ID,
    name: 'Auth',
    kind: 'capability',
    path: 'specs/auth',
    docIds: [D_ID],
    archived: false,
  };

  return {
    root: '/projects/demo-app',
    flavor: 'openspec',
    groups: [group],
    docs: [doc],
    warnings: [],
  };
}

const DIAGRAMS: Diagram[] = [
  {
    id: diagramId(S_ID, 'sequence'),
    title: 'Happy path sequence',
    kind: 'sequence',
    anchor: S_ID,
    mermaid: 'sequenceDiagram\n  User->>System: submit credentials\n  System-->>User: session',
  },
];

const NOTE: Note = {
  id: 'note_abc123',
  anchor: R_ID,
  anchorLabel: 'Auth / Authentication / Login',
  kind: 'question',
  body: 'Should this expire after 30 days?',
  author: 'reviewer',
  createdAt: '2026-01-02T03:04:05.000Z',
  status: 'open',
  replies: [
    {
      id: 'rep_1',
      body: 'Yes, matching the session policy.',
      author: 'agent',
      createdAt: '2026-01-02T04:00:00.000Z',
    },
  ],
};

function render(notes: Note[] = [NOTE]): string {
  return renderTechDoc(buildModel(), DIAGRAMS, notes, VENDOR);
}

test('renders a single complete HTML document', () => {
  const html = render();
  assert.ok(html.startsWith('<!doctype html>'), 'starts with a doctype');
  assert.equal(html.match(/<html[\s>]/g)?.length, 1, 'exactly one <html> element');
  assert.equal(html.match(/<\/html>/g)?.length, 1, 'exactly one </html>');
  assert.ok(html.trimEnd().endsWith('</html>'), 'ends with </html>');
  for (const marker of ['<head>', '</head>', '<body id="top">', '</body>']) {
    assert.ok(html.includes(marker), `contains ${marker}`);
  }
  assert.ok(html.includes('<title>demo-app'), 'title carries the project name');
});

test('cover block reports the model counts', () => {
  const html = render();
  const start = html.indexOf('<section class="cover">');
  const cover = html.slice(start, html.indexOf('</section>', start));
  assert.ok(cover.includes('openspec'), 'flavor on the cover');
  assert.ok(cover.includes('1/2'), 'tasks done over total');
  assert.ok(/<span class="k">requirements<\/span>/.test(cover), 'requirement stat present');
});

test('vendor sources are inlined verbatim apart from script-tag escaping', () => {
  const html = render();
  assert.ok(html.includes('window.__MARKED_STUB__ = 1;'), 'marked stub inlined');
  assert.ok(html.includes('window.__MERMAID_STUB__'), 'mermaid stub inlined');
  // No <link>/<script src> pointing anywhere: the file must work offline.
  assert.ok(!/<script[^>]+\ssrc=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheets');
});

test('a </script> inside an inlined bundle is neutralised', () => {
  const html = render();
  assert.ok(
    !html.includes('window.__MERMAID_STUB__ = "</script>";'),
    'raw closing tag must not survive'
  );
  assert.ok(
    html.includes('window.__MERMAID_STUB__ = "<\\/script>";'),
    'closing tag is escaped for the HTML tokenizer'
  );
});

test('model-derived text is escaped, never emitted as live markup', () => {
  const html = render();
  assert.ok(!html.includes(XSS), 'the payload never appears as a live tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the payload appears escaped');
  // Requirement heading, TOC entry and Markdown prose all carried the payload.
  assert.equal(
    html.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/g)?.length,
    3,
    'every occurrence went through the escaper'
  );
});

test('requirement, scenario steps and its sequence diagram are rendered', () => {
  const html = render();
  assert.ok(html.includes('badge-added">ADDED'), 'delta badge rendered');
  assert.ok(html.includes('kw-when">WHEN'), 'step keyword is styled');
  assert.ok(html.includes('<span class="actor">User</span>'), 'explicit actor rendered');
  assert.ok(html.includes('<pre class="mermaid">sequenceDiagram'), 'mermaid source embedded');
  assert.ok(html.includes('Happy path sequence'), 'diagram caption rendered');
});

test('notes appendix appears only when there are open notes', () => {
  const withNotes = render();
  assert.ok(withNotes.includes('id="appendix-notes"'), 'appendix present');
  assert.ok(withNotes.includes('Should this expire after 30 days?'), 'note body present');
  assert.ok(withNotes.includes('Yes, matching the session policy.'), 'reply present');
  assert.ok(withNotes.includes('2026-01-02T03:04:05.000Z'), 'timestamp present');
  assert.ok(withNotes.includes('Auth / Authentication / Login'), 'anchor breadcrumb present');

  const withoutNotes = render([]);
  assert.ok(!withoutNotes.includes('id="appendix-notes"'), 'appendix absent when there are none');

  const resolved = render([
    { ...NOTE, status: 'resolved', resolvedAt: '2026-01-03T00:00:00.000Z' },
  ]);
  assert.ok(!resolved.includes('id="appendix-notes"'), 'resolved notes do not open an appendix');
});

test('every table-of-contents link points at an id that exists', () => {
  const html = render();

  const navStart = html.indexOf('<nav class="toc"');
  const nav = html.slice(navStart, html.indexOf('</nav>', navStart));
  assert.ok(nav.length > 0, 'table of contents was emitted');

  const ids = new Set<string>();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }

  const targets: string[] = [];
  for (const match of nav.matchAll(/href="#([^"]+)"/g)) {
    const target = match[1];
    if (target !== undefined) targets.push(target);
  }

  assert.ok(targets.length >= 4, 'group, doc, requirement and scenario are all linked');
  const missing = targets.filter((target) => !ids.has(target));
  assert.deepEqual(missing, [], 'no dangling table-of-contents links');

  // The four structural levels must each be reachable.
  for (const id of [G_ID, D_ID, R_ID, S_ID]) {
    assert.ok(targets.includes(id), `table of contents links ${id}`);
    assert.ok(ids.has(id), `document defines an anchor for ${id}`);
  }
});

test('documents no group claims are still reachable', () => {
  const model = buildModel();
  const orphan: SpecDoc = {
    id: docId('specs/orphan.md'),
    path: 'specs/orphan.md',
    title: 'Orphan',
    kind: 'other',
    markdown: '# Orphan\n',
    tasks: [],
    requirements: [],
  };
  model.docs.push(orphan);

  const html = renderTechDoc(model, DIAGRAMS, [], VENDOR);
  assert.ok(html.includes('id="ungrouped"'), 'ungrouped section emitted');
  assert.ok(html.includes(`id="${orphan.id}"`), 'orphan document rendered');
  assert.ok(html.includes(`href="#${orphan.id}"`), 'orphan document linked from the contents');
});

test('a print stylesheet is present for PDF review', () => {
  const html = render();
  assert.ok(html.includes('@media print'), 'print rules emitted');
  assert.ok(/@media print[\s\S]*header\.chrome[^}]*display: none/.test(html), 'nav chrome hidden');
  assert.ok(/@media print[\s\S]*break-inside: avoid/.test(html), 'blocks avoid page breaks');
  assert.ok(/@media print[\s\S]*attr\(href\)/.test(html), 'links reveal their target');
});

/* -------------------------------------------------------------------------- */
/* review layer — decisions, explanations, stamps, glossary, changes          */
/* -------------------------------------------------------------------------- */

function reviewFile(overrides: Partial<ReviewFile> = {}): ReviewFile {
  return {
    version: 1,
    decisions: [],
    stamps: [],
    explanations: [],
    glossary: [],
    diagrams: [],
    diagramSkips: [],
    ...overrides,
  };
}

/** Render with a seeded review (and optional changes) against the standard model. */
function renderReview(review: ReviewFile, changes: ChangeEntry[] = [], notes: Note[] = []): string {
  return renderTechDoc(buildModel(), DIAGRAMS, notes, VENDOR, review, changes);
}

const BASE_DECISION: Decision = {
  id: 'dec_seed',
  title: 'Adopt platform passkeys',
  context: 'We need phishing-resistant authentication for the sign-in flow.',
  options: ['Passwords', 'TOTP', 'Passkeys'],
  choice: 'Use platform passkeys as the primary factor.',
  tradeoffs: 'Devices without a platform authenticator need a fallback path.',
  consequence: 'The password-reset flow can be retired.',
  provenance: 'grounded',
  sources: [
    { kind: 'requirement', anchor: R_ID, label: 'Login', quote: 'SHALL authenticate a user' },
  ],
  status: 'recorded',
  author: 'reviewer',
  createdAt: '2026-01-02T00:00:00.000Z',
};

const BASE_EXPLANATION: Explanation = {
  id: 'exp_seed',
  anchor: R_ID,
  anchorLabel: 'Auth / Authentication / Login',
  kind: 'summary',
  body: 'In plain terms: a returning user proves who they are and gets a session.',
  provenance: 'grounded',
  sources: [{ kind: 'requirement', anchor: R_ID }],
  specHash: '',
  author: 'agent',
  createdAt: '2026-01-02T00:00:00.000Z',
};

test('the decision ledger lists recorded decisions, badged and sourced', () => {
  const html = renderReview(reviewFile({ decisions: [BASE_DECISION] }));
  assert.ok(html.includes('id="decision-ledger"'), 'ledger section present');
  assert.ok(html.includes('Adopt platform passkeys'), 'decision title rendered');
  assert.ok(html.includes('Use platform passkeys as the primary factor.'), 'choice rendered');
  assert.ok(/badge-grounded[^>]*>grounded<\/span>/.test(html), 'provenance badge rendered');
  assert.ok(html.includes(`href="#${R_ID}"`), 'source links back to the requirement');
  assert.ok(html.includes('1 recorded decision'), 'cover tally counts the recorded decision');
  assert.ok(html.includes('<a href="#decision-ledger">'), 'ledger is linked from the contents');
});

test('open and superseded decisions are kept out of the ledger', () => {
  const open = {
    ...BASE_DECISION,
    id: 'dec_open',
    title: 'Still debating logout',
    status: 'open' as const,
  };
  const html = renderReview(reviewFile({ decisions: [open] }));
  assert.ok(!html.includes('id="decision-ledger"'), 'an open-only review omits the ledger');
  assert.ok(!html.includes('Still debating logout'), 'the open decision is not shown');
  assert.ok(html.includes('0 recorded decisions'), 'cover tally reports zero recorded decisions');
});

test('grounded/inferred summaries build the plain overview lead', () => {
  const html = renderReview(reviewFile({ explanations: [BASE_EXPLANATION] }));
  assert.ok(html.includes('id="overview"'), 'overview section present');
  assert.ok(
    html.includes('a returning user proves who they are and gets a session'),
    'summary prose forms the lead'
  );
  assert.ok(html.includes('<a href="#overview">Overview</a>'), 'overview linked from the contents');
});

test('unstated explanations and undefined glossary terms surface as open questions', () => {
  const unstated: Explanation = {
    ...BASE_EXPLANATION,
    id: 'exp_gap',
    body: 'The spec never states how long a session remains valid.',
    provenance: 'unstated',
    specHash: '',
  };
  const term: GlossaryTerm = {
    id: 'term_pa',
    term: 'platform authenticator',
    definition: '',
    provenance: 'unstated',
    sources: [],
    defined: false,
    author: 'agent',
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  const html = renderReview(reviewFile({ explanations: [unstated], glossary: [term] }));
  assert.ok(html.includes('id="open-questions"'), 'open questions section present');
  assert.ok(
    html.includes('The spec never states how long a session remains valid.'),
    'unstated body listed'
  );
  assert.ok(html.includes('platform authenticator'), 'undefined term listed');
  assert.ok(html.includes('undefined term'), 'the term is flagged as undefined, not defined');
  assert.ok(!html.includes('id="appendix-glossary"'), 'an undefined term never opens the glossary');
  // Honesty: an unstated summary must not be laundered into the plain overview lead.
  assert.ok(!html.includes('id="overview"'), 'unstated summary is kept out of the overview');
  assert.ok(html.includes('2 open questions'), 'cover tally counts both open questions');
});

test('blocking and concern stamps are raised as open questions', () => {
  const blocking: ReviewStamp = {
    id: 'stamp_b',
    anchor: S_ID,
    anchorLabel: 'Auth / Login / Happy path',
    verdict: 'blocking',
    note: 'The session lifetime is unspecified.',
    author: 'reviewer',
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  const html = renderReview(reviewFile({ stamps: [blocking] }));
  assert.ok(html.includes('id="open-questions"'), 'open questions section present');
  assert.ok(/badge-blocking[^>]*>blocking<\/span>/.test(html), 'blocking verdict badged');
  assert.ok(html.includes('The session lifetime is unspecified.'), 'stamp note carried through');
  assert.ok(html.includes('1 open question'), 'a single open question is singular in the tally');
});

test('a stamped verdict switches the requirement map to the review heat map', () => {
  const stamp: ReviewStamp = {
    id: 'stamp_c',
    anchor: R_ID,
    anchorLabel: 'Auth / Login',
    verdict: 'concern',
    author: 'reviewer',
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  const html = renderReview(reviewFile({ stamps: [stamp] }));
  assert.ok(html.includes('review heat map'), 'heat-map diagram is rendered');
  assert.ok(html.includes('classDef concern'), 'heat-map carries the verdict styling');
});

test('a summary is marked stale only when its spec hash no longer matches', () => {
  const model = buildModel();
  const req = model.docs[0]?.requirements[0];
  assert.ok(req, 'fixture requirement exists');
  const freshHash = specHash(
    requirementSource(
      req.name,
      req.text,
      req.scenarios.map((s) => s.name)
    )
  );

  const fresh: Explanation = { ...BASE_EXPLANATION, specHash: freshHash };
  const freshHtml = renderTechDoc(
    model,
    DIAGRAMS,
    [],
    VENDOR,
    reviewFile({ explanations: [fresh] }),
    []
  );
  // `.badge-stale` is always defined in the stylesheet; assert on the rendered badge.
  assert.ok(!/>stale<\/span>/.test(freshHtml), 'a matching hash is not marked stale');

  const stale: Explanation = { ...BASE_EXPLANATION, specHash: 'deadbeefdeadbeef' };
  const staleHtml = renderTechDoc(
    model,
    DIAGRAMS,
    [],
    VENDOR,
    reviewFile({ explanations: [stale] }),
    []
  );
  assert.ok(/badge-stale[^>]*>stale<\/span>/.test(staleHtml), 'a stale hash is marked stale');
});

test('a scenario narration is marked stale when its steps change under it', () => {
  const model = buildModel();
  const scn = model.docs[0]?.requirements[0]?.scenarios[0];
  assert.ok(scn, 'fixture scenario exists');
  const freshHash = specHash(
    scenarioSource(
      scn.name,
      scn.steps.map((s) => s.text)
    )
  );

  const narration: Explanation = {
    ...BASE_EXPLANATION,
    id: 'exp_narr',
    anchor: S_ID,
    kind: 'narration',
    body: 'Walkthrough: the user signs in and a session opens.',
    specHash: freshHash,
  };
  const fresh = renderTechDoc(
    model,
    DIAGRAMS,
    [],
    VENDOR,
    reviewFile({ explanations: [narration] }),
    []
  );
  assert.ok(
    fresh.includes('Walkthrough: the user signs in and a session opens.'),
    'narration inlined'
  );
  assert.ok(!/>stale<\/span>/.test(fresh), 'a matching narration hash is not stale');

  const stale = renderTechDoc(
    model,
    DIAGRAMS,
    [],
    VENDOR,
    reviewFile({ explanations: [{ ...narration, specHash: 'ffffffffffffffff' }] }),
    []
  );
  assert.ok(
    /badge-stale[^>]*>stale<\/span>/.test(stale),
    'a drifted narration hash is marked stale'
  );
});

test('a script-laden decision title is escaped, never emitted as live markup', () => {
  const hostile = { ...BASE_DECISION, id: 'dec_xss', title: `Ship ${XSS}` };
  const html = renderReview(reviewFile({ decisions: [hostile] }));
  assert.ok(!html.includes(`Ship ${XSS}`), 'the raw payload never appears in a decision title');
  assert.ok(
    html.includes('Ship &lt;script&gt;alert(1)&lt;/script&gt;'),
    'the title appears escaped'
  );
});

test('the changes appendix quotes the before/after fragments', () => {
  const changes: ChangeEntry[] = [
    {
      anchor: R_ID,
      requirement: 'Login',
      delta: 'MODIFIED',
      summary: 'Requirement "Login" was MODIFIED; only the current text is shown.',
      after: 'The system SHALL authenticate a user with a platform passkey.',
    },
    {
      anchor: 'doc:auth/req:legacy',
      requirement: 'Legacy password login',
      delta: 'REMOVED',
      summary: 'Requirement "Legacy password login" was REMOVED; the text below is deleted.',
      before: 'The system SHALL accept a username and password.',
    },
  ];
  const html = renderReview(reviewFile(), changes);
  assert.ok(html.includes('id="appendix-changes"'), 'changes appendix present');
  assert.ok(html.includes('badge-modified">MODIFIED'), 'modified delta badged');
  assert.ok(html.includes('badge-removed">REMOVED'), 'removed delta badged');
  assert.ok(
    html.includes('The system SHALL authenticate a user with a platform passkey.'),
    'after quoted'
  );
  assert.ok(html.includes('The system SHALL accept a username and password.'), 'before quoted');
  assert.ok(
    html.includes('<a href="#appendix-changes">Changes</a>'),
    'changes linked from contents'
  );
  // The default 4-arg render passes no changes, so the appendix must stay absent.
  assert.ok(!render().includes('id="appendix-changes"'), 'no changes means no appendix');
});

test('defined glossary terms populate the glossary appendix, badged', () => {
  const term: GlossaryTerm = {
    id: 'term_session',
    term: 'session',
    definition: 'A server-issued token proving the user recently authenticated.',
    provenance: 'inferred',
    sources: [],
    defined: true,
    author: 'agent',
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  const html = renderReview(reviewFile({ glossary: [term] }));
  assert.ok(html.includes('id="appendix-glossary"'), 'glossary appendix present');
  assert.ok(
    html.includes('A server-issued token proving the user recently authenticated.'),
    'definition shown'
  );
  assert.ok(/badge-inferred[^>]*>inferred<\/span>/.test(html), 'term carries a provenance badge');
});

test('a review-laden export is still one self-contained offline document', () => {
  const changes = changeEntries(buildModel());
  const review = reviewFile({
    decisions: [BASE_DECISION],
    explanations: [BASE_EXPLANATION],
    stamps: [
      {
        id: 'stamp_z',
        anchor: R_ID,
        anchorLabel: 'Auth / Login',
        verdict: 'concern',
        author: 'reviewer',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    glossary: [
      {
        id: 'term_z',
        term: 'session',
        definition: 'A short-lived proof of authentication.',
        provenance: 'inferred',
        sources: [],
        defined: true,
        author: 'agent',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ],
  });
  const html = renderReview(review, changes);
  assert.ok(html.startsWith('<!doctype html>'), 'still a single document');
  assert.equal(html.match(/<\/html>/g)?.length, 1, 'exactly one </html>');
  assert.ok(!/<script[^>]+\ssrc=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheets');
  assert.ok(!/\ssrc\s*=\s*["']https?:/i.test(html), 'no remote asset sources');
  assert.ok(!/url\(\s*["']?https?:/i.test(html), 'no remote CSS urls');
});

test('a review with missing and hostile fields renders instead of throwing', () => {
  const hostile = {
    version: 1,
    decisions: [
      { id: 'd_half', title: 'Half-written decision', choice: 'do the thing', status: 'recorded' },
    ],
    stamps: [{ id: 's_half', anchor: R_ID, verdict: 'blocking' }],
    explanations: [{ anchor: R_ID, kind: 'summary', body: 4242 }],
    glossary: [{ term: 'thing', defined: false }],
  } as unknown as ReviewFile;

  let html = '';
  assert.doesNotThrow(() => {
    html = renderReview(hostile);
  }, 'a half-written review.json must not throw the exporter');
  assert.ok(html.includes('Half-written decision'), 'coerced decision still rendered');
  assert.ok(html.includes('4242'), 'a numeric explanation body is coerced to text, not dropped');
  assert.ok(
    html.includes('id="open-questions"'),
    'the blocking stamp still raises an open question'
  );
});

/* -------------------------------------------------------------------------- */
/* review layer — agent-authored diagrams                                     */
/* -------------------------------------------------------------------------- */

/** A seed authored diagram anchored to the fixture doc; override per test. */
function authoredDiagram(overrides: Partial<AuthoredDiagram> = {}): AuthoredDiagram {
  return {
    id: 'diag_seed',
    title: 'Session lifecycle',
    type: 'state',
    anchor: D_ID,
    anchorLabel: 'Auth / Authentication',
    covers: [R_ID],
    mermaid:
      'stateDiagram-v2\n  [*] --> Anonymous\n  Anonymous --> Authenticated: sign in\n  Authenticated --> [*]: sign out',
    trigger: 'One entity moves through named states.',
    provenance: 'grounded',
    sources: [{ kind: 'requirement', anchor: R_ID }],
    specHash: '',
    author: 'agent',
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

/** The hash the fixture doc's authored diagrams must carry to read as fresh. */
function freshDocHash(): string {
  const doc = buildModel().docs[0];
  assert.ok(doc, 'fixture doc exists');
  return specHash(docStructureSource(doc));
}

test('an authored diagram renders as an inline mermaid figure with type and provenance badges', () => {
  const diagram = authoredDiagram({ specHash: freshDocHash() });
  const html = renderReview(reviewFile({ diagrams: [diagram] }));
  assert.ok(
    html.includes('<pre class="mermaid">stateDiagram-v2'),
    'authored mermaid embedded on the same inline pre.mermaid path'
  );
  assert.ok(html.includes('Session lifecycle'), 'diagram title rendered as the caption');
  assert.ok(/badge-diagram-type[^>]*>state<\/span>/.test(html), 'type badge rendered');
  assert.ok(/badge-grounded[^>]*>grounded<\/span>/.test(html), 'provenance badge rendered');
  assert.ok(html.includes('class="diagram diagram-authored'), 'authored figure carries its class');
  // The diagram anchors to the doc, so it lands above the derived scenario chart.
  const authoredAt = html.indexOf('diagram-authored');
  const sequenceAt = html.indexOf('Happy path sequence');
  assert.ok(authoredAt !== -1 && sequenceAt !== -1, 'both diagrams present');
  assert.ok(authoredAt < sequenceAt, 'authored diagram sits above the derived per-scenario chart');
  assert.ok(!/>stale<\/span>/.test(html), 'a fresh authored diagram is not marked stale');
});

test('a script payload in an authored diagram title is escaped, never emitted as live markup', () => {
  const diagram = authoredDiagram({
    id: 'diag_xss',
    title: `Danger ${XSS}`,
    specHash: freshDocHash(),
  });
  const html = renderReview(reviewFile({ diagrams: [diagram] }));
  assert.ok(
    !html.includes(`Danger ${XSS}`),
    'the raw payload never appears live in a diagram title'
  );
  assert.ok(
    html.includes('Danger &lt;script&gt;alert(1)&lt;/script&gt;'),
    'the diagram title appears escaped'
  );
});

test('an authored diagram whose spec hash drifted from the doc is marked stale', () => {
  const fresh = renderReview(
    reviewFile({ diagrams: [authoredDiagram({ specHash: freshDocHash() })] })
  );
  assert.ok(!/badge-stale[^>]*>stale<\/span>/.test(fresh), 'a matching doc hash is not stale');

  const stale = renderReview(
    reviewFile({ diagrams: [authoredDiagram({ specHash: 'deadbeefdeadbeef' })] })
  );
  assert.ok(
    /badge-stale[^>]*>stale<\/span>/.test(stale),
    'a drifted authored-diagram hash is marked stale'
  );
  assert.ok(stale.includes('diagram-authored is-stale'), 'the stale figure is flagged for styling');
});

test('a doc with only a diagram skip renders no authored-diagram block and does not throw', () => {
  const skip: DiagramSkip = {
    anchor: D_ID,
    specHash: freshDocHash(),
    reason: 'all scenarios are single-step lookups',
    author: 'agent',
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  let html = '';
  assert.doesNotThrow(() => {
    html = renderReview(reviewFile({ diagramSkips: [skip] }));
  }, 'a review carrying only a skip must not throw the exporter');
  // Match the rendered figure's class attribute, not the `.diagram-authored` CSS rule.
  assert.ok(
    !html.includes('class="diagram diagram-authored'),
    'no authored-diagram figure is emitted for a skip'
  );
});

/* -------------------------------------------------------------------------- */
/* export/notes CLI contract (touches the disk and the built CLI)             */
/* -------------------------------------------------------------------------- */

/** `dist/test/export.test.js` -> repo root, then the real bin entry point. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'spec-scope.js');
const execFileAsync = promisify(execFile);

/** Runs the built CLI and returns its streams plus exit code, never throwing. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      timeout: 60_000,
      env: { ...process.env, SPEC_SCOPE_NO_OPEN: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A minimal OpenSpec project with one open note seeded into its discussion store. */
async function makeSeededProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'spec-scope-export-'));
  await mkdir(path.join(dir, 'openspec', 'specs', 'auth'), { recursive: true });
  await writeFile(
    path.join(dir, 'openspec', 'specs', 'auth', 'spec.md'),
    [
      '# Authentication',
      '',
      '## Requirements',
      '',
      '### Requirement: Sign in with a passkey',
      '',
      'Users authenticate with a platform authenticator.',
      '',
      '#### Scenario: Successful sign-in',
      '',
      '- **GIVEN** an enrolled passkey',
      '- **WHEN** the user taps sign in',
      '- **THEN** the system opens a session',
      '',
    ].join('\n'),
    'utf8'
  );
  const store = new NoteStore(dir);
  await store.add({
    anchor: 'doc:auth/req:signin',
    anchorLabel: 'auth / Sign in with a passkey',
    kind: 'question',
    body: 'CONFIDENTIAL: should this note ship in the review pack?',
  });
  store.close();
  return dir;
}

test('exportTechDoc bakes open notes in by default and includeNotes:false opts out', async () => {
  const dir = await makeSeededProject();
  try {
    const withPath = path.join(dir, 'with-notes.html');
    await exportTechDoc({ root: dir, out: withPath });
    const withHtml = await readFile(withPath, 'utf8');
    assert.ok(withHtml.includes('id="appendix-notes"'), 'notes appendix present by default');
    assert.ok(withHtml.includes('CONFIDENTIAL'), 'seeded note body present by default');

    const withoutPath = path.join(dir, 'without-notes.html');
    await exportTechDoc({ root: dir, out: withoutPath, includeNotes: false });
    const withoutHtml = await readFile(withoutPath, 'utf8');
    assert.ok(
      !withoutHtml.includes('id="appendix-notes"'),
      'appendix omitted with includeNotes:false'
    );
    assert.ok(!withoutHtml.includes('CONFIDENTIAL'), 'note body absent with includeNotes:false');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exportTechDoc loads review.json off disk and bakes the decision ledger in', async () => {
  const dir = await makeSeededProject();
  try {
    // Seed the review sidecar on disk exactly as the agent's `apply` path would.
    const store = new ReviewStore(dir);
    try {
      await store.applyBatch({
        decisions: [
          {
            id: 'dec_disk_1',
            title: 'Adopt platform passkeys',
            context: 'Phishing resistance is required.',
            options: ['Passwords', 'Passkeys'],
            choice: 'Use platform passkeys as the primary factor.',
            tradeoffs: 'Devices without an authenticator need a fallback.',
            consequence: 'Password reset can be retired.',
            provenance: 'grounded',
            sources: [],
            status: 'recorded',
            author: 'reviewer',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      });
    } finally {
      store.close();
    }

    const out = path.join(dir, 'review-export.html');
    await exportTechDoc({ root: dir, out });
    const html = await readFile(out, 'utf8');
    assert.ok(html.includes('id="decision-ledger"'), 'ledger rendered from review.json on disk');
    assert.ok(html.includes('Adopt platform passkeys'), 'seeded decision title present');
    assert.ok(html.includes('1 recorded decision'), 'cover tally reflects the on-disk decision');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export --no-notes drops the appendix end-to-end; the default keeps it', async () => {
  const dir = await makeSeededProject();
  try {
    const withOut = path.join(dir, 'cli-with.html');
    const withRun = await runCli(['export', dir, '--out', withOut]);
    assert.equal(withRun.code, 0, withRun.stderr);
    const withHtml = await readFile(withOut, 'utf8');
    assert.ok(withHtml.includes('id="appendix-notes"'), 'default export includes the appendix');

    const withoutOut = path.join(dir, 'cli-without.html');
    const withoutRun = await runCli(['export', dir, '--no-notes', '--out', withoutOut]);
    assert.equal(withoutRun.code, 0, withoutRun.stderr);
    const withoutHtml = await readFile(withoutOut, 'utf8');
    assert.ok(!withoutHtml.includes('id="appendix-notes"'), '--no-notes drops the appendix');
    assert.ok(!withoutHtml.includes('CONFIDENTIAL'), '--no-notes drops the note body');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * FIX 4 is defence in depth: `NoteStore.load()` sanitises the store, so the
 * only way to reach `formatNote`/`printNotes` with a hostile note is to call
 * them directly with the shape a half-written `notes.json` could carry. These
 * casts deliberately violate the `Note` contract to exercise the print boundary.
 */
function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('formatNote coerces a hostile note instead of throwing', () => {
  const missingReplies = {
    id: 'note_missing_replies',
    anchor: 'doc:x/req:y',
    anchorLabel: 'auth / Sign in',
    kind: 'question',
    body: 'a normal body, but the replies array is missing entirely',
    author: 'reviewer',
    createdAt: '2026-01-02T03:04:05.000Z',
    status: 'open',
    // replies intentionally absent
  } as unknown as Note;

  let missingOut = '';
  assert.doesNotThrow(() => {
    missingOut = formatNote(missingReplies, false);
  }, 'a missing replies array must not throw');
  assert.ok(missingOut.includes('note_missing_replies'), missingOut);
  assert.ok(missingOut.includes('a normal body'), missingOut);

  const numericBody = {
    id: 'note_numeric_body',
    anchor: 'doc:x/req:z',
    anchorLabel: 'auth / Sign out',
    kind: 'change',
    body: 4242,
    author: 'reviewer',
    createdAt: '2026-01-02T03:04:05.000Z',
    status: 'open',
    replies: [{ id: 'r1', body: 7, author: 'agent', createdAt: '2026-01-02T04:00:00.000Z' }],
  } as unknown as Note;

  let numericOut = '';
  assert.doesNotThrow(() => {
    numericOut = formatNote(numericBody, true);
  }, 'a non-string body or reply body must not throw');
  assert.ok(numericOut.includes('4242'), 'numeric body coerced to text');
  assert.ok(numericOut.includes('> agent: 7'), 'numeric reply body coerced to text');
});

test('printNotes does not throw on a hostile note list', () => {
  const hostile = [
    {
      id: 'note_hostile',
      anchor: 'doc:x/req:y',
      anchorLabel: 'auth / Sign in',
      kind: 'question',
      body: 99,
      author: 'reviewer',
      createdAt: '2026-01-02T03:04:05.000Z',
      status: 'open',
      // replies intentionally absent
    },
  ] as unknown as Note[];

  let out = '';
  assert.doesNotThrow(() => {
    out = captureStdout(() => printNotes(hostile, false, false));
  });
  assert.ok(out.includes('note_hostile'), out);
  assert.ok(out.includes('99'), 'numeric body coerced to text, not dropped');
});
