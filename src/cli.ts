/**
 * Command line entry point.
 *
 * Argument handling is hand-rolled on `node:util`'s `parseArgs` so the package
 * ships with no CLI dependency. Every command funnels through `main`, which
 * turns a thrown Error into a one-line message rather than a stack trace —
 * agents call `poll` in a loop and a stack trace is just wasted tokens.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { exportTechDoc } from './export.js';
import { NoteStore } from './notes.js';
import { startServer } from './server.js';
import type { Note } from './types.js';

/** Signals "the user typed something wrong" — printed with usage, exit 2. */
class UsageError extends Error {}

const COMMANDS = ['poll', 'notes', 'resolve', 'export'] as const;
type Command = (typeof COMMANDS)[number] | 'serve';

const DEFAULT_POLL_SECONDS = 300;

let debugMode = Boolean(process.env.SPEC_SCOPE_DEBUG);

const USAGE = `spec-scope — visualize, discuss and resolve Spec Kit / OpenSpec specifications

Usage:
  spec-scope [dir]                       start the review server (default dir ".")
    --port <n>        port to listen on (default: first free port)
    --host <h>        interface to bind (default: 127.0.0.1)
    --no-open         do not launch a browser

  spec-scope poll [dir]                  long-poll for open notes, print them, exit
    --timeout <s>     seconds to wait (default: ${DEFAULT_POLL_SECONDS})
    --json            emit JSON instead of the compact text format

  spec-scope notes [dir]                 print notes without waiting
    --all             include resolved notes
    --json            emit JSON

  spec-scope resolve <noteId> [dir]      mark a note resolved
  spec-scope export [dir]                write a self-contained HTML tech doc
    --out <file>      output path (default: <dir>/<name>.techdoc.html)
    --no-notes        omit the open discussion notes appendix

  spec-scope --help                      show this message
  spec-scope --version                   show the installed version

Environment:
  SPEC_SCOPE_NO_OPEN   never launch a browser
  SPEC_SCOPE_DEBUG     print stack traces on failure`;

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Version comes from the shipped package.json so it can never drift from npm. */
function readVersion(): string {
  const require = createRequire(import.meta.url);
  // dist/src/cli.js -> <package root>/package.json
  for (const candidate of ['../../package.json', '../package.json']) {
    try {
      const pkg = require(candidate) as { version?: unknown };
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* try the next candidate */
    }
  }
  return 'unknown';
}

function resolveDir(input: string | undefined): string {
  const dir = resolve(input ?? '.');
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    throw new Error(`no such directory: ${dir}`);
  }
  if (!isDir) throw new Error(`not a directory: ${dir}`);
  return dir;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port must be an integer between 0 and 65535, got "${raw}"`);
  }
  return port;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_POLL_SECONDS * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(`--timeout must be a positive number of seconds, got "${raw}"`);
  }
  return Math.round(seconds * 1000);
}

/** Indent continuation lines so multi-line bodies stay visually attached to their note. */
function indent(body: string, prefix: string): string {
  return body
    .trim()
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

/**
 * Compact, line-oriented note rendering. This is what an AI agent reads back
 * from `poll`, so it stays terse: one header line, the body, then replies.
 */
export function formatNote(note: Note, showStatus: boolean): string {
  const status = showStatus ? ` (${note.status})` : '';
  // A hostile or half-written notes.json can hand us a non-string body or a
  // missing replies array; coerce at the print boundary so the agent-facing
  // path never throws on data the store has not sanitised.
  const body = String(note.body ?? '');
  const replies = Array.isArray(note.replies) ? note.replies : [];
  const lines = [`${note.id} [${note.kind}]${status} ${note.anchorLabel}`, indent(body, '  ')];
  for (const reply of replies) {
    lines.push(indent(`> ${reply.author}: ${String(reply.body ?? '').trim()}`, '  '));
  }
  return lines.join('\n');
}

export function printNotes(notes: Note[], json: boolean, showStatus: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(notes, null, 2)}\n`);
    return;
  }
  if (notes.length === 0) {
    process.stdout.write('no open notes\n');
    return;
  }
  process.stdout.write(`${notes.map((note) => formatNote(note, showStatus)).join('\n\n')}\n`);
}

/**
 * Launch the platform browser. The URL is always passed as a separate argv
 * entry — never spliced into a shell string — and every failure is swallowed
 * because CI boxes and containers have no opener at all.
 */
function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    // rundll32 is a real executable, so this avoids cmd.exe's quoting rules entirely.
    command = 'rundll32';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no opener available — the URL is already on stdout */
  }
}

/* -------------------------------------------------------------------------- */
/* commands                                                                    */
/* -------------------------------------------------------------------------- */

interface Flags {
  port?: string;
  host?: string;
  'no-open'?: boolean;
  'no-notes'?: boolean;
  timeout?: string;
  all?: boolean;
  json?: boolean;
  out?: string;
}

