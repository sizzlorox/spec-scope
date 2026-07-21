/**
 * Durable JSON-file helpers, shared by every on-disk store in `.spec-scope/`.
 *
 * These are the persistence primitives factored out of the notes store: an
 * atomic write (unique temp + rename), an `O_EXCL` cross-process lock with
 * stale-lock takeover, corrupt-file quarantine, and a missing-dir-tolerant
 * directory watcher. Both `NoteStore` and `ReviewStore` build on them so their
 * `load -> modify -> save` windows are safe against a second CLI invocation and
 * against the running review server sharing the same directory.
 */

import {
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Upper bound on quarantine attempts, so a pathological directory cannot spin. */
const MAX_QUARANTINE = 1000;

/** Cross-process write lock. The budget (tries * retry) is kept above the stale
 *  threshold so a lock abandoned by a crashed writer is always reclaimed within
 *  one acquire. */
const LOCK_MAX_TRIES = 120;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 5000;

/**
 * Per-process, monotonic counter. Combined with `process.pid` it makes every temp
 * filename unique, so two writers can never truncate a shared temp mid-flight.
 */
let writeCounter = 0;

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A parsed value is only a usable store file when it is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Name a quarantine sibling from the file's stem: `notes.json` -> `notes.corrupt-N.json`. */
function quarantinePath(file: string, n: number): string {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  return path.join(dir, `${stem}.corrupt-${n}${ext}`);
}

/**
 * Moves an unreadable file aside under the first unused `.corrupt-N` index and
 * returns the warning to surface. Never deletes: an unparseable file is still the
 * user's data. The `wx` open claims each candidate name atomically, so a
 * concurrent quarantine simply takes the next index.
 */
async function quarantine(file: string, reason: string): Promise<string> {
  const base = path.basename(file);
  for (let n = 1; n <= MAX_QUARANTINE; n += 1) {
    const target = quarantinePath(file, n);
    let claimed;
    try {
      claimed = await open(target, 'wx');
    } catch (err) {
      if (hasCode(err, 'EEXIST')) continue;
      return `${base} could not be parsed (${reason}) and could not be moved aside: ${String(err)}`;
    }
    await claimed.close();
    await rename(file, target);
    return `${base} could not be parsed (${reason}). It was moved to ${path.basename(
      target
    )} and a fresh store was started.`;
  }
  return `${base} could not be parsed (${reason}) and no free quarantine name was available.`;
}

/**
 * Reads and parses a JSON store file.
 *
 * A missing file is not an error — every project starts without one — so it
 * yields `fallback` with no warning. An unreadable file (invalid JSON, or a
 * top-level value that is not a plain object) is quarantined to
 * `<stem>.corrupt-N.json` and `fallback` is returned with a warning; callers
 * never see a throw and never lose the bad data. A parsed object is returned as
 * `T` unchecked: field-level validation and normalisation are the store's job.
 */
export async function readJsonSafe<T>(
  file: string,
  fallback: T
): Promise<{ data: T; warnings: string[] }> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return { data: fallback, warnings: [] };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('expected a JSON object at the top level');
  } catch (err) {
    // Unreadable data is still the user's data: move it aside, never delete it.
    const reason = err instanceof Error ? err.message : String(err);
    const warning = await quarantine(file, reason);
    return { data: fallback, warnings: [warning] };
  }

  return { data: parsed as T, warnings: [] };
}

