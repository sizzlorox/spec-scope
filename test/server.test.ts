/**
 * Review-server tests.
 *
 * These start a real `node:http` server on an ephemeral port against a temp
 * spec fixture and drive it over the wire. They lean on `node:http` rather than
 * global `fetch` on purpose: undici drops `Host`, `Origin` and `Sec-Fetch-Site`
 * as forbidden header names, which are exactly the headers the CSRF and
 * DNS-rebinding guards key off, so `fetch` would silently test the wrong path.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import { startServer, type ServerHandle } from '../src/server.js';

const execFileAsync = promisify(execFile);

/** `dist/test/server.test.js` -> `dist/src/server.js`, for the leak child. */
const SERVER_JS = fileURLToPath(new URL('../src/server.js', import.meta.url));

const SPEC_MD = [
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
].join('\n');

/**
 * Runs in a child process: start a server, then attempt a second start on the
 * now-taken port. A clean exit proves the failed start left no ref'd handle
 * (a leaked spec watcher would hang the process instead).
 */
const LEAK_CHILD = [
  "import { pathToFileURL } from 'node:url';",
  'const [, , serverJs, root] = process.argv;',
  'const { startServer } = await import(pathToFileURL(serverJs).href);',
  'const h = await startServer({ root, port: 0 });',
  'try {',
  '  await startServer({ root, port: h.port });',
  "  console.error('MISSING_REJECTION');",
  '  await h.close();',
  '  process.exit(3);',
  '} catch {',
  '  // expected EADDRINUSE',
  '}',
  'await h.close();',
  '// No process.exit(): exiting on our own is the assertion.',
  '',
].join('\n');

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface ReqOpts {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** One request against 127.0.0.1:port with full control over every header. */
function request(port: number, opts: ReqOpts): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        ...(opts.headers ? { headers: opts.headers } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Pull the `error` field out of a JSON error body without tripping no-unsafe-* rules. */
function errorOf(body: string): string {
  return String((JSON.parse(body) as { error?: unknown }).error);
}

/** Opens the SSE stream, reads its first frame, then tears the socket down. */
function sseHead(port: number): Promise<{ status: number; contentType: string; first: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      res.once('data', (chunk: Buffer) => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          first: chunk.toString('utf8'),
        });
        req.destroy();
      });
    });
    // `req.destroy()` surfaces here after we have already resolved; ignore it.
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `pred` until true or the deadline; returns the final value. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await delay(40);
  }
  return pred();
}

/** Holds an SSE connection open and counts the `model` events it delivers. */
function openSse(port: number): { modelEvents: () => number; close: () => void } {
  let count = 0;
  let buf = '';
  const req = http.request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) if (/(^|\n)event: model(\n|$)/.test(frame)) count += 1;
    });
  });
  req.on('error', () => {
    /* surfaced by close()/destroy(); nothing to do */
  });
  req.end();
  return { modelEvents: () => count, close: () => req.destroy() };
}

function validNote(): string {
  return JSON.stringify({
    anchor: 'doc:auth/req:sign-in',
    anchorLabel: 'Authentication / Sign in with a passkey',
    kind: 'question',
    body: 'Which authenticators are in scope here?',
  });
}

let fixture: string;
let handle: ServerHandle;
let port: number;

before(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), 'spec-scope-server-'));
  await mkdir(path.join(fixture, 'openspec', 'specs', 'auth'), { recursive: true });
  await writeFile(path.join(fixture, 'openspec', 'specs', 'auth', 'spec.md'), SPEC_MD, 'utf8');
  handle = await startServer({ root: fixture, port: 0 });
  port = handle.port;
});

after(async () => {
  await handle.close();
  await rm(fixture, { recursive: true, force: true });
});

