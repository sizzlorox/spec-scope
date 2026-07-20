# Spec formats

What spec-scope actually recognises, dialect by dialect. This is the reference to extend from when
you add support for another format — see
[CONTRIBUTING.md](../CONTRIBUTING.md#adding-support-for-another-spec-dialect).

Two things to hold onto while reading:

1. **The parser is line-oriented and regex-driven**, not a Markdown AST walk. Every rule below is a
   pattern matched against a single trimmed line. This is a deliberate ceiling — spec Markdown is a
   narrow, heading-driven dialect, a line scanner is easy to extend and debug, and it yields accurate
   line numbers for anchoring notes.
2. **Everything lands in the same model** (`src/types.ts`). Both dialects produce `Requirement`,
   `Scenario`, `Step` and `Task` objects. That's why every diagram generator works on every dialect
   for free, and why widening the model to fit a new dialect is the one expensive change.

## Detection

`detectProject()` walks upward from the given directory looking for these markers, first match wins:

| Marker                       | Flavor     | Directories scanned                             |
| ---------------------------- | ---------- | ----------------------------------------------- |
| `openspec/` directory exists | `openspec` | `openspec/`                                     |
| `.specify/` directory exists | `speckit`  | `specs/`, `.specify/memory/`                    |
| Neither                      | `unknown`  | `specs/` if it exists, else the given directory |

`unknown` is not a failure. spec-scope still parses any Markdown it finds using the union of both
grammars — you get less structure, but a directory of loose spec files still renders.

If both markers exist, `openspec` wins. Adding a marker for a third dialect means adding a row here
and a case to `SpecFlavor`.

---

## OpenSpec

### Layout

```
openspec/
  project.md                       # kind: other — project conventions
  specs/
    <capability>/
      spec.md                      # kind: spec — the current, agreed truth
      design.md                    # kind: design
  changes/
    <change-id>/
      proposal.md                  # kind: proposal
      tasks.md                     # kind: tasks
      design.md                    # kind: design
      specs/
        <capability>/
          spec.md                  # kind: spec — deltas against the capability
    archive/
      <change-id>/                 # same shape; SpecGroup.archived = true
```

| Directory                               | `SpecGroup.kind`           |
| --------------------------------------- | -------------------------- |
| `openspec/specs/<capability>/`          | `capability`               |
| `openspec/changes/<change-id>/`         | `change`                   |
| `openspec/changes/archive/<change-id>/` | `change`, `archived: true` |
| Files directly under `openspec/`        | `root`                     |

### Requirement headings

A level-3 heading with a `Requirement:` prefix. The prefix is stripped; the rest is the name.

```markdown
### Requirement: Long-poll for open notes
```

→ `Requirement { name: 'Long-poll for open notes', line: <n> }`

The prefix match is case-insensitive and tolerates a missing space after the colon. A `###` heading
_without_ the prefix is treated as prose and does not create a requirement — this matters because
real spec files use `###` for ordinary sub-sections.

Prose between a requirement heading and its first scenario becomes `Requirement.text`. It's kept for
the UI to render; nothing is parsed out of it.

### Delta markers

Level-2 headings in a change's `specs/**/spec.md` declare what the change does to the capability.
Every requirement under one of these headings inherits its `DeltaKind` until the next level-2 heading.

```markdown
## ADDED Requirements

### Requirement: Long-poll for open notes

...

## MODIFIED Requirements

### Requirement: Note anchoring

...
```

| Heading                    | `DeltaKind` |
| -------------------------- | ----------- |
| `## ADDED Requirements`    | `ADDED`     |
| `## MODIFIED Requirements` | `MODIFIED`  |
| `## REMOVED Requirements`  | `REMOVED`   |
| `## RENAMED Requirements`  | `RENAMED`   |

Matching is case-insensitive on the keyword and the trailing word `Requirements` is optional.
Requirements in a capability's own `spec.md` — outside any change — have **no** `delta`; they're the
current state, not a diff.

### Scenario headings

A level-4 heading with a `Scenario:` prefix, belonging to the most recent requirement.

```markdown
#### Scenario: Agent receives a pending note
```

A scenario appearing before any requirement heading is recorded as a warning in
`SpecModel.warnings` and attached to a synthetic requirement, so the content still renders rather
than vanishing.

### Scenario steps

List items whose first content is a bolded Gherkin keyword. Bullet marker may be `-`, `*` or `+`.

```markdown
- **GIVEN** a project with one open note
- **WHEN** Agent: requests the pending notes
- **THEN** System: returns the open notes as JSON
- **AND** the process exits with code 0
- **BUT** no notes are marked resolved
```

Recognised keywords are `GIVEN`, `WHEN`, `THEN`, `AND`, `BUT` (`StepKeyword`). Matching is
case-insensitive; the bold markers may be `**` or `__`, and a trailing colon after the keyword is
absorbed. A list item that doesn't start with a recognised keyword is not a step — it stays prose.

`AND` and `BUT` inherit the direction of the preceding keyword when rendered. They are stored as
themselves, not rewritten to the keyword they continue, so the model stays faithful to the source.

### Actor annotation

**This is the convention worth learning**, because it's the difference between a two-lane diagram and
a useful one.

```markdown
- **WHEN** Agent: requests the pending notes
```

A short, name-like head, followed by a colon, immediately after the keyword. The head becomes
`Step.actor` and a participant in the generated sequence diagram; the remainder becomes `Step.text`.

`extractActor` splits on the **first** colon and accepts the head only when every one of these holds:

- The colon is within the first 40 characters. A colon further in reads as prose punctuation.
- The head starts with an uppercase letter **or a digit** (`2FA Service` is fine; `the agent` is not).
- The head is at most four words.
- The head contains no `.`, `,`, `;`, `!`, `?`, `/`, `` ` ``, `*`, `_`, `[`, `]`, `(` or `)`.
- The remainder after the colon is non-empty and does not start with `//` (so `https://…` is not
  mistaken for an actor named `https`).

