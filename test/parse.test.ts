/**
 * Parser tests.
 *
 * Expectations here are counted by hand from the fixtures, not captured from a
 * previous run. A test that only records what the parser happens to do today
 * cannot tell you the heuristics regressed tomorrow.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { detectProject } from '../src/detect.js';
import { classifyDoc, parseMarkdown, parseProject } from '../src/parse.js';
import type { Requirement, SpecDoc, SpecModel } from '../src/types.js';

// Tests execute from `dist/test/`; fixtures are never copied there.
const OPENSPEC_DIR = fileURLToPath(
  new URL('../../test/fixtures/openspec-project', import.meta.url)
);
const SPECKIT_DIR = fileURLToPath(new URL('../../test/fixtures/speckit-project', import.meta.url));

function doc(model: SpecModel, relPath: string): SpecDoc {
  const found = model.docs.find((d) => d.path === relPath);
  assert.ok(
    found,
    `expected a document at ${relPath}, saw ${model.docs.map((d) => d.path).join(', ')}`
  );
  return found;
}

function requirement(source: SpecDoc, name: string): Requirement {
  const found = source.requirements.find((r) => r.name === name);
  assert.ok(found, `expected requirement "${name}" in ${source.path}`);
  return found;
}

const openspecModel = await parseProject(OPENSPEC_DIR);
const speckitModel = await parseProject(SPECKIT_DIR);

describe('detectProject', () => {
  it('recognises an OpenSpec project and scans only openspec/', async () => {
    const result = await detectProject(OPENSPEC_DIR);
    assert.equal(result.flavor, 'openspec');
    assert.equal(result.specDirs.length, 1);
    assert.ok(result.specDirs[0]?.endsWith('openspec'));
  });

  it('recognises a Spec Kit project and scans specs/ plus .specify/memory/', async () => {
    const result = await detectProject(SPECKIT_DIR);
    assert.equal(result.flavor, 'speckit');
    const tails = result.specDirs.map((d) => d.split(/[\\/]/).slice(-2).join('/'));
    assert.deepEqual(tails, ['speckit-project/specs', '.specify/memory']);
  });

  it('walks up from a nested directory to the project root', async () => {
    const nested = fileURLToPath(
      new URL('../../test/fixtures/openspec-project/openspec/specs/auth', import.meta.url)
    );
    const result = await detectProject(nested);
    assert.equal(result.flavor, 'openspec');
    assert.equal(result.root, OPENSPEC_DIR);
  });

  it('falls back to unknown without inventing a flavor', async () => {
    // Deliberately outside the repo: a directory inside it would inherit any
    // `openspec/` or `specs/` folder spec-scope later grows for its own specs,
    // and this test would start passing for the wrong reason.
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-scope-unknown-'));
    try {
      await writeFile(path.join(dir, 'README.md'), '# Loose Notes\n\n- nothing structured here\n');
      const result = await detectProject(dir);
      assert.equal(result.flavor, 'unknown');
      assert.deepEqual(result.specDirs, [result.root]);

      const model = await parseProject(dir);
      assert.equal(model.flavor, 'unknown');
      assert.deepEqual(
        model.docs.map((d) => d.path),
        ['README.md']
      );
      assert.equal(model.docs[0]?.title, 'Loose Notes');
      assert.deepEqual(
        model.groups.map((g) => g.kind),
        ['root']
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('classifyDoc', () => {
  it('maps every known basename to its role', () => {
    assert.equal(classifyDoc('openspec/changes/x/spec.md'), 'spec');
    assert.equal(classifyDoc('openspec/changes/x/proposal.md'), 'proposal');
    assert.equal(classifyDoc('specs/001-x/plan.md'), 'plan');
    assert.equal(classifyDoc('specs/001-x/tasks.md'), 'tasks');
    assert.equal(classifyDoc('openspec/changes/x/design.md'), 'design');
    assert.equal(classifyDoc('openspec/changes/x/research.md'), 'research');
    assert.equal(classifyDoc('.specify/memory/constitution.md'), 'constitution');
  });

  it('defaults files under openspec/specs/ to spec, everything else to other', () => {
    assert.equal(classifyDoc('openspec/specs/auth/overview.md'), 'spec');
    assert.equal(classifyDoc('openspec/specs/auth/notes.md'), 'spec');
    assert.equal(classifyDoc('openspec/project.md'), 'other');
    assert.equal(classifyDoc('docs/whatever.md'), 'other');
  });

  it('normalises Windows separators before classifying', () => {
    assert.equal(classifyDoc('openspec\\specs\\auth\\overview.md'), 'spec');
    assert.equal(classifyDoc('specs\\001-x\\tasks.md'), 'tasks');
  });
});

describe('OpenSpec project', () => {
  it('reads every spec file and nothing outside openspec/', () => {
    assert.equal(openspecModel.flavor, 'openspec');
    assert.deepEqual(
      openspecModel.docs.map((d) => d.path),
      [
        'openspec/changes/add-passkey-login/design.md',
        'openspec/changes/add-passkey-login/proposal.md',
        'openspec/changes/add-passkey-login/specs/auth/spec.md',
        'openspec/changes/add-passkey-login/tasks.md',
        'openspec/changes/archive/add-email-signin/proposal.md',
        'openspec/changes/archive/add-email-signin/specs/auth/spec.md',
        'openspec/project.md',
        'openspec/specs/auth/spec.md',
      ]
    );
  });

  it('groups changes, capabilities and loose files, archived last', () => {
    assert.deepEqual(
      openspecModel.groups.map((g) => [g.kind, g.path, g.archived, g.docIds.length]),
      [
        ['root', '', false, 1],
        ['change', 'openspec/changes/add-passkey-login', false, 4],
        ['capability', 'openspec/specs/auth', false, 1],
        ['change', 'openspec/changes/archive/add-email-signin', true, 2],
      ]
    );
  });

  it('names an archived change after the change, never after the archive bucket', () => {
    const archived = openspecModel.groups.find((g) => g.archived);
    assert.equal(archived?.name, 'add-email-signin');
  });

  it('points every document back at the group that owns it', () => {
    for (const group of openspecModel.groups) {
      for (const id of group.docIds) {
        const owned = openspecModel.docs.find((d) => d.id === id);
        assert.equal(owned?.groupId, group.id, `${owned?.path} should belong to ${group.path}`);
      }
    }
  });

  it('does not double-count requirements in a spec that also has a "## Requirements" heading', () => {
    // The regression this guards: OpenSpec capability specs carry BOTH a
    // `## Requirements` section heading and `### Requirement: X` entries. Running
    // the Spec Kit "plain ### under a Requirements section" rule alongside the
    // OpenSpec rule counts each requirement twice.
    const spec = doc(openspecModel, 'openspec/specs/auth/spec.md');
    assert.match(
      spec.markdown,
      /^## Requirements$/m,
      'fixture must keep the "## Requirements" heading or this guard proves nothing'
    );
    assert.deepEqual(
      spec.requirements.map((r) => r.name),
      ['Password Sign-In', 'Session Expiry', 'Sign Out']
    );
    assert.equal(spec.title, 'Auth Specification');
    assert.equal(spec.kind, 'spec');
  });

  it('attaches scenarios to the requirement that opened them', () => {
    const spec = doc(openspecModel, 'openspec/specs/auth/spec.md');
    assert.deepEqual(
      spec.requirements.map((r) => r.scenarios.length),
      [2, 1, 1]
    );
    assert.deepEqual(
      requirement(spec, 'Password Sign-In').scenarios.map((s) => s.name),
      ['Valid credentials', 'Wrong password']
    );
  });

  it('keeps the prose between a requirement heading and its first scenario', () => {
    const spec = doc(openspecModel, 'openspec/specs/auth/spec.md');
    const req = requirement(spec, 'Password Sign-In');
    assert.match(req.text, /^Shoppers MUST be able to sign in/);
    assert.match(req.text, /never stored or logged\.$/);
    assert.ok(!req.text.includes('Scenario'), 'requirement text must stop at the first scenario');
  });

  it('reads bold, bare and mixed step keywords', () => {
    const spec = doc(openspecModel, 'openspec/specs/auth/spec.md');
    const bold = requirement(spec, 'Password Sign-In').scenarios[0];
    assert.deepEqual(
      bold?.steps.map((s) => s.keyword),
      ['GIVEN', 'WHEN', 'THEN', 'AND']
    );

    const bare = requirement(spec, 'Session Expiry').scenarios[0];
    assert.deepEqual(
      bare?.steps.map((s) => s.keyword),
      ['GIVEN', 'WHEN', 'THEN']
    );
    assert.equal(bare?.steps[0]?.text, 'a session whose last request was 15 days ago');

    const negated = requirement(spec, 'Password Sign-In').scenarios[1];
    assert.equal(negated?.steps[3]?.keyword, 'BUT');
  });

  it('splits "Actor: does thing" into actor and text', () => {
    const spec = doc(openspecModel, 'openspec/specs/auth/spec.md');
    const steps = requirement(spec, 'Password Sign-In').scenarios[0]?.steps ?? [];
    assert.equal(steps[1]?.actor, 'Storefront Web');
    assert.equal(steps[1]?.text, 'submits a matching email and password');
    assert.equal(steps[2]?.actor, 'Auth Service');
    assert.equal(steps[2]?.text, 'issues a session token valid for 30 days');
    assert.equal(steps[0]?.actor, undefined);
    assert.equal(steps[3]?.actor, undefined);
  });

  it('records 1-based line numbers that point at the real source lines', () => {
    const spec = doc(openspecModel, 'openspec/specs/auth/spec.md');
    const lines = spec.markdown.split(/\r?\n/);
    for (const req of spec.requirements) {
      assert.match(lines[req.line - 1] ?? '', /^### Requirement: /);
      for (const scenario of req.scenarios) {
        assert.match(lines[scenario.line - 1] ?? '', /^#### Scenario: /);
        for (const step of scenario.steps) {
          assert.match(lines[step.line - 1] ?? '', /^[-*]\s/);
        }
      }
    }
  });

  it('carries the OpenSpec delta marker onto each requirement below it', () => {
    const delta = doc(openspecModel, 'openspec/changes/add-passkey-login/specs/auth/spec.md');
    assert.deepEqual(
      delta.requirements.map((r) => [r.name, r.delta]),
      [
        ['Passkey Enrolment', 'ADDED'],
        ['Passkey Sign-In', 'ADDED'],
        ['Session Expiry', 'MODIFIED'],
        ['Password Sign-In', 'REMOVED'],
        ['Credential Revocation', 'RENAMED'],
      ]
    );
  });

  it('leaves delta undefined on a plain capability spec', () => {
    const spec = doc(openspecModel, 'openspec/specs/auth/spec.md');
    for (const req of spec.requirements) assert.equal(req.delta, undefined);
  });
});

describe('code fences', () => {
  it('ignores requirements, scenarios, steps and tasks inside fenced blocks', () => {
    // design.md quotes a whole authored delta inside ``` and ~~~ fences. If the
    // fence tracker breaks, this document sprouts requirements and tasks.
    const design = doc(openspecModel, 'openspec/changes/add-passkey-login/design.md');
    assert.equal(design.requirements.length, 0);
    assert.equal(design.tasks.length, 0);
    assert.ok(design.markdown.includes('Fenced Decoy'), 'fixture must still contain the decoy');
    assert.ok(
      design.markdown.includes('Tilde Decoy'),
      'fixture must still contain the tilde decoy'
    );
  });

  it('ignores a fenced block sitting inside a live requirements section', () => {
    const plan = doc(speckitModel, 'specs/001-passkey-login/plan.md');
    assert.ok(
      plan.markdown.includes('### FR-999: Fenced Decoy Requirement'),
      'fixture must keep the fenced decoy or this guard proves nothing'
    );
    const names = plan.requirements.map((r) => r.name);
    assert.ok(!names.some((n) => n.includes('999')), `fenced decoy leaked: ${names.join(', ')}`);
    assert.equal(plan.tasks.length, 0, 'a fenced checklist item is not a task');
  });

  it('closes a fence only on its own marker', () => {
    const md = [
      '# Fences',
      '',
      '~~~text',
      '```',
      '### Requirement: Still Fenced',
      '```',
      '~~~',
      '',
      '### Requirement: Real One',
    ].join('\n');
    const parsed = parseMarkdown(md, 'openspec/specs/x/spec.md');
    assert.deepEqual(
      parsed.requirements.map((r) => r.name),
      ['Real One']
    );
  });
});

describe('tasks', () => {
  const tasks = () => doc(openspecModel, 'openspec/changes/add-passkey-login/tasks.md').tasks;

  it('reads -, * and numbered checklist markers', () => {
    assert.equal(tasks().length, 11);
  });

  it('records done state from [x] only', () => {
    assert.deepEqual(
      tasks().map((t) => t.done),
      [true, true, false, false, false, false, false, false, false, false, false]
    );
  });

  it('derives depth from indentation and parentId from the nearest shallower task', () => {
    const all = tasks();
    assert.deepEqual(
      all.map((t) => t.depth),
      [0, 1, 1, 0, 0, 1, 1, 2, 0, 0, 0]
    );
    assert.equal(all[0]?.parentId, undefined);
    assert.equal(all[1]?.parentId, all[0]?.id);
    assert.equal(all[2]?.parentId, all[0]?.id);
    assert.equal(all[3]?.parentId, undefined, 'dedenting to 0 must clear the parent');
    assert.equal(all[5]?.parentId, all[4]?.id);
    assert.equal(all[7]?.parentId, all[6]?.id, 'depth 2 hangs off the nearest depth 1');
    assert.equal(all[8]?.parentId, undefined, 'a numbered item at depth 0 has no parent');
  });

  it('labels each task with the nearest preceding heading', () => {
    assert.deepEqual(
      tasks().map((t) => t.section),
      [
        '1. Data Model',
        '1. Data Model',
        '1. Data Model',
        '1. Data Model',
        '2. Registration Flow',
        '2. Registration Flow',
        '2. Registration Flow',
        '2. Registration Flow',
        '2. Registration Flow',
        '3. Sign-In Flow',
        '3. Sign-In Flow',
      ]
    );
  });

  it('strips the task id and bold wrappers but keeps the sentence readable', () => {
    const all = tasks();
    assert.equal(all[0]?.text, 'Add the `credential` table migration');
    assert.equal(all[1]?.text, 'Columns: account id, public key, sign count, created at');
    assert.equal(all[8]?.text, 'Ship the account security page');
  });

  it('counts a tab as one nesting level', () => {
    const md = [
      '# Tabs',
      '- [ ] T001 root',
      '\t- [ ] T002 child',
      '\t\t- [x] T003 grandchild',
    ].join('\n');
    const parsed = parseMarkdown(md, 'tasks.md');
    assert.deepEqual(
      parsed.tasks.map((t) => t.depth),
      [0, 1, 2]
    );
    assert.equal(parsed.tasks[2]?.parentId, parsed.tasks[1]?.id);
    assert.equal(parsed.tasks[2]?.done, true);
  });

  it('accepts any single-character checkbox marker and treats non-x as undone', () => {
    // FIX 6: `CHECKBOX_RE` used to accept only `[ xX]`, so `- [~]` produced no
    // task at all. Any single non-`]` marker is now a checkbox; only x/X is done.
    const parsed = parseMarkdown(
      '# T\n\n- [~] in progress\n- [P] parallel\n- [] empty bracket\n- [X] shipped\n',
      'tasks.md'
    );
    assert.deepEqual(
      parsed.tasks.map((t) => [t.text, t.done]),
      [
        ['in progress', false],
        ['parallel', false],
        ['shipped', true],
      ]
    );
  });

  it('does not treat a multi-character bracket as a checkbox', () => {
    const parsed = parseMarkdown('# T\n\n- [PP] two chars\n- [ ] T001 a task\n', 'tasks.md');
    assert.deepEqual(
      parsed.tasks.map((t) => t.text),
      ['a task']
    );
  });
});

describe('Spec Kit project', () => {
  it('reads specs/ and .specify/memory/ into feature and root groups', () => {
    assert.equal(speckitModel.flavor, 'speckit');
    assert.deepEqual(
      speckitModel.groups.map((g) => [g.kind, g.path, g.docIds.length]),
      [
        ['root', '', 1],
        ['feature', 'specs/001-passkey-login', 3],
      ]
    );
  });

  it('treats user story headings and FR headings as requirements', () => {
    const spec = doc(speckitModel, 'specs/001-passkey-login/spec.md');
    assert.deepEqual(
      spec.requirements.map((r) => r.name),
      [
        'User Story 1 - Enrol a passkey',
        'User Story 2 - Sign in with a passkey',
        'FR-001: Passkey Enrolment',
        'FR-002 Passkey Sign-In',
        'Credential Revocation',
      ]
    );
  });

  it('stops treating ### headings as requirements once the section ends', () => {
    // `## Key Entities` follows `## Requirements`; `### Credential` under it is a
    // data note, not a requirement.
    const spec = doc(speckitModel, 'specs/001-passkey-login/spec.md');
    const names = spec.requirements.map((r) => r.name);
    assert.ok(!names.includes('Credential'), 'Key Entities leaked into requirements');
    assert.ok(!names.includes('Enrolment Challenge'));
  });

  it('folds acceptance-criteria bullets into an implicit Acceptance scenario', () => {
    const spec = doc(speckitModel, 'specs/001-passkey-login/spec.md');
    const story = requirement(spec, 'User Story 1 - Enrol a passkey');
    assert.deepEqual(
      story.scenarios.map((s) => s.name),
      ['Acceptance']
    );
    assert.deepEqual(
      story.scenarios[0]?.steps.map((s) => s.keyword),
      ['GIVEN', 'WHEN', 'THEN', 'AND']
    );
    assert.equal(story.scenarios[0]?.steps[1]?.text, 'the shopper chooses "Add a passkey"');
  });

  it('keeps the As-a sentence as requirement prose, not as a second requirement', () => {
    const spec = doc(speckitModel, 'specs/001-passkey-login/spec.md');
    const story = requirement(spec, 'User Story 1 - Enrol a passkey');
    assert.match(story.text, /^As a returning shopper, I want to register a passkey/);
    assert.match(
      story.text,
      /storefront again\.$/,
      'the dangling "**Acceptance Criteria**" label must be dropped'
    );
  });

  it('keeps a bold label that still has prose after it', () => {
    const md = [
      '# X',
      '## User Story 1 - Something',
      '',
      '**Note**',
      '',
      'This sentence follows the label, so the label is not dangling.',
      '',
      '- Given a thing',
    ].join('\n');
    const req = parseMarkdown(md, 'specs/001-x/spec.md').requirements[0];
    assert.match(req?.text ?? '', /\*\*Note\*\*/);
    assert.match(req?.text ?? '', /not dangling\.$/);
  });

  it('turns an As-a bullet into a requirement named for the want', () => {
    const plan = doc(speckitModel, 'specs/001-passkey-login/plan.md');
    assert.deepEqual(
      plan.requirements.map((r) => r.name),
      [
        'Reuse a passkey across my devices',
        'Revoke a lost passkey for a shopper',
        'Rate Limiting',
        'Audit Logging',
      ]
    );
  });

  it('leaves a constitution as prose', () => {
    const constitution = doc(speckitModel, '.specify/memory/constitution.md');
    assert.equal(constitution.kind, 'constitution');
    assert.equal(constitution.requirements.length, 0, 'numbered principles are not requirements');
    assert.equal(constitution.tasks.length, 0);
  });

  it('does not read a phase heading that mentions a user story as a user story', () => {
    const tasks = doc(speckitModel, 'specs/001-passkey-login/tasks.md');
    assert.equal(tasks.requirements.length, 0, '"## Phase 3: User Story 1 …" is not a requirement');
    assert.equal(tasks.tasks.length, 8);
  });
});

