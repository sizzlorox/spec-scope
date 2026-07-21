import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { validateAuthoredMermaid } from '../src/diagram.js';
import { ReviewStore } from '../src/review.js';
import type {
  AuthoredDiagram,
  Decision,
  DiagramSkip,
  Explanation,
  GlossaryTerm,
  Provenance,
  ReviewVerdict,
} from '../src/types.js';

let base: string;
let counter = 0;

/** A private project root per test, so watchers and files never cross-talk. */
function freshRoot(): string {
  counter += 1;
  return mkdtempSync(path.join(base, `project-${counter}-`));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Builders for `applyBatch` elements. `ReviewBatch` is typed with the full
 * records, but an agent's batch usually omits the generated `id`/`createdAt`;
 * the empty-string sentinels here exercise the store's field-generation path the
 * same way a real `spec-scope apply <file>` (untyped `JSON.parse`) would.
 */
function makeExplanation(over: Partial<Explanation> = {}): Explanation {
  return {
    id: '',
    anchor: 'doc:a/req:x',
    anchorLabel: 'A / requirement x',
    kind: 'summary',
    body: 'a plain-language summary',
    provenance: 'inferred',
    sources: [],
    specHash: '',
    author: 'agent',
    createdAt: '',
    ...over,
  };
}

function makeDecision(over: Partial<Decision> = {}): Decision {
  return {
    id: '',
    title: 'a decision',
    context: '',
    options: [],
    choice: 'a choice',
    tradeoffs: '',
    consequence: '',
    provenance: 'inferred',
    sources: [],
    status: 'open',
    author: 'agent',
    createdAt: '',
    ...over,
  };
}

function makeGlossary(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    id: '',
    term: 'Term',
    definition: 'a definition',
    provenance: 'inferred',
    sources: [],
    defined: true,
    author: 'agent',
    createdAt: '',
    ...over,
  };
}

/**
 * A comfortably-valid authored flowchart: the flowchart header its `type`
 * requires and four clearly labelled, edge-connected nodes — mid-range for the
 * validator's node bounds, so it stays valid under any faithful implementation
 * of the (empty / wrong-header / <3 / >24) contract.
 */
const VALID_FLOWCHART = 'flowchart TD\n  A[Start] --> B[Check]\n  B --> C[Work]\n  C --> D[Done]';

function makeDiagram(over: Partial<AuthoredDiagram> = {}): AuthoredDiagram {
  return {
    id: '',
    title: 'Request lifecycle',
    type: 'flowchart',
    anchor: 'doc:a',
    anchorLabel: 'A',
    covers: ['doc:a/req:x'],
    mermaid: VALID_FLOWCHART,
    trigger: 'a branching process with a decision point',
    provenance: 'inferred',
    sources: [],
    specHash: 'h1',
    author: 'agent',
    createdAt: '',
    ...over,
  };
}

function makeDiagramSkip(over: Partial<DiagramSkip> = {}): DiagramSkip {
  return {
    anchor: 'doc:a',
    specHash: 'h1',
    reason: 'all scenarios are single-step lookups',
    author: 'agent',
    createdAt: '',
    ...over,
  };
}

/** Resolves the first time `store` reports a change, or rejects after `timeoutMs`. */
function nextChange(store: ReviewStore, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsub = (): void => {};
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('onChange did not fire within timeout'));
    }, timeoutMs);
    unsub = store.onChange(() => {
      clearTimeout(timer);
      unsub();
      resolve();
    });
  });
}

/**
 * A standalone ESM worker that adds N decisions to a store, in its own OS
 * process. It imports the compiled ReviewStore by absolute file URL and exits
 * explicitly so a stray handle can never hang the parent test.
 */
const WORKER_SRC = `
const [url, root, nStr, label] = process.argv.slice(2);
const { ReviewStore } = await import(url);
const store = new ReviewStore(root);
const n = Number(nStr);
for (let i = 0; i < n; i += 1) {
  await store.addDecision({ title: label + ' decision ' + i, choice: 'choice ' + i });
}
store.close();
process.exit(0);
`;

