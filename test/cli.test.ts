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

import { NoteStore } from '../src/notes.js';

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
});