describe('duplicate slugs', () => {
  it('suffixes colliding requirement ids instead of overwriting them', () => {
    const spec = doc(openspecModel, 'openspec/changes/archive/add-email-signin/specs/auth/spec.md');
    const colliding = spec.requirements.filter((r) => r.id.includes('sign-in-rate-limiting'));
    assert.equal(colliding.length, 2, 'both spellings must survive');
    assert.ok(colliding[0]?.id.endsWith('/req:sign-in-rate-limiting'));
    assert.ok(colliding[1]?.id.endsWith('/req:sign-in-rate-limiting-2'));
    assert.notEqual(colliding[0]?.id, colliding[1]?.id);
  });

  it('suffixes colliding scenario ids inside one requirement', () => {
    const md = [
      '# Dup',
      '### Requirement: Thing',
      '#### Scenario: Same Name',
      '- WHEN a thing happens',
      '#### Scenario: same name',
      '- WHEN it happens again',
    ].join('\n');
    const parsed = parseMarkdown(md, 'openspec/specs/x/spec.md');
    const scenarios = parsed.requirements[0]?.scenarios ?? [];
    assert.equal(scenarios.length, 2);
    assert.ok(scenarios[0]?.id.endsWith('/scn:same-name'));
    assert.ok(scenarios[1]?.id.endsWith('/scn:same-name-2'));
  });

  it('keeps every id in the model unique', () => {
    for (const model of [openspecModel, speckitModel]) {
      const ids = new Set<string>();
      for (const d of model.docs) {
        for (const r of d.requirements) {
          assert.ok(!ids.has(r.id), `duplicate requirement id ${r.id}`);
          ids.add(r.id);
          for (const s of r.scenarios) {
            assert.ok(!ids.has(s.id), `duplicate scenario id ${s.id}`);
            ids.add(s.id);
          }
        }
        for (const t of d.tasks) {
          assert.ok(!ids.has(t.id), `duplicate task id ${t.id}`);
          ids.add(t.id);
        }
      }
    }
  });
});

