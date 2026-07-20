/**
 * Local review server.
 *
 * Serves the browser UI, the parsed spec model and the discussion store over
 * plain `node:http`. It binds loopback by default and has no authentication of
 * any kind, so every decision here leans towards "do not expose this": a static
 * allowlist instead of path joining, a hard body cap, and a CSP that forbids
 * the page from reaching the network at all.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { watch, existsSync, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { detectProject } from './detect.js';
import { parseProject } from './parse.js';
import { generateDiagrams } from './diagram.js';
import { NoteStore } from './notes.js';
import { readVendor, type VendorAsset } from './vendor.js';
import type { Diagram, NoteKind, SpecModel } from './types.js';

export interface ServerHandle {
  url: string;
  port: number;
  /** The project root `detectProject` resolved by walking up from `opts.root`. */
  root: string;
  close(): Promise<void>;
}

export interface StartServerOptions {
  root: string;
  port?: number;
  host?: string;
}

/** `dist/src/server.js` -> `<repo>/web`. Also correct when published. */
const WEB_DIR = fileURLToPath(new URL('../../web', import.meta.url));

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4390;
const PORT_ATTEMPTS = 20;
const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25_000;
const WATCH_DEBOUNCE_MS = 150;
/** How often to retry a spec watcher whose directory vanished (git checkout). */
const SPEC_REARM_MS = 500;

/**
 * Static routes are an explicit map rather than a path join so a crafted URL
 * can never escape `web/`. Adding a file to the UI means adding it here.
 */
const STATIC_ROUTES = new Map<string, { file: string; type: string }>([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
]);

const VENDOR_ROUTES = new Map<string, VendorAsset>([
  ['/vendor/mermaid.min.js', 'mermaid'],
  ['/vendor/marked.min.js', 'marked'],
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
].join('; ');

const NOTE_KINDS: readonly NoteKind[] = ['question', 'change', 'resolve'];

interface ModelPayload {
  model: SpecModel;
  diagrams: Diagram[];
}

/** Baseline headers applied to every response, including errors. */
function baseHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
  };
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Collects a request body, refusing anything over the cap before it is
 * buffered. Resolves `null` when the limit is hit so the caller can answer 413.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        // Stop reading; the handler answers 413 and ends the response.
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Parses a JSON object body, returning `undefined` for anything malformed. */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Binds one port, distinguishing "taken" from every other failure. */
function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** The port actually bound, which differs from the requested one for `--port 0`. */
function boundPort(server: Server, fallback: number): number {
  const addr = server.address();
  return addr !== null && typeof addr === 'object' ? addr.port : fallback;
}

async function bind(server: Server, host: string, port?: number): Promise<number> {
  if (port !== undefined) {
    await listenOnce(server, port, host);
    // `--port 0` asks the OS for an ephemeral port; report the real one.
    return boundPort(server, port);
  }
  let lastError: unknown;
  for (let i = 0; i < PORT_ATTEMPTS; i += 1) {
    const candidate = DEFAULT_PORT + i;
    try {
      await listenOnce(server, candidate, host);
      return boundPort(server, candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw err;
      lastError = err;
    }
  }
  throw new Error(
    `no free port in ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_ATTEMPTS - 1}` +
      (lastError ? '; last error EADDRINUSE' : '')
  );
}

/** Non-loopback hosts serve local files to the network with no auth. */
function isPublicHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

/**
 * The `host:port` authorities this server legitimately answers to, lower-cased.
 * Used both to allowlist the `Host` header (DNS-rebinding defence) and to check
 * a mutating request's `Origin`. IPv6 hosts are bracketed to match the wire form.
 */
function buildAuthorities(host: string, port: number): Set<string> {
  const set = new Set<string>();
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) set.add(`${name}:${port}`);
  if (!isPublicHost(host)) {
    const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    set.add(`${bracketed}:${port}`.toLowerCase());
  }
  return set;
}

/**
 * Cross-site write guard for mutating `/api` requests. Any one of three
 * independent signals is enough to reject, so a browser that omits one still
 * fails another:
 *  - a fetch-metadata `Sec-Fetch-Site` that is not first-party;
 *  - an `Origin` that is not one of our own authorities;
 *  - a body whose `Content-Type` is a CORS-safelisted type, which a cross-site
 *    page can send only via the preflight this server never answers.
 * Returns a reason string to reject with, or `null` to allow.
 */
