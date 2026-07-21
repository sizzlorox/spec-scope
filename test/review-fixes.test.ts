/**
 * Regression tests for the review-layer audit fixes.
 *
 * Each test pins a specific defect the adversarial audit reproduced, so a later
 * change that reintroduces it fails here rather than in a reviewer's browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blastRadius } from '../src/blast.js';
import { changeEntries } from '../src/changes.js';
import { escapeMermaid } from '../src/diagram.js';
import { explainWork } from '../src/explainwork.js';
import { requirementSource, specHash } from '../src/hash.js';
import { docId, requirementId, taskId } from '../src/ids.js';
import type {
  Explanation,
  Requirement,
  ReviewFile,
  SpecDoc,
  SpecModel,
  Task,
} from '../src/types.js';

function doc(path: string, reqs: Requirement[], tasks: Task[] = []): SpecDoc {
  return {
    id: docId(path),
    path,
    title: path,
    kind: 'spec',
    requirements: reqs,
    tasks,
    markdown: '',
  };
}

function model(docs: SpecDoc[]): SpecModel {
  return { root: '/repo', flavor: 'unknown', groups: [], docs, warnings: [] };
}

function emptyReview(): ReviewFile {
  return {
    version: 1,
    decisions: [],
    stamps: [],
    explanations: [],
    glossary: [],
    diagrams: [],
    diagramSkips: [],
  };
}

// --- Engine F2: the staleness round-trip must close --------------------------

test('explainWork emits the current specHash so the agent can pin an explanation', () => {
  const dId = docId('a/spec.md');
  const rId = requirementId(dId, 'Passkey Enrolment');
  const req: Requirement = {
    id: rId,
    name: 'Passkey Enrolment',
    text: 'A shopper can register a passkey.',
    scenarios: [],
    line: 1,
  };
  const tasks = explainWork(model([doc('a/spec.md', [req])]), emptyReview(), []);
  const summary = tasks.find((t) => t.kind === 'summary' && t.anchor === rId);
  assert.ok(summary, 'a missing summary produces a task');
  const want = specHash(requirementSource(req.name, req.text, []));
  assert.equal(summary.specHash, want, 'the task carries the hash the agent must copy');
  assert.match(summary.hint, /specHash/, 'the hint tells the agent to copy it');

  // An explanation that copies that specHash must NOT be reported stale again.
  const review = emptyReview();
  review.explanations.push(pinnedSummary(rId, summary.specHash));
  const after = explainWork(model([doc('a/spec.md', [req])]), review, []);
  assert.equal(
    after.filter((t) => t.kind === 'summary' || t.kind === 'narration').length,
    0,
    'a correctly-pinned explanation is neither missing nor stale'
  );
});

test('glossary and decision tasks carry an empty specHash', () => {
  const review = emptyReview();
  review.glossary.push({
    id: 't',
    term: 'RP ID',
    definition: '',
    provenance: 'unstated',
    sources: [],
    defined: false,
    author: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const tasks = explainWork(model([]), review, []);
  const g = tasks.find((t) => t.kind === 'glossary');
  assert.ok(g);
  assert.equal(g.specHash, '', 'glossary tasks pin to no source text');
});

function pinnedSummary(anchor: string, hash: string): Explanation {
  return {
    id: 'e',
    anchor,
    anchorLabel: anchor,
    kind: 'summary',
    body: 'plain',
    provenance: 'grounded',
    sources: [],
    specHash: hash,
    author: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

// --- Engine F1: a single-word requirement name is not a structural task edge --

test('blastRadius does not solid-link a task that merely shares a one-word name', () => {
  const dId = docId('a/spec.md');
  const rId = requirementId(dId, 'Support');
  const req: Requirement = { id: rId, name: 'Support', text: '', scenarios: [], line: 1 };
  const tasks: Task[] = [
    {
      id: taskId(dId, 0),
      text: 'Add support for older Android browsers',
      done: false,
      depth: 0,
      line: 1,
    },
    { id: taskId(dId, 1), text: 'Write the changelog', done: false, depth: 0, line: 2 },
  ];
  const graph = blastRadius(model([doc('a/spec.md', [req], tasks)]), rId);
  const structuralTaskEdges = graph.edges.filter(
    (e) => e.kind === 'structural' && e.to.includes('task:')
  );
  assert.equal(
    structuralTaskEdges.length,
    0,
    'a task sharing only the common word "support" must not be a factual dependency'
  );
});

test('blastRadius still solid-links a task that names a distinctive multi-word requirement', () => {
  const dId = docId('a/spec.md');
  const rId = requirementId(dId, 'Passkey Enrolment');
  const req: Requirement = { id: rId, name: 'Passkey Enrolment', text: '', scenarios: [], line: 1 };
  const tasks: Task[] = [
    {
      id: taskId(dId, 0),
      text: 'Implement passkey enrolment on the client',
      done: false,
      depth: 0,
      line: 1,
    },
  ];
  const graph = blastRadius(model([doc('a/spec.md', [req], tasks)]), rId);
  assert.ok(
    graph.edges.some((e) => e.kind === 'structural' && e.to.includes('task:')),
    'a two-word name still links a task that names it'
  );
});

// --- Engine F3: RENAMED must not deny a name it displays ----------------------

test('changeEntries RENAMED summary does not claim "no prior name"', () => {
  const dId = docId('a/spec.md');
  const req: Requirement = {
    id: requirementId(dId, 'Credential Revocation'),
    name: 'Credential Revocation',
    delta: 'RENAMED',
    text: '- FROM: `### Requirement: Sign Out`\n- TO: `### Requirement: Credential Revocation`',
    scenarios: [],
    line: 1,
  };
  const [entry] = changeEntries(model([doc('a/spec.md', [req])]));
  assert.ok(entry);
  assert.doesNotMatch(entry.summary, /no prior name is recorded/i);
  assert.ok((entry.after ?? '').includes('Sign Out'), 'the recorded prior name is still shown');
});

// --- Browser F4: escapeMermaid must neutralise angle brackets and ampersands --

test('escapeMermaid encodes < > & so spec HTML cannot become a live DOM node', () => {
  const out = escapeMermaid('<img src=x onerror=alert(1)> & more');
  assert.doesNotMatch(out, /</, 'no raw <');
  assert.doesNotMatch(out, />/, 'no raw >');
  assert.doesNotMatch(out, /&(?!#)/, 'no raw &');
  assert.match(out, /#60;/, '< is entity-encoded');
  assert.match(out, /#62;/, '> is entity-encoded');
  assert.match(out, /#38;/, '& is entity-encoded');
  // The earlier escapes still hold and are not double-encoded.
  assert.doesNotMatch(out, /#35;60;/, '# escaping did not corrupt the new entities');
});