describe('warnings', () => {
  it('reports a duplicate slug and an empty scenario without dropping either', () => {
    const spec = doc(openspecModel, 'openspec/changes/archive/add-email-signin/specs/auth/spec.md');
    assert.equal(spec.requirements.length, 3, 'the flawed document still parses in full');

    const empty = requirement(spec, 'Email Magic Link').scenarios.find((s) => s.steps.length === 0);
    assert.equal(empty?.name, 'Bounced address', 'the stepless scenario is kept, not discarded');

    assert.ok(
      openspecModel.warnings.some((w) => w.includes('Bounced address') && w.includes('no steps')),
      `expected a stepless-scenario warning, got: ${openspecModel.warnings.join(' | ')}`
    );
    assert.ok(
      openspecModel.warnings.some((w) => w.includes('sign-in-rate-limiting')),
      `expected a duplicate-slug warning, got: ${openspecModel.warnings.join(' | ')}`
    );
  });

  it('stays quiet about a clean project', () => {
    assert.deepEqual(speckitModel.warnings, []);
  });
});

describe('parseMarkdown edge cases', () => {
  it('falls back to a prettified basename when a document has no # heading', () => {
    const parsed = parseMarkdown(
      '## Not a title\n\ntext\n',
      'openspec/changes/add-passkey-login.md'
    );
    assert.equal(parsed.title, 'Add Passkey Login');
  });

  it('accepts italic and colon-suffixed keywords', () => {
    const md = [
      '# X',
      '### Requirement: Styles',
      '#### Scenario: Mixed',
      '- *GIVEN* an italic keyword',
      '- __WHEN__ an underscored keyword',
      '- **THEN:** a colon inside the bold',
      '- AND: a bare keyword with a colon',
    ].join('\n');
    const steps = parseMarkdown(md, 'spec.md').requirements[0]?.scenarios[0]?.steps ?? [];
    assert.deepEqual(
      steps.map((s) => s.keyword),
      ['GIVEN', 'WHEN', 'THEN', 'AND']
    );
    assert.equal(steps[3]?.text, 'a bare keyword with a colon');
  });

  it('does not treat a word merely starting with a keyword as a step', () => {
    const md = [
      '# X',
      '### Requirement: Prefixes',
      '#### Scenario: Words',
      '- Whenever the job runs it retries',
      '- Butter is not a keyword',
      '- WHEN a real step runs',
    ].join('\n');
    const steps = parseMarkdown(md, 'spec.md').requirements[0]?.scenarios[0]?.steps ?? [];
    assert.deepEqual(
      steps.map((s) => s.text),
      ['a real step runs']
    );
  });

  it('refuses an actor prefix that is too long, too wordy, or a URL scheme', () => {
    const md = [
      '# X',
      '### Requirement: Actors',
      '#### Scenario: Guards',
      '- **WHEN** Payment Service: charges the card',
      '- **THEN** the shopper waits for the confirmation email: which arrives later',
      '- **AND** see https://example.test for the full list',
      '- **BUT** Averyveryverylongsingletokenwithnospacesatallhere: still not an actor',
      '- **GIVEN** a step that ends a clause, then: continues',
    ].join('\n');
    const steps = parseMarkdown(md, 'spec.md').requirements[0]?.scenarios[0]?.steps ?? [];
    assert.equal(steps[0]?.actor, 'Payment Service');
    assert.equal(steps[1]?.actor, undefined, 'a five-word prefix is prose, not an actor');
    assert.equal(steps[2]?.actor, undefined, 'a URL scheme is not an actor');
    assert.equal(steps[3]?.actor, undefined, 'a colon past column 40 is not an actor');
    assert.equal(steps[4]?.actor, undefined, 'a prefix with inner punctuation is not an actor');
  });

  it('adopts a scenario found before any requirement into a synthetic requirement', () => {
    // FIX 5: an orphan scenario used to be dropped (requirements stayed empty).
    // It is now attached to a synthetic "(unattached)" requirement so it still renders.
    const parsed = parseMarkdown('# X\n\n#### Scenario: Orphan\n\n- WHEN nothing\n', 'spec.md');
    assert.equal(parsed.requirements.length, 1);
    assert.equal(parsed.requirements[0]?.name, '(unattached)');
    assert.deepEqual(
      parsed.requirements[0]?.scenarios.map((s) => s.name),
      ['Orphan']
    );
    assert.equal(parsed.requirements[0]?.scenarios[0]?.steps[0]?.text, 'nothing');
  });

  it('handles CRLF line endings', () => {
    const md =
      '# X\r\n\r\n### Requirement: Windows\r\n\r\n#### Scenario: CRLF\r\n\r\n- WHEN a file has CRLF\r\n';
    const parsed = parseMarkdown(md, 'openspec/specs/x/spec.md');
    assert.equal(parsed.requirements[0]?.name, 'Windows');
    assert.equal(parsed.requirements[0]?.scenarios[0]?.steps[0]?.text, 'a file has CRLF');
  });

  it('preserves the original markdown verbatim', () => {
    const md = '# Kept\r\n\r\n\ttrailing whitespace   \n';
    assert.equal(parseMarkdown(md, 'x.md').markdown, md);
  });
});

