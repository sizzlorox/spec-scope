import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blastDiagram,
  escapeMermaid,
  generateDiagrams,
  groupOverview,
  requirementHeatMap,
  requirementMap,
  scenarioSequence,
  taskFlow,
  validateAuthoredMermaid,
} from '../src/diagram.js';
import type {
  BlastEdge,
  BlastGraph,
  BlastNode,
  DeltaKind,
  Diagram,
  Requirement,
  ReviewStamp,
  ReviewVerdict,
  Scenario,
  SpecDoc,
  SpecFlavor,
  SpecGroup,
  SpecModel,
  Step,
  StepKeyword,
  Task,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// builders — deliberately inline so these tests never depend on fixture files
// ---------------------------------------------------------------------------

function step(keyword: StepKeyword, text: string, actor?: string): Step {
  return { keyword, text, actor, line: 1 };
}

function scenario(name: string, steps: Step[] = [], id = `scn:${name}`): Scenario {
  return { id, name, steps, line: 1 };
}

function requirement(
  name: string,
  scenarios: Scenario[] = [],
  delta?: DeltaKind,
  id = `req:${name}`
): Requirement {
  return { id, name, delta, text: '', scenarios, line: 1 };
}

function task(text: string, extra: Partial<Task> = {}): Task {
  return { id: extra.id ?? `task:${text}`, text, done: false, depth: 0, line: 1, ...extra };
}

function doc(id: string, title: string, extra: Partial<SpecDoc> = {}): SpecDoc {
  return {
    id,
    path: `${title}.md`,
    title,
    kind: 'spec',
    requirements: [],
    tasks: [],
    markdown: '',
    ...extra,
  };
}

function group(
  id: string,
  name: string,
  docIds: string[],
  kind: SpecGroup['kind'] = 'change'
): SpecGroup {
  return { id, name, kind, path: name, docIds, archived: false };
}

function model(
  docs: SpecDoc[],
  groups: SpecGroup[] = [],
  flavor: SpecFlavor = 'openspec'
): SpecModel {
  return { root: '/tmp/project', flavor, groups, docs, warnings: [] };
}

function stamp(
  anchor: string,
  verdict: ReviewVerdict,
  extra: Partial<ReviewStamp> = {}
): ReviewStamp {
  return {
    id: `stamp:${anchor}:${verdict}`,
    anchor,
    anchorLabel: anchor,
    verdict,
    author: 'rev',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function bnode(id: string, type: BlastNode['type'], label = id): BlastNode {
  return { id, label, type };
}

function bedge(from: string, to: string, kind: BlastEdge['kind']): BlastEdge {
  return { from, to, kind };
}

function bgraph(root: string, nodes: BlastNode[], edges: BlastEdge[] = []): BlastGraph {
  return { root, nodes, edges };
}

/** Lines of a diagram with Mermaid comments and blanks removed. */
function bodyLines(diagram: Diagram): string[] {
  return diagram.mermaid
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));
}

/** The `participant AN as Label` declarations, in order. */
function participantLines(diagram: Diagram): string[] {
  return bodyLines(diagram).filter((l) => l.startsWith('participant'));
}

/**
 * The message lines with generated aliases rewritten back to their human labels, so
 * assertions read as `Sender->>Recipient: text` regardless of lane numbering.
 */
function messages(diagram: Diagram): string[] {
  const aliasToLabel = new Map<string, string>();
  for (const line of bodyLines(diagram)) {
    const m = /^participant (A\d+) as (.+)$/.exec(line);
    if (m && m[1] && m[2]) aliasToLabel.set(m[1], m[2]);
  }
  return bodyLines(diagram)
    .filter((l) => l.includes('->>'))
    .map((l) => l.replace(/A\d+/g, (a) => aliasToLabel.get(a) ?? a));
}

// ---------------------------------------------------------------------------
// escapeMermaid
// ---------------------------------------------------------------------------

test('escapeMermaid replaces # before other entities and never double-escapes', () => {
  assert.equal(escapeMermaid('issue #42'), 'issue #35;42');
  assert.equal(escapeMermaid('say "hi"'), 'say #quot;hi#quot;');
  // The killer case: a literal # next to a character that becomes an entity.
  const out = escapeMermaid('#"');
  assert.equal(out, '#35;#quot;');
  assert.ok(!out.includes('#35;quot;'), 'the # of #quot; must not be re-escaped');
});

test('escapeMermaid escapes brackets, parens and braces', () => {
  assert.equal(escapeMermaid('a(b)c[d]e{f}'), 'a#40;b#41;c#91;d#93;e#123;f#125;');
});

test('escapeMermaid neutralises the semicolon that would split a sequence statement', () => {
  // `;` is Mermaid's statement separator and cannot be entity-encoded (`#59;`
  // still contains one), so it becomes a full-width look-alike.
  const out = escapeMermaid('do a; then b');
  assert.ok(!out.includes(';'), `raw semicolon survived: ${out}`);
  assert.equal(out, 'do a； then b');
});

test('escapeMermaid neutralises semicolons before it starts emitting entities', () => {
  // If the order were reversed the entity terminators would be mangled too.
  assert.equal(escapeMermaid('#a;b'), '#35;a；b');
});

test('escapeMermaid stops a literal %% from opening a comment', () => {
  const out = escapeMermaid('50%% off');
  assert.ok(!out.includes('%'), `raw percent survived: ${out}`);
  assert.equal(out, '50#37;#37; off');
});

test('escapeMermaid escapes backticks so a label cannot enter markdown-string mode', () => {
  assert.equal(escapeMermaid('`code`'), '#96;code#96;');
});

test('escapeMermaid collapses all whitespace and newlines to single spaces', () => {
  assert.equal(escapeMermaid('  a\n\n  b\tc  '), 'a b c');
  assert.ok(!escapeMermaid('a\nb').includes('\n'));
});

test('escapeMermaid truncates long text with an ellipsis', () => {
  const out = escapeMermaid('x'.repeat(200));
  assert.ok(out.length <= 90, `expected <= 90 chars, got ${out.length}`);
  assert.ok(out.endsWith('…'));
  // Short text is left completely alone.
  assert.equal(escapeMermaid('short'), 'short');
});

test('escapeMermaid truncation never splits an entity', () => {
  // The trailing quote is dropped by truncation rather than becoming a dangling `#qu`.
  const out = escapeMermaid(`${'x'.repeat(120)}"`);
  assert.ok(!/#[a-z0-9]*$/.test(out), `truncated mid-entity: ${out}`);
});

// ---------------------------------------------------------------------------
// scenarioSequence
// ---------------------------------------------------------------------------

test('scenarioSequence declares named actors in order without a phantom System lane', () => {
  const scn = scenario('login', [
    step('WHEN', 'submits credentials', 'Alice'),
    step('THEN', 'is granted a token', 'Bob'),
    step('AND', 'Alice sees the dashboard', 'Alice'),
  ]);
  // Two actors are named and every message step is annotated, so no System lane is
  // invented — Alice and Bob are the only participants.
  assert.deepEqual(participantLines(scenarioSequence(scn, requirement('Auth'))), [
    'participant A0 as Alice',
    'participant A1 as Bob',
  ]);
});

test('scenarioSequence dedupes actors case-insensitively', () => {
  const scn = scenario('x', [step('WHEN', 'a', 'Alice'), step('THEN', 'b', 'alice')]);
  const participants = bodyLines(scenarioSequence(scn, requirement('R'))).filter((l) =>
    l.startsWith('participant')
  );
  assert.deepEqual(participants, ['participant A0 as Alice', 'participant A1 as System']);
});

test('scenarioSequence adds System (not User) when a response step names no actor', () => {
  // The anonymous step is a THEN, so it is a reply from the service side; the lane
  // that gets invented is System, and it answers the named requester Alice.
  const scn = scenario('x', [step('WHEN', 'a', 'Alice'), step('THEN', 'b')]);
  const diagram = scenarioSequence(scn, requirement('R'));

  assert.deepEqual(participantLines(diagram), [
    'participant A0 as Alice',
    'participant A1 as System',
  ]);
  assert.deepEqual(messages(diagram), ['Alice->>System: a', 'System-->>Alice: b']);
});

test('scenarioSequence adds User when a request step names no actor', () => {
  // The anonymous step is an AND inheriting request direction, so it originates from
  // the User lane — never routed through a phantom System.
  const scn = scenario('x', [step('WHEN', 'a', 'Alice'), step('AND', 'b')]);
  const diagram = scenarioSequence(scn, requirement('R'));

  assert.deepEqual(participantLines(diagram), [
    'participant A0 as Alice',
    'participant A1 as User',
  ]);
  assert.deepEqual(messages(diagram), ['Alice->>User: a', 'User->>Alice: b']);
});

test('scenarioSequence defaults to User and System when no actors appear at all', () => {
  const scn = scenario('x', [step('WHEN', 'a'), step('THEN', 'b')]);
  const participants = bodyLines(scenarioSequence(scn, requirement('R'))).filter((l) =>
    l.startsWith('participant')
  );
  assert.deepEqual(participants, ['participant A0 as User', 'participant A1 as System']);
});

test('scenarioSequence uses a solid arrow to System for WHEN and a dashed arrow back for THEN', () => {
  const scn = scenario('x', [step('WHEN', 'asks'), step('THEN', 'answers')]);
  const lines = bodyLines(scenarioSequence(scn, requirement('R')));

  assert.ok(lines.includes('A0->>A1: asks'), lines.join('\n'));
  assert.ok(lines.includes('A1-->>A0: answers'), lines.join('\n'));
});

test('scenarioSequence emits GIVEN as a Note over, not a message', () => {
  const scn = scenario('x', [step('GIVEN', 'a user exists'), step('WHEN', 'they log in')]);
  const lines = bodyLines(scenarioSequence(scn, requirement('R')));

  assert.ok(lines.includes('Note over A0,A1: a user exists'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('->>') && l.includes('a user exists')));
});

test('scenarioSequence AND inherits the direction of the previous step', () => {
  const scn = scenario('x', [
    step('WHEN', 'first request'),
    step('AND', 'second request'),
    step('THEN', 'first response'),
    step('AND', 'second response'),
  ]);
  const lines = bodyLines(scenarioSequence(scn, requirement('R')));

  assert.ok(lines.includes('A0->>A1: first request'));
  assert.ok(lines.includes('A0->>A1: second request'), 'AND after WHEN stays a request');
  assert.ok(lines.includes('A1-->>A0: first response'));
  assert.ok(lines.includes('A1-->>A0: second response'), 'AND after THEN stays a response');
});

test('scenarioSequence AND following a GIVEN becomes another Note', () => {
  const scn = scenario('x', [
    step('GIVEN', 'a user exists'),
    step('AND', 'the user is an admin'),
    step('WHEN', 'they act'),
  ]);
  const lines = bodyLines(scenarioSequence(scn, requirement('R')));

  assert.ok(lines.includes('Note over A0,A1: the user is an admin'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('the user is an admin') && l.includes('>>')));
});

test('scenarioSequence marks BUT with a comment and keeps the inherited direction', () => {
  const scn = scenario('x', [step('THEN', 'it succeeds'), step('BUT', 'no email is sent')]);
  const all = scenarioSequence(scn, requirement('R'))
    .mermaid.split('\n')
    .map((l) => l.trim());

  const marker = all.indexOf('%% but');
  assert.ok(marker >= 0, 'expected a %% but marker');
  assert.equal(all[marker + 1], 'A1-->>A0: no email is sent');
});

test('scenarioSequence produces a valid diagram for a scenario with zero steps', () => {
  const lines = bodyLines(scenarioSequence(scenario('empty'), requirement('R')));

  assert.equal(lines[0], 'sequenceDiagram');
  assert.ok(lines.includes('participant A0 as User'));
  assert.ok(lines.includes('participant A1 as System'));
  assert.ok(lines.includes('Note over A0: no steps defined'));
});

test('scenarioSequence carries a title comment and autonumber', () => {
  const diagram = scenarioSequence(scenario('logs in'), requirement('User Auth'));

  assert.ok(diagram.mermaid.startsWith('%% User Auth / logs in'));
  assert.ok(bodyLines(diagram).includes('autonumber'));
  assert.equal(diagram.title, 'User Auth / logs in');
  assert.equal(diagram.kind, 'sequence');
});

// ---------------------------------------------------------------------------
// scenarioSequence — actor-as-sender routing (regression for the System-lane bug)
// ---------------------------------------------------------------------------

test('scenarioSequence routes an annotated WHEN/THEN pair directly between the two actors', () => {
  // Shipped fixture shape: openspec add-passkey-login "First passkey enrolment".
  const scn = scenario('First passkey enrolment', [
    step('GIVEN', 'a signed-in shopper with no enrolled credential'),
    step('WHEN', 'requests an enrolment challenge', 'Storefront Web'),
    step('THEN', 'returns a challenge bound to the current session', 'Auth Service'),
  ]);
  const diagram = scenarioSequence(scn, requirement('Passkey Enrolment'));

  // No phantom System lane: the two named actors are the only participants.
  assert.deepEqual(participantLines(diagram), [
    'participant A0 as Storefront Web',
    'participant A1 as Auth Service',
  ]);
  // The THEN is a reply from its actor back to the requester — not a self-arrow and
  // not routed through System.
  assert.deepEqual(messages(diagram), [
    'Storefront Web->>Auth Service: requests an enrolment challenge',
    'Auth Service-->>Storefront Web: returns a challenge bound to the current session',
  ]);
  assert.ok(!messages(diagram).some((m) => m.includes('System')), 'no System lane in messages');
});

test('scenarioSequence README case produces the canonical Agent/System source', () => {
  // GIVEN precondition, WHEN request from Agent, THEN + anonymous AND both replies
  // from the named System actor. This exact source is the README's canonical output.
  const scn = scenario('Agent receives a pending note', [
    step('GIVEN', 'a project with one open note'),
    step('WHEN', 'requests the pending notes', 'Agent'),
    step('THEN', 'returns the open notes as JSON', 'System'),
    step('AND', 'the process exits with code 0'),
  ]);
  const diagram = scenarioSequence(scn, requirement('Long-poll for open notes'));

  assert.deepEqual(participantLines(diagram), [
    'participant A0 as Agent',
    'participant A1 as System',
  ]);
  assert.deepEqual(messages(diagram), [
    'Agent->>System: requests the pending notes',
    'System-->>Agent: returns the open notes as JSON',
    'System-->>Agent: the process exits with code 0',
  ]);

  const canonical = [
    '%% Long-poll for open notes / Agent receives a pending note',
    'sequenceDiagram',
    '  autonumber',
    '  participant A0 as Agent',
    '  participant A1 as System',
    '  Note over A0,A1: a project with one open note',
    '  A0->>A1: requests the pending notes',
    '  A1-->>A0: returns the open notes as JSON',
    '  A1-->>A0: the process exits with code 0',
  ].join('\n');
  assert.equal(diagram.mermaid, canonical);
});

test('scenarioSequence falls back to User and System for an unannotated two-party flow', () => {
  const scn = scenario('x', [
    step('GIVEN', 'a form is displayed'),
    step('WHEN', 'submits the form'),
    step('THEN', 'shows a confirmation'),
  ]);
  const diagram = scenarioSequence(scn, requirement('R'));

  assert.deepEqual(participantLines(diagram), [
    'participant A0 as User',
    'participant A1 as System',
  ]);
  assert.deepEqual(messages(diagram), [
    'User->>System: submits the form',
    'System-->>User: shows a confirmation',
  ]);
});

test('scenarioSequence never invents a System lane when three actors are all annotated', () => {
  const scn = scenario('x', [
    step('WHEN', 'opens the file', 'Editor'),
    step('WHEN', 'indexes the change', 'Watcher'),
    step('WHEN', 'renders the diagram', 'Browser'),
  ]);
  const diagram = scenarioSequence(scn, requirement('R'));

  assert.deepEqual(participantLines(diagram), [
    'participant A0 as Editor',
    'participant A1 as Watcher',
    'participant A2 as Browser',
  ]);
  // Every message is between the named actors; no phantom System lane appears.
  assert.ok(!bodyLines(diagram).some((l) => l.includes('System')), 'no System lane at all');
  for (const m of messages(diagram)) {
    assert.ok(/^(Editor|Watcher|Browser)->>(Editor|Watcher|Browser): /.test(m), m);
  }
});

// ---------------------------------------------------------------------------
// requirementMap
// ---------------------------------------------------------------------------

test('requirementMap returns null when the doc has no requirements', () => {
  assert.equal(requirementMap(doc('doc:a', 'A')), null);
});

test('requirementMap links doc to requirements to scenarios', () => {
  const diagram = requirementMap(
    doc('doc:a', 'Auth', {
      requirements: [requirement('Login', [scenario('happy path'), scenario('bad password')])],
    })
  );
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.equal(lines[0], 'flowchart LR');
  assert.ok(lines.includes('D0[["Auth"]]'));
  assert.ok(lines.includes('R1["Login"]'));
  assert.ok(lines.includes('D0 --> R1'));
  assert.ok(lines.includes('S2("happy path")'));
  assert.ok(lines.includes('R1 --> S2'));
  assert.ok(lines.includes('S3("bad password")'));
  assert.ok(lines.includes('R1 --> S3'));
});

test('requirementMap applies the right classDef per delta kind', () => {
  const diagram = requirementMap(
    doc('doc:a', 'Deltas', {
      requirements: [
        requirement('New thing', [], 'ADDED', 'req:1'),
        requirement('Changed thing', [], 'MODIFIED', 'req:2'),
        requirement('Gone thing', [], 'REMOVED', 'req:3'),
        requirement('Moved thing', [], 'RENAMED', 'req:4'),
      ],
    })
  );
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(lines.includes('R1["New thing"]:::added'));
  assert.ok(lines.includes('R2["Changed thing"]:::modified'));
  assert.ok(lines.includes('R3["Gone thing"]:::removed'));
  assert.ok(lines.includes('R4["Moved thing"]:::renamed'));

  for (const cls of ['added', 'modified', 'removed', 'renamed']) {
    assert.ok(
      lines.some((l) => l.startsWith(`classDef ${cls} `)),
      `missing classDef ${cls}`
    );
  }
  const removed = lines.find((l) => l.startsWith('classDef removed'));
  assert.ok(removed?.includes('stroke-dasharray'), 'removed should be dashed');
});

test('requirementMap omits classDefs it does not use', () => {
  const diagram = requirementMap(
    doc('doc:a', 'Plain', { requirements: [requirement('No delta')] })
  );
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(!lines.some((l) => l.startsWith('classDef')));
  assert.ok(lines.includes('R1["No delta"]'));
});

// ---------------------------------------------------------------------------
// taskFlow
// ---------------------------------------------------------------------------

test('taskFlow returns null when the doc has no tasks', () => {
  assert.equal(taskFlow(doc('doc:a', 'A')), null);
});

test('taskFlow chains top-level tasks and hangs children off their parent', () => {
  const tasks = [
    task('build it', { id: 't1' }),
    task('write the test', { id: 't2', depth: 1, parentId: 't1' }),
    task('ship it', { id: 't3' }),
  ];
  const diagram = taskFlow(doc('doc:a', 'Tasks', { tasks }));
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.equal(lines[0], 'flowchart TD');
  assert.ok(lines.includes('T0 --> T1'), 'parent to child');
  assert.ok(lines.includes('T0 --> T2'), 'top-level chain skips the child');
  assert.ok(!lines.includes('T1 --> T2'));
});

test('taskFlow treats an unknown parentId as top-level rather than dropping the task', () => {
  const tasks = [task('first', { id: 't1' }), task('orphan', { id: 't2', parentId: 'nope' })];
  const diagram = taskFlow(doc('doc:a', 'Tasks', { tasks }));
  assert.ok(diagram);
  assert.ok(bodyLines(diagram).includes('T0 --> T1'));
});

test('taskFlow styles done and pending tasks differently', () => {
  const tasks = [task('done one', { id: 't1', done: true }), task('todo one', { id: 't2' })];
  const diagram = taskFlow(doc('doc:a', 'Tasks', { tasks }));
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(lines.includes('T0["✓ done one"]:::done'));
  assert.ok(lines.includes('T1["todo one"]:::todo'));
  assert.ok(lines.some((l) => l.startsWith('classDef done ')));
  assert.ok(lines.some((l) => l.startsWith('classDef todo ')));
});

test('taskFlow wraps sections in subgraphs and still chains across them', () => {
  const tasks = [
    task('a', { id: 't1', section: 'Setup' }),
    task('b', { id: 't2', section: 'Setup' }),
    task('c', { id: 't3', section: 'Teardown' }),
  ];
  const diagram = taskFlow(doc('doc:a', 'Tasks', { tasks }));
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(lines.includes('subgraph SG0["Setup"]'));
  assert.ok(lines.includes('subgraph SG1["Teardown"]'));
  assert.equal(lines.filter((l) => l === 'end').length, 2);
  assert.ok(lines.includes('T1 --> T2'), 'chain crosses the subgraph boundary');
});

test('taskFlow emits no subgraph when no task has a section', () => {
  const diagram = taskFlow(doc('doc:a', 'Tasks', { tasks: [task('a', { id: 't1' })] }));
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(!lines.some((l) => l.startsWith('subgraph')));
  assert.ok(!lines.includes('end'));
});

// ---------------------------------------------------------------------------
// groupOverview
// ---------------------------------------------------------------------------

test('groupOverview returns null for a group with fewer than two docs', () => {
  const d = doc('doc:a', 'A');
  const g = group('group:g', 'G', ['doc:a']);
  assert.equal(groupOverview(g, model([d], [g])), null);
});

test('groupOverview returns null when the group references docs that do not exist', () => {
  const g = group('group:g', 'G', ['doc:a', 'doc:missing']);
  assert.equal(groupOverview(g, model([doc('doc:a', 'A')], [g])), null);
});

test('groupOverview orders OpenSpec docs proposal, design, spec, tasks', () => {
  const docs = [
    doc('doc:tasks', 'Tasks', { kind: 'tasks' }),
    doc('doc:spec', 'Spec', { kind: 'spec' }),
    doc('doc:proposal', 'Proposal', { kind: 'proposal' }),
    doc('doc:design', 'Design', { kind: 'design' }),
  ];
  const g = group(
    'group:g',
    'Add auth',
    docs.map((d) => d.id)
  );
  const diagram = groupOverview(g, model(docs, [g], 'openspec'));
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.equal(lines[0], 'flowchart LR');
  assert.ok(lines.includes('N0["Proposal"]'));
  assert.ok(lines.includes('N1["Design"]'));
  assert.ok(lines.includes('N2["Spec"]'));
  assert.ok(lines.includes('N3["Tasks"]'));
  assert.ok(lines.includes('N0 --> N1'));
  assert.ok(lines.includes('N1 --> N2'));
  assert.ok(lines.includes('N2 --> N3'));
});

test('groupOverview orders Spec Kit docs spec, plan, tasks, other', () => {
  const docs = [
    doc('doc:other', 'Notes', { kind: 'other' }),
    doc('doc:tasks', 'Tasks', { kind: 'tasks' }),
    doc('doc:plan', 'Plan', { kind: 'plan' }),
    doc('doc:spec', 'Spec', { kind: 'spec' }),
  ];
  const g = group(
    'group:g',
    'Feature',
    docs.map((d) => d.id),
    'feature'
  );
  const diagram = groupOverview(g, model(docs, [g], 'speckit'));
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(lines.includes('N0["Spec"]'));
  assert.ok(lines.includes('N1["Plan"]'));
  assert.ok(lines.includes('N2["Tasks"]'));
  assert.ok(lines.includes('N3["Notes"]'));
});

test('groupOverview badges nodes with requirement and task counts', () => {
  const docs = [
    doc('doc:spec', 'Spec', { kind: 'spec', requirements: [requirement('One')] }),
    doc('doc:tasks', 'Tasks', {
      kind: 'tasks',
      tasks: [task('a', { id: 't1' }), task('b', { id: 't2' })],
    }),
  ];
  const g = group(
    'group:g',
    'Feature',
    docs.map((d) => d.id)
  );
  const diagram = groupOverview(g, model(docs, [g], 'speckit'));
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(lines.includes('N0["Spec<br/>1 req"]'), lines.join('\n'));
  assert.ok(lines.includes('N1["Tasks<br/>2 tasks"]'), lines.join('\n'));
});

// ---------------------------------------------------------------------------
// generateDiagrams
// ---------------------------------------------------------------------------

test('generateDiagrams emits overviews, then maps, then task flows, then sequences', () => {
  const specDoc = doc('doc:spec', 'Spec', {
    kind: 'spec',
    // Two message arrows so the sequence clears the derived-noise floor.
    requirements: [
      requirement('Login', [scenario('happy', [step('WHEN', 'x'), step('THEN', 'y')])]),
    ],
  });
  const tasksDoc = doc('doc:tasks', 'Tasks', { kind: 'tasks', tasks: [task('a', { id: 't1' })] });
  const g = group('group:g', 'Add auth', ['doc:spec', 'doc:tasks']);
  const diagrams = generateDiagrams(model([specDoc, tasksDoc], [g]));

  assert.deepEqual(
    diagrams.map((d) => d.kind),
    ['overview', 'requirement-map', 'task-flow', 'sequence']
  );
});

test('generateDiagrams skips docs with nothing to draw', () => {
  assert.deepEqual(generateDiagrams(model([doc('doc:empty', 'Empty')])), []);
});

test('generateDiagrams produces unique ids even when anchors slug to the same value', () => {
  // `a/b.md` and `a-b.md` both slug to `doc-a-b-md`, so their diagram ids collide.
  const one = doc('doc:a/b.md', 'One', { requirements: [requirement('R1', [], undefined, 'r1')] });
  const two = doc('doc:a-b.md', 'Two', { requirements: [requirement('R2', [], undefined, 'r2')] });
  const ids = generateDiagrams(model([one, two])).map((d) => d.id);

  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
  assert.ok(
    ids.some((id) => id.endsWith('-2')),
    `expected an ordinal suffix in ${ids.join(', ')}`
  );
});

test('generateDiagrams anchors every diagram at the object it describes', () => {
  // Two message arrows so the sequence clears the derived-noise floor.
  const scn = scenario('happy', [step('WHEN', 'x'), step('THEN', 'y')], 'scn:happy');
  const req = requirement('Login', [scn], undefined, 'req:login');
  const d = doc('doc:spec', 'Spec', { requirements: [req], tasks: [task('a', { id: 't1' })] });
  const byKind = new Map(generateDiagrams(model([d])).map((x) => [x.kind, x]));

  assert.equal(byKind.get('requirement-map')?.anchor, 'doc:spec');
  assert.equal(byKind.get('task-flow')?.anchor, 'doc:spec');
  assert.equal(byKind.get('sequence')?.anchor, 'scn:happy');
});

test('generateDiagrams suppresses a sequence for a <2-message scenario but keeps a real one', () => {
  // A GIVEN-only precondition renders zero arrows; a single lone WHEN renders one —
  // neither is worth a chart. Only the WHEN/THEN scenario clears the 2-arrow floor.
  const givenOnly = scenario(
    'setup',
    [step('GIVEN', 'a user exists'), step('AND', 'is admin')],
    'scn:given'
  );
  const loneWhen = scenario('poke', [step('WHEN', 'acts')], 'scn:lone');
  const real = scenario('exchange', [step('WHEN', 'asks'), step('THEN', 'answers')], 'scn:real');
  const d = doc('doc:spec', 'Spec', {
    requirements: [requirement('R', [givenOnly, loneWhen, real], undefined, 'req:r')],
  });

  const seqAnchors = generateDiagrams(model([d]))
    .filter((x) => x.kind === 'sequence')
    .map((x) => x.anchor);
  assert.deepEqual(seqAnchors, ['scn:real'], 'only the multi-message scenario draws a sequence');
});

// ---------------------------------------------------------------------------
// hostile input + structural sanity
// ---------------------------------------------------------------------------

test('hostile requirement and scenario names round-trip into intact Mermaid', () => {
  const nasty = 'He said "stop" #now\n[urgent] (really) {json} 50% `code`; end';
  // Two message steps so the sequence survives the derived-noise floor and its
  // escaping is exercised alongside the map/overview/task-flow diagrams below.
  const scn = scenario(
    nasty,
    [step('WHEN', nasty, nasty), step('THEN', nasty, nasty)],
    'scn:nasty'
  );
  const req = requirement(nasty, [scn], 'ADDED', 'req:nasty');
  const d = doc('doc:nasty', nasty, {
    requirements: [req],
    tasks: [task(nasty, { id: 't1', section: nasty })],
  });
  const other = doc('doc:other', nasty, { kind: 'tasks' });
  const g = group('group:nasty', nasty, ['doc:nasty', 'doc:other']);
  const diagrams = generateDiagrams(model([d, other], [g]));

  assert.ok(diagrams.length > 0);
  for (const diagram of diagrams) {
    const raw = diagram.mermaid;
    // No raw metacharacter survives anywhere in the emitted source...
    assert.ok(!raw.includes('"stop"'), `unescaped quotes in ${diagram.id}`);
    assert.ok(!raw.includes('[urgent]'), `unescaped brackets in ${diagram.id}`);
    assert.ok(!raw.includes('(really)'), `unescaped parens in ${diagram.id}`);
    assert.ok(!raw.includes('{json}'), `unescaped braces in ${diagram.id}`);
    assert.ok(!raw.includes('#now'), `unescaped hash in ${diagram.id}`);
    assert.ok(!raw.includes('`code`'), `unescaped backtick in ${diagram.id}`);
    // ...no stray statement separator or comment opener survives outside an entity
    // (the leading `%%` of our own comment lines is stripped first)...
    const withoutEntities = raw
      .split('\n')
      .map((l) => l.trim().replace(/^%%/, ''))
      .join('\n')
      .replace(/#(?:\d+|quot);/g, '');
    assert.ok(!withoutEntities.includes(';'), `bare semicolon in ${diagram.id}`);
    assert.ok(!withoutEntities.includes('%'), `bare percent in ${diagram.id}`);
    // ...and every label stays on one line with balanced quoting.
    for (const line of raw.split('\n')) {
      const quotes = (line.match(/"/g) ?? []).length;
      assert.equal(quotes % 2, 0, `unbalanced quotes in ${diagram.id}: ${line}`);
    }
  }
});

test('a hostile name cannot inject a Mermaid directive through the title comment', () => {
  const diagram = scenarioSequence(scenario('x'), requirement('%%{init: {"theme":"dark"}}%%'));
  assert.ok(!diagram.mermaid.includes('%%{'), diagram.mermaid);
});

test('every emitted diagram starts with a valid Mermaid header after its comments', () => {
  const scn = scenario('happy path', [
    step('GIVEN', 'a user'),
    step('WHEN', 'they log in', 'Alice'),
    step('THEN', 'they see the dashboard'),
    step('BUT', 'no email is sent'),
  ]);
  const specDoc = doc('doc:spec', 'Spec', {
    kind: 'spec',
    requirements: [requirement('Login', [scn], 'ADDED', 'req:login')],
  });
  const tasksDoc = doc('doc:tasks', 'Tasks', {
    kind: 'tasks',
    tasks: [
      task('parent', { id: 't1', section: 'Setup' }),
      task('child', { id: 't2', depth: 1, parentId: 't1', section: 'Setup', done: true }),
    ],
  });
  const g = group('group:g', 'Add auth', ['doc:spec', 'doc:tasks']);
  const diagrams = generateDiagrams(model([specDoc, tasksDoc], [g]));

  assert.ok(diagrams.length >= 4);
  for (const diagram of diagrams) {
    const raw = diagram.mermaid.split('\n');
    const headerAt = raw.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith('%%'));
    assert.ok(headerAt >= 0, `${diagram.id} has no header at all`);
    const header = raw[headerAt];
    assert.ok(
      header !== undefined && /^(sequenceDiagram|flowchart (LR|TD|TB|RL|BT))$/.test(header.trim()),
      `${diagram.id} starts with ${String(header)}`
    );
    // Anything before the header must be a Mermaid comment.
    for (const line of raw.slice(0, headerAt)) {
      assert.ok(line.trim().startsWith('%%'), `non-comment preamble in ${diagram.id}: ${line}`);
    }
  }
});

// ---------------------------------------------------------------------------
// requirementHeatMap
// ---------------------------------------------------------------------------

test('requirementHeatMap returns null when the doc has no requirements', () => {
  assert.equal(requirementHeatMap(doc('doc:a', 'A'), []), null);
});

test('requirementHeatMap id and title differ from the plain requirement map', () => {
  const d = doc('doc:a', 'Auth', { requirements: [requirement('Login')] });
  const plain = requirementMap(d);
  const heat = requirementHeatMap(d, []);
  assert.ok(plain && heat);
  assert.notEqual(plain.id, heat.id);
  assert.notEqual(plain.title, heat.title);
  // The kind is reused (the union is fixed) but the anchor is disambiguated.
  assert.equal(heat.kind, 'requirement-map');
  assert.notEqual(plain.anchor, heat.anchor);
});

test('requirementHeatMap tints a requirement by the worst verdict on it or its scenarios', () => {
  const happy = scenario('happy', [], 'scn:happy');
  const sad = scenario('sad', [], 'scn:sad');
  const req = requirement('Login', [happy, sad], undefined, 'req:login');
  const d = doc('doc:a', 'Auth', { requirements: [req] });
  const diagram = requirementHeatMap(d, [
    stamp('req:login', 'understood'),
    stamp('scn:happy', 'blocking'),
    stamp('scn:sad', 'concern'),
  ]);
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.equal(lines[0], 'flowchart LR');
  // The requirement rolls up to the worst of {understood, blocking, concern} = blocking.
  assert.ok(lines.includes('R1["! Login"]:::blocking'), lines.join('\n'));
  // Each scenario reflects only its own verdict.
  assert.ok(lines.includes('S2("! happy"):::blocking'), lines.join('\n'));
  assert.ok(lines.includes('S3("? sad"):::concern'), lines.join('\n'));
  // blocking is styled red and dashed; concern is emitted; understood is not a node
  // state anywhere (the requirement rolled past it) so its classDef is omitted.
  assert.ok(
    lines.some((l) => l.startsWith('classDef blocking ') && l.includes('stroke-dasharray')),
    'blocking should be dashed'
  );
  assert.ok(lines.some((l) => l.startsWith('classDef concern ')));
  assert.ok(!lines.some((l) => l.startsWith('classDef understood ')));
});

test('requirementHeatMap ranks approved above understood and marks understood with a middot', () => {
  const calm = scenario('calm', [], 'scn:calm');
  const risky = scenario('risky', [], 'scn:risky');
  const req = requirement('R', [calm, risky], undefined, 'req:r');
  const d = doc('doc:a', 'A', { requirements: [req] });
  const diagram = requirementHeatMap(d, [
    stamp('scn:calm', 'understood'),
    stamp('scn:risky', 'approved'),
  ]);
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  // approved (severity 2) outranks understood (1), so the requirement takes approved.
  assert.ok(lines.includes('R1["✓ R"]:::approved'), lines.join('\n'));
  assert.ok(lines.includes('S2("· calm"):::understood'), lines.join('\n'));
  assert.ok(lines.includes('S3("✓ risky"):::approved'), lines.join('\n'));
});

test('requirementHeatMap leaves unstamped nodes grey with no marker', () => {
  const req = requirement('Plain', [scenario('sc', [], 'scn:sc')], undefined, 'req:plain');
  const d = doc('doc:a', 'A', { requirements: [req] });
  const diagram = requirementHeatMap(d, []);
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(lines.includes('R1["Plain"]:::unreviewed'), lines.join('\n'));
  assert.ok(lines.includes('S2("sc"):::unreviewed'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('classDef unreviewed ')));
  // No marker glyph leaks into any label, and only the grey classDef is emitted.
  assert.ok(!/[!?✓·]/.test(diagram.mermaid), diagram.mermaid);
  assert.ok(!lines.some((l) => /classDef (blocking|concern|approved|understood) /.test(l)));
});

test('requirementHeatMap ignores stamps whose anchor matches nothing in the doc', () => {
  const req = requirement('R', [], undefined, 'req:r');
  const d = doc('doc:a', 'A', { requirements: [req] });
  const diagram = requirementHeatMap(d, [stamp('req:elsewhere', 'blocking')]);
  assert.ok(diagram);
  const lines = bodyLines(diagram);

  assert.ok(lines.includes('R1["R"]:::unreviewed'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes(':::blocking')));
});

// ---------------------------------------------------------------------------
// blastDiagram
// ---------------------------------------------------------------------------

test('blastDiagram emphasises the root node with a thick-bordered class', () => {
  const graph = bgraph(
    'req:root',
    [bnode('req:root', 'requirement', 'Root req'), bnode('scn:child', 'scenario', 'Child')],
    [bedge('req:root', 'scn:child', 'structural')]
  );
  const diagram = blastDiagram(graph);
  const lines = bodyLines(diagram);

  assert.equal(lines[0], 'flowchart LR');
  assert.ok(lines.includes('B0["Root req"]:::root'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.startsWith('B1') && l.includes(':::root')));
  const rootDef = lines.find((l) => l.startsWith('classDef root '));
  assert.ok(rootDef?.includes('stroke-width:3px'), String(rootDef));
  assert.equal(diagram.kind, 'overview');
});

test('blastDiagram draws structural edges solid and inferred edges dashed', () => {
  const graph = bgraph(
    'req:a',
    [
      bnode('req:a', 'requirement', 'A'),
      bnode('scn:b', 'scenario', 'B'),
      bnode('req:c', 'requirement', 'C'),
    ],
    [bedge('req:a', 'scn:b', 'structural'), bedge('req:a', 'req:c', 'inferred')]
  );
  const lines = bodyLines(blastDiagram(graph));

  assert.ok(lines.includes('B0 --> B1'), lines.join('\n'));
  assert.ok(lines.includes('B0 -.-> B2'), lines.join('\n'));
});

test('blastDiagram shapes each node by its type', () => {
  const graph = bgraph('req:r', [
    bnode('req:r', 'requirement', 'Req'),
    bnode('scn:s', 'scenario', 'Scn'),
    bnode('task:t', 'task', 'Task'),
    bnode('doc:d', 'doc', 'Doc'),
    bnode('con:c', 'constitution', 'Clause'),
  ]);
  const lines = bodyLines(blastDiagram(graph));

  assert.ok(lines.includes('B0["Req"]:::root'), lines.join('\n')); // requirement = rectangle
  assert.ok(lines.includes('B1("Scn")'), 'scenario = rounded'); // scenario = rounded
  assert.ok(lines.includes('B2(["Task"])'), 'task = stadium'); // task = stadium
  assert.ok(lines.includes('B3[["Doc"]]'), 'doc = subroutine'); // doc = subroutine
  assert.ok(lines.includes('B4{{"Clause"}}'), 'constitution = hexagon'); // constitution = hexagon
});

test('blastDiagram renders a valid single-node flowchart for a root-only graph', () => {
  const diagram = blastDiagram(bgraph('req:solo', [bnode('req:solo', 'requirement', 'Solo')]));
  const lines = bodyLines(diagram);

  assert.equal(lines[0], 'flowchart LR');
  assert.ok(lines.includes('B0["Solo"]:::root'));
  assert.ok(lines.some((l) => l.startsWith('classDef root ')));
  assert.ok(!lines.some((l) => l.includes('-->')));
});

test('blastDiagram renders a valid flowchart even for a node-less graph', () => {
  const diagram = blastDiagram({ root: 'req:gone', nodes: [], edges: [] });
  const lines = bodyLines(diagram);

  assert.equal(lines[0], 'flowchart LR');
  assert.ok(lines.includes('B0["(empty)"]'), lines.join('\n'));
});

test('blastDiagram drops an edge that names an undeclared node', () => {
  const graph = bgraph(
    'req:a',
    [bnode('req:a', 'requirement', 'A')],
    [bedge('req:a', 'ghost', 'structural')]
  );
  const lines = bodyLines(blastDiagram(graph));

  assert.ok(!lines.some((l) => l.includes('-->')), lines.join('\n'));
});

test('blastDiagram escapes labels and never uses spec text as a node id', () => {
  const nasty = 'He said "stop" [x] (y) {z} 50% `c`; end';
  const graph = bgraph(
    'req:n',
    [bnode('req:n', 'requirement', nasty), bnode('scn:m', 'scenario', nasty)],
    [bedge('req:n', 'scn:m', 'inferred')]
  );
  const raw = blastDiagram(graph).mermaid;

  assert.ok(!raw.includes('"stop"'), raw);
  assert.ok(!raw.includes('[x]'), raw);
  assert.ok(!raw.includes('(y)'), raw);
  assert.ok(!raw.includes('{z}'), raw);
  assert.ok(!raw.includes('`c`'), raw);
  // Node ids are generated ordinals, never the raw model ids.
  assert.ok(!raw.includes('scn:m'), raw);
  assert.ok(raw.includes('B0'), raw);
  assert.ok(raw.includes('B1'), raw);
  // Every emitted line keeps balanced quoting.
  for (const line of raw.split('\n')) {
    assert.equal((line.match(/"/g) ?? []).length % 2, 0, `unbalanced quotes: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// validateAuthoredMermaid
// ---------------------------------------------------------------------------

test('validateAuthoredMermaid accepts a well-formed state diagram with 3+ states', () => {
  const src = [
    'stateDiagram-v2',
    '  [*] --> Draft',
    '  Draft --> Review: submit',
    '  Review --> Published: approve',
    '  Review --> Draft: reject',
    '  Published --> [*]',
  ].join('\n');
  assert.deepEqual(validateAuthoredMermaid(src, 'state'), { ok: true });
});

test('validateAuthoredMermaid accepts a well-formed er diagram with 3+ entities', () => {
  const src = [
    'erDiagram',
    '  CUSTOMER ||--o{ ORDER : places',
    '  ORDER ||--|{ LINE_ITEM : contains',
    '  CUSTOMER {',
    '    string name',
    '  }',
  ].join('\n');
  assert.deepEqual(validateAuthoredMermaid(src, 'er'), { ok: true });
});

test('validateAuthoredMermaid accepts a well-formed sequence diagram (ignoring leading %% comments)', () => {
  const src = [
    '%% endpoint: POST /enrol',
    'sequenceDiagram',
    '  participant A as Storefront Web',
    '  participant B as Auth Service',
    '  participant C as Credential Store',
    '  A->>B: request challenge',
    '  B->>C: persist challenge',
  ].join('\n');
  assert.deepEqual(validateAuthoredMermaid(src, 'sequence'), { ok: true });
});

test('validateAuthoredMermaid rejects a body whose header is wrong for the type', () => {
  const res = validateAuthoredMermaid('flowchart LR\n  A --> B --> C', 'sequence');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /sequenceDiagram/);
});

test('validateAuthoredMermaid rejects a 2-node diagram as too trivial to draw', () => {
  const src = [
    'sequenceDiagram',
    '  participant A as Alice',
    '  participant B as Bob',
    '  A->>B: hi',
  ].join('\n');
  const res = validateAuthoredMermaid(src, 'sequence');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /2 distinct nodes|earns its place/);
});

test('validateAuthoredMermaid rejects empty or whitespace-only source', () => {
  const res = validateAuthoredMermaid('   \n\n  ', 'state');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /empty/i);
});

test('validateAuthoredMermaid rejects a hairball above the 24-node ceiling', () => {
  const participants = Array.from({ length: 25 }, (_, i) => `  participant P${i} as Node ${i}`);
  const src = ['sequenceDiagram', ...participants, '  P0->>P1: go'].join('\n');
  const res = validateAuthoredMermaid(src, 'sequence');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /25 distinct nodes|Split it/);
});