/**
 * Writes `data` as pretty JSON to a unique sibling temp file then renames it over
 * `file`, so a reader never observes a half-written file. Creates the containing
 * directory on demand — this is a write path, so materialising `.spec-scope/`
 * here is expected.
 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  writeCounter += 1;
  // Unique per process (pid) and per write (counter): a concurrent writer can never
  // truncate this temp file mid-flight the way a single fixed `.tmp` name allowed.
  const tmp = `${file}.${process.pid}.${writeCounter}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
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
 * Acquires an `O_EXCL` lock file, returning a release callback.
 *
 * tradeoff: advisory, single-host, cooperative. It guards concurrent processes on
 * one machine only — not writers on a shared network drive, and not a tool that
 * ignores the lock. If a holder is SIGKILLed mid-write the lock file survives; the
 * stale-lock takeover reclaims it once its mtime is older than LOCK_STALE_MS.
 * The residual risk is the mirror image: a *live* writer whose critical section
 * genuinely outlives LOCK_STALE_MS could have its lock taken over — LOCK_STALE_MS
 * is set well above a KB-file write to keep that vanishingly unlikely. Upgrade
 * path: a real advisory byte-range lock (flock / LockFileEx) if cross-host or
 * hard-kill windows ever need to be tight.
 */
async function acquireLock(lockPath: string): Promise<() => void> {
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
    `Could not acquire lock ${lockPath} after ${LOCK_MAX_TRIES} attempts; ` +
      'another process may be stuck holding it.'
  );
}

/**
 * Runs `fn` while holding a cross-process lock at `lockPath`, releasing it in a
 * `finally` even if `fn` throws. Ensures the lock's directory exists first, so
 * the very first write to a pristine project can take the lock.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const release = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Watches `dir` for changes and calls `onChange` when one lands, tolerating a
 * directory that does not exist yet.
 *
 * When `dir` is absent — a pristine repo running a read-only command — it watches
 * the *parent* for `dir` to appear, then re-targets onto `dir` itself and reports
 * the first write. This means a read-only command never has to create `dir` just
 * to watch it. When `filePrefix` is given, only events for files whose name
 * starts with it (or a null filename, which some platforms report) fire
 * `onChange`; this keeps a store watching one file in a shared directory from
 * reacting to a sibling store's writes. The watcher is unref'd so a handle the
 * caller forgot to close cannot wedge process exit, and its `error` events are
 * swallowed rather than crashing a long-lived server.
 */
/**
 * The OS-canonical form of a path, or the input unchanged when it cannot be
 * resolved (it may not exist yet). On Windows this expands 8.3 short-name
 * components (e.g. `RUNNER~1`) to their long form. `fs.watch` must be handed the
 * canonical path: libuv compares the directory it was given against the long-form
 * paths `ReadDirectoryChangesW` reports, and on Node 24 a mismatch trips a fatal
 * assertion (`!_wcsnicmp(filename, dir, dirlen)`) that aborts the process — which
 * no `error` handler can catch. Canonicalising first keeps the prefixes equal.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function watchJsonDir(
  dir: string,
  onChange: () => void,
  filePrefix?: string
): { close(): void } {
  const dirName = path.basename(dir);
  const parent = path.dirname(dir);
  let watcher: FSWatcher | null = null;
  let closed = false;

  const attach = (): void => {
    if (closed || watcher !== null) return;
    const dirExists = existsSync(dir);
    const target = canonicalPath(dirExists ? dir : parent);
    let swapped = false;
    let w: FSWatcher;
    try {
      w = watch(target, (_event, filename) => {
        const name = filename === null ? null : String(filename);
        if (dirExists) {
          if (filePrefix !== undefined && name !== null && !name.startsWith(filePrefix)) return;
          onChange();
          return;
        }
        // Still watching the parent: wait for `dir` itself to be created.
        if (swapped || closed) return;
        if (name !== null && name !== dirName) return;
        if (!existsSync(dir)) return;
        // The directory exists now: swap onto it and report the first write.
        swapped = true;
        watcher?.close();
        watcher = null;
        attach();
        onChange();
      });
    } catch {
      // `fs.watch` on the parent can still fail (it too may be missing): degrade to
      // no live updates rather than crashing a review server.
      return;
    }
    // Watch errors are not worth crashing a long-lived server over.
    w.on('error', () => {});
    // Unref'd so a store the caller forgot to close() cannot wedge process exit.
    w.unref();
    if (closed) {
      w.close();
      return;
    }
    watcher = w;
  };

  attach();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      watcher?.close();
      watcher = null;
    },
  };
}
