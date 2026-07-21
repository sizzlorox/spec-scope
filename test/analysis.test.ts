import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blastRadius } from '../src/blast.js';
import { changeEntries } from '../src/changes.js';
import { explainWork } from '../src/explainwork.js';
import { docStructureSource, requirementSource, scenarioSource, specHash } from '../src/hash.js';
import { docId, requirementId, scenarioId, taskId } from '../src/ids.js';
import type {
  AuthoredDiagram,
  Decision,
  DeltaKind,
  DiagramSkip,
  Explanation,
  ExplanationKind,
  GlossaryTerm,
  Note,
  Requirement,
  ReviewFile,
  Scenario,
  SpecDoc,
  SpecModel,
  Step,
  Task,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// builders — inline, and threaded through the real id helpers so the structural
// id-fragment path is exercised for real, not accidentally short-circuited.
// ---------------------------------------------------------------------------

interface ScnSpec {
  name: string;
  steps?: Array<[Step['keyword'], string]>;
}

interface ReqSpec {
  name: string;
  text?: string;
  delta?: DeltaKind;
  scenarios?: ScnSpec[];
}

function buildDoc(
  path: string,
  reqs: ReqSpec[],
  extra: Partial<SpecDoc> = {},
  taskSpecs: Array<{ text: string; section?: string }> = []
): SpecDoc {
  const id = docId(path);
  const requirements: Requirement[] = reqs.map((r) => {
    const reqIdVal = requirementId(id, r.name);
    const scenarios: Scenario[] = (r.scenarios ?? []).map((s) => {
      const steps: Step[] = (s.steps ?? []).map(([keyword, txt], i) => ({
        keyword,
        text: txt,
        line: i + 1,
      }));
      return { id: scenarioId(reqIdVal, s.name), name: s.name, steps, line: 1 };
    });
    return { id: reqIdVal, name: r.name, delta: r.delta, text: r.text ?? '', scenarios, line: 1 };
  });
  const tasks: Task[] = taskSpecs.map((t, i) => ({
    id: taskId(id, i),
    text: t.text,
    done: false,
    depth: 0,
    section: t.section,
    line: i + 1,
  }));
  return {
    id,
    path,
    title: path.replace(/\.md$/, ''),
    kind: 'spec',
    requirements,
    tasks,
    markdown: '',
    ...extra,
  };
}

function buildModel(docs: SpecDoc[]): SpecModel {
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

function explanation(anchor: string, kind: ExplanationKind, hash: string): Explanation {
  return {
    id: `exp_${anchor}_${kind}`,
    anchor,
    anchorLabel: anchor,
    kind,
    body: 'prose',
    provenance: 'grounded',
    sources: [],
    specHash: hash,
    author: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function decision(threadNoteId?: string): Decision {
  return {
    id: `dec_${threadNoteId ?? 'x'}`,
    title: 'a decision',
    context: '',
    options: [],
    choice: 'do the thing',
    tradeoffs: '',
    consequence: '',
    provenance: 'grounded',
    sources: [],
    threadNoteId,
    status: 'recorded',
    author: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function glossaryTerm(term: string, defined: boolean): GlossaryTerm {
  return {
    id: `term_${term}`,
    term,
    definition: defined ? 'a definition' : '',
    provenance: defined ? 'grounded' : 'unstated',
    sources: [],
    defined,
    author: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function authoredDiagram(anchor: string, hash: string): AuthoredDiagram {
  return {
    id: `dgm_${anchor}`,
    title: 'A diagram',
    type: 'state',
    anchor,
    anchorLabel: anchor,
    covers: [],
    mermaid: 'stateDiagram-v2\n  A --> B --> C',
    trigger: 'lifecycle',
    provenance: 'grounded',
    sources: [],
    specHash: hash,
    author: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function diagramSkip(anchor: string, hash: string): DiagramSkip {
  return {
    anchor,
    specHash: hash,
    reason: 'all scenarios are single-step lookups',
    author: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function note(id: string, status: Note['status']): Note {
  return {
    id,
    anchor: 'doc:x/req:y',
    anchorLabel: 'Requirement Y',
    kind: 'question',
    body: 'why?',
    author: 'human',
    createdAt: '2026-01-01T00:00:00.000Z',
    status,
    replies: [],
  };
}

// ---------------------------------------------------------------------------
// blast
// ---------------------------------------------------------------------------

test('blast: a requirement links structurally to each of its scenarios', () => {
  const doc = buildDoc('a.md', [
    { name: 'Passkey Login', scenarios: [{ name: 'Happy Path' }, { name: 'Locked Out' }] },
  ]);
  const req = doc.requirements[0]!;
  const graph = blastRadius(buildModel([doc]), req.id);

  assert.equal(graph.root, req.id);
  assert.ok(graph.nodes.some((n) => n.id === req.id && n.type === 'requirement'));
  for (const scn of req.scenarios) {
    assert.ok(
      graph.edges.some((e) => e.from === req.id && e.to === scn.id && e.kind === 'structural'),
      `missing structural edge to ${scn.name}`
    );
    assert.ok(graph.nodes.some((n) => n.id === scn.id && n.type === 'scenario'));
  }
});

test('blast: a task naming the requirement links structurally; an unrelated task does not', () => {
  const doc = buildDoc('a.md', [{ name: 'Passkey Login' }], {}, [
    { text: 'Implement passkey login backend' },
    { text: 'Write release notes' },
  ]);
  const req = doc.requirements[0]!;
  const graph = blastRadius(buildModel([doc]), req.id);

  const linked = taskId(doc.id, 0);
  const unrelated = taskId(doc.id, 1);
  assert.ok(
    graph.edges.some((e) => e.from === req.id && e.to === linked && e.kind === 'structural'),
    'task naming the requirement should link structurally'
  );
  assert.ok(!graph.edges.some((e) => e.to === unrelated), 'unrelated task must not be linked');
});

test('blast: a scenario anchor roots at the scenario and shows its owning requirement', () => {
  const doc = buildDoc('a.md', [{ name: 'Passkey Login', scenarios: [{ name: 'Happy Path' }] }]);
  const req = doc.requirements[0]!;
  const scn = req.scenarios[0]!;
  const graph = blastRadius(buildModel([doc]), scn.id);

  assert.equal(graph.root, scn.id);
  assert.ok(graph.nodes.some((n) => n.id === scn.id && n.type === 'scenario'));
  assert.ok(
    graph.edges.some((e) => e.from === req.id && e.to === scn.id && e.kind === 'structural'),
    'the owning requirement should link structurally to the scenario'
  );
});

test('blast: a task under a section named after the requirement links structurally', () => {
  const doc = buildDoc('a.md', [{ name: 'Checkout Flow' }], {}, [
    { text: 'misc cleanup', section: 'Checkout Flow' },
  ]);
  const req = doc.requirements[0]!;
  const graph = blastRadius(buildModel([doc]), req.id);

  // The task text alone ("misc cleanup") shares no term with the requirement — it
  // links only via the section-heading route, which must therefore fire.
  const sectioned = taskId(doc.id, 0);
  assert.ok(
    graph.edges.some((e) => e.from === req.id && e.to === sectioned && e.kind === 'structural'),
    'a task under the matching section heading should link structurally'
  );
});

test('blast: a shared domain term yields a dashed inferred edge; a shared stopword does not', () => {
  const rootDoc = buildDoc('a.md', [{ name: 'Login with Passkey' }]);
  const others = buildDoc('b.md', [
    { name: 'Passkey Recovery' }, // shares "passkey" -> inferred
    { name: 'Logout with Token' }, // shares only "with" (stopword) -> nothing
  ]);
  const model = buildModel([rootDoc, others]);
  const root = rootDoc.requirements[0]!;
  const shared = others.requirements[0]!;
  const stopwordOnly = others.requirements[1]!;

  const graph = blastRadius(model, root.id);

  const inferred = graph.edges.filter((e) => e.kind === 'inferred');
  assert.ok(
    inferred.some((e) => e.from === root.id && e.to === shared.id),
    'requirement sharing a domain term should get an inferred edge'
  );
  assert.ok(
    !graph.edges.some((e) => e.to === stopwordOnly.id),
    'sharing only a stopword must not create an edge'
  );
});

test('blast: a constitution clause sharing a term is linked as an inferred constitution node', () => {
  const rootDoc = buildDoc('a.md', [{ name: 'Privacy Controls' }]);
  const constitution = buildDoc('constitution.md', [], {
    kind: 'constitution',
    markdown: '# Constitution\n\n## Data Privacy\n\nProtect it.\n\n## Simplicity\n\nStay small.\n',
  });
  const graph = blastRadius(buildModel([rootDoc, constitution]), rootDoc.requirements[0]!.id);

  const clause = graph.nodes.find((n) => n.type === 'constitution' && n.label === 'Data Privacy');
  assert.ok(clause, 'a constitution clause sharing "privacy" should appear');
  assert.ok(
    graph.edges.some((e) => e.to === clause.id && e.kind === 'inferred'),
    'the constitution clause edge should be inferred (dashed)'
  );
});

test('blast: inferred edges are capped', () => {
  const rootDoc = buildDoc('a.md', [{ name: 'Payment Gateway' }]);
  const many: ReqSpec[] = [];
  for (let i = 0; i < 15; i += 1) many.push({ name: `Payment Channel ${i}` });
  const model = buildModel([rootDoc, buildDoc('b.md', many)]);

  const graph = blastRadius(model, rootDoc.requirements[0]!.id);
  const inferred = graph.edges.filter((e) => e.kind === 'inferred');
  assert.equal(inferred.length, 12, 'inferred edges must be capped at 12');
});

test('blast: an unknown anchor yields an empty graph and never throws', () => {
  const model = buildModel([buildDoc('a.md', [{ name: 'Something' }])]);
  let graph;
  assert.doesNotThrow(() => {
    graph = blastRadius(model, 'doc:nope/req:missing');
  });
  assert.deepEqual(graph, { root: 'doc:nope/req:missing', nodes: [], edges: [] });
});

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

test('changes: ADDED/MODIFIED/REMOVED quote the name and never invent a before', () => {
  const doc = buildDoc('a.md', [
    { name: 'Alpha', delta: 'ADDED', text: 'alpha does X' },
    { name: 'Beta', delta: 'MODIFIED', text: 'beta does Y' },
    { name: 'Gamma', delta: 'REMOVED', text: 'gamma did Z' },
    { name: 'Delta', text: 'no delta, excluded' },
  ]);
  const entries = changeEntries(buildModel([doc]));
  assert.equal(entries.length, 3, 'only delta-bearing requirements produce entries');

  const byName = new Map(entries.map((e) => [e.requirement, e]));

  const added = byName.get('Alpha')!;
  assert.match(added.summary, /"Alpha"/);
  assert.match(added.summary, /ADDED/);
  assert.equal(added.before, undefined, 'ADDED must not carry a before');
  assert.equal(added.after, 'alpha does X');

  const modified = byName.get('Beta')!;
  assert.match(modified.summary, /"Beta"/);
  assert.match(modified.summary, /MODIFIED/);
  assert.equal(modified.before, undefined, 'MODIFIED must not invent a before');
  assert.equal(modified.after, 'beta does Y');

  // REMOVED is the one delta whose text is a genuinely-recorded prior state.
  const removed = byName.get('Gamma')!;
  assert.match(removed.summary, /"Gamma"/);
  assert.match(removed.summary, /REMOVED/);
  assert.equal(removed.before, 'gamma did Z', 'REMOVED keeps the deleted text as before');
  assert.equal(removed.after, undefined, 'REMOVED has no after state');
});

test('changes: entries order by delta kind then doc path', () => {
  const docA = buildDoc('a.md', [
    { name: 'A', delta: 'ADDED', text: 'a' },
    { name: 'N', delta: 'RENAMED', text: 'n' },
  ]);
  const docB = buildDoc('b.md', [
    { name: 'B', delta: 'ADDED', text: 'b' },
    { name: 'M', delta: 'MODIFIED', text: 'm' },
    { name: 'R', delta: 'REMOVED', text: 'r' },
  ]);
  const entries = changeEntries(buildModel([docA, docB]));
  assert.deepEqual(
    entries.map((e) => e.requirement),
    ['A', 'B', 'M', 'N', 'R']
  );
});

test('changes: a model with no deltas yields no entries', () => {
  const doc = buildDoc('a.md', [{ name: 'Plain', text: 'no delta' }]);
  assert.deepEqual(changeEntries(buildModel([doc])), []);
  assert.deepEqual(changeEntries(buildModel([])), []);
});

// ---------------------------------------------------------------------------
// explainwork
// ---------------------------------------------------------------------------

test('explainwork: a requirement with no summary produces a missing summary task', () => {
  const doc = buildDoc('a.md', [{ name: 'R1', text: 'does a thing' }]);
  const req = doc.requirements[0]!;
  const tasks = explainWork(buildModel([doc]), emptyReview(), []);

  const summary = tasks.find((t) => t.kind === 'summary' && t.anchor === req.id);
  assert.ok(summary, 'expected a summary task');
  assert.equal(summary.reason, 'missing');
  assert.match(summary.hint, /grounded/);
});

test('explainwork: a summary whose hash matches produces no task; a changed one goes stale', () => {
  const doc = buildDoc('a.md', [{ name: 'R1', text: 'does a thing' }]);
  const req = doc.requirements[0]!;
  const goodHash = specHash(requirementSource(req.name, req.text, []));

  const matched = emptyReview();
  matched.explanations.push(explanation(req.id, 'summary', goodHash));
  const noTasks = explainWork(buildModel([doc]), matched, []);
  assert.ok(
    !noTasks.some((t) => t.kind === 'summary' && t.anchor === req.id),
    'a matching hash should suppress the summary task'
  );

  const stale = emptyReview();
  stale.explanations.push(explanation(req.id, 'summary', 'deadbeefdeadbeef'));
  const staleTasks = explainWork(buildModel([doc]), stale, []);
  const staleTask = staleTasks.find((t) => t.kind === 'summary' && t.anchor === req.id);
  assert.ok(staleTask, 'a changed requirement should produce a task');
  assert.equal(staleTask.reason, 'stale');
});

test('explainwork: a scenario with no narration produces a missing narration task', () => {
  const doc = buildDoc('a.md', [
    {
      name: 'R1',
      scenarios: [
        {
          name: 'Happy',
          steps: [
            ['WHEN', 'do x'],
            ['THEN', 'get y'],
          ],
        },
      ],
    },
  ]);
  const scn = doc.requirements[0]!.scenarios[0]!;
  const tasks = explainWork(buildModel([doc]), emptyReview(), []);
  const narration = tasks.find((t) => t.kind === 'narration' && t.anchor === scn.id);
  assert.ok(narration, 'expected a narration task');
  assert.equal(narration.reason, 'missing');

  // and it clears once a matching narration is stored
  const scnHash = specHash(
    scenarioSource(
      scn.name,
      scn.steps.map((s) => s.text)
    )
  );
  const review = emptyReview();
  review.explanations.push(explanation(scn.id, 'narration', scnHash));
  const cleared = explainWork(buildModel([doc]), review, []);
  assert.ok(!cleared.some((t) => t.kind === 'narration' && t.anchor === scn.id));
});

test('explainwork: a resolved note without a decision produces a decision task; a recorded one does not', () => {
  const model = buildModel([buildDoc('a.md', [])]);
  const review = emptyReview();
  review.decisions.push(decision('note-decided'));

  const notes: Note[] = [
    note('note-open', 'open'),
    note('note-decided', 'resolved'),
    note('note-undecided', 'resolved'),
  ];
  const tasks = explainWork(model, review, notes);
  const decisionTasks = tasks.filter((t) => t.kind === 'decision');

  assert.deepEqual(
    decisionTasks.map((t) => t.anchor),
    ['note-undecided'],
    'only resolved notes without a decision produce a decision task'
  );
  assert.equal(decisionTasks[0]!.reason, 'missing');
});

test('explainwork: an undefined glossary term produces a task; a defined one does not', () => {
  const model = buildModel([buildDoc('a.md', [])]);
  const review = emptyReview();
  review.glossary.push(glossaryTerm('Passkey', false));
  review.glossary.push(glossaryTerm('Session', true));

  const tasks = explainWork(model, review, []);
  const glossary = tasks.filter((t) => t.kind === 'glossary');
  assert.deepEqual(
    glossary.map((t) => t.anchor),
    ['Passkey'],
    'only undefined terms produce a glossary task'
  );
});

// ---------------------------------------------------------------------------
// explainwork — per-document diagram tasks
// ---------------------------------------------------------------------------

test('explainwork: a doc with requirements produces a diagram task pinned to its structural hash', () => {
  const doc = buildDoc('a.md', [
    { name: 'R1', text: 'does a thing', scenarios: [{ name: 'Happy', steps: [['WHEN', 'x']] }] },
  ]);
  const tasks = explainWork(buildModel([doc]), emptyReview(), []);

  const diagram = tasks.find((t) => t.kind === 'diagram' && t.anchor === doc.id);
  assert.ok(diagram, 'expected a diagram task for a doc with requirements');
  assert.equal(diagram.reason, 'missing');
  assert.equal(diagram.anchorLabel, doc.title);
  assert.equal(diagram.specHash, specHash(docStructureSource(doc)));
  assert.match(diagram.hint, /DEFAULT IS NO DIAGRAM/);
});

test('explainwork: a doc with no requirements gets no diagram task', () => {
  const tasks = explainWork(buildModel([buildDoc('a.md', [])]), emptyReview(), []);
  assert.ok(!tasks.some((t) => t.kind === 'diagram'));
});

test('explainwork: diagram tasks are appended after summary, glossary and decision tasks', () => {
  const doc = buildDoc('a.md', [
    { name: 'R1', text: 't', scenarios: [{ name: 'S', steps: [['WHEN', 'x']] }] },
  ]);
  const review = emptyReview();
  review.glossary.push(glossaryTerm('Passkey', false));
  const tasks = explainWork(buildModel([doc]), review, [note('n1', 'resolved')]);

  const kinds = tasks.map((t) => t.kind);
  const firstDiagram = kinds.indexOf('diagram');
  const lastOther = kinds.reduce((acc, k, i) => (k === 'diagram' ? acc : i), -1);
  assert.ok(firstDiagram >= 0, 'expected a diagram task');
  assert.ok(firstDiagram > lastOther, `diagram tasks must come last: ${kinds.join(', ')}`);
});

test('explainwork: a matching-hash AuthoredDiagram anchored on the doc suppresses the task', () => {
  const doc = buildDoc('a.md', [{ name: 'R1', text: 'does a thing' }]);
  const review = emptyReview();
  review.diagrams.push(authoredDiagram(doc.id, specHash(docStructureSource(doc))));

  const tasks = explainWork(buildModel([doc]), review, []);
  assert.ok(
    !tasks.some((t) => t.kind === 'diagram' && t.anchor === doc.id),
    'a matching authored diagram closes the task'
  );
});

test('explainwork: a matching-hash DiagramSkip anchored on the doc suppresses the task', () => {
  const doc = buildDoc('a.md', [{ name: 'R1', text: 'does a thing' }]);
  const review = emptyReview();
  review.diagramSkips.push(diagramSkip(doc.id, specHash(docStructureSource(doc))));

  const tasks = explainWork(buildModel([doc]), review, []);
  assert.ok(
    !tasks.some((t) => t.kind === 'diagram' && t.anchor === doc.id),
    'a matching skip is an honest tracked "none" that closes the task'
  );
});

test('explainwork: editing the doc structure re-opens the diagram task as stale', () => {
  const before = buildDoc('a.md', [{ name: 'R1', text: 'original text' }]);
  const review = emptyReview();
  review.diagrams.push(authoredDiagram(before.id, specHash(docStructureSource(before))));

  // While the hash matches, no task.
  assert.ok(
    !explainWork(buildModel([before]), review, []).some((t) => t.kind === 'diagram'),
    'the matching hash should suppress the task'
  );

  // The doc's structural text changes; the diagram (same anchor) now sits at a stale hash.
  const after = buildDoc('a.md', [{ name: 'R1', text: 'reworded text' }]);
  const staleTasks = explainWork(buildModel([after]), review, []);
  const diagram = staleTasks.find((t) => t.kind === 'diagram' && t.anchor === after.id);
  assert.ok(diagram, 'a structural edit should re-open the diagram task');
  assert.equal(diagram.reason, 'stale');
  assert.equal(diagram.specHash, specHash(docStructureSource(after)));
});
