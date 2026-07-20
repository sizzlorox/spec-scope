/**
 * The discussion store: human notes attached to parts of a spec.
 *
 * This is the hand-off point between a person reading specs in the browser and
 * an agent waiting on `spec-scope poll`, so two properties matter more than
 * speed: a note is never lost once accepted, and a CLI blocked in `wait()`
 * exits cleanly when it is done.
 *
 * State lives on disk, not in memory. Every read re-reads `notes.json`, which
 * keeps a second CLI invocation and the server honest about each other's writes
 * without a cache-invalidation story. The files are kilobytes.
 */

import {
  closeSync,
  existsSync,
  openSync,
  statSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { newId } from './ids.js';
import type { Note, NoteKind, NoteStatus, NotesFile, Reply } from './types.js';

const DIR_NAME = '.spec-scope';
const FILE_NAME = 'notes.json';

/** Limits exist because the browser posts straight into `add()`. */
const MAX_BODY = 8000;
const MAX_ANCHOR = 512;
const MAX_AUTHOR = 64;
const DEFAULT_AUTHOR = 'human';

/** One atomic write fires several fs events (tmp create, rename); collapse them. */
const DEBOUNCE_MS = 50;

/** Upper bound on quarantine attempts, so a pathological directory cannot spin. */
const MAX_QUARANTINE = 1000;

/** Cross-process write lock. Budget (tries * retry) is kept above the stale threshold
 *  so a lock abandoned by a crashed writer is always reclaimed within one acquire. */
const LOCK_SUFFIX = '.lock';
const LOCK_MAX_TRIES = 120;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 5000;

const NOTE_KINDS: readonly NoteKind[] = ['question', 'change', 'resolve'];

/**
 * Per-process, monotonic counter. Combined with `process.pid` it makes every temp
 * filename unique, so two writers can never truncate a shared temp mid-flight.
 */
let writeCounter = 0;

type ChangeListener = (notes: Note[]) => void;

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

/** Matches what `AbortSignal` consumers expect, without depending on DOMException. */
function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Validates one caller-supplied string field.
 *
 * Trims first, then length-checks, so trailing whitespace can never push a note
 * over the cap and a whitespace-only body is rejected as empty.
 */
function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string (got ${value === null ? 'null' : typeof value})`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function requireKind(value: unknown): NoteKind {
  if (typeof value !== 'string' || !NOTE_KINDS.includes(value as NoteKind)) {
    throw new Error(`kind must be one of ${NOTE_KINDS.join('|')} (got ${JSON.stringify(value)})`);
  }
  return value as NoteKind;
}

function optionalAuthor(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_AUTHOR;
  return requireText(value, 'author', MAX_AUTHOR);
}

function emptyFile(): NotesFile {
  return { version: 1, notes: [] };
}

/** Reads and writes `<projectRoot>/.spec-scope/notes.json`. */
export class NoteStore {
  /** Absolute path to the notes file. It may not exist yet. */
  readonly file: string;

  /** Non-fatal problems worth showing the user, e.g. a quarantined bad file. */
  readonly warnings: string[] = [];

  private readonly dir: string;
  private readonly listeners = new Set<ChangeListener>();

  /** Serialises writes so two rapid POSTs cannot read-modify-write over each other. */
  private tail: Promise<unknown> = Promise.resolve();

  private watcher: FSWatcher | null = null;
  private watcherStarted = false;
  private debounce: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(projectRoot: string) {
    this.dir = path.join(path.resolve(projectRoot), DIR_NAME);
    this.file = path.join(this.dir, FILE_NAME);
  }

  /**
   * Current on-disk state. A missing file is an empty store, not an error —
   * every project starts without one.
   */
  async load(): Promise<NotesFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return emptyFile();
      throw err;
    }

    let rawNotes: unknown[];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as { notes?: unknown }).notes)
      ) {
        throw new Error('expected an object with a "notes" array');
      }
      rawNotes = (parsed as { notes: unknown[] }).notes;
    } catch (err) {
      // Unreadable data is still the user's data: move it aside, never delete it.
      await this.quarantine(err);
      return emptyFile();
    }

    // A public repo can carry a hand-edited or partial notes.json. Normalise every
    // element so a missing/mistyped field can never crash export, `poll`/`notes`
    // or a reply — `load()` must never return a note that would throw in `formatNote`.
    const notes: Note[] = [];
    let dropped = 0;
    for (const candidate of rawNotes) {
      const note = normalizeNote(candidate);
      if (note === null) dropped += 1;
      else notes.push(note);
    }
    if (dropped > 0) {
      const msg = `${FILE_NAME} contained ${dropped} unreadable ${
        dropped === 1 ? 'entry that was' : 'entries that were'
      } skipped.`;
      // Deduped: `load()` runs on every read and before every write, so a stable
      // message must not accumulate across calls (the warnings-count tests rely on this).
      if (!this.warnings.includes(msg)) this.warnings.push(msg);
    }
    return { version: 1, notes };
  }

  async list(opts?: { status?: NoteStatus }): Promise<Note[]> {
    const { notes } = await this.load();
    const status = opts?.status;
    return status === undefined ? notes : notes.filter((note) => note.status === status);
  }

  async add(input: {
    anchor: string;
    anchorLabel: string;
    kind: NoteKind;
    body: string;
    author?: string;
  }): Promise<Note> {
    if (typeof input !== 'object' || input === null) {
      throw new Error('add() requires an object with anchor, anchorLabel, kind and body');
    }
    // Validate before touching the write queue so a bad request never blocks a good one.
    const anchor = requireText(input.anchor, 'anchor', MAX_ANCHOR);
    const anchorLabel = requireText(input.anchorLabel, 'anchorLabel', MAX_ANCHOR);
    const kind = requireKind(input.kind);
    const body = requireText(input.body, 'body', MAX_BODY);
    const author = optionalAuthor(input.author);

    const note: Note = {
      id: newId('note', Date.now()),
      anchor,
      anchorLabel,
      kind,
      body,
      author,
      createdAt: new Date().toISOString(),
      status: 'open',
      replies: [],
    };

    return this.mutate((file) => {
      file.notes.push(note);
      return note;
    });
  }

  async reply(noteId: string, body: string, author?: string): Promise<Note> {
    const text = requireText(body, 'body', MAX_BODY);
    const who = optionalAuthor(author);

    return this.mutate((file) => {
      const note = findNote(file, noteId);
      const entry: Reply = {
        id: newId('rep', Date.now()),
        body: text,
        author: who,
        createdAt: new Date().toISOString(),
      };
      note.replies.push(entry);
      return note;
    });
  }

  async resolve(noteId: string): Promise<Note> {
    return this.mutate((file) => {
      const note = findNote(file, noteId);
      note.status = 'resolved';
      note.resolvedAt = new Date().toISOString();
      return note;
    });
  }

  async reopen(noteId: string): Promise<Note> {
    return this.mutate((file) => {
      const note = findNote(file, noteId);
      note.status = 'open';
      delete note.resolvedAt;
      return note;
    });
  }

  async remove(noteId: string): Promise<void> {
    await this.mutate((file) => {
      const index = file.notes.findIndex((note) => note.id === noteId);
      if (index < 0) throw new Error(`No note with id '${noteId}'`);
      file.notes.splice(index, 1);
    });
  }

  /**
   * Blocks until the note set changes, then yields the open notes.
   *
   * Resolves with `[]` on timeout so `spec-scope poll` can exit 0 with nothing
   * to report. Rejects with an `AbortError` when `signal` fires.
   */
  wait(opts: { timeoutMs: number; signal?: AbortSignal }): Promise<Note[]> {
    const { timeoutMs, signal } = opts;
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<Note[]>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        signal?.removeEventListener('abort', onAbort);
      };

      function settle(run: () => void): void {
        if (settled) return;
        settled = true;
        cleanup();
        run();
      }

      const onChanged = (notes: Note[]): void => {
        settle(() => resolve(notes.filter((note) => note.status === 'open')));
      };

      function onAbort(): void {
        settle(() => reject(abortError()));
      }

      // Subscribe synchronously and before anything async, otherwise a change
      // landing during setup would be missed and the caller would hang.
      unsubscribe = this.onChange(onChanged);
      signal?.addEventListener('abort', onAbort, { once: true });

      // Deliberately not unref'd: while polling, this timer is what keeps the
      // CLI process alive.
      timer = setTimeout(() => settle(() => resolve([])), timeoutMs);
    });
  }

  /**
   * Subscribes to note-set changes from this process *and* from other processes.
   * Returns an unsubscribe function; call `close()` to release the watcher.
   */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    this.ensureWatcher();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Releases the watcher and any pending timer. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounce !== null) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Runs `fn` after every previously queued operation, whether those succeeded
   * or failed. The chain is deliberately isolated from rejections: a rejected
   * validation must not poison later writes or surface as an unhandled rejection.
   */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Read-modify-write under the queue, notifying listeners only after a durable write.
   *
   * The `tail` chain keeps *this* process's writes serialised (the fast path). The
   * lock file additionally serialises against *other* processes — a second
   * `spec-scope serve` on the same project (trivial via the 4390->4391 port walk) —
   * so their `load->modify->save` windows cannot interleave and drop a note.
   */
  private mutate<T>(apply: (file: NotesFile) => T): Promise<T> {
    return this.run(async () => {
      // This is the write path, and the only place that creates `.spec-scope`: a
      // read-only `poll`/`notes` on a pristine repo must leave no directory behind.
      await mkdir(this.dir, { recursive: true });
      const release = await this.acquireLock();
      try {
        const file = await this.load();
        const result = apply(file);
        await this.save(file);
        this.emit(file.notes);
        return result;
      } finally {
        release();
      }
    });
  }

  /**
   * Serialises `load->mutate->save` across processes with an `O_EXCL` lock file,
   * returning a release callback the caller must invoke in a finally.
   *
   * tradeoff: advisory, single-host, cooperative. It guards concurrent processes on
   * one machine only — not writers on a shared network drive, and not a tool that
   * ignores the lock. If a holder is SIGKILLed mid-write the lock file survives; the
   * stale-lock takeover below reclaims it once its mtime is older than LOCK_STALE_MS.
   * The residual risk is the mirror image: a *live* writer whose critical section
   * genuinely outlives LOCK_STALE_MS (e.g. an AV scanner stalling the rename) could
   * have its lock taken over — LOCK_STALE_MS is set well above a KB-file write to keep
   * that vanishingly unlikely. Upgrade path: a real advisory byte-range lock
   * (flock / LockFileEx) if cross-host or hard-kill windows ever need to be tight.
   */
  private async acquireLock(): Promise<() => void> {
    const lockPath = `${this.file}${LOCK_SUFFIX}`;
    for (let attempt = 0; attempt < LOCK_MAX_TRIES; attempt += 1) {
      try {
        closeSync(openSync(lockPath, 'wx'));
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone (e.g. reclaimed as stale by another process): nothing to do.
          }
        };
      } catch (err) {
        if (!hasCode(err, 'EEXIST')) throw err;
        breakStaleLock(lockPath);
        await sleep(LOCK_RETRY_MS);
      }
    }
    throw new Error(
      `Could not acquire notes lock ${lockPath} after ${LOCK_MAX_TRIES} attempts; ` +
        'another process may be stuck holding it.'
    );
  }

  /** Write to a unique sibling temp file then rename, so readers never see a half-written file. */
  private async save(next: NotesFile): Promise<void> {
    writeCounter += 1;
    // Unique per process (pid) and per write (counter): a concurrent writer can never
    // truncate this temp file mid-flight the way a single fixed `.tmp` name allowed.
    const tmp = `${this.file}.${process.pid}.${writeCounter}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  /** Moves an unparseable notes file aside under the first unused index. */
  private async quarantine(cause: unknown): Promise<void> {
    const reason = cause instanceof Error ? cause.message : String(cause);

    for (let n = 1; n <= MAX_QUARANTINE; n += 1) {
      const name = `notes.corrupt-${n}.json`;
      const target = path.join(this.dir, name);
      // 'wx' claims the name atomically, so a concurrent quarantine takes the next.
      let claimed;
      try {
        claimed = await open(target, 'wx');
      } catch (err) {
        if (hasCode(err, 'EEXIST')) continue;
        this.warnings.push(
          `${FILE_NAME} could not be parsed (${reason}) and could not be moved aside: ${String(err)}`
        );
        return;
      }
      await claimed.close();
      await rename(this.file, target);
      this.warnings.push(
        `${FILE_NAME} could not be parsed (${reason}). It was moved to ${name} and an empty note store was started.`
      );
      return;
    }

    this.warnings.push(
      `${FILE_NAME} could not be parsed (${reason}) and no free quarantine name was available.`
    );
  }

  private emit(notes: Note[]): void {
    // Copy first: a listener may unsubscribe itself, as `wait()` does.
    for (const listener of [...this.listeners]) listener(notes);
  }

  private ensureWatcher(): void {
    if (this.closed || this.watcherStarted) return;
    this.watcherStarted = true;
    this.attachWatcher();
  }

  /**
   * Attaches an fs watcher *without* creating `.spec-scope`. When the directory
   * exists it watches the directory (so the first write is seen too); when it does
   * not — a pristine repo running `poll`/`notes` — it watches the parent for the
   * directory to appear, then re-targets onto the directory itself. A read-only
   * command therefore never leaves an empty `.spec-scope` behind.
   */
  private attachWatcher(): void {
    if (this.closed || this.watcher !== null) return;
    const dirExists = existsSync(this.dir);
    const target = dirExists ? this.dir : path.dirname(this.dir);
    let swapped = false;
    let watcher: FSWatcher;
    try {
      watcher = watch(target, (_event, filename) => {
        const name = filename === null ? null : String(filename);
        if (dirExists) {
          if (name !== null && !name.startsWith(FILE_NAME)) return;
          this.scheduleReload();
          return;
        }
        // Still watching the parent: wait for `.spec-scope` itself to be created.
        if (swapped || this.closed) return;
        if (name !== null && name !== DIR_NAME) return;
        if (!existsSync(this.dir)) return;
        // The directory exists now: swap onto it and report the first write.
        swapped = true;
        this.watcher?.close();
        this.watcher = null;
        this.attachWatcher();
        this.scheduleReload();
      });
    } catch (err) {
      // `fs.watch` on the parent can still fail (it too may be missing): degrade to
      // no live updates rather than crashing a review server.
      this.warnings.push(`Could not watch ${DIR_NAME} for changes: ${String(err)}`);
      return;
    }
    // Watch errors are not worth crashing a review server over.
    watcher.on('error', () => {});
    // Unref'd so a store the caller forgot to close() cannot wedge process exit.
    watcher.unref();
    if (this.closed) {
      watcher.close();
      return;
    }
    this.watcher = watcher;
  }

  private scheduleReload(): void {
    if (this.closed) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.load().then(
        (file) => {
          if (!this.closed) this.emit(file.notes);
        },
        () => undefined
      );
    }, DEBOUNCE_MS);
    this.debounce.unref();
  }
}