Recognised — one, two, three, and four-word heads, and a digit-leading head:

```markdown
- **WHEN** Agent: requests the pending notes
- **THEN** Review Server: writes the note to disk
- **WHEN** CLI: exits with code 0
- **WHEN** 2FA Service: sends a code
- **WHEN** Four Word Actor Name: acts
```

Not recognised — no actor is extracted and the whole thing stays as `text`:

```markdown
- **WHEN** the agent requests the pending notes ← no colon
- **WHEN** the agent: requests the notes ← head is lowercase
- **THEN** returns: the open notes as JSON ← head is lowercase
- **WHEN** Auth, Service: does a thing ← head contains punctuation (`,`)
- **WHEN** Five Word Actor Name Here: acts ← head is more than four words
- **WHEN** The Long Running Background Reconciliation Worker Process: starts ← colon past column 40
```

The heuristic is deliberately narrow and positional, not semantic. It does not attempt to find actors
in free prose, and it never will — there is no NLP here.

When a step has no actor, the sequence generator falls back to two generic participants: `User` for
`GIVEN`/`WHEN`, `System` for `THEN`. An unannotated scenario still produces a readable diagram; it
just won't discover that your spec is really about three services.

Because the annotation is plain Markdown, it stays readable to humans and to every other tool that
reads your specs. It is not a spec-scope directive.

---

## Spec Kit

### Layout

```
.specify/
  memory/
    constitution.md                # kind: constitution
specs/
  001-review-loop/                 # NNN-slug — SpecGroup.kind = 'feature'
    spec.md                        # kind: spec
    plan.md                        # kind: plan
    tasks.md                       # kind: tasks
    research.md                    # kind: research
    data-model.md                  # kind: other  (basename not in the map)
    quickstart.md                  # kind: other
    contracts/                     # kind: other  (only the basename is classified)
```

Feature directories are matched as **three or more leading digits, a separator, then a slug**
(`001-review-loop`, `042-export-techdoc`). The numeric prefix orders groups; the slug becomes the
group name with dashes turned into spaces. A directory under `specs/` that doesn't match the pattern
is still parsed, but ordered last.

`.specify/memory/constitution.md` is parsed as a `root` group — it's project-wide, not part of any
one feature.

### Functional requirements

Requirements are recognised as **headings**, in two ways:

1. Any level-2-or-deeper heading with a `Requirement:` prefix — the same rule as OpenSpec, and it
   works in a Spec Kit file too:

   ```markdown
   ### Requirement: Long-poll for open notes
   ```

2. Any level-3 heading **directly under** a level-2 requirements section. The section heading must be
   `Requirements`, `Functional Requirements`, `Non-functional Requirements` or `Technical Requirements`
   (the trailing `Requirements` is required; the leading word is optional). Under such a section the
   whole heading text becomes the requirement name, so a Spec Kit `FR-NNN` heading works:

   ```markdown
   ## Functional Requirements

   ### FR-001: Long-poll for open notes
   ```

   → `Requirement { name: 'FR-001: Long-poll for open notes' }`. The `FR-001` is kept verbatim at the
   front of the name — it's how people refer to these in conversation, and dropping it would make
   anchors unreadable.