describe('review server', () => {
  it('binds a real ephemeral port and exposes the detected root', () => {
    // FIX 5(a): `--port 0` must report the OS-assigned port, never 0.
    assert.ok(port > 0, `expected a real port, got ${port}`);
    assert.match(handle.url, new RegExp(`:${port}$`));
    // FIX 5(b): `root` is the project root detectProject resolved.
    assert.equal(path.resolve(handle.root), path.resolve(fixture));
  });

  it('serves the static UI, vendor bundles, model and notes over GET', async () => {
    const index = await request(port, { path: '/' });
    assert.equal(index.status, 200);
    assert.match(String(index.headers['content-type']), /text\/html/);

    for (const asset of [
      '/app.js',
      '/style.css',
      '/vendor/mermaid.min.js',
      '/vendor/marked.min.js',
    ]) {
      const res = await request(port, { path: asset });
      assert.equal(res.status, 200, `${asset} should be served`);
    }

    const model = await request(port, { path: '/api/model' });
    assert.equal(model.status, 200);
    const parsedModel: unknown = JSON.parse(model.body);
    assert.ok(parsedModel && typeof parsedModel === 'object' && 'model' in parsedModel);

    const notes = await request(port, { path: '/api/notes' });
    assert.equal(notes.status, 200);
    assert.ok(Array.isArray((JSON.parse(notes.body) as { notes: unknown[] }).notes));
  });

  it('answers the SSE stream with an event-stream connection', async () => {
    const sse = await sseHead(port);
    assert.equal(sse.status, 200);
    assert.match(sse.contentType, /text\/event-stream/);
    assert.match(sse.first, /connected/);
  });

  it('404s a path-traversal attempt instead of escaping web/', async () => {
    const res = await request(port, { path: '/../../etc/passwd' });
    assert.equal(res.status, 404);
  });

  it('rejects a request whose Host header is not an allowlisted authority', async () => {
    // FIX 2: DNS-rebinding — the connection is loopback but Host lies.
    const bad = await request(port, {
      path: '/api/model',
      headers: { host: 'evil.example.com' },
    });
    assert.equal(bad.status, 403);
    assert.match(errorOf(bad.body), /Host/i);

    const good = await request(port, {
      path: '/api/model',
      headers: { host: `127.0.0.1:${port}` },
    });
    assert.equal(good.status, 200);
  });

  it('accepts a same-origin application/json POST', async () => {
    // FIX 1: the legitimate first-party write path must still work.
    const res = await request(port, {
      path: '/api/notes',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
      },
      body: validNote(),
    });
    assert.equal(res.status, 201, res.body);
    assert.ok((JSON.parse(res.body) as { note: { id: string } }).note.id);
  });

  it('rejects a cross-site POST that carries a CORS-safelisted Content-Type', async () => {
    // FIX 1: the reproduced no-cors attack — a text/plain body the browser can
    // send cross-site without the preflight this server never answers.
    const res = await request(port, {
      path: '/api/notes',
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: validNote(),
    });
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res.body), /Content-Type/i);
  });

  it('rejects a POST whose Origin is not one of our authorities', async () => {
    const res = await request(port, {
      path: '/api/notes',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example.com:1234',
      },
      body: validNote(),
    });
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res.body), /Origin/i);
  });

  it('rejects a cross-site POST flagged by Sec-Fetch-Site', async () => {
    const res = await request(port, {
      path: '/api/notes',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' },
      body: validNote(),
    });
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res.body), /Sec-Fetch-Site/i);
  });

  it('deletes a real note and 404s a missing one', async () => {
    const created = await request(port, {
      path: '/api/notes',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validNote(),
    });
    assert.equal(created.status, 201, created.body);
    const id = (JSON.parse(created.body) as { note: { id: string } }).note.id;

    // A bodyless same-origin DELETE (no Content-Type) must pass the CSRF gate.
    const ok = await request(port, { path: `/api/notes/${id}`, method: 'DELETE' });
    assert.equal(ok.status, 204, ok.body);

    // FIX 5(b): a missing resource is a 404, not a 500.
    const missing = await request(port, {
      path: '/api/notes/note_does_not_exist',
      method: 'DELETE',
    });
    assert.equal(missing.status, 404, missing.body);
  });

  it('re-arms its spec watcher after the watched dir is deleted and recreated', async () => {
    // FIX 3: a deleted recursive watch never recovers on its own — Linux raises
    // a fatal `error` (unhandled, the run crashes), Windows floods `change`
    // events that starve the debounce so no `model` event ever fires. After the
    // fix, the re-armed watcher must deliver a `model` event for a fresh edit.
    const specRoot = path.join(fixture, 'openspec');
    const specFile = path.join(specRoot, 'specs', 'auth', 'spec.md');
    const sse = openSse(port);
    try {
      await delay(250); // let the SSE stream connect

      await rm(specRoot, { recursive: true, force: true });
      await delay(500); // storm→drop (win) / error (linux) → re-arm scheduled

      await mkdir(path.dirname(specFile), { recursive: true });
      await writeFile(specFile, SPEC_MD, 'utf8');
      await delay(1300); // let the re-arm poll re-establish the watch

      const before = sse.modelEvents();
      await writeFile(specFile, `${SPEC_MD}\n<!-- edited after re-arm -->\n`, 'utf8');
      const delivered = await waitFor(() => sse.modelEvents() > before, 3000);
      assert.ok(delivered, 'expected a model SSE event from the re-armed watcher');
    } finally {
      sse.close();
    }
  });

  it('tears down a failed startServer so the process still exits on its own', async () => {
    // FIX 4: a second start on the taken port must reject AND leak nothing that
    // keeps the event loop alive. The child exits by itself iff that holds.
    const childScript = path.join(fixture, 'leak-child.mjs');
    await writeFile(childScript, LEAK_CHILD, 'utf8');
    try {
      const { stderr } = await execFileAsync(process.execPath, [childScript, SERVER_JS, fixture], {
        timeout: 10_000,
      });
      assert.ok(!stderr.includes('MISSING_REJECTION'), `second start should reject: ${stderr}`);
    } catch (err) {
      const e = err as { killed?: boolean; signal?: string; code?: number; stderr?: string };
      assert.fail(
        `leak child did not exit on its own (killed=${e.killed}, signal=${e.signal}, ` +
          `code=${e.code}): ${e.stderr ?? ''}`
      );
    }
  });
});
