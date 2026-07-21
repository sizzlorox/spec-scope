/**
 * Spec Kit dialect coverage — the `US-N` user-story heading and the
 * `- **FR-NNN**:` bullet requirement form used by the canonical Spec Kit
 * template, which real projects (unlike the checked-in fixture) use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkdown } from '../src/parse.js';

test('recognises a `US-N — Title (P1)` user story as a requirement', () => {
  const doc = parseMarkdown(
    [
      '# Feature',
      '',
      '## User Stories',
      '',
      '### US-1 — Quick Code Access (P1)',
      '',
      'A user grabs a code.',
      '',
    ].join('\n'),
    'specs/003-otp/spec.md'
  );
  assert.equal(doc.requirements.length, 1);
  assert.equal(doc.requirements[0]?.name, 'US-1 — Quick Code Access', 'priority suffix stripped');
});

test('does not treat an ordinary word like "Usage" as a user story', () => {
  const doc = parseMarkdown(
    ['# Feature', '', '### Usage notes', '', 'Some prose.', ''].join('\n'),
    'a/spec.md'
  );
  assert.equal(doc.requirements.length, 0);
});

test('parses `- **FR-NNN**:` bullets under a requirements section', () => {
  const doc = parseMarkdown(
    [
      '# Feature',
      '',
      '## Functional Requirements',
      '',
      '- **FR-001**: System MUST capture notifications.',
      '- **FR-002**: System MUST extract the code.',
      '',
      '## Data Model',
      '',
      '- Not a requirement.',
      '',
    ].join('\n'),
    'specs/005-locale/spec.md'
  );
  assert.equal(doc.requirements.length, 2);
  assert.equal(doc.requirements[0]?.name, 'FR-001', 'the id is the requirement name');
  assert.equal(
    doc.requirements[0]?.text,
    'System MUST capture notifications.',
    'the statement is the requirement text'
  );
  // The bullet under `## Data Model` is not a requirements section, so it is ignored.
  assert.ok(!doc.requirements.some((r) => r.name.includes('Not a requirement')));
});

test('tolerates the `## Requirements *(mandatory)*` template annotation', () => {
  const doc = parseMarkdown(
    [
      '# Feature',
      '',
      '## Requirements *(mandatory)*',
      '',
      '- **FR-001**: System MUST do the thing.',
      '',
    ].join('\n'),
    'specs/001-mvp/spec.md'
  );
  assert.equal(doc.requirements.length, 1);
  assert.equal(doc.requirements[0]?.name, 'FR-001');
});

test('an `**AB-12**:` bullet outside a requirements section is not a requirement', () => {
  const doc = parseMarkdown(
    ['# Feature', '', '## Notes', '', '- **AB-12**: just a labelled note.', ''].join('\n'),
    'a/spec.md'
  );
  assert.equal(doc.requirements.length, 0);
});