async function runServe(dir: string, flags: Flags): Promise<void> {
  const root = resolveDir(dir);
  const port = parsePort(flags.port);
  const handle = await startServer({
    root,
    ...(port !== undefined ? { port } : {}),
    ...(flags.host !== undefined ? { host: flags.host } : {}),
  });

  // Report the project root the server actually resolved (it walks upward from
  // the input dir), so running `spec-scope` from a subdirectory does not print a
  // misleading path.
  // tradeoff: ServerHandle.root is being added by the server group; until it
  // lands we read it defensively and fall back to the input dir. Upgrade path:
  // print `handle.root` directly once the field is guaranteed on ServerHandle.
  const reviewingRoot = (handle as { root?: string }).root ?? root;
  process.stdout.write(`spec-scope reviewing ${reviewingRoot}\n`);
  process.stdout.write(`${handle.url}\n`);

  if (!flags['no-open'] && !process.env.SPEC_SCOPE_NO_OPEN) openBrowser(handle.url);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write('\nshutting down\n');
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function runPoll(dir: string, flags: Flags): Promise<void> {
  const root = resolveDir(dir);
  const store = new NoteStore(root);
  try {
    // Return anything already waiting before blocking. `wait` only fires on a
    // *change*, so polling straight into it would sleep through notes the human
    // left while the agent was busy — the exact case poll exists to catch.
    const pending = await store.list({ status: 'open' });
    const notes = pending.length
      ? pending
      : await store.wait({ timeoutMs: parseTimeout(flags.timeout) });
    printNotes(notes, Boolean(flags.json), false);
  } finally {
    store.close();
  }
}

async function runNotes(dir: string, flags: Flags): Promise<void> {
  const root = resolveDir(dir);
  const store = new NoteStore(root);
  try {
    const notes = flags.all ? await store.list() : await store.list({ status: 'open' });
    printNotes(notes, Boolean(flags.json), Boolean(flags.all));
  } finally {
    store.close();
  }
}

async function runResolve(noteId: string | undefined, dir: string): Promise<void> {
  if (!noteId) throw new UsageError('resolve requires a note id');
  const root = resolveDir(dir);
  const store = new NoteStore(root);
  try {
    const existing = await store.list();
    if (!existing.some((note) => note.id === noteId)) {
      throw new Error(`no note with id "${noteId}"`);
    }
    const note = await store.resolve(noteId);
    process.stdout.write(`resolved ${note.id} — ${note.anchorLabel}\n`);
  } finally {
    store.close();
  }
}

async function runExport(dir: string, flags: Flags): Promise<void> {
  const root = resolveDir(dir);
  const written = await exportTechDoc({
    root,
    ...(flags.out !== undefined ? { out: flags.out } : {}),
    // Notes are baked in by default (they are useful in a review pack); --no-notes
    // opts out so a team can ship a doc without its open discussion.
    ...(flags['no-notes'] ? { includeNotes: false } : {}),
  });
  process.stdout.write(`${written}\n`);
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One flag schema for every command. `strict` turns an unknown flag into a
 * throw, which the caller reports as a usage error rather than a crash.
 */
function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'no-open': { type: 'boolean' },
        'no-notes': { type: 'boolean' },
        timeout: { type: 'string' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        debug: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

async function main(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  const flags = parsed.values;
  if (flags.debug) debugMode = true;

  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const positionals = parsed.positionals;
  const first = positionals[0];
  const isCommand = first !== undefined && (COMMANDS as readonly string[]).includes(first);
  const command: Command = isCommand ? (first as Command) : 'serve';
  const rest = isCommand ? positionals.slice(1) : positionals;

  // A bare first positional is the directory to review. If it is neither a
  // known command nor an existing path the user mistyped something, and usage
  // is more helpful than "no such directory".
  if (!isCommand && first !== undefined && !existsSync(resolve(first))) {
    throw new UsageError(`unknown command or directory: "${first}"`);
  }

  switch (command) {
    case 'serve':
      return runServe(rest[0] ?? '.', flags);
    case 'poll':
      return runPoll(rest[0] ?? '.', flags);
    case 'notes':
      return runNotes(rest[0] ?? '.', flags);
    case 'resolve':
      return runResolve(rest[0], rest[1] ?? '.');
    case 'export':
      return runExport(rest[0] ?? '.', flags);
  }
}

/**
 * Whether this process was launched to *be* the CLI, versus a test that merely
 * imported the module to unit-test a helper like `formatNote`.
 *
 * In real use there is nothing to check — run. Under `node --test` the runner's
 * environment leaks into spawned children (the CLI integration tests forward
 * `process.env`), so `NODE_TEST_CONTEXT` alone cannot tell an imported module
 * apart from a spawned CLI. Fall back to the process entry: the bin shim, which
 * dynamically imports this module, or this module run directly.
 *
 * tradeoff: the bin shim is matched by path name because it — not this module —
 * is `argv[1]`. If `NODE_TEST_CONTEXT` were ever set in a real shell *and* the
 * bin were reached through a differently-named symlink, auto-run would be
 * skipped. Upgrade path: have `bin/spec-scope.js` call an exported `run()`.
 */
function invokedAsCli(): boolean {
  if (process.env.NODE_TEST_CONTEXT === undefined) return true;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return (
    pathToFileURL(entry).href === import.meta.url || /[\\/]bin[\\/]spec-scope\.js$/.test(entry)
  );
}

if (invokedAsCli()) {
  void main(process.argv.slice(2)).catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`spec-scope: ${err.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    if (debugMode && err instanceof Error) {
      process.stderr.write(`${err.stack ?? err.message}\n`);
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`spec-scope: ${message}\n`);
    process.exit(1);
  });
}