describe('reproduced parser fixes', () => {
  it('FIX 1: skips a four-space indented code block after a blank line', () => {
    // Without indented-code tracking, the indented `- [ ]` lines below become
    // real tasks. The block spans several lines, so the fix must survive the
    // second line (whose previous line is not blank).
    const md = [
      '# Doc',
      '',
      'Here is an example of the checklist syntax:',
      '',
      '    - [ ] T001 a fake task',
      '    - [ ] T002 another fake task',
      '',
      'Real prose resumes here.',
    ].join('\n');
    const parsed = parseMarkdown(md, 'tasks.md');
    assert.equal(parsed.tasks.length, 0, 'indented example must not sprout tasks');
  });

  it('FIX 1: skips a tab-indented example after a blank line', () => {
    // A tab-indented `- [ ]` after a blank line is a code block, not a task.
    const md = ['# Doc', '', 'Example:', '', '\t- [ ] T001 fake tab task', '', 'Prose again.'].join(
      '\n'
    );
    const parsed = parseMarkdown(md, 'tasks.md');
    assert.equal(parsed.tasks.length, 0, 'tab-indented example must not sprout a task');
  });

  it('FIX 1: still parses a nested list item indented after a blank line', () => {
    // A list is open at a shallower indent, so the indented line is nested list
    // content, not a code block.
    const md = ['# Tasks', '- [ ] T001 parent', '', '    - [ ] T002 child'].join('\n');
    const parsed = parseMarkdown(md, 'tasks.md');
    assert.deepEqual(
      parsed.tasks.map((t) => t.text),
      ['parent', 'child']
    );
    assert.equal(parsed.tasks[1]?.parentId, parsed.tasks[0]?.id);
  });

  it('FIX 2: a deep sub-heading under ## Requirements is not a requirement', () => {
    const md = [
      '# Doc',
      '## Requirements',
      '### Requirement: Real One',
      '',
      'Prose about the requirement.',
      '',
      '##### Implementation notes',
      '',
      'These notes are not a requirement.',
    ].join('\n');
    const parsed = parseMarkdown(md, 'openspec/specs/x/spec.md');
    assert.deepEqual(
      parsed.requirements.map((r) => r.name),
      ['Real One']
    );
  });

  it('FIX 3: refuses a lowercase actor head but keeps a capitalised one', () => {
    const md = [
      '# X',
      '### Requirement: Actors',
      '#### Scenario: Prose actors',
      '- **WHEN** the agent: requests the pending notes',
      '- **THEN** returns: the open notes as JSON',
      '- **GIVEN** Agent: polls for notes',
    ].join('\n');
    const steps = parseMarkdown(md, 'spec.md').requirements[0]?.scenarios[0]?.steps ?? [];
    assert.equal(steps[0]?.actor, undefined, 'a lowercase "the agent" head is prose');
    assert.equal(steps[0]?.text, 'the agent: requests the pending notes');
    assert.equal(steps[1]?.actor, undefined, 'a lowercase "returns" head is prose');
    assert.equal(steps[2]?.actor, 'Agent');
    assert.equal(steps[2]?.text, 'polls for notes');
  });

  it('FIX 4: disambiguates colliding document ids so requirement ids stay unique', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-scope-collide-'));
    try {
      await mkdir(path.join(dir, 'auth'));
      const body = '# T\n\n### Requirement: Shared Name\n\nprose\n';
      await writeFile(path.join(dir, 'auth', 'spec.md'), body);
      await writeFile(path.join(dir, 'auth-spec.md'), body);

      const model = await parseProject(dir);
      const a = doc(model, 'auth/spec.md');
      const b = doc(model, 'auth-spec.md');
      assert.notEqual(a.id, b.id, 'colliding slugs must not share a document id');
      const reqA = requirement(a, 'Shared Name');
      const reqB = requirement(b, 'Shared Name');
      assert.notEqual(
        reqA.id,
        reqB.id,
        'the disambiguated doc id must cascade into requirement ids'
      );
      assert.ok(
        model.warnings.some((w) => w.includes('reassigned')),
        `expected a collision warning, got: ${model.warnings.join(' | ')}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('FIX 5: records a warning for a scenario found before any requirement', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-scope-orphan-'));
    try {
      await writeFile(
        path.join(dir, 'spec.md'),
        '# X\n\n#### Scenario: Orphan\n\n- WHEN nothing happens\n'
      );
      const model = await parseProject(dir);
      assert.ok(
        model.warnings.some((w) => w.includes('unattached')),
        `expected an unattached-scenario warning, got: ${model.warnings.join(' | ')}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('FIX 6: strips a leading BOM before finding the title', () => {
    const parsed = parseMarkdown('﻿# BOM Title\n\ntext\n', 'x.md');
    assert.equal(parsed.title, 'BOM Title');
  });

  it('FIX 6: skips YAML front matter and keeps line numbers correct', () => {
    const md = [
      '---',
      '# a yaml comment, not the title',
      'title: Real',
      '---',
      '# Actual Title',
      '',
      '### Requirement: After Front Matter',
    ].join('\n');
    const parsed = parseMarkdown(md, 'openspec/specs/x/spec.md');
    assert.equal(parsed.title, 'Actual Title');
    assert.equal(parsed.requirements[0]?.name, 'After Front Matter');
    assert.equal(
      parsed.requirements[0]?.line,
      7,
      'line numbers must survive the skipped front matter'
    );
  });

  it('FIX 6: parses .markdown files, not only .md', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-scope-ext-'));
    try {
      await writeFile(path.join(dir, 'notes.markdown'), '# Markdown Ext\n\ntext\n');
      const model = await parseProject(dir);
      assert.deepEqual(
        model.docs.map((d) => d.path),
        ['notes.markdown']
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('FIX 6: skips build outputs and dot-directories while walking', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-scope-excluded-'));
    try {
      await writeFile(path.join(dir, 'README.md'), '# Keep me\n');
      for (const skip of ['build', 'out', 'coverage', '.next', '.cache', '.hidden']) {
        await mkdir(path.join(dir, skip));
        await writeFile(path.join(dir, skip, 'ignored.md'), '# Ignore me\n');
      }
      const model = await parseProject(dir);
      assert.deepEqual(
        model.docs.map((d) => d.path),
        ['README.md']
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('FIX 6: keeps a trailing # that belongs to the heading text', () => {
    const kept = parseMarkdown('### Requirement: Support C#\n', 'spec.md');
    assert.equal(kept.requirements[0]?.name, 'Support C#');
    const closed = parseMarkdown('### Requirement: Trimmed ###\n', 'spec.md');
    assert.equal(
      closed.requirements[0]?.name,
      'Trimmed',
      'a real ATX close sequence is still stripped'
    );
  });
});
