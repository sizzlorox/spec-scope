import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NoteStore } from '../src/notes.js';
import type { Note, NoteKind } from '../src/types.js';

let base: string;
let counter = 0;

/** A private project root per test, so watchers and files never cross-talk. */
function freshRoot(): string {
  counter += 1;
  return mkdtempSync(path.join(base, `project-${counter}-`));
}

function sampleInput(overrides: Partial<Parameters<NoteStore['add']>[0]> = {}) {
  return {
    anchor: 'doc:specs-auth/req:user-can-log-in',
    anchorLabel: 'Auth spec / User can log in',
    kind: 'question' as NoteKind,
    body: 'Which identity provider is assumed here?',
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A note shaped as if a different process had written it. */
function externalNote(): Note {
  return {
    id: 'note_external',
    anchor: 'doc:specs-auth',
    anchorLabel: 'Auth spec',
    kind: 'change',
    body: 'written by another process',
    author: 'agent',
    createdAt: new Date().toISOString(),
    status: 'open',
    replies: [],
  };
}

/**
 * A standalone ESM worker that adds N notes to a store, in its own OS process.
 * It imports the compiled NoteStore by absolute file URL (argv[2]) and exits
 * explicitly so a stray handle can never hang the parent test.
 */
const WORKER_SRC = `
const [url, root, nStr, label] = process.argv.slice(2);
const { NoteStore } = await import(url);
const store = new NoteStore(root);
const n = Number(nStr);
for (let i = 0; i < n; i += 1) {
  await store.add({
    anchor: 'doc:concurrent',
    anchorLabel: 'Concurrent',
    kind: 'question',
    body: label + '#' + i,
  });
}
store.close();
process.exit(0);
`;

function runWorker(script: string, root: string, count: number, label: string): Promise<void> {
  const notesUrl = new URL('../src/notes.js', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, notesUrl, root, String(count), label], {
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

/** Mirrors cli.ts `formatNote`: the exact field access a salvaged note must survive. */
function formatNoteShaped(note: Note): string {
  const indent = (body: string): string =>
    body
      .trim()
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
  const lines = [
    `${note.id} [${note.kind}] (${note.status}) ${note.anchorLabel}`,
    indent(note.body),
  ];
  for (const reply of note.replies) {
    lines.push(indent(`> ${reply.author}: ${reply.body.trim()}`));
  }
  return lines.join('\n');
}

before(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'spec-scope-'));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('NoteStore', () => {
  it('reads an empty store on a fresh project without creating anything', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      const file = await store.load();
      assert.deepEqual(file, { version: 1, notes: [] });
      assert.deepEqual(await store.list(), []);
      assert.equal(existsSync(path.join(root, '.spec-scope', 'notes.json')), false);
      assert.deepEqual(store.warnings, []);
    } finally {
      store.close();
    }
  });

  it('round-trips add, list, resolve, reopen and remove', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      const note = await store.add(sampleInput());
      assert.equal(note.status, 'open');
      assert.equal(note.author, 'human');
      assert.deepEqual(note.replies, []);
      assert.equal(note.resolvedAt, undefined);
      assert.match(note.id, /^note_/);

      assert.equal((await store.list()).length, 1);
      assert.equal((await store.list({ status: 'open' })).length, 1);
      assert.equal((await store.list({ status: 'resolved' })).length, 0);

      const replied = await store.reply(note.id, 'Okta, see the design doc.', 'agent');
      assert.equal(replied.replies.length, 1);
      assert.equal(replied.replies[0]?.author, 'agent');
      assert.match(String(replied.replies[0]?.id), /^rep_/);

      const resolved = await store.resolve(note.id);
      assert.equal(resolved.status, 'resolved');
      assert.equal(typeof resolved.resolvedAt, 'string');
      assert.equal((await store.list({ status: 'open' })).length, 0);
      assert.equal((await store.list({ status: 'resolved' })).length, 1);

      const reopened = await store.reopen(note.id);
      assert.equal(reopened.status, 'open');
      assert.equal(reopened.resolvedAt, undefined);
      assert.equal((await store.list({ status: 'open' })).length, 1);

      await store.remove(note.id);
      assert.deepEqual(await store.list(), []);
    } finally {
      store.close();
    }
  });

  it('lists notes newest last', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      await store.add(sampleInput({ body: 'first' }));
      await store.add(sampleInput({ body: 'second' }));
      await store.add(sampleInput({ body: 'third' }));
      assert.deepEqual(
        (await store.list()).map((note) => note.body),
        ['first', 'second', 'third']
      );
    } finally {
      store.close();
    }
  });

  it('reports unknown ids by id', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      await assert.rejects(store.resolve('note_missing'), /note_missing/);
      await assert.rejects(store.reopen('note_missing'), /note_missing/);
      await assert.rejects(store.remove('note_missing'), /note_missing/);
      await assert.rejects(store.reply('note_missing', 'hi'), /note_missing/);
    } finally {
      store.close();
    }
  });

  it('persists across store instances', async () => {
    const root = freshRoot();
    const first = new NoteStore(root);
    let id: string;
    try {
      const note = await first.add(sampleInput({ body: 'survives a restart' }));
      id = note.id;
    } finally {
      first.close();
    }

    const second = new NoteStore(root);
    try {
      const notes = await second.list();
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.id, id);
      assert.equal(notes[0]?.body, 'survives a restart');
    } finally {
      second.close();
    }
  });

  it('rejects invalid input', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      await assert.rejects(
        store.add(sampleInput({ kind: 'nonsense' as NoteKind })),
        /kind must be one of/
      );
      await assert.rejects(store.add(sampleInput({ body: '' })), /body must be a non-empty string/);
      await assert.rejects(
        store.add(sampleInput({ body: '   \n\t ' })),
        /body must be a non-empty string/
      );
      await assert.rejects(
        store.add(sampleInput({ body: 'x'.repeat(8001) })),
        /body must be at most 8000 characters/
      );
      await assert.rejects(store.add(sampleInput({ anchor: '' })), /anchor must be a non-empty/);
      await assert.rejects(
        store.add(sampleInput({ anchorLabel: 'y'.repeat(513) })),
        /anchorLabel must be at most 512 characters/
      );
      await assert.rejects(
        store.add(sampleInput({ author: 'z'.repeat(65) })),
        /author must be at most 64 characters/
      );
      await assert.rejects(
        store.add(sampleInput({ body: 42 as unknown as string })),
        /body must be a string/
      );

      // A rejected write must not poison the queue.
      const ok = await store.add(sampleInput({ body: 'still works' }));
      assert.equal(ok.body, 'still works');
      assert.equal((await store.list()).length, 1);
    } finally {
      store.close();
    }
  });

  it('trims and accepts input at the limits', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      const note = await store.add(
        sampleInput({ body: `  ${'x'.repeat(8000)}  `, author: '  reviewer  ' })
      );
      assert.equal(note.body.length, 8000);
      assert.equal(note.author, 'reviewer');
    } finally {
      store.close();
    }
  });

  it('quarantines a corrupt notes file and records a warning', async () => {
    const root = freshRoot();
    const dir = path.join(root, '.spec-scope');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'notes.json'), '{ this is not json', 'utf8');

    const store = new NoteStore(root);
    try {
      assert.deepEqual(await store.list(), []);
      assert.equal(store.warnings.length, 1);
      assert.match(String(store.warnings[0]), /notes\.corrupt-1\.json/);
      assert.equal(existsSync(path.join(dir, 'notes.corrupt-1.json')), true);

      // The store is usable afterwards, and a second corruption takes the next index.
      await store.add(sampleInput());
      assert.equal((await store.list()).length, 1);
    } finally {
      store.close();
    }

    writeFileSync(path.join(dir, 'notes.json'), 'also not json', 'utf8');
    const second = new NoteStore(root);
    try {
      assert.deepEqual(await second.list(), []);
      assert.equal(existsSync(path.join(dir, 'notes.corrupt-2.json')), true);
    } finally {
      second.close();
    }
  });

  it('leaves no temp file behind after writes', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      await Promise.all([
        store.add(sampleInput({ body: 'one' })),
        store.add(sampleInput({ body: 'two' })),
        store.add(sampleInput({ body: 'three' })),
      ]);

      // Serialised writes: none of the three may be lost to a read-modify-write race.
      assert.equal((await store.list()).length, 3);

      const entries = readdirSync(path.join(root, '.spec-scope'));
      assert.deepEqual(
        entries.filter((name) => name.endsWith('.tmp')),
        []
      );
      assert.deepEqual(entries, ['notes.json']);
    } finally {
      store.close();
    }
  });

  it('wait() resolves when a note is added in the same process', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      const pending = store.wait({ timeoutMs: 5000 });
      const added = await store.add(sampleInput({ body: 'wake up' }));
      const notes = await pending;
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.id, added.id);
      assert.equal(notes[0]?.status, 'open');
    } finally {
      store.close();
    }
  });

  it('wait() yields only open notes', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      const stale = await store.add(sampleInput({ body: 'already handled' }));
      await store.resolve(stale.id);

      const pending = store.wait({ timeoutMs: 5000 });
      await store.add(sampleInput({ body: 'needs an answer' }));
      const notes = await pending;
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.body, 'needs an answer');
    } finally {
      store.close();
    }
  });

  it('wait() resolves with an empty array on timeout', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      const started = Date.now();
      const notes = await store.wait({ timeoutMs: 100 });
      assert.deepEqual(notes, []);
      assert.ok(Date.now() - started >= 90, 'should have waited for the timeout');
    } finally {
      store.close();
    }
  });

  it('wait() rejects with an AbortError when the signal fires', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      const controller = new AbortController();
      const pending = store.wait({ timeoutMs: 5000, signal: controller.signal });
      controller.abort();
      await assert.rejects(pending, (err: Error) => err.name === 'AbortError');

      // An already-aborted signal rejects immediately too.
      await assert.rejects(
        store.wait({ timeoutMs: 5000, signal: AbortSignal.abort() }),
        (err: Error) => err.name === 'AbortError'
      );
    } finally {
      store.close();
    }
  });

  it('wait() wakes on a write from outside this process', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      // Generous timeout: this asserts the fs watcher fires at all, not how fast.
      const pending = store.wait({ timeoutMs: 5000 });
      await delay(150); // let the watcher attach

      // Write notes.json behind the store's back, as a second CLI invocation would.
      const dir = path.join(root, '.spec-scope');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'notes.json'),
        JSON.stringify({ version: 1, notes: [externalNote()] }),
        'utf8'
      );

      const notes = await pending;
      assert.equal(notes.length, 1);
      assert.equal(notes[0]?.body, 'written by another process');
    } finally {
      store.close();
    }
  });

  it('onChange notifies subscribers and unsubscribes cleanly', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      let calls = 0;
      const unsubscribe = store.onChange(() => {
        calls += 1;
      });

      await store.add(sampleInput({ body: 'first' }));
      assert.equal(calls, 1);

      unsubscribe();
      unsubscribe(); // idempotent
      await store.add(sampleInput({ body: 'second' }));
      assert.equal(calls, 1);
    } finally {
      store.close();
    }
  });

  it('close() is idempotent and leaves no open handles', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    await store.add(sampleInput());
    store.onChange(() => {});
    store.close();
    store.close();
    store.close();
    // If a watcher or timer leaked, the test process would never exit.
  });

  it(
    'two concurrent processes both persist every note (no loss, no corruption)',
    { timeout: 30000 },
    async () => {
      const root = freshRoot();
      const worker = path.join(base, 'concurrent-worker.mjs');
      writeFileSync(worker, WORKER_SRC, 'utf8');

      const perProcess = 20;
      await Promise.all([
        runWorker(worker, root, perProcess, 'A'),
        runWorker(worker, root, perProcess, 'B'),
      ]);

      const store = new NoteStore(root);
      try {
        const notes = await store.list();
        // Every accepted note from both processes must survive: last-writer-wins loss
        // and shared-temp corruption would leave fewer than 2N here.
        assert.equal(
          notes.length,
          2 * perProcess,
          `expected ${2 * perProcess} notes, got ${notes.length}`
        );
        const bodies = new Set(notes.map((note) => note.body));
        assert.equal(bodies.size, 2 * perProcess, 'no note body was lost or duplicated');
        assert.deepEqual(store.warnings, [], 'no corruption warning should be raised');

        const entries = readdirSync(path.join(root, '.spec-scope'));
        assert.deepEqual(
          entries.filter((name) => name.includes('.corrupt')),
          [],
          'no note file was quarantined'
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
        assert.deepEqual(entries, ['notes.json']);
      } finally {
        store.close();
      }
    }
  );

  it('salvages a partial hand-written notes.json instead of crashing consumers', async () => {
    const root = freshRoot();
    const dir = path.join(root, '.spec-scope');
    await mkdir(dir, { recursive: true });
    const onDisk = {
      version: 1,
      notes: [
        {
          id: 'note_ok',
          anchor: 'doc:a',
          anchorLabel: 'A',
          kind: 'question',
          body: 'fine',
          author: 'human',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'open',
          replies: [],
        },
        // Missing `replies`, numeric `body`, unknown `kind`, no author/createdAt/status.
        { id: 'note_bad', anchor: 'doc:b', anchorLabel: 'B', kind: 'nope', body: 42 },
        // Replies present but with a numeric body, a non-object entry and one missing its id.
        {
          id: 'note_c',
          anchor: 'doc:c',
          anchorLabel: 'C',
          kind: 'change',
          body: 'has replies',
          author: 'human',
          createdAt: '2026-01-02T00:00:00.000Z',
          status: 'resolved',
          replies: [
            { id: 'rep_1', body: 7, author: 'agent', createdAt: 't' },
            'garbage',
            { body: 'no id' },
          ],
        },
        // Wholly unsalvageable elements.
        'this is not a note',
        null,
        42,
      ],
    };
    await writeFile(path.join(dir, 'notes.json'), JSON.stringify(onDisk), 'utf8');

    const store = new NoteStore(root);
    try {
      const notes = await store.list();
      // The three object entries are salvaged; the three junk entries are dropped.
      assert.equal(notes.length, 3);
      assert.deepEqual((await store.load()).notes.length, 3);

      // A single, deduped warning names the dropped entries (and survives the extra load above).
      assert.equal(store.warnings.length, 1);
      assert.match(String(store.warnings[0]), /3 unreadable entries/);

      // The `formatNote`-shaped access every consumer performs must never throw.
      for (const note of notes) {
        assert.doesNotThrow(() => formatNoteShaped(note));
      }

      const byId = new Map(notes.map((note) => [note.id, note]));

      // A fully valid note round-trips deep-equal: no field added, dropped or retyped.
      assert.deepEqual(byId.get('note_ok'), onDisk.notes[0]);

      const bad = byId.get('note_bad');
      assert.ok(bad);
      assert.equal(bad.body, '42'); // numeric body salvaged to a string
      assert.equal(bad.kind, 'question'); // unknown kind falls back
      assert.equal(bad.author, 'human'); // default author
      assert.equal(bad.status, 'open'); // default status
      assert.equal(bad.createdAt, '');
      assert.deepEqual(bad.replies, []); // missing replies becomes an array

      const c = byId.get('note_c');
      assert.ok(c);
      assert.equal(c.status, 'resolved');
      assert.equal(c.replies.length, 2); // 'garbage' dropped, the id-less reply salvaged
      assert.equal(c.replies[0]?.body, '7'); // numeric reply body salvaged
      assert.match(String(c.replies[1]?.id), /^rep_/); // minted id for the id-less reply

      // Every field a consumer reads is a string / array, so nothing downstream can throw.
      for (const note of notes) {
        for (const key of [
          'id',
          'anchor',
          'anchorLabel',
          'kind',
          'body',
          'author',
          'createdAt',
          'status',
        ] as const) {
          assert.equal(typeof note[key], 'string', `${note.id}.${key} must be a string`);
        }
        assert.ok(Array.isArray(note.replies));
        for (const reply of note.replies) {
          for (const key of ['id', 'body', 'author', 'createdAt'] as const) {
            assert.equal(typeof reply[key], 'string');
          }
        }
      }

      // The store stays usable after salvaging.
      await store.add(sampleInput());
      assert.equal((await store.list()).length, 4);
    } finally {
      store.close();
    }
  });

  it('a read-only poll on a pristine repo creates no .spec-scope directory', async () => {
    const root = freshRoot();
    const store = new NoteStore(root);
    try {
      // wait() starts the watcher via onChange; the read path must not mkdir.
      const notes = await store.wait({ timeoutMs: 100 });
      assert.deepEqual(notes, []);
      assert.equal(existsSync(path.join(root, '.spec-scope')), false);
      assert.deepEqual(store.warnings, []);
    } finally {
      store.close();
    }
  });
});
