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
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { detectProject } from './detect.js';
import { explainWork } from './explainwork.js';
import { exportTechDoc } from './export.js';
import { NoteStore } from './notes.js';
import { parseProject } from './parse.js';
import { ReviewStore } from './review.js';
import { startServer } from './server.js';
import { encodeToon } from './toon.js';
import type { Decision, ExplainTask, Note, ReviewBatch, SpecGroup, SpecModel } from './types.js';

/** Signals "the user typed something wrong" — printed with usage, exit 2. */
class UsageError extends Error {}

const COMMANDS = [
  'poll',
  'notes',
  'resolve',
  'reply',
  'export',
  'specs',
  'explain',
  'apply',
  'decisions',
] as const;
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
  spec-scope reply <noteId> [msg] [dir]  reply to a note in its thread (as the agent)
                                         msg may be omitted to read the reply from stdin
  spec-scope export [dir]                write a self-contained HTML tech doc
    --out <file>      output path (default: <dir>/<name>.techdoc.html)
    --no-notes        omit the open discussion notes appendix

  spec-scope specs [dir]                 list the reviewable specs (features/changes) and
                                         how much review work each still has
    --json            emit JSON

  spec-scope explain [dir]               list the explanation work an agent should write
                                         (compact TOON by default — token-lean for agents)
    --spec <name>     scope to one spec (a feature/change) — prepare it one at a time
    --json            emit the full ExplainTask[] as JSON (includes per-task hints)
    --text            human-readable long form with the hint under each task

  spec-scope apply <file> [dir]          merge a ReviewBatch (JSON) an agent wrote back
                                         <file> may be "-" to read the batch from stdin

  spec-scope decisions [dir]             print the captured decision ledger (TOON by default)
    --all             include superseded decisions
    --json            emit the full decisions as JSON
    --text            human-readable long form with receipts

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

/**
 * The project root the review layer keys off. `parseProject` walks upward from
 * the input dir to find the spec root, so the review store, note store and model
 * must all agree on that same root — reading a subdir's `.spec-scope` while the
 * model came from the walked-up root would compare anchors against the wrong
 * sidecar. Commands that do not need the full model resolve the root here so they
 * still write where `explain` reads.
 */
async function projectRoot(dir: string): Promise<string> {
  return (await detectProject(resolveDir(dir))).root;
}

/** Reads all of stdin as UTF-8 — the `apply -` path an agent pipes a batch into. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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

/**
 * A token-cheap count header — `3 (2 question, 1 change)` — so an agent learns the
 * shape of the list without a second round trip. Borrowed from the AXI convention
 * of leading with a pre-computed aggregate.
 */
function tally<T>(items: T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([k, n]) => `${n} ${k}`);
  return parts.length > 1 ? `${items.length} (${parts.join(', ')})` : String(items.length);
}

/**
 * The `next_step:` line every agent-facing command ends on. Re-anchoring the loop
 * in the output itself (not only in the skill) keeps an agent on track mid-loop —
 * the single most portable idea from the AXI convention.
 */
function writeNextStep(text: string): void {
  process.stdout.write(`\nnext_step: ${text}\n`);
}