The section gate matters: a `### FR-001: …` heading that is **not** under one of those level-2
sections is treated as an ordinary sub-heading and does not become a requirement. Section names
outside that set — `## Success Criteria`, for example — do not enable the rule.

### User stories

A heading beginning with `User Story` becomes a `Requirement`:

```markdown
## User Scenarios & Testing

### User Story 1 - Agent polls for review notes (Priority: P1)

An agent that has just written a spec waits for a human to review it before implementing.
```

→ `Requirement { name: 'User Story 1 - Agent polls for review notes' }`. The `User Story N -` prefix
is **kept**; only a trailing `(Priority: PN)` suffix is **stripped**. (The heading level is not
constrained to 3 — the rule fires on any heading whose text starts with `User Story`.)

Spec Kit's "as a … I want …" bullet is also recognised as a requirement: a list item matching
`As a <role>, I want <goal>[, so that …]` yields `Requirement { name: '<Goal>' }` — the `I want`
prefix and any `so that` tail are dropped and the goal is capitalised.

```markdown
- As a reviewer, I want to attach a note to any requirement, so that the agent can fix it.
```

→ `Requirement { name: 'Attach a note to any requirement' }`.

### Acceptance scenarios

Steps are recognised **one keyword per line**: a bullet (`-`, `*`, `+`) or ordered (`1.`) list item
whose content starts with a single Gherkin keyword becomes one `Step`. This is the same step grammar
as OpenSpec — Spec Kit just tends to place the bullets under a story rather than under a
`#### Scenario:` heading, so when steps appear with no scenario open, spec-scope synthesises a
scenario named `Acceptance` to hold them:

```markdown
### User Story 1 - Agent polls for review notes (Priority: P1)

- **WHEN** Agent: polls for notes
- **THEN** System: returns the open notes as JSON
```

→ a scenario `Acceptance` with a `WHEN` step (actor `Agent`) and a `THEN` step (actor `System`). The
per-clause actor annotation works exactly as in the OpenSpec section.

`[NEEDS CLARIFICATION: ...]` markers are left in the text verbatim and rendered by the UI. They mark
exactly the thing a reviewer should be leaving a note on, so hiding them would be backwards.

---

## Shared: task checklists

Both dialects use GitHub task-list syntax in `tasks.md`, and spec-scope parses them identically.

```markdown
## 1. Parsing

- [x] 1.1 Recognise `### Requirement:` headings
- [x] 1.2 Recognise `#### Scenario:` headings
- [ ] 1.3 Extract actor annotations
  - [ ] 1.3.1 Handle multi-word actors
  - [ ] 1.3.2 Reject lowercase leading tokens

## 2. Diagrams

- [ ] 2.1 Sequence chart from scenario steps
```

| Source                                                   | Model                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `- [x]` / `- [X]`                                        | `Task.done = true`                                                           |
| `- [ ]`, or any other single-char box (`- [~]`, `- [P]`) | `Task.done = false` — still a task, just not done                            |
| Leading indent                                           | `Task.depth`, 0 for top-level (2 spaces or 1 tab per level)                  |
| Nesting                                                  | `Task.parentId` → the nearest shallower task                                 |
| Nearest preceding heading                                | `Task.section`                                                               |
| Remaining text                                           | `Task.text` — checkbox removed, emphasis unwrapped, leading task id stripped |

A checkbox is any single character between the brackets; only `x`/`X` counts as done, so `- [~]` and
`- [P]` still render as (undone) tasks rather than being skipped.

Spec Kit prefixes tasks with a `TNNN` id and inline `[P]` / `[US1]` markers:

```markdown
- [ ] T001 [P] Set up the fixture directory
- [ ] T002 [P] [US1] Parse requirement headings
```

The leading `TNNN` (or `TASK-N`) id **is stripped** from `Task.text` — it is positional metadata, and
the model already carries a positional id (below) — leaving `[P] Set up the fixture directory` and
`[P] [US1] Parse requirement headings`. The `[P]` parallel and `[US1]` story markers are **kept**, as
is a numeric outline id like `1.1`; those carry meaning the id does not. Bold/italic emphasis in the
text is unwrapped.

Task ids are positional — `taskId(docId, index)` — because checklist entries have no stable name.
This is the one place the id scheme is deliberately not name-derived; see
[architecture.md](./architecture.md#the-id-scheme).

---

## Document classification

`classifyDoc(relPath)` maps a path to a `DocKind`. Pure function of the relative path — no file
contents are read. It matches on the **exact basename** (case-insensitive), not a substring:

| Basename          | `DocKind`      |
| ----------------- | -------------- |
| `constitution.md` | `constitution` |
| `spec.md`         | `spec`         |
| `proposal.md`     | `proposal`     |
| `plan.md`         | `plan`         |
| `tasks.md`        | `tasks`        |
| `design.md`       | `design`       |
| `research.md`     | `research`     |
| anything else     | `other`        |

Because the match is on the whole filename, `data-model.md`, `contracts/api.md` and even `myspec.md`
are all `other` — only `design.md` maps to `design`. There is one fallback applied after the table: a
file under `openspec/specs/` whose basename is not listed is classified `spec` (it's a capability spec
named after its capability rather than `spec.md`). The basename table still wins, so
`openspec/specs/auth/design.md` is `design`, while `openspec/specs/auth/auth.md` is `spec`.

---

## What is deliberately ignored

### Fenced code blocks

Content inside ``` or ~~~ fences is **never parsed as spec syntax**. This is not an optimisation, it
is a correctness requirement: a proposal that documents the heading grammar would otherwise generate
phantom requirements from its own examples. This document would parse as a spec.