function findNote(file: NotesFile, noteId: string): Note {
  const note = file.notes.find((candidate) => candidate.id === noteId);
  if (note === undefined) throw new Error(`No note with id '${noteId}'`);
  return note;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Removes a lock left behind by a crashed writer, identified by an old mtime. */
function breakStaleLock(lockPath: string): void {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
  } catch {
    // Vanished between the failed open and the stat: the next attempt retries cleanly.
  }
}

/**
 * Coerces a caller-untrusted value to a string, salvaging the common on-disk
 * mistakes (a number or boolean where a string was expected) rather than dropping
 * the note. Anything else falls back, so the result is *always* a string and can
 * never throw in `String.prototype` methods downstream.
 */
function coerceString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

/** Optional ISO string: kept only when actually a string, otherwise absent. */
function coerceOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A usable id, or a freshly minted one when the stored id is missing/blank. */
function coerceId(value: unknown, prefix: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return newId(prefix, Date.now());
}

function coerceKind(value: unknown): NoteKind {
  return typeof value === 'string' && NOTE_KINDS.includes(value as NoteKind)
    ? (value as NoteKind)
    : 'question';
}

/** Every reply is coerced to a `Reply` with string fields; unusable entries drop out. */
function coerceReplies(value: unknown): Reply[] {
  if (!Array.isArray(value)) return [];
  const replies: Reply[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const src = raw as Record<string, unknown>;
    replies.push({
      id: coerceId(src.id, 'rep'),
      body: coerceString(src.body, ''),
      author: coerceString(src.author, DEFAULT_AUTHOR),
      createdAt: coerceString(src.createdAt, ''),
    });
  }
  return replies;
}

/**
 * Salvages one raw element from a `notes.json` `notes` array into a well-typed
 * `Note`, or returns `null` when it cannot possibly be a note (not an object).
 * A fully valid note round-trips unchanged; a partial one is repaired in place.
 */
function normalizeNote(raw: unknown): Note | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;

  const anchor = coerceString(src.anchor, '');
  const note: Note = {
    id: coerceId(src.id, 'note'),
    anchor,
    anchorLabel: coerceString(src.anchorLabel, anchor),
    kind: coerceKind(src.kind),
    body: coerceString(src.body, ''),
    author: coerceString(src.author, DEFAULT_AUTHOR),
    createdAt: coerceString(src.createdAt, ''),
    status: src.status === 'resolved' ? 'resolved' : 'open',
    replies: coerceReplies(src.replies),
  };
  const resolvedAt = coerceOptionalString(src.resolvedAt);
  if (resolvedAt !== undefined) note.resolvedAt = resolvedAt;
  return note;
}