export function printNotes(
  notes: Note[],
  json: boolean,
  showStatus: boolean,
  nextStep?: string
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(notes, null, 2)}\n`);
    return;
  }
  const label = showStatus ? 'notes' : 'open notes';
  if (notes.length === 0) {
    process.stdout.write(`no ${label}\n`);
  } else {
    process.stdout.write(`${tally(notes, (n) => n.kind)} ${label}:\n\n`);
    process.stdout.write(`${notes.map((note) => formatNote(note, showStatus)).join('\n\n')}\n`);
  }
  if (nextStep) writeNextStep(nextStep);
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
  toon?: boolean;
  text?: boolean;
  spec?: string;
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
    printNotes(notes, Boolean(flags.json), false, notesNextStep(notes.length));
  } finally {
    store.close();
  }
}

/** Resolve the read format from the flags. TOON is the default (agent-first). */
function readFormat(flags: Flags): ReadFormat {
  if (flags.json) return 'json';
  if (flags.text) return 'text';
  return 'toon';
}

/** What the agent should do after seeing the note list. */
function notesNextStep(openCount: number): string {
  return openCount > 0
    ? 'address each note by kind — `reply` a question, edit the spec for a change, then `resolve <id>`; regenerate any explanation your edit made stale, then re-run `spec-scope poll .`'
    : 'no open notes. Run `spec-scope explain .` to fill any missing summaries, or the review is settled.';
}

async function runNotes(dir: string, flags: Flags): Promise<void> {
  const root = resolveDir(dir);
  const store = new NoteStore(root);
  try {
    const notes = flags.all ? await store.list() : await store.list({ status: 'open' });
    const openCount = flags.all ? notes.filter((n) => n.status === 'open').length : notes.length;
    printNotes(notes, Boolean(flags.json), Boolean(flags.all), notesNextStep(openCount));
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

/**
 * Answer a note without closing it. This is the conversational half of the loop:
 * the human asks a question on a requirement, the agent replies in the thread
 * (as `agent`), and the human decides whether it is resolved. The message comes
 * from the argument or, when omitted, stdin — so an agent can pipe a long answer.
 */
async function runReply(
  noteId: string | undefined,
  message: string | undefined,
  dir: string
): Promise<void> {
  if (!noteId) throw new UsageError('reply requires a note id');
  const body = (message ?? (await readStdin())).trim();
  if (!body) throw new UsageError('reply requires a message (as an argument or on stdin)');
  const root = resolveDir(dir);
  const store = new NoteStore(root);
  try {
    const existing = await store.list();
    if (!existing.some((note) => note.id === noteId)) {
      throw new Error(`no note with id "${noteId}"`);
    }
    const note = await store.reply(noteId, body, 'agent');
    process.stdout.write(`replied to ${note.id} — ${note.anchorLabel}\n`);
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

/**
 * Compact work list an agent reads back from `explain`. One block per task:
 * a `[kind] label  (reason)` header, then the hint indented beneath it. The hint
 * already carries the provenance rule the agent must follow, so nothing here is
 * generated — spec-scope only reports what is missing or stale.
 */
/**
 * Output format for the agent-facing read commands. TOON is the default because
 * the primary reader is the agent and it is the token-lean form; `json` is the
 * full data contract; `text` is the human-readable long form.
 */
type ReadFormat = 'toon' | 'json' | 'text';

export function printExplain(tasks: ExplainTask[], format: ReadFormat, nextStep?: string): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return;
  }
  if (tasks.length === 0) {
    process.stdout.write('no explanation work\n');
    if (nextStep) writeNextStep(nextStep);
    return;
  }
  if (format === 'toon') {
    // The token-lean default: a header row, then one line per task. The per-task
    // `hint` is dropped — the honesty rules live once in the skill, so repeating
    // them on every row is pure token cost. The `[N]{…}` header carries the count.
    const rows = tasks.map((t) => ({
      kind: t.kind,
      reason: t.reason,
      anchor: t.anchor,
      anchorLabel: t.anchorLabel,
      specHash: t.specHash,
    }));
    process.stdout.write(`${encodeToon(rows)}\n`);
  } else {
    process.stdout.write(`${tally(tasks, (t) => t.kind)} tasks:\n\n`);
    const blocks = tasks.map(
      (task) => `[${task.kind}] ${task.anchorLabel}  (${task.reason})\n${indent(task.hint, '  ')}`
    );
    process.stdout.write(`${blocks.join('\n\n')}\n`);
  }
  if (nextStep) writeNextStep(nextStep);
}

/**
 * Non-root groups (a Spec Kit feature, an OpenSpec change/capability) matching a
 * `--spec` selector — a case-insensitive substring of the group's name, path or
 * id. Reviewing a whole project at once is a lot of work; scoping to one spec is
 * how a human (or the agent) takes it one feature at a time.
 */
function matchSpecs(model: SpecModel, selector: string): SpecGroup[] {
  const needle = selector.trim().toLowerCase();
  const candidates = model.groups.filter((g) => g.kind !== 'root');
  const matches = candidates.filter(
    (g) =>
      g.name.toLowerCase().includes(needle) ||
      g.path.toLowerCase().includes(needle) ||
      g.id.toLowerCase().includes(needle)
  );
  if (matches.length === 0) {
    const names = candidates.map((g) => g.name).join(', ') || '(none)';
    throw new UsageError(`no spec matches "${selector}". Available specs: ${names}`);
  }
  return matches;
}

/** The model restricted to the docs of the given groups — the `--spec` scope. */
function scopeModel(model: SpecModel, groups: SpecGroup[]): SpecModel {
  const ids = new Set(groups.map((g) => g.id));
  return {
    ...model,
    groups,
    docs: model.docs.filter((d) => d.groupId !== undefined && ids.has(d.groupId)),
  };
}

/** True when a note's anchor falls inside one of the scoped documents. */
function noteInDocs(note: Note, docIds: string[]): boolean {
  return docIds.some((id) => note.anchor === id || note.anchor.startsWith(`${id}/`));
}

/** Which group a doc-derived task belongs to, via its anchor's document. */
function groupOfTask(task: ExplainTask, model: SpecModel): string | undefined {
  const doc = model.docs.find((d) => task.anchor === d.id || task.anchor.startsWith(`${d.id}/`));
  return doc?.groupId;
}

/**
 * `spec-scope specs` — list the reviewable specs (features / changes / capabilities)
 * with how much review work each still has, so a human or the agent can pick one
 * to prepare instead of the whole project at once.
 */
async function runSpecs(dir: string, flags: Flags): Promise<void> {
  const model = await parseProject(resolveDir(dir));
  const reviewStore = new ReviewStore(model.root);
  const noteStore = new NoteStore(model.root);
  try {
    const review = await reviewStore.load();
    const notes = await noteStore.list();
    const groups = model.groups.filter((g) => g.kind !== 'root');

    const pending = new Map<string, number>();
    for (const task of explainWork(model, review, notes)) {
      const gid = groupOfTask(task, model);
      if (gid) pending.set(gid, (pending.get(gid) ?? 0) + 1);
    }

    const rows = groups.map((g) => {
      const docs = model.docs.filter((d) => d.groupId === g.id);
      return {
        spec: g.name,
        kind: g.kind,
        docs: docs.length,
        requirements: docs.reduce((a, d) => a + d.requirements.length, 0),
        pending: pending.get(g.id) ?? 0,
      };
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    if (rows.length === 0) {
      process.stdout.write('no specs found — this project has no feature or change folders.\n');
      return;
    }
    process.stdout.write(`${encodeToon(rows)}\n`);
    writeNextStep(
      'pick a spec and prepare just it: `spec-scope explain --spec <name>` (then `apply`), rather than the whole project at once.'
    );
  } finally {
    reviewStore.close();
    noteStore.close();
  }
}

async function runExplain(dir: string, flags: Flags): Promise<void> {
  // The model resolves the real spec root; the review and notes must be read from
  // that same root or their anchors would not line up with the requirements.
  const model = await parseProject(resolveDir(dir));
  const reviewStore = new ReviewStore(model.root);
  const noteStore = new NoteStore(model.root);
  try {
    const review = await reviewStore.load();
    let notes = await noteStore.list();

    // `--spec` narrows the work to one feature/change so a reviewer isn't handed
    // the whole project at once. Scope the model's docs (and the notes anchored in
    // them); the glossary stays project-wide since a term isn't tied to a document.
    let scoped = model;
    if (flags.spec !== undefined) {
      scoped = scopeModel(model, matchSpecs(model, flags.spec));
      const docIds = scoped.docs.map((d) => d.id);
      notes = notes.filter((n) => noteInDocs(n, docIds));
    }

    const tasks = explainWork(scoped, review, notes);
    const specArg = flags.spec !== undefined ? ` --spec ${flags.spec}` : '';
    const nextStep =
      tasks.length > 0
        ? `write each item honestly (copy every specHash verbatim), hand it back with \`spec-scope apply <batch.json> .\`, then re-run \`spec-scope explain${specArg} .\` until it is empty.`
        : `${flags.spec !== undefined ? `"${flags.spec}" is` : 'the report is'} fully explained — nothing missing or stale.`;
    printExplain(tasks, readFormat(flags), nextStep);
  } finally {
    reviewStore.close();
    noteStore.close();
  }
}