Fence tracking handles the usual cases — a fence closes only on a matching or longer run of the same
character, so nested examples work. Indented (four-space) code blocks are also skipped when they
follow a blank line.

### Inline code

Backticked spans are left as literal text. A `` `### Requirement: X` `` mid-sentence is prose.

### Directories

Never walked, at any depth:

```
node_modules/   .git/   dist/   build/   out/   coverage/   .next/   .cache/   .spec-scope/
```

Any directory whose name starts with `.` is skipped, with the single exception of `.specify/`, which
is a Spec Kit marker. (The `.` rule already covers `.git/`, `.next/`, `.cache/` and `.spec-scope/`;
they are named explicitly in `EXCLUDED_DIRS` as well.)

### Files

- Anything that isn't `.md` or `.markdown`.
- Symlinks are not followed. This keeps a symlink loop from hanging the walk and stops a crafted spec
  tree from reading files outside the project root.

### Markdown that isn't spec structure

Tables, images, block quotes, footnotes, front matter — all preserved verbatim in `SpecDoc.markdown`
and rendered by the UI, none of it parsed into the model. spec-scope extracts structure; it does not
reimplement Markdown. (Raw HTML blocks are the exception — the scanner does not track them, so a
heading inside one is still parsed. See [Not yet supported](#not-yet-supported).)

### YAML front matter

Recognised and skipped so it doesn't pollute the first requirement's prose, but no fields are read
from it. If a dialect needs front-matter metadata, that's a model change — raise it in an issue
first.

---

## Not yet supported

These forms show up in real specs, but the current parser does **not** handle them. They are recorded
here so the gap is documented rather than surprising — each is a candidate for a future change, not a
promise.

- **Inline `Given … When … Then` on one line.** A numbered acceptance line such as
  `1. **Given** a project…, **When** the agent polls, **Then** the note is returned` is **not** split
  into three steps. The step grammar matches on the leading keyword only, so the line becomes a single
  `GIVEN` step whose text is the rest of the sentence. Write one keyword per line to get distinct
  steps.
- **The `- **FR-001**:` requirement bullet.** A bolded `FR-NNN` identifier in a _list item_ is not
  modelled as a requirement — it renders from the verbatim Markdown like any other prose. Spec Kit
  `FR-NNN` requirements are recognised only as headings under a requirements section (see
  [Functional requirements](#functional-requirements)).
- **Setext (underline) headings.** Only ATX headings (`#`, `##`, …) are recognised. A title underlined
  with `===` or `---` is not seen as a heading, so a `Requirement: X` written that way is prose.
- **Raw HTML blocks.** The scanner does not track HTML blocks, so it neither renders them specially
  nor shields their contents: a `### Requirement:` line sitting _inside_ a `<div>…</div>` is still
  parsed as a requirement. Keep spec structure out of raw HTML.

---

## Adding a dialect

The short version of the [contributing guide](../CONTRIBUTING.md#adding-support-for-another-spec-dialect):

1. Add the detection marker to `detectProject()` and the flavor to `SpecFlavor`.
2. Teach `classifyDoc()` the dialect's filenames.
3. Extend `parseMarkdown()` with the heading and step grammar.
4. Add `test/fixtures/<flavor>-basic/` and assert on the parsed model.
5. Document it here, at the same depth as the dialects above.

The constraint that matters: **map onto the existing model.** If a dialect appears to need a new
field on `Requirement`, `Scenario`, `Step` or `Task`, open an issue before writing code — widening
the shared model touches every diagram generator, the web UI and the exporter simultaneously, and
it's the only change in this codebase that isn't cheap.