function runWorker(script: string, root: string, count: number, label: string): Promise<void> {
  const reviewUrl = new URL('../src/review.js', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, reviewUrl, root, String(count), label], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${label} exited ${code}: ${stderr}`));
    });
  });
}

before(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'spec-scope-review-'));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('ReviewStore', () => {
  it('reads an empty review on a fresh project without creating anything', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const file = await store.load();
      assert.deepEqual(file, {
        version: 1,
        decisions: [],
        stamps: [],
        explanations: [],
        glossary: [],
        diagrams: [],
        diagramSkips: [],
      });
      assert.deepEqual(await store.listDecisions(), []);
      assert.deepEqual(await store.listStamps(), []);
      assert.deepEqual(await store.listExplanations(), []);
      assert.deepEqual(await store.listGlossary(), []);
      assert.deepEqual(await store.listDiagrams(), []);
      assert.deepEqual(await store.listDiagramSkips(), []);
      assert.equal(existsSync(path.join(root, '.spec-scope')), false);
      assert.deepEqual(store.warnings, []);
    } finally {
      store.close();
    }
  });

  it('adds, lists, updates and removes a decision', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const decision = await store.addDecision({
        title: 'Use Postgres',
        context: 'we need relational integrity',
        options: ['Postgres', 'Mongo'],
        choice: 'Postgres',
        tradeoffs: 'more ops overhead than a hosted document store',
        consequence: 'schema migrations become part of the workflow',
        provenance: 'inferred',
      });
      assert.match(decision.id, /^dec_/);
      assert.equal(decision.status, 'open');
      assert.equal(decision.author, 'human');
      assert.deepEqual(decision.options, ['Postgres', 'Mongo']);
      assert.equal(decision.updatedAt, undefined);
      assert.equal((await store.listDecisions()).length, 1);

      const updated = await store.updateDecision(decision.id, {
        status: 'recorded',
        choice: 'Postgres 16',
      });
      assert.equal(updated.status, 'recorded');
      assert.equal(updated.choice, 'Postgres 16');
      assert.equal(typeof updated.updatedAt, 'string');
      // Untouched fields survive the patch.
      assert.deepEqual(updated.options, ['Postgres', 'Mongo']);

      assert.equal((await store.listDecisions({ status: 'recorded' })).length, 1);
      assert.equal((await store.listDecisions({ status: 'open' })).length, 0);

      await store.removeDecision(decision.id);
      assert.deepEqual(await store.listDecisions(), []);
    } finally {
      store.close();
    }
  });

  it('sets and clears a decision threadNoteId', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const decision = await store.addDecision({
        title: 'From a thread',
        choice: 'x',
        threadNoteId: 'note_123',
      });
      assert.equal(decision.threadNoteId, 'note_123');

      const relinked = await store.updateDecision(decision.id, { threadNoteId: 'note_456' });
      assert.equal(relinked.threadNoteId, 'note_456');

      // An empty threadNoteId clears the link rather than storing a blank string.
      const cleared = await store.updateDecision(decision.id, { threadNoteId: '' });
      assert.equal(cleared.threadNoteId, undefined);
      assert.equal('threadNoteId' in cleared, false);
    } finally {
      store.close();
    }
  });

  it('defaults an unspecified decision provenance to inferred', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const decision = await store.addDecision({ title: 'Ship it', choice: 'yes' });
      assert.equal(decision.provenance, 'inferred');
      assert.deepEqual(decision.sources, []);
      assert.equal(decision.context, '');
    } finally {
      store.close();
    }
  });

  it('setStamp upserts on (anchor, author) and does not duplicate', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const first = await store.setStamp({
        anchor: 'doc:a/req:x',
        anchorLabel: 'A / requirement x',
        verdict: 'concern',
        note: 'needs a look',
      });
      assert.equal(first.verdict, 'concern');
      assert.match(first.id, /^stamp_/);

      // Same anchor + author: the verdict is replaced in place, not appended.
      const second = await store.setStamp({
        anchor: 'doc:a/req:x',
        anchorLabel: 'A / requirement x',
        verdict: 'approved',
      });
      assert.equal(second.id, first.id);
      assert.equal(second.verdict, 'approved');
      // A cleared note is dropped on update.
      assert.equal(second.note, undefined);

      const stamps = await store.listStamps();
      assert.equal(stamps.length, 1, 'a repeat stamp must not duplicate');
      assert.equal(stamps[0]?.verdict, 'approved');

      // A different author is a separate stamp on the same anchor.
      await store.setStamp({
        anchor: 'doc:a/req:x',
        anchorLabel: 'A / requirement x',
        verdict: 'blocking',
        author: 'reviewer-2',
      });
      assert.equal((await store.listStamps()).length, 2);

      const stamp = (await store.listStamps())[0];
      assert.ok(stamp);
      await store.removeStamp(stamp.id);
      assert.equal((await store.listStamps()).length, 1);
    } finally {
      store.close();
    }
  });

  it('applyBatch upserts by key and reports add vs update counts', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const explanation = makeExplanation({
        id: 'exp_1',
        body: 'The system authenticates before serving protected routes.',
        provenance: 'grounded',
        sources: [{ kind: 'requirement', anchor: 'doc:a/req:x' }],
        specHash: 'abc123',
      });

      const added = await store.applyBatch({ explanations: [explanation] });
      assert.deepEqual(added, { added: 1, updated: 0 });

      // Same (anchor, kind) upserts in place, keeping the original id.
      const updated = await store.applyBatch({
        explanations: [makeExplanation({ id: 'exp_ignored', body: 'A revised summary.' })],
      });
      assert.deepEqual(updated, { added: 0, updated: 1 });
      const explanations = await store.listExplanations();
      assert.equal(explanations.length, 1);
      assert.equal(explanations[0]?.body, 'A revised summary.');
      assert.equal(explanations[0]?.id, 'exp_1', 'the original id is preserved on upsert');

      // Decisions upsert by id; glossary upserts by term.
      const decision = makeDecision({
        id: 'dec_fixed',
        title: 'Adopt JWT sessions',
        choice: 'JWT',
      });
      const term = makeGlossary({
        term: 'Tenant',
        definition: 'a customer organisation with isolated data',
        provenance: 'grounded',
      });
      const both = await store.applyBatch({ decisions: [decision], glossary: [term] });
      assert.deepEqual(both, { added: 2, updated: 0 });

      const reapplied = await store.applyBatch({
        decisions: [
          makeDecision({ id: 'dec_fixed', title: 'Adopt JWT sessions (v2)', choice: 'JWT' }),
        ],
        glossary: [
          makeGlossary({
            term: 'Tenant',
            definition: 'a customer org with isolated data and billing',
            provenance: 'grounded',
          }),
        ],
      });
      assert.deepEqual(reapplied, { added: 0, updated: 2 });

      const decisions = await store.listDecisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.title, 'Adopt JWT sessions (v2)');
      const glossary = await store.listGlossary();
      assert.equal(glossary.length, 1);
      assert.equal(glossary[0]?.definition, 'a customer org with isolated data and billing');

      // A mixed batch counts adds and updates together.
      const mixed = await store.applyBatch({
        explanations: [makeExplanation({ body: 'third revision' })],
        glossary: [
          makeGlossary({ term: 'Session', definition: '', provenance: 'unstated', defined: false }),
        ],
      });
      assert.deepEqual(mixed, { added: 1, updated: 1 });
    } finally {
      store.close();
    }
  });

  it('applyBatch stores an authored diagram, lists it, and upserts by id', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const added = await store.applyBatch({
        diagrams: [makeDiagram({ id: 'dgm_1', title: 'Auth flow' })],
      });
      assert.deepEqual(added, { added: 1, updated: 0 });

      const diagrams = await store.listDiagrams();
      assert.equal(diagrams.length, 1);
      assert.equal(diagrams[0]?.id, 'dgm_1');
      assert.equal(diagrams[0]?.title, 'Auth flow');
      assert.equal(diagrams[0]?.type, 'flowchart');
      assert.equal(diagrams[0]?.mermaid, VALID_FLOWCHART);
      assert.deepEqual(diagrams[0]?.covers, ['doc:a/req:x']);

      // Same id upserts in place, keeping the original createdAt.
      const updated = await store.applyBatch({
        diagrams: [makeDiagram({ id: 'dgm_1', title: 'Auth flow v2' })],
      });
      assert.deepEqual(updated, { added: 0, updated: 1 });
      const after = await store.listDiagrams();
      assert.equal(after.length, 1);
      assert.equal(after[0]?.title, 'Auth flow v2');
      assert.equal(after[0]?.createdAt, diagrams[0]?.createdAt);

      // An absent id is minted, like every other record.
      const minted = await store.applyBatch({ diagrams: [makeDiagram({ anchor: 'doc:b' })] });
      assert.deepEqual(minted, { added: 1, updated: 0 });
      const both = await store.listDiagrams();
      const fresh = both.find((d) => d.anchor === 'doc:b');
      assert.match(String(fresh?.id), /^diag_/);
    } finally {
      store.close();
    }
  });

  it('rejects an authored diagram whose mermaid fails validation, landing nothing', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      // Wrong header for the declared type: a sequence diagram with a flowchart body.
      // The store must surface the validator's own error verbatim, not a generic one.
      const headerVerdict = validateAuthoredMermaid(VALID_FLOWCHART, 'sequence');
      const headerError = headerVerdict.ok ? '' : headerVerdict.error;
      assert.ok(headerError.length > 0, 'the validator must reject a mismatched header');
      await assert.rejects(
        store.applyBatch({
          diagrams: [makeDiagram({ type: 'sequence', mermaid: VALID_FLOWCHART })],
        }),
        (err: unknown) =>
          err instanceof Error &&
          /diagram mermaid is invalid/.test(err.message) &&
          err.message.includes(headerError)
      );
      assert.equal((await store.listDiagrams()).length, 0, 'a rejected diagram must not land');

      // A two-node triviality is below the validator's node floor.
      const twoNode = 'flowchart TD\n  A[Only] --> B[Two]';
      const nodeVerdict = validateAuthoredMermaid(twoNode, 'flowchart');
      const nodeError = nodeVerdict.ok ? '' : nodeVerdict.error;
      assert.ok(nodeError.length > 0, 'the validator must reject a 2-node diagram');
      await assert.rejects(
        store.applyBatch({
          diagrams: [makeDiagram({ type: 'flowchart', mermaid: twoNode })],
        }),
        (err: unknown) =>
          err instanceof Error &&
          /diagram mermaid is invalid/.test(err.message) &&
          err.message.includes(nodeError)
      );
      assert.equal((await store.listDiagrams()).length, 0);

      // All-or-nothing: a valid diagram alongside an invalid one lands nothing.
      await assert.rejects(
        store.applyBatch({
          diagrams: [
            makeDiagram({ id: 'dgm_good', anchor: 'doc:a' }),
            makeDiagram({ id: 'dgm_bad', anchor: 'doc:b', mermaid: '' }),
          ],
        }),
        /diagram\.mermaid must be a non-empty string|diagram mermaid is invalid/
      );
      assert.equal(
        (await store.listDiagrams()).length,
        0,
        'a batch with one bad diagram must land nothing'
      );

      // The write queue is not poisoned — a good batch still applies afterward.
      const ok = await store.applyBatch({ diagrams: [makeDiagram({ id: 'dgm_ok' })] });
      assert.deepEqual(ok, { added: 1, updated: 0 });
    } finally {
      store.close();
    }
  });

  it('diagramSkip upserts by anchor and supersedes / is superseded by a diagram', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      // A skip is added, then upserted in place by its anchor.
      const first = await store.applyBatch({
        diagramSkips: [makeDiagramSkip({ anchor: 'doc:a' })],
      });
      assert.deepEqual(first, { added: 1, updated: 0 });
      assert.equal((await store.listDiagramSkips()).length, 1);

      const second = await store.applyBatch({
        diagramSkips: [makeDiagramSkip({ anchor: 'doc:a', reason: 'reconsidered — still none' })],
      });
      assert.deepEqual(second, { added: 0, updated: 1 }, 'a skip upserts by anchor');
      const skips = await store.listDiagramSkips();
      assert.equal(skips.length, 1);
      assert.equal(skips[0]?.reason, 'reconsidered — still none');

      // Authoring a diagram for that anchor clears the skip (authoring supersedes "none").
      const authored = await store.applyBatch({
        diagrams: [makeDiagram({ id: 'dgm_a', anchor: 'doc:a' })],
      });
      assert.deepEqual(authored, { added: 1, updated: 0 });
      assert.equal((await store.listDiagramSkips()).length, 0, 'a diagram clears the skip');
      assert.equal((await store.listDiagrams()).length, 1);

      // The reverse: a skip for that anchor removes the diagram (the agent changed its mind).
      const reskipped = await store.applyBatch({
        diagramSkips: [makeDiagramSkip({ anchor: 'doc:a' })],
      });
      assert.deepEqual(reskipped, { added: 1, updated: 0 });
      assert.equal(
        (await store.listDiagrams()).length,
        0,
        'a skip removes diagrams for its anchor'
      );
      assert.equal((await store.listDiagramSkips()).length, 1);
    } finally {
      store.close();
    }
  });

  it('loads an old review.json with no diagram keys as empty, never throwing', async () => {
    const root = freshRoot();
    const dir = path.join(root, '.spec-scope');
    await mkdir(dir, { recursive: true });
    // A review.json written before authored diagrams existed: neither key present.
    const legacy = { version: 1, decisions: [], stamps: [], explanations: [], glossary: [] };
    await writeFile(path.join(dir, 'review.json'), JSON.stringify(legacy), 'utf8');

    const store = new ReviewStore(root);
    try {
      const file = await store.load();
      assert.deepEqual(file.diagrams, []);
      assert.deepEqual(file.diagramSkips, []);
      assert.deepEqual(await store.listDiagrams(), []);
      assert.deepEqual(await store.listDiagramSkips(), []);
      // A missing key is back-compat, not corruption — no warning is raised.
      assert.deepEqual(store.warnings, []);
    } finally {
      store.close();
    }
  });

  it('salvages hostile diagram entries on load and never throws a consumer', async () => {
    const root = freshRoot();
    const dir = path.join(root, '.spec-scope');
    await mkdir(dir, { recursive: true });
    const onDisk = {
      version: 1,
      decisions: [],
      stamps: [],
      explanations: [],
      glossary: [],
      diagrams: [
        // Numeric mermaid, missing type: salvaged, never dropped — mermaid coerced
        // to a string, type defaulted to `flowchart`.
        { anchor: 'doc:a', anchorLabel: 'A', title: 'hostile', mermaid: 42 },
        'garbage',
        null,
        7,
      ],
      diagramSkips: [
        { anchor: 'doc:b', specHash: 'h', author: 'agent', createdAt: '2026-01-01T00:00:00.000Z' },
        5,
      ],
    };
    await writeFile(path.join(dir, 'review.json'), JSON.stringify(onDisk), 'utf8');

    const store = new ReviewStore(root);
    try {
      const file = await store.load();
      assert.equal(file.diagrams.length, 1, 'one diagram salvaged, three junk dropped');
      assert.equal(file.diagramSkips.length, 1);

      const salvaged = file.diagrams[0];
      assert.ok(salvaged);
      assert.equal(typeof salvaged.mermaid, 'string');
      assert.equal(salvaged.mermaid, '42');
      assert.equal(salvaged.type, 'flowchart', 'a missing/unknown type defaults to flowchart');
      // Every consumer-visible string field is a string, so nothing downstream throws.
      for (const key of [
        'id',
        'title',
        'anchor',
        'anchorLabel',
        'mermaid',
        'trigger',
        'provenance',
        'specHash',
        'author',
        'createdAt',
      ] as const) {
        assert.equal(typeof salvaged[key], 'string');
      }
      assert.ok(Array.isArray(salvaged.covers));
      assert.ok(Array.isArray(salvaged.sources));

      assert.equal(store.warnings.length, 1);
      assert.match(String(store.warnings[0]), /unreadable/);
    } finally {
      store.close();
    }
  });

  it('filters explanations by kind and anchor', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      await store.applyBatch({
        explanations: [
          makeExplanation({ anchor: 'doc:a/req:x', anchorLabel: 'X', kind: 'summary' }),
          makeExplanation({ anchor: 'doc:a/req:x/scn:s', anchorLabel: 'S', kind: 'narration' }),
        ],
      });
      assert.equal((await store.listExplanations({ kind: 'summary' })).length, 1);
      assert.equal((await store.listExplanations({ anchor: 'doc:a/req:x/scn:s' })).length, 1);
      assert.equal(
        (await store.listExplanations({ kind: 'summary', anchor: 'doc:a/req:x/scn:s' })).length,
        0
      );
    } finally {
      store.close();
    }
  });

  it('rejects invalid provenance, verdict and over-long input', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      await assert.rejects(
        store.addDecision({ title: 't', choice: 'c', provenance: 'bogus' as Provenance }),
        /provenance must be one of/
      );
      await assert.rejects(
        store.setStamp({ anchor: 'a', anchorLabel: 'A', verdict: 'nope' as ReviewVerdict }),
        /verdict must be one of/
      );
      await assert.rejects(
        store.addDecision({ title: 'x'.repeat(201), choice: 'c' }),
        /title must be at most 200 characters/
      );
      await assert.rejects(
        store.addDecision({ title: 't', choice: 'c'.repeat(8001) }),
        /choice must be at most 8000 characters/
      );
      await assert.rejects(
        store.setStamp({
          anchor: 'a',
          anchorLabel: 'A',
          verdict: 'concern',
          note: 'n'.repeat(8001),
        }),
        /note must be at most 8000 characters/
      );
      await assert.rejects(
        store.addDecision({ title: '   ', choice: 'c' }),
        /title must be a non-empty string/
      );

      // A whole batch is rejected if any element is invalid — nothing lands.
      await assert.rejects(
        store.applyBatch({
          explanations: [
            makeExplanation({ anchor: 'doc:a/req:x', anchorLabel: 'X', body: 'fine' }),
            makeExplanation({
              anchor: 'doc:a/req:y',
              anchorLabel: 'Y',
              body: 'bad provenance',
              provenance: 'made-up' as Provenance,
            }),
          ],
        }),
        /provenance must be one of/
      );
      assert.equal(
        (await store.listExplanations()).length,
        0,
        'a rejected batch must land nothing'
      );

      // The write queue is not poisoned by the rejections above.
      const ok = await store.addDecision({ title: 'still works', choice: 'yes' });
      assert.equal(ok.title, 'still works');
      assert.equal((await store.listDecisions()).length, 1);
    } finally {
      store.close();
    }
  });

  it('trims and caps input at the limits', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      const decision = await store.addDecision({
        title: `  ${'t'.repeat(200)}  `,
        choice: 'c',
        author: '  reviewer  ',
      });
      assert.equal(decision.title.length, 200);
      assert.equal(decision.author, 'reviewer');
    } finally {
      store.close();
    }
  });

  it('reports unknown ids and does not poison the write queue', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      // These throw *inside* the locked section, exercising run()'s isolation.
      await assert.rejects(
        store.updateDecision('dec_missing', { status: 'recorded' }),
        /dec_missing/
      );
      await assert.rejects(store.removeDecision('dec_missing'), /dec_missing/);
      await assert.rejects(store.removeStamp('stamp_missing'), /stamp_missing/);

      const decision = await store.addDecision({ title: 'ok', choice: 'c' });
      assert.equal((await store.listDecisions()).length, 1);
      assert.ok(decision.id);
    } finally {
      store.close();
    }
  });

  it('quarantines a corrupt review.json and records a warning', async () => {
    const root = freshRoot();
    const dir = path.join(root, '.spec-scope');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'review.json'), '{ this is not json', 'utf8');

    const store = new ReviewStore(root);
    try {
      const file = await store.load();
      assert.deepEqual(file, {
        version: 1,
        decisions: [],
        stamps: [],
        explanations: [],
        glossary: [],
        diagrams: [],
        diagramSkips: [],
      });
      assert.equal(store.warnings.length, 1);
      assert.match(String(store.warnings[0]), /review\.corrupt-1\.json/);
      assert.equal(existsSync(path.join(dir, 'review.corrupt-1.json')), true);

      // Still usable, and the warning is not re-raised on the next load.
      await store.addDecision({ title: 'recovered', choice: 'yes' });
      assert.equal((await store.listDecisions()).length, 1);
      assert.equal(store.warnings.length, 1);
    } finally {
      store.close();
    }

    // A second corruption takes the next quarantine index.
    writeFileSync(path.join(dir, 'review.json'), 'also not json', 'utf8');
    const second = new ReviewStore(root);
    try {
      assert.deepEqual(await second.listDecisions(), []);
      assert.equal(existsSync(path.join(dir, 'review.corrupt-2.json')), true);
    } finally {
      second.close();
    }
  });

  it('salvages a partial hand-written review.json instead of crashing consumers', async () => {
    const root = freshRoot();
    const dir = path.join(root, '.spec-scope');
    await mkdir(dir, { recursive: true });
    const okDecision = {
      id: 'dec_ok',
      title: 'Keep the monolith',
      context: 'team is small',
      options: ['monolith', 'microservices'],
      choice: 'monolith',
      tradeoffs: 'harder to scale teams later',
      consequence: 'one deploy pipeline',
      provenance: 'grounded',
      sources: [],
      status: 'recorded',
      author: 'agent',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const onDisk = {
      version: 1,
      decisions: [
        okDecision,
        // Numeric title, boolean choice, everything else missing.
        { title: 42, choice: true },
        'garbage',
        null,
      ],
      stamps: [
        // Unknown verdict is coerced to `concern`, never dropped or approved.
        { id: 'stamp_ok', anchor: 'doc:a', anchorLabel: 'A', verdict: 'nonsense', author: 'human' },
        99,
      ],
      explanations: [
        // Unknown kind -> summary; unknown provenance -> inferred.
        { anchor: 'doc:a/req:x', kind: 'weird', body: 'hi', provenance: 'bogus' },
      ],
      glossary: [{ term: 'Tenant', definition: '', defined: false, provenance: 'unstated' }],
    };
    await writeFile(path.join(dir, 'review.json'), JSON.stringify(onDisk), 'utf8');

    const store = new ReviewStore(root);
    try {
      const file = await store.load();
      assert.equal(file.decisions.length, 2, 'two decisions salvaged, two junk dropped');
      assert.equal(file.stamps.length, 1);
      assert.equal(file.explanations.length, 1);
      assert.equal(file.glossary.length, 1);

      // A single deduped warning names the dropped entries (survives a second load).
      assert.equal(store.warnings.length, 1);
      assert.match(String(store.warnings[0]), /3 unreadable entries/);

      // A fully valid decision round-trips deep-equal.
      const byId = new Map(file.decisions.map((d) => [d.id, d]));
      assert.deepEqual(byId.get('dec_ok'), okDecision);

      const salvaged = file.decisions.find((d) => d.id !== 'dec_ok');
      assert.ok(salvaged);
      assert.equal(salvaged.title, '42');
      assert.equal(salvaged.choice, 'true');
      assert.equal(salvaged.provenance, 'inferred');
      assert.equal(salvaged.status, 'open');

      assert.equal(file.stamps[0]?.verdict, 'concern');
      assert.equal(file.explanations[0]?.kind, 'summary');
      assert.equal(file.explanations[0]?.provenance, 'inferred');
      assert.equal(file.glossary[0]?.defined, false);

      // Every consumer-visible string field is a string, so nothing downstream throws.
      for (const decision of file.decisions) {
        for (const key of [
          'id',
          'title',
          'context',
          'choice',
          'tradeoffs',
          'consequence',
          'provenance',
          'status',
          'author',
          'createdAt',
        ] as const) {
          assert.equal(typeof decision[key], 'string');
        }
        assert.ok(Array.isArray(decision.options));
        assert.ok(Array.isArray(decision.sources));
      }

      // Still usable after salvaging.
      await store.addDecision({ title: 'added later', choice: 'x' });
      assert.equal((await store.listDecisions()).length, 3);
    } finally {
      store.close();
    }
  });

  it('two ReviewStore instances see each other writes', async () => {
    const root = freshRoot();
    const writer = new ReviewStore(root);
    const reader = new ReviewStore(root);
    try {
      // Generous timeout: this asserts the fs watcher fires at all, not how fast.
      const changed = nextChange(reader, 5000);
      await delay(150); // let the reader's watcher attach

      await writer.addDecision({ title: 'written by the other instance', choice: 'yes' });

      await changed;
      const decisions = await reader.listDecisions();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.title, 'written by the other instance');
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('onChange notifies subscribers and unsubscribes cleanly', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    try {
      let calls = 0;
      const unsubscribe = store.onChange(() => {
        calls += 1;
      });

      await store.addDecision({ title: 'first', choice: 'c' });
      assert.equal(calls, 1);

      unsubscribe();
      unsubscribe(); // idempotent
      await store.addDecision({ title: 'second', choice: 'c' });
      assert.equal(calls, 1);
    } finally {
      store.close();
    }
  });

  it('close() is idempotent and leaves no open handles', async () => {
    const root = freshRoot();
    const store = new ReviewStore(root);
    await store.addDecision({ title: 't', choice: 'c' });
    store.onChange(() => {});
    store.close();
    store.close();
    store.close();
    // If a watcher or timer leaked, the test process would never exit.
  });

  it(
    'two concurrent processes both persist every decision (no loss, no corruption)',
    { timeout: 30000 },
    async () => {
      const root = freshRoot();
      const worker = path.join(base, 'concurrent-review-worker.mjs');
      writeFileSync(worker, WORKER_SRC, 'utf8');

      const perProcess = 20;
      await Promise.all([
        runWorker(worker, root, perProcess, 'A'),
        runWorker(worker, root, perProcess, 'B'),
      ]);

      const store = new ReviewStore(root);
      try {
        const decisions = await store.listDecisions();
        assert.equal(
          decisions.length,
          2 * perProcess,
          `expected ${2 * perProcess} decisions, got ${decisions.length}`
        );
        const titles = new Set(decisions.map((d) => d.title));
        assert.equal(titles.size, 2 * perProcess, 'no decision was lost or duplicated');
        assert.deepEqual(store.warnings, [], 'no corruption warning should be raised');

        const entries = readdirSync(path.join(root, '.spec-scope'));
        assert.deepEqual(
          entries.filter((name) => name.includes('.corrupt')),
          [],
          'no review file was quarantined'
        );
        assert.deepEqual(
          entries.filter((name) => name.endsWith('.tmp')),
          [],
          'no temp file was left behind'
        );
        assert.deepEqual(
          entries.filter((name) => name.endsWith('.lock')),
          [],
          'no lock file was left behind'
        );
        assert.deepEqual(entries, ['review.json']);
      } finally {
        store.close();
      }
    }
  );
});