/**
 * Parses a `ReviewBatch` from raw JSON at the CLI trust boundary. A syntax error
 * or a non-object payload is a plain `Error` (exit 1), never a stack trace —
 * `ReviewStore.applyBatch` validates the element contents beyond this shape check.
 */
function parseBatch(raw: string): ReviewBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `could not parse batch as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'batch must be a JSON object with explanations, decisions and/or glossary arrays'
    );
  }
  return parsed;
}

async function runApply(file: string | undefined, dir: string): Promise<void> {
  if (!file) throw new UsageError('apply requires a batch file (or "-" to read stdin)');
  const root = await projectRoot(dir);
  const raw = file === '-' ? await readStdin() : await readFile(resolve(file), 'utf8');
  const batch = parseBatch(raw);
  const store = new ReviewStore(root);
  try {
    const { added, updated } = await store.applyBatch(batch);
    process.stdout.write(`applied: ${added} added, ${updated} updated\n`);
  } finally {
    store.close();
  }
}

/**
 * One decision as a compact block: an id/status/title header, then the choice,
 * any tradeoffs, the provenance flag, and a single line of source/thread receipts
 * so a reader can trace the decision back to the spec or the discussion it came
 * from.
 */
export function formatDecision(decision: Decision): string {
  const lines = [`${decision.id} [${decision.status}] ${decision.title}`];
  lines.push(indent(`choice: ${decision.choice}`, '  '));
  if (decision.tradeoffs.length > 0) {
    lines.push(indent(`tradeoffs: ${decision.tradeoffs}`, '  '));
  }
  lines.push(indent(`provenance: ${decision.provenance}`, '  '));
  const refs: string[] = [];
  if (decision.threadNoteId) refs.push(`thread ${decision.threadNoteId}`);
  for (const source of decision.sources)
    refs.push(`${source.kind}:${source.label ?? source.anchor}`);
  if (refs.length > 0) lines.push(indent(`refs: ${refs.join(', ')}`, '  '));
  return lines.join('\n');
}

export function printDecisions(decisions: Decision[], format: ReadFormat, nextStep?: string): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(decisions, null, 2)}\n`);
    return;
  }
  if (decisions.length === 0) {
    process.stdout.write('no decisions\n');
    if (nextStep) writeNextStep(nextStep);
    return;
  }
  if (format === 'toon') {
    // Flat, scannable rows for the agent; the full receipts (sources, thread) are
    // available via --json when a decision needs tracing.
    const rows = decisions.map((d) => ({
      id: d.id,
      status: d.status,
      provenance: d.provenance,
      title: d.title,
      choice: d.choice,
      tradeoffs: d.tradeoffs,
    }));
    process.stdout.write(`${encodeToon(rows)}\n`);
  } else {
    process.stdout.write(`${decisions.map(formatDecision).join('\n\n')}\n`);
  }
  if (nextStep) writeNextStep(nextStep);
}

async function runDecisions(dir: string, flags: Flags): Promise<void> {
  const root = await projectRoot(dir);
  const store = new ReviewStore(root);
  try {
    const all = await store.listDecisions();
    // The ledger shows the live decisions (open + recorded); superseded ones are
    // history and only surface under --all.
    const decisions = flags.all ? all : all.filter((d) => d.status !== 'superseded');
    printDecisions(
      decisions,
      readFormat(flags),
      'capture the rationale behind any resolved thread not yet recorded here with `spec-scope apply` (a decision element).'
    );
  } finally {
    store.close();
  }
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
        toon: { type: 'boolean' },
        text: { type: 'boolean' },
        spec: { type: 'string' },
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
    case 'reply':
      return runReply(rest[0], rest[1], rest[2] ?? '.');
    case 'export':
      return runExport(rest[0] ?? '.', flags);
    case 'specs':
      return runSpecs(rest[0] ?? '.', flags);
    case 'explain':
      return runExplain(rest[0] ?? '.', flags);
    case 'apply':
      return runApply(rest[0], rest[1] ?? '.');
    case 'decisions':
      return runDecisions(rest[0] ?? '.', flags);
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