function csrfDenied(
  req: IncomingMessage,
  authorities: ReadonlySet<string>,
  publicBind: boolean
): string | null {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return 'cross-site request blocked (Sec-Fetch-Site)';
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && !publicBind) {
    const authority = /^http:\/\/(.+)$/i.exec(origin)?.[1]?.toLowerCase();
    if (authority === undefined || !authorities.has(authority)) {
      return 'cross-site request blocked (Origin mismatch)';
    }
  }

  // tradeoff: the Content-Type gate only fires when a type is declared. A
  // browser always sets one for any request body (so the reproduced text/plain
  // note-injection is caught), but a *bodyless* cross-site POST (e.g. /resolve)
  // from an extinct browser that sends neither Origin nor Sec-Fetch-Site slips
  // this gate — it is still caught by those two on every current browser.
  // Upgrade path: a per-session CSRF token, which needs changes to web/app.js.
  const contentType = req.headers['content-type'];
  if (typeof contentType === 'string' && !/^application\/json\b/i.test(contentType.trim())) {
    return 'mutating requests must use Content-Type: application/json';
  }

  return null;
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  if (isPublicHost(host)) {
    // The whole point of this branch is to be loud on the terminal about an
    // unauthenticated bind; a silent security downgrade would be worse.
    // eslint-disable-next-line no-console
    console.warn(
      `[spec-scope] binding ${host}: the review UI and your specs are reachable from the network, ` +
        'and there is no authentication. Use 127.0.0.1 unless you mean this.'
    );
  }

  const detected = await detectProject(opts.root);
  const store = new NoteStore(detected.root);

  const publicBind = isPublicHost(host);
  const streams = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  /** Set once bind succeeds; requests only arrive after that, so never empty then. */
  let allowedAuthorities: ReadonlySet<string> = new Set();
  /** Flipped on teardown so a re-arming spec watcher cannot resurrect itself. */
  let stopped = false;
  const rearmTimers = new Set<NodeJS.Timeout>();
  let cached: ModelPayload | null = null;
  let inFlight: Promise<ModelPayload> | null = null;
  /** Bumped on every spec change so a parse that raced an edit is not cached. */
  let generation = 0;

  /** Re-parsing is cheap but not free, so hold the result until a file moves. */
  async function getModel(): Promise<ModelPayload> {
    if (cached) return cached;
    if (inFlight) return inFlight;
    const startedAt = generation;
    inFlight = (async () => {
      const model = await parseProject(detected.root);
      const diagrams = generateDiagrams(model);
      return { model, diagrams };
    })();
    try {
      const payload = await inFlight;
      // A file moved while we were parsing: serve this result, cache nothing.
      if (generation === startedAt) cached = payload;
      return payload;
    } finally {
      inFlight = null;
    }
  }

  function broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) stream.write(frame);
  }

  const unsubscribe = store.onChange(() => {
    broadcast('notes', { ok: true });
  });

  let debounce: NodeJS.Timeout | null = null;
  function onSpecChange(): void {
    if (debounce) clearTimeout(debounce);
    generation += 1;
    debounce = setTimeout(() => {
      debounce = null;
      cached = null;
      broadcast('model', { ok: true });
    }, WATCH_DEBOUNCE_MS);
  }

  /** Retry a vanished spec dir until it is watchable again, without wedging exit. */
  function scheduleRearm(dir: string): void {
    if (stopped) return;
    const timer = setTimeout(() => {
      rearmTimers.delete(timer);
      armSpecWatcher(dir);
    }, SPEC_REARM_MS);
    // Never keep the process alive just to poll for a directory that may not return.
    timer.unref();
    rearmTimers.add(timer);
  }

  /** Drops a dead spec watcher and schedules its re-establishment. */
  function dropAndRearm(watcher: FSWatcher, dir: string): void {
    const index = watchers.indexOf(watcher);
    if (index < 0) return; // a racing event already handled this watcher
    watchers.splice(index, 1);
    try {
      watcher.close();
    } catch {
      // already gone
    }
    // The disruption is itself a spec change worth telling clients about, and
    // we re-establish once the directory is back.
    onSpecChange();
    scheduleRearm(dir);
  }

  /**
   * Watches one spec dir and, crucially, survives it being deleted+recreated
   * (git checkout, spec regen). A recursive watch on a deleted root never
   * recovers on its own: Linux raises a fatal `error` (unhandled, it crashes
   * the process) while Windows floods `change` events and pins a core. Both are
   * caught below and answered by dropping the watcher and re-arming.
   */
  function armSpecWatcher(dir: string): void {
    if (stopped) return;
    let watcher: FSWatcher;
    const onEvent = (): void => {
      onSpecChange();
      // The Windows storm never emits `error`, so detect the vanished root
      // here — synchronously, so the flood cannot outrun an async stat — and
      // re-arm. This is the "re-arm on the next fs event" recovery path.
      if (!existsSync(dir)) dropAndRearm(watcher, dir);
    };
    try {
      watcher = watch(dir, { recursive: true }, onEvent);
    } catch {
      // tradeoff: `recursive` is unsupported on some platforms (older Linux,
      // AIX). Falling back to a flat watch means edits in nested spec folders
      // are missed until the next reload. Upgrade path: walk the tree and open
      // one watcher per directory, refreshing on mkdir/rmdir.
      try {
        watcher = watch(dir, onEvent);
      } catch {
        // The dir is not there right now; poll for it to reappear rather than
        // giving up on live reload for the rest of the session.
        scheduleRearm(dir);
        return;
      }
    }
    // Linux's fatal `error` on a deleted watched dir: recover instead of dying.
    watcher.on('error', () => dropAndRearm(watcher, dir));
    watchers.push(watcher);
  }

  for (const dir of detected.specDirs) armSpecWatcher(dir);

  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  async function serveStatic(res: ServerResponse, file: string, type: string): Promise<void> {
    const body = await readFile(join(WEB_DIR, file));
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }

  async function serveVendor(res: ServerResponse, asset: VendorAsset): Promise<void> {
    const body = await readVendor(asset);
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }

  function serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    streams.add(res);
    req.on('close', () => {
      streams.delete(res);
    });
  }

  /** Reads and validates a JSON body, answering the client on failure. */
  async function takeJsonBody(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<Record<string, unknown> | undefined> {
    const raw = await readBody(req);
    if (raw === null) {
      sendError(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`);
      return undefined;
    }
    const body = parseJsonObject(raw);
    if (!body) {
      sendError(res, 400, 'body must be a JSON object');
      return undefined;
    }
    return body;
  }

  async function handleNotes(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[]
  ): Promise<void> {
    const method = req.method ?? 'GET';
    // segments: ['api', 'notes', id?, action?]
    const id = segments[2];
    const action = segments[3];

    if (id === undefined) {
      if (method === 'GET') {
        sendJson(res, 200, { notes: await store.list() });
        return;
      }
      if (method === 'POST') {
        const body = await takeJsonBody(req, res);
        if (!body) return;
        const anchor = asString(body['anchor']);
        const anchorLabel = asString(body['anchorLabel']);
        const kind = asString(body['kind']);
        const text = asString(body['body']);
        if (!anchor || !anchorLabel || !text) {
          sendError(res, 400, 'anchor, anchorLabel and body are required strings');
          return;
        }
        if (!kind || !NOTE_KINDS.includes(kind as NoteKind)) {
          sendError(res, 400, `kind must be one of ${NOTE_KINDS.join(', ')}`);
          return;
        }
        const author = asString(body['author']);
        const note = await store.add({
          anchor,
          anchorLabel,
          kind: kind as NoteKind,
          body: text,
          ...(author ? { author } : {}),
        });
        sendJson(res, 201, { note });
        return;
      }
      sendError(res, 405, `method ${method} not allowed on /api/notes`);
      return;
    }

    if (action === undefined) {
      if (method === 'DELETE') {
        try {
          await store.remove(id);
        } catch (err) {
          // tradeoff: a missing note is a 404, not a 500, but the store signals
          // it only by message text, so we string-match its `No note with id`.
          // Upgrade path: a typed NotFoundError on NoteStore.remove.
          const message = err instanceof Error ? err.message : String(err);
          if (/^No note with id/.test(message)) {
            sendError(res, 404, message);
            return;
          }
          throw err;
        }
        res.writeHead(204, baseHeaders());
        res.end();
        return;
      }
      sendError(res, 405, `method ${method} not allowed on /api/notes/:id`);
      return;
    }

    if (method !== 'POST') {
      sendError(res, 405, `method ${method} not allowed on /api/notes/:id/${action}`);
      return;
    }

    if (action === 'replies') {
      const body = await takeJsonBody(req, res);
      if (!body) return;
      const text = asString(body['body']);
      if (!text) {
        sendError(res, 400, 'body is required');
        return;
      }
      const author = asString(body['author']);
      sendJson(res, 201, { note: await store.reply(id, text, author) });
      return;
    }
    if (action === 'resolve') {
      sendJson(res, 200, { note: await store.resolve(id) });
      return;
    }
    if (action === 'reopen') {
      sendJson(res, 200, { note: await store.reopen(id) });
      return;
    }
    sendError(res, 404, `unknown note action ${action}`);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

        // FIX 2: reject a lying `Host` before routing, so a DNS-rebound page
        // cannot read the model (which leaks the absolute project root).
        const hostHeader = (req.headers.host ?? '').toLowerCase();
        if (!publicBind && !allowedAuthorities.has(hostHeader)) {
          return sendError(res, 403, 'invalid Host header');
        }

        // FIX 1: block cross-site writes before any state changes.
        if ((method === 'POST' || method === 'DELETE') && pathname.startsWith('/api')) {
          const denied = csrfDenied(req, allowedAuthorities, publicBind);
          if (denied) return sendError(res, 403, denied);
        }

        const vendor = VENDOR_ROUTES.get(pathname);
        if (vendor) {
          if (method !== 'GET') return sendError(res, 405, 'vendor assets are GET only');
          return await serveVendor(res, vendor);
        }

        if (pathname === '/api/events') {
          if (method !== 'GET') return sendError(res, 405, 'events are GET only');
          return serveEvents(req, res);
        }

        if (pathname === '/api/model') {
          if (method !== 'GET') return sendError(res, 405, 'model is GET only');
          return sendJson(res, 200, await getModel());
        }

        const segments = pathname.split('/').filter(Boolean);
        if (segments[0] === 'api' && segments[1] === 'notes') {
          return await handleNotes(req, res, segments);
        }
        if (segments[0] === 'api') {
          return sendError(res, 404, `unknown endpoint ${pathname}`);
        }

        const asset = STATIC_ROUTES.get(pathname);
        if (asset) {
          if (method !== 'GET') return sendError(res, 405, 'static assets are GET only');
          return await serveStatic(res, asset.file, asset.type);
        }
        return sendError(res, 404, 'not found');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendError(res, 500, message);
        else res.end();
      }
    })();
  });

  let port: number;
  try {
    port = await bind(server, host, opts.port);
  } catch (err) {
    // FIX 4: bind is the last allocation, so a taken port would otherwise leave
    // the store, spec watchers and heartbeat live and the ref'd recursive
    // watcher wedging process exit for a caller that caught this. Tear it all
    // down before rethrowing.
    stopped = true;
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    for (const timer of rearmTimers) clearTimeout(timer);
    rearmTimers.clear();
    unsubscribe();
    for (const watcher of watchers) watcher.close();
    for (const stream of streams) stream.end();
    streams.clear();
    store.close();
    throw err;
  }
  allowedAuthorities = buildAuthorities(host, port);
  const displayHost = isPublicHost(host) ? '127.0.0.1' : host;
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`;

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    // Idempotent: repeat calls await the same teardown.
    if (closing) return closing;
    closing = (async () => {
      stopped = true;
      clearInterval(heartbeat);
      if (debounce) clearTimeout(debounce);
      for (const timer of rearmTimers) clearTimeout(timer);
      rearmTimers.clear();
      unsubscribe();
      for (const watcher of watchers) watcher.close();
      for (const stream of streams) stream.end();
      streams.clear();
      store.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets would otherwise hold `close` open for seconds.
        server.closeAllConnections?.();
      });
    })();
    return closing;
  }

  return { url, port, root: detected.root, close };
}
