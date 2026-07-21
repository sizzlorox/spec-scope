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
import { ReviewStore } from '../src/review.js';

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

/** Headers a first-party browser write carries, so the CSRF gate lets it through. */
function sameOrigin(p: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    origin: `http://127.0.0.1:${p}`,
    'sec-fetch-site': 'same-origin',
  };
}

/** Holds an SSE connection open and counts frames of one named event. */
function openSseCounting(
  p: number,
  eventName: string
): { events: () => number; close: () => void } {
  let count = 0;
  let buf = '';
  const re = new RegExp(`(^|\\n)event: ${eventName}(\\n|$)`);
  const req = http.request({ host: '127.0.0.1', port: p, path: '/api/events' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) if (re.test(frame)) count += 1;
    });
  });
  req.on('error', () => {
    /* surfaced by close()/destroy(); nothing to do */
  });
  req.end();
  return { events: () => count, close: () => req.destroy() };
}

/** First requirement id the parser assigned to the fixture, for anchored routes. */
async function firstRequirementId(): Promise<string> {
  const res = await request(port, { path: '/api/model' });
  const payload = JSON.parse(res.body) as {
    model: { docs: Array<{ requirements: Array<{ id: string }> }> };
  };
  for (const doc of payload.model.docs) {
    const req = doc.requirements[0];
    if (req) return req.id;
  }
  throw new Error('fixture has no requirement to anchor on');
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

describe('review layer server', () => {
  it('creates a decision (same-origin JSON) and surfaces it in GET /api/review', async () => {
    const created = await request(port, {
      path: '/api/decisions',
      method: 'POST',
      headers: sameOrigin(port),
      body: JSON.stringify({
        title: 'Adopt passkeys',
        choice: 'Require a platform authenticator',
        context: 'Passwords are phishable.',
        provenance: 'inferred',
      }),
    });
    assert.equal(created.status, 201, created.body);
    const decision = (JSON.parse(created.body) as { decision: { id: string; status: string } })
      .decision;
    assert.ok(decision.id);
    assert.equal(decision.status, 'open');

    const review = await request(port, { path: '/api/review' });
    assert.equal(review.status, 200);
    const rf = (JSON.parse(review.body) as { review: { decisions: Array<{ id: string }> } }).review;
    assert.ok(
      rf.decisions.some((d) => d.id === decision.id),
      review.body
    );
  });

  it('blocks a cross-site POST to /api/decisions (CSRF gate covers the new routes)', async () => {
    // The reproduced no-cors attack: a text/plain body a cross-site page can send.
    const res = await request(port, {
      path: '/api/decisions',
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ title: 'x', choice: 'y' }),
    });
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res.body), /Content-Type/i);
  });

  it('blocks a cross-site POST to /api/stamps (Origin mismatch)', async () => {
    const res = await request(port, {
      path: '/api/stamps',
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example.com:1234' },
      body: JSON.stringify({ anchor: 'a', anchorLabel: 'A', verdict: 'concern' }),
    });
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res.body), /Origin/i);
  });

  it('upserts a stamp: a repeat verdict updates the same record in place', async () => {
    const post = (verdict: string): Promise<Res> =>
      request(port, {
        path: '/api/stamps',
        method: 'POST',
        headers: sameOrigin(port),
        body: JSON.stringify({
          anchor: 'req:upsert-target',
          anchorLabel: 'Upsert target',
          verdict,
          author: 'reviewer',
        }),
      });

    const first = await post('concern');
    assert.equal(first.status, 200, first.body);
    const stamp1 = (JSON.parse(first.body) as { stamp: { id: string; verdict: string } }).stamp;
    assert.equal(stamp1.verdict, 'concern');

    const second = await post('approved');
    assert.equal(second.status, 200, second.body);
    const stamp2 = (JSON.parse(second.body) as { stamp: { id: string; verdict: string } }).stamp;
    assert.equal(stamp2.id, stamp1.id, 'upsert must reuse the stamp id, not create a new one');
    assert.equal(stamp2.verdict, 'approved');

    const review = await request(port, { path: '/api/review' });
    const stamps = (
      JSON.parse(review.body) as { review: { stamps: Array<{ anchor: string; author: string }> } }
    ).review.stamps;
    const forTarget = stamps.filter(
      (s) => s.anchor === 'req:upsert-target' && s.author === 'reviewer'
    );
    assert.equal(forTarget.length, 1, 'exactly one stamp per (anchor, author)');
  });

  it('updates a decision, deletes it, and 404s an unknown id', async () => {
    const created = await request(port, {
      path: '/api/decisions',
      method: 'POST',
      headers: sameOrigin(port),
      body: JSON.stringify({ title: 'Draft', choice: 'Option A' }),
    });
    assert.equal(created.status, 201, created.body);
    const id = (JSON.parse(created.body) as { decision: { id: string } }).decision.id;

    const updated = await request(port, {
      path: `/api/decisions/${id}`,
      method: 'POST',
      headers: sameOrigin(port),
      body: JSON.stringify({ status: 'recorded', choice: 'Option B' }),
    });
    assert.equal(updated.status, 200, updated.body);
    const dec = (JSON.parse(updated.body) as { decision: { status: string; choice: string } })
      .decision;
    assert.equal(dec.status, 'recorded');
    assert.equal(dec.choice, 'Option B');

    const missingUpdate = await request(port, {
      path: '/api/decisions/dec_nope',
      method: 'POST',
      headers: sameOrigin(port),
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(missingUpdate.status, 404, missingUpdate.body);

    // A bodyless same-origin DELETE (no Content-Type) must pass the CSRF gate.
    const del = await request(port, { path: `/api/decisions/${id}`, method: 'DELETE' });
    assert.equal(del.status, 204, del.body);

    const missingDelete = await request(port, {
      path: '/api/decisions/dec_nope',
      method: 'DELETE',
    });
    assert.equal(missingDelete.status, 404, missingDelete.body);
  });

  it('deletes a stamp and 404s an unknown id', async () => {
    const created = await request(port, {
      path: '/api/stamps',
      method: 'POST',
      headers: sameOrigin(port),
      body: JSON.stringify({
        anchor: 'req:delete-me',
        anchorLabel: 'Delete me',
        verdict: 'blocking',
      }),
    });
    assert.equal(created.status, 200, created.body);
    const id = (JSON.parse(created.body) as { stamp: { id: string } }).stamp.id;

    const del = await request(port, { path: `/api/stamps/${id}`, method: 'DELETE' });
    assert.equal(del.status, 204, del.body);

    const missing = await request(port, { path: '/api/stamps/stamp_nope', method: 'DELETE' });
    assert.equal(missing.status, 404, missing.body);
  });

  it('applies a ReviewBatch and the explanation appears in GET /api/review', async () => {
    const batch = {
      explanations: [
        {
          anchor: 'doc:auth/req:sign-in',
          anchorLabel: 'Authentication / Sign in with a passkey',
          kind: 'summary',
          body: 'Users prove identity with a platform passkey.',
          provenance: 'inferred',
          sources: [],
          specHash: 'deadbeef',
        },
      ],
    };
    const res = await request(port, {
      path: '/api/apply',
      method: 'POST',
      headers: sameOrigin(port),
      body: JSON.stringify(batch),
    });
    assert.equal(res.status, 200, res.body);
    const result = JSON.parse(res.body) as { added: number; updated: number };
    assert.equal(result.added, 1, res.body);
    assert.equal(result.updated, 0);

    const review = await request(port, { path: '/api/review' });
    const explanations = (
      JSON.parse(review.body) as { review: { explanations: Array<{ anchor: string }> } }
    ).review.explanations;
    assert.ok(
      explanations.some((e) => e.anchor === 'doc:auth/req:sign-in'),
      review.body
    );
  });

  it('returns a blast graph for a known anchor and 400s a missing one', async () => {
    const anchor = await firstRequirementId();
    const res = await request(port, {
      path: `/api/blast?anchor=${encodeURIComponent(anchor)}`,
    });
    assert.equal(res.status, 200, res.body);
    const body = JSON.parse(res.body) as {
      graph: { root: string; nodes: unknown[]; edges: unknown[] };
      mermaid: string;
    };
    assert.equal(body.graph.root, anchor);
    assert.ok(Array.isArray(body.graph.nodes) && Array.isArray(body.graph.edges));
    // The browser renders the subgraph from this ready-made Mermaid source.
    assert.match(body.mermaid, /flowchart/);

    const missing = await request(port, { path: '/api/blast' });
    assert.equal(missing.status, 400, missing.body);
  });

  it('returns change entries and explain tasks as arrays', async () => {
    const changes = await request(port, { path: '/api/changes' });
    assert.equal(changes.status, 200);
    assert.ok(Array.isArray((JSON.parse(changes.body) as { changes: unknown[] }).changes));

    const explain = await request(port, { path: '/api/explain' });
    assert.equal(explain.status, 200);
    const tasks = (JSON.parse(explain.body) as { tasks: Array<{ kind: string; specHash: string }> })
      .tasks;
    assert.ok(Array.isArray(tasks));
    // The fixture requirement is unexplained, so a summary task is always emitted.
    const summary = tasks.find((t) => t.kind === 'summary');
    assert.ok(summary, explain.body);
    // The task carries the hash the agent copies to close the staleness loop.
    assert.ok(summary.specHash.length > 0, 'summary task must carry a specHash');
  });

  it('serves a review heat-map keyed by anchor id, and 400s/404s bad input', async () => {
    const anchor = await firstRequirementId();
    const docIdOf = anchor.slice(0, anchor.indexOf('/req:'));
    // Stamp a verdict, then the heat map must render (tint is anchor-keyed server-side,
    // never re-derived from node text in the browser).
    const stamped = await request(port, {
      path: '/api/stamps',
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ anchor, anchorLabel: 'x', verdict: 'blocking' }),
    });
    assert.equal(stamped.status, 200, stamped.body);

    const heat = await request(port, { path: `/api/heatmap?doc=${encodeURIComponent(docIdOf)}` });
    assert.equal(heat.status, 200, heat.body);
    assert.match((JSON.parse(heat.body) as { mermaid: string }).mermaid, /flowchart/);

    assert.equal((await request(port, { path: '/api/heatmap' })).status, 400);
    assert.equal((await request(port, { path: '/api/heatmap?doc=doc:nope' })).status, 404);
  });

  it('rejects an invalid /api/apply element with 400, not 500', async () => {
    const bad = await request(port, {
      path: '/api/apply',
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({
        explanations: [
          {
            anchor: 'a'.repeat(600), // over the 512 cap -> validation error
            anchorLabel: 'x',
            kind: 'summary',
            body: 'y',
            provenance: 'grounded',
            sources: [],
            specHash: 'h',
            author: 'a',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });
    assert.equal(bad.status, 400, bad.body);
  });

  it('emits an SSE review event when review.json changes on disk', async () => {
    // Drives the cross-process watcher path (a hand edit / a second CLI), exactly
    // as the notes feed reacts to notes.json.
    const reviewFile = path.join(fixture, '.spec-scope', 'review.json');
    await mkdir(path.dirname(reviewFile), { recursive: true });
    const empty = {
      version: 1,
      decisions: [],
      stamps: [],
      explanations: [],
      glossary: [],
      diagrams: [],
      diagramSkips: [],
    };
    await writeFile(reviewFile, JSON.stringify(empty), 'utf8');

    const sse = openSseCounting(port, 'review');
    try {
      await delay(300); // connect + let the watcher target .spec-scope
      const before = sse.events();
      await writeFile(reviewFile, JSON.stringify({ ...empty, touched: Date.now() }), 'utf8');
      const delivered = await waitFor(() => sse.events() > before, 3000);
      assert.ok(delivered, 'expected a review SSE event from the watcher');
    } finally {
      sse.close();
    }
  });

  it('close() and a failed start each tear down the ReviewStore', async () => {
    // The review watcher is unref'd, so its leak is invisible to any handle count
    // (getActiveResourcesInfo and _getActiveHandles both omit unref'd handles) —
    // a count test stays green with the teardown deleted, so it proves nothing.
    // Spy on the collaborator instead: ESM modules are singletons, so this
    // ReviewStore class object is the exact one the server imports. Patch the
    // prototype (call through, restore in finally) and assert the server actually
    // invoked close() on both the success and the failed-start paths.
    // Deliberate spy: stash the real method and restore it in finally. The
    // unbound-method rule is a false positive here — we call it back with an
    // explicit `this`, which is the whole point.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const realClose = ReviewStore.prototype.close;
    let closeCalls = 0;
    ReviewStore.prototype.close = function (this: ReviewStore): void {
      closeCalls += 1;
      realClose.call(this); // release the watcher for real, so the process still exits
    };
    try {
      const h1 = await startServer({ root: fixture, port: 0 });
      closeCalls = 0;
      await h1.close();
      assert.equal(closeCalls, 1, 'close() must tear down the ReviewStore');

      const h2 = await startServer({ root: fixture, port: 0 });
      try {
        closeCalls = 0;
        // A second start on the taken port rejects; its catch-block teardown must
        // close the ReviewStore it already opened.
        await assert.rejects(startServer({ root: fixture, port: h2.port }));
        assert.equal(closeCalls, 1, 'a failed start must tear down the ReviewStore it opened');
      } finally {
        await h2.close();
      }
    } finally {
      ReviewStore.prototype.close = realClose;
    }
  });
});
