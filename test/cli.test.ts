/**
 * CLI integration tests.
 *
 * These spawn the real built CLI rather than importing its internals — the
 * agent loop (`poll` -> edit -> `resolve`) is a process-level contract, and the
 * bugs worth catching here (a poll that sleeps through notes that are already
 * open, a non-zero exit on a healthy run) only show up across that boundary.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { docStructureSource, requirementSource, scenarioSource, specHash } from '../src/hash.js';
import { NoteStore } from '../src/notes.js';
import { parseProject } from '../src/parse.js';

const execFileAsync = promisify(execFile);

/** `dist/test/cli.test.js` -> repo root. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'spec-scope.js');

let project: string;

/** Runs the CLI and returns its streams plus exit code, never throwing on non-zero. */
async function cli(
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      timeout: opts.timeoutMs ?? 30_000,
      env: { ...process.env, SPEC_SCOPE_NO_OPEN: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Like `cli`, but writes `input` to the child's stdin — for the `apply -` path. */
function cliStdin(
  args: string[],
  input: string,
  opts: { timeoutMs?: number; cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: opts.cwd ?? REPO_ROOT,
        timeout: opts.timeoutMs ?? 30_000,
        env: { ...process.env, SPEC_SCOPE_NO_OPEN: '1' },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolveResult({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
    child.stdin?.end(input);
  });
}

/**
 * The fixture's lone requirement and scenario, each with the specHash `explain`
 * pins against — so a batch can mark an explanation current (not stale) and drive
 * the work list down to empty.
 */
async function fixtureAnchors(): Promise<{
  doc: { id: string; hash: string };
  req: { id: string; name: string; hash: string };
  scn: { id: string; name: string; hash: string };
}> {
  const model = await parseProject(project);
  const doc = model.docs.find((d) => d.requirements.length > 0);
  assert.ok(doc, 'fixture should have a doc with requirements');
  const req = doc.requirements[0];
  assert.ok(req, 'fixture should have a requirement');
  const scn = req.scenarios[0];
  assert.ok(scn, 'fixture should have a scenario');
  return {
    // The doc's structural hash — what a `diagram` task and a `diagramSkip` pin to.
    doc: { id: doc.id, hash: specHash(docStructureSource(doc)) },
    req: {
      id: req.id,
      name: req.name,
      hash: specHash(
        requirementSource(
          req.name,
          req.text,
          req.scenarios.map((s) => s.name)
        )
      ),
    },
    scn: {
      id: scn.id,
      name: scn.name,
      hash: specHash(
        scenarioSource(
          scn.name,
          scn.steps.map((s) => s.text)
        )
      ),
    },
  };
}

before(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'spec-scope-cli-'));
  await mkdir(path.join(project, 'openspec', 'specs', 'auth'), { recursive: true });
  await writeFile(
    path.join(project, 'openspec', 'specs', 'auth', 'spec.md'),
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
});

after(async () => {
  await rm(project, { recursive: true, force: true });
});

/** Drops the notes file so each test starts from a clean discussion state. */
async function clearNotes(): Promise<void> {
  await rm(path.join(project, '.spec-scope'), { recursive: true, force: true });
}

describe('spec-scope CLI', () => {
  test('--version prints the package version', async () => {
    const r = await cli(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('--help exits 0 and lists every command', async () => {
    const r = await cli(['--help']);
    assert.equal(r.code, 0);
    for (const cmd of ['poll', 'notes', 'resolve', 'export']) {
      assert.ok(r.stdout.includes(cmd), `usage should mention ${cmd}`);
    }
  });

  test('unknown command exits 2', async () => {
    const r = await cli(['frobnicate']);
    assert.equal(r.code, 2);
  });

  test('missing directory exits 1 without a stack trace', async () => {
    const r = await cli(['notes', path.join(project, 'nope')]);
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes('    at '), 'expected no stack trace for an expected failure');
  });

  test('notes on a project with no discussion exits 0', async () => {
    await clearNotes();
    const r = await cli(['notes', project]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no open notes/i);
  });

  test('poll returns immediately when a note is already open', async () => {
    await clearNotes();
    const store = new NoteStore(project);
    await store.add({
      anchor: 'doc:x/req:y',
      anchorLabel: 'auth / Sign in with a passkey',
      kind: 'question',
      body: 'Which authenticators are in scope?',
    });
    store.close();

    // Regression guard: `wait` only fires on a *change*, so polling straight
    // into it slept through notes left while the agent was busy. A 60s timeout
    // against a 15s test cap means a regression fails loudly instead of passing
    // slowly.
    const started = Date.now();
    const r = await cli(['poll', project, '--timeout', '60'], { timeoutMs: 15_000 });
    const elapsed = Date.now() - started;

    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Which authenticators are in scope?'), r.stdout);
    assert.ok(elapsed < 10_000, `poll should not have blocked, took ${elapsed}ms`);
  });

  test('poll times out cleanly when nothing is open', async () => {
    await clearNotes();
    const r = await cli(['poll', project, '--timeout', '1'], { timeoutMs: 15_000 });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no open notes/i);
  });

  test('poll --json emits parseable JSON', async () => {
    await clearNotes();
    const store = new NoteStore(project);
    await store.add({
      anchor: 'doc:x/req:y',
      anchorLabel: 'auth / Sign in with a passkey',
      kind: 'change',
      body: 'Split enrolment out of this requirement.',
    });
    store.close();

    const r = await cli(['poll', project, '--timeout', '60', '--json'], { timeoutMs: 15_000 });
    assert.equal(r.code, 0);
    const parsed: unknown = JSON.parse(r.stdout);
    const notes = Array.isArray(parsed) ? parsed : (parsed as { notes: unknown[] }).notes;
    assert.equal(notes.length, 1);
  });

  test('resolve closes the loop and hides the note from poll', async () => {
    await clearNotes();
    const store = new NoteStore(project);
    const note = await store.add({
      anchor: 'doc:x/req:y',
      anchorLabel: 'auth / Sign in with a passkey',
      kind: 'question',
      body: 'Does this cover revocation?',
    });
    store.close();

    const resolved = await cli(['resolve', note.id, project]);
    assert.equal(resolved.code, 0);

    const after_ = await cli(['notes', project]);
    assert.match(after_.stdout, /no open notes/i);

    const all = await cli(['notes', project, '--all']);
    assert.ok(all.stdout.includes('Does this cover revocation?'), all.stdout);
  });

  test('resolve with an unknown id exits 1 and names the id', async () => {
    await clearNotes();
    const r = await cli(['resolve', 'note_nope', project]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('note_nope'), r.stderr);
  });

  test('export writes a self-contained tech doc', async () => {
    const out = path.join(project, 'out.html');
    const r = await cli(['export', project, '--out', out], { timeoutMs: 60_000 });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.trim().length > 0, 'export should print the path it wrote');

    const { readFile } = await import('node:fs/promises');
    const html = await readFile(out, 'utf8');
    assert.ok(html.length > 1_000_000, `expected inlined vendor scripts, got ${html.length} bytes`);
    assert.ok(html.includes('sequenceDiagram'), 'expected a generated sequence chart');
    assert.ok(
      !/<script[^>]+src=["']https?:/i.test(html),
      'tech doc must not reference remote scripts'
    );
    await rm(out, { force: true });
  });

  test('explain lists summary and narration work for a fresh project', async () => {
    await clearNotes();
    const r = await cli(['explain', project, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const tasks = JSON.parse(r.stdout) as Array<{
      kind: string;
      anchor: string;
      anchorLabel: string;
      reason: string;
    }>;
    const summary = tasks.find((t) => t.kind === 'summary');
    assert.ok(summary, 'expected a summary task for the requirement');
    assert.equal(summary.anchorLabel, 'Sign in with a passkey');
    assert.equal(summary.reason, 'missing');
    assert.ok(
      tasks.some((t) => t.kind === 'narration'),
      'expected a narration task for the scenario'
    );
  });

  test('explain reports no work once every requirement and scenario is explained', async () => {
    await clearNotes();
    const { doc, req, scn } = await fixtureAnchors();

    // A fresh project has outstanding work, so the empty-state string must NOT show yet.
    // The default format is now TOON (agent-first), so a summary task is a `summary,…` row.
    const fresh = await cli(['explain', project]);
    assert.equal(fresh.code, 0);
    assert.doesNotMatch(fresh.stdout, /no explanation work/);
    assert.match(fresh.stdout, /summary,missing,/);

    const batch = {
      explanations: [
        {
          anchor: req.id,
          anchorLabel: req.name,
          kind: 'summary',
          body: 'Users sign in with a platform passkey.',
          provenance: 'grounded',
          sources: [{ kind: 'requirement', anchor: req.id }],
          specHash: req.hash,
        },
        {
          anchor: scn.id,
          anchorLabel: `${req.name} / ${scn.name}`,
          kind: 'narration',
          body: 'Given an enrolled passkey, tapping sign in opens a session.',
          provenance: 'grounded',
          sources: [{ kind: 'scenario', anchor: scn.id }],
          specHash: scn.hash,
        },
      ],
      // explain now also asks for a per-doc diagram; a single-scenario auth spec
      // warrants none, so the honest "done" is a diagramSkip pinned to the doc hash.
      diagramSkips: [
        {
          anchor: doc.id,
          specHash: doc.hash,
          reason: 'A single sign-in scenario is clearer as prose.',
        },
      ],
    };
    const batchFile = path.join(project, 'full-batch.json');
    await writeFile(batchFile, JSON.stringify(batch), 'utf8');
    const applied = await cli(['apply', batchFile, project]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /applied: 3 added, 0 updated/);

    const done = await cli(['explain', project]);
    assert.equal(done.code, 0);
    assert.match(done.stdout, /no explanation work/);
  });

  test('apply merges a batch, shrinking the explain list and recording a decision', async () => {
    await clearNotes();
    const { req } = await fixtureAnchors();

    const before = JSON.parse((await cli(['explain', project, '--json'])).stdout) as unknown[];

    const batch = {
      explanations: [
        {
          anchor: req.id,
          anchorLabel: req.name,
          kind: 'summary',
          body: 'Users sign in with a platform passkey rather than a password.',
          provenance: 'grounded',
          sources: [{ kind: 'requirement', anchor: req.id }],
          specHash: req.hash,
        },
      ],
      decisions: [
        {
          title: 'Passkeys are the only first-party sign-in',
          choice: 'Adopt platform authenticators and drop password sign-in.',
          tradeoffs: 'No fallback for users without a passkey-capable device.',
          provenance: 'grounded',
        },
      ],
    };
    const batchFile = path.join(project, 'batch.json');
    await writeFile(batchFile, JSON.stringify(batch), 'utf8');

    const applied = await cli(['apply', batchFile, project]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /applied: 2 added, 0 updated/);

    const after = JSON.parse((await cli(['explain', project, '--json'])).stdout) as Array<{
      kind: string;
      anchor: string;
    }>;
    assert.ok(
      after.length < before.length,
      `explain should shrink: ${before.length} -> ${after.length}`
    );
    assert.ok(
      !after.some((t) => t.kind === 'summary' && t.anchor === req.id),
      'the summary task for the explained requirement should be gone'
    );

    const decisions = JSON.parse((await cli(['decisions', project, '--json'])).stdout) as Array<{
      title: string;
    }>;
    assert.ok(
      decisions.some((d) => d.title === 'Passkeys are the only first-party sign-in'),
      'decisions ledger should include the applied decision'
    );
  });

  test('apply reads a batch from stdin with -', async () => {
    await clearNotes();
    const batch = {
      decisions: [
        { title: 'Store sessions server-side', choice: 'Opaque cookie backed by a session table.' },
      ],
    };
    const r = await cliStdin(['apply', '-', project], JSON.stringify(batch));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /applied: 1 added, 0 updated/);

    const decisions = await cli(['decisions', project]);
    assert.ok(decisions.stdout.includes('Store sessions server-side'), decisions.stdout);
  });

  test('apply of a malformed batch exits 1 without a stack trace', async () => {
    await clearNotes();
    const badFile = path.join(project, 'bad-batch.json');
    await writeFile(badFile, '{ this is not valid json', 'utf8');
    const r = await cli(['apply', badFile, project]);
    assert.equal(r.code, 1);
    assert.ok(!r.stderr.includes('    at '), 'expected no stack trace for a malformed batch');
    assert.match(r.stderr, /spec-scope:/);
  });

  test('decisions prints an applied decision and --json parses', async () => {
    await clearNotes();
    const batch = {
      decisions: [
        {
          title: 'Rotate refresh tokens',
          choice: 'Issue single-use refresh tokens.',
          provenance: 'inferred',
        },
      ],
    };
    const batchFile = path.join(project, 'decision-batch.json');
    await writeFile(batchFile, JSON.stringify(batch), 'utf8');
    const applied = await cli(['apply', batchFile, project]);
    assert.equal(applied.code, 0, applied.stderr);

    const text = await cli(['decisions', project]);
    assert.equal(text.code, 0);
    assert.ok(text.stdout.includes('Rotate refresh tokens'), text.stdout);
    assert.ok(text.stdout.includes('provenance'), text.stdout);

    const json = await cli(['decisions', project, '--json']);
    const parsed = JSON.parse(json.stdout) as Array<{ title: string; status: string }>;
    assert.ok(
      parsed.some((d) => d.title === 'Rotate refresh tokens'),
      json.stdout
    );
  });

  test('reply answers a note in its thread as the agent', async () => {
    await clearNotes();
    const store = new NoteStore(project);
    const note = await store.add({
      anchor: 'doc:x/req:y',
      anchorLabel: 'auth / Sign in with a passkey',
      kind: 'question',
      body: 'Which authenticators are in scope?',
    });
    store.close();

    const inline = await cli(['reply', note.id, 'Platform authenticators only.', project]);
    assert.equal(inline.code, 0, inline.stderr);

    const listed = await cli(['notes', project]);
    assert.ok(listed.stdout.includes('> agent: Platform authenticators only.'), listed.stdout);

    // The note stays open — a reply answers, it does not resolve.
    assert.match(listed.stdout, /Which authenticators are in scope\?/);

    const unknown = await cli(['reply', 'note_nope', 'hi', project]);
    assert.equal(unknown.code, 1);
    assert.ok(unknown.stderr.includes('note_nope'), unknown.stderr);
  });

  test('reply reads the message from stdin when the argument is omitted', async () => {
    await clearNotes();
    const store = new NoteStore(project);
    const note = await store.add({
      anchor: 'doc:x/req:y',
      anchorLabel: 'auth / Sign in with a passkey',
      kind: 'question',
      body: 'Anything else?',
    });
    store.close();

    // The stdin form omits the message argument, so it runs from the project
    // directory (a message and an explicit dir positional would be ambiguous).
    const piped = await cliStdin(['reply', note.id], 'Answered from stdin.', { cwd: project });
    assert.equal(piped.code, 0, piped.stderr);
    const listed = await cli(['notes', project]);
    assert.ok(listed.stdout.includes('Answered from stdin.'), listed.stdout);
  });

  test('explain --toon is a compact table and far smaller than --json', async () => {
    await clearNotes();
    const toon = await cli(['explain', project, '--toon']);
    assert.equal(toon.code, 0, toon.stderr);
    // A TOON table header, keys stated once, then rows.
    assert.match(toon.stdout, /^\[\d+\]\{kind,reason,anchor,anchorLabel,specHash\}:/m);
    assert.ok(toon.stdout.includes('summary,missing,'), toon.stdout);

    const json = await cli(['explain', project, '--json']);
    assert.ok(
      toon.stdout.length < json.stdout.length,
      `toon (${toon.stdout.length}) should be smaller than json (${json.stdout.length})`
    );
    // The agent-facing text carries a next_step imperative; the --json data
    // contract stays pure (no trailing prose to break a parser).
    assert.match(toon.stdout, /\nnext_step: /);
    assert.doesNotMatch(json.stdout, /next_step/);

    // TOON is now the DEFAULT — bare `explain` matches `--toon`.
    const bare = await cli(['explain', project]);
    assert.match(bare.stdout, /^\[\d+\]\{kind,reason,anchor,anchorLabel,specHash\}:/m);
    // `--text` is the human-readable long form with the bracketed blocks + hints.
    const text = await cli(['explain', project, '--text']);
    assert.match(text.stdout, /\[summary\] .+\(missing\)/);
    assert.match(text.stdout, /specHash/); // the hint is present in the long form
  });

  test('agent-facing output leads with a count and ends with a next_step', async () => {
    await clearNotes();
    const store = new NoteStore(project);
    await store.add({
      anchor: 'doc:x/req:y',
      anchorLabel: 'auth / Sign in',
      kind: 'question',
      body: 'Which authenticators?',
    });
    await store.add({
      anchor: 'doc:x/req:z',
      anchorLabel: 'auth / Enrol',
      kind: 'change',
      body: 'Split this out.',
    });
    store.close();

    const notes = await cli(['notes', project]);
    assert.equal(notes.code, 0);
    // Count header with a per-kind breakdown, so the agent skips a round trip.
    assert.match(notes.stdout, /2 \(1 question, 1 change\) open notes:/);
    assert.match(notes.stdout, /\nnext_step: /);

    // The empty case still names the next move.
    await clearNotes();
    const empty = await cli(['notes', project]);
    assert.match(empty.stdout, /no open notes/);
    assert.match(empty.stdout, /\nnext_step: /);
  });

  test('specs lists the reviewable specs, and explain --spec scopes to one', async () => {
    await clearNotes();
    // The fixture's one capability lives under openspec/specs/auth.
    const specs = await cli(['specs', project, '--json']);
    assert.equal(specs.code, 0, specs.stderr);
    const rows = JSON.parse(specs.stdout) as Array<{ spec: string; pending: number }>;
    assert.ok(
      rows.some((r) => r.spec.includes('auth')),
      specs.stdout
    );

    const scoped = await cli(['explain', project, '--spec', 'auth', '--json']);
    assert.equal(scoped.code, 0, scoped.stderr);
    const scopedTasks = JSON.parse(scoped.stdout) as unknown[];
    assert.ok(scopedTasks.length > 0, 'the auth spec has outstanding work');

    // A --spec that matches nothing is a usage error that names the real specs.
    const bad = await cli(['explain', project, '--spec', 'does-not-exist']);
    assert.equal(bad.code, 2);
    assert.ok(bad.stderr.includes('auth'), bad.stderr);
  });
});
