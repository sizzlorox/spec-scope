# The review layer

The base tool renders a spec and lets you leave notes on it. The **review layer** adds the part a spec
usually buries: the _why_. It surfaces plain-language explanations, captured decisions, a glossary, and
per-requirement review verdicts — and it does so **honestly**, which is the whole design.

## The one rule: nothing invented is shown as fact

spec-scope has no language model of its own. It never calls an API and never writes prose. Every
explanation is produced by the **AI agent already in your loop** — the one that wrote the spec — and
carries a **provenance** flag that the UI and the exported doc always show:

| Provenance | Meaning                                                             | Shown as                           |
| ---------- | ------------------------------------------------------------------- | ---------------------------------- |
| `grounded` | Restates spec text or a resolved discussion thread, with a citation | A plain summary, cited             |
| `inferred` | The agent's reading of intent the text does not state outright      | A claim, marked as one, disputable |
| `unstated` | The rationale genuinely isn't recorded anywhere                     | An **open question**, never a fact |

The third state is the point. When the agent can't ground a rationale, it does **not** invent one — it
records an `unstated` gap, which the UI surfaces as an open question for a human to answer. Absence of
rationale becomes an input to the review, not a fabrication.

Explanations also **go stale, not silently wrong**. Each one stores a hash of the spec text it explains
(`src/hash.ts`). When the spec changes under it, the hash stops matching and the explanation is marked
stale instead of presenting an out-of-date paraphrase as current.

## What the layer gives you

- **Plain Layer** — a one- or two-sentence plain-language companion beside each requirement and
  scenario, never replacing the formal text. A "Plain mode" toggle makes the companions primary; the
  formal text is always one click away.
- **Scenario narration** — each `GIVEN`/`WHEN`/`THEN` scenario read as a short story, with the step
  list hover-synced to the generated sequence diagram (hover a step, its message arrow highlights). A
  trivial scenario — fewer than two message arrows — is now rendered as prose rather than a two-box chart.
- **Authored diagrams** — a state machine for an entity's lifecycle, an ER diagram for a data model, an
  endpoint sequence: the higher-value diagrams the agent authors when a structure earns one (spec-scope
  validates and renders them, it does not draw them). The rubric — whether, which type, and at what
  altitude — is in [diagrams](./diagrams.md).
- **Decision Ledger** — what was chosen, what was traded away, and the receipt. Each decision links
  back to the requirement or discussion thread it came from.
- **Review stamps** — a verdict per requirement (`understood` / `concern` / `blocking` / `approved`),
  rolled up into a heat signal so you can see where no one has looked yet. `blocking` is loud.
- **Blast radius** — select a requirement and see what a change to it reaches: scenarios and tasks
  (solid, structural edges) and lexically-related requirements (dashed, a guess, drawn as a guess).
- **What changed** — OpenSpec `ADDED`/`MODIFIED`/`REMOVED`/`RENAMED` deltas rendered as prose with the
  before/after quoted. It never claims a magnitude it can't see ("no prior text is recorded" when true).
- **Glossary** — domain terms with definitions, plus a lint: a term the spec uses but never defines is
  flagged as an open question, not given an invented meaning.
- **Story Export** — `spec-scope export` leads with the plain overview, the decision ledger, and the
  open questions, then the diagrams and the full spec. A briefing, not a wall of Markdown.

## The agent loop

The layer extends the same human⇄agent loop as notes. spec-scope tells the agent what needs explaining;
the agent writes it back.

```bash
# What still needs a plain summary, narration, glossary def, decision write-up, or diagram?
spec-scope explain            # compact TOON work list (the default — token-lean)
spec-scope explain --json     # the full ExplainTask[] incl. per-task hints
spec-scope explain --text     # human-readable long form

# ... the agent generates the content, grounding each item and setting provenance
#     honestly, and writes a ReviewBatch JSON ...

spec-scope apply batch.json   # merge it (or `spec-scope apply -` to read from stdin)

# Read the captured decisions back (TOON by default; --json / --text as above)
spec-scope decisions
spec-scope decisions --all
```

Every agent-facing command also ends with a `next_step:` line — the imperative for
what to do next — so the loop stays anchored without re-reading this doc.

`explain` only lists work that is **missing or stale** — an explanation whose hash still matches the
spec is done and never reappears. Each `summary`/`narration` task carries a `specHash`; the agent copies
that value verbatim into the explanation it writes, which is what marks the explanation current so the
task doesn't come straight back as stale. A resolved discussion note with no decision recorded against
it shows up as a `decision` task, so the _why_ behind a resolution is captured while it's still fresh.
Each document also gets a `diagram` task: the agent authors the diagram(s) a structure earned, or records
a `diagramSkip` (the tracked "no diagram warranted"), copying the task's `specHash` verbatim into either.
Which to draw — or when to skip — is its own rubric; see [diagrams](./diagrams.md).

### What the agent writes: a `ReviewBatch`

```jsonc
{
  "explanations": [
    {
      "anchor": "doc:…/req:passkey-enrolment", // a Requirement or Scenario id
      "anchorLabel": "auth / Passkey Enrolment",
      "kind": "summary", // "summary" | "narration" | "glossary-def"
      "body": "In plain terms: a signed-in shopper can register a passkey …",
      "provenance": "grounded", // grounded | inferred | unstated
      "sources": [{ "kind": "requirement", "anchor": "doc:…/req:passkey-enrolment", "quote": "…" }],
      "specHash": "…", // copy this verbatim from the explain task; drives staleness
      "author": "agent",
      "createdAt": "2026-07-20T00:00:00.000Z",
    },
  ],
  "decisions": [/* Decision objects */],
  "glossary": [/* GlossaryTerm objects */],
  "diagrams": [/* AuthoredDiagram objects — one per structure that earned one */],
  "diagramSkips": [/* DiagramSkip objects — the tracked "no diagram warranted" */],
}
```

The exact field shapes are the `Explanation`, `Decision`, `GlossaryTerm`, `AuthoredDiagram`, and
`DiagramSkip` types in [`src/types.ts`](../src/types.ts). `apply` upserts (explanations by anchor+kind,
glossary by term, decisions by id, diagrams by id, skips by anchor), validates the whole batch before
writing, and never lands a partial batch — including the diagram floors (a valid Mermaid header per type,
at least 3 nodes, at most 24). The rules for whether and what to draw are in [diagrams](./diagrams.md).

Point your agent at it once, in its instructions file:

```markdown
After a spec review settles, run `spec-scope explain` (add `--json` if you want the per-task hint).
For each task, write the requested content grounded in the cited spec text and set `provenance`
honestly — `grounded` when you restate the spec, `inferred` when you read intent it doesn't state,
`unstated` when the rationale genuinely isn't recorded (never invent one). Copy each task's
`specHash` verbatim into the explanation you write for it. Hand the batch back with `spec-scope apply -`.
```

## Where it lives

All review data is one file, `.spec-scope/review.json`, next to `notes.json` at your project root. It
holds the decisions, stamps, explanations, glossary, and the authored `diagrams` and `diagramSkips`. The
[commit-or-gitignore decision](../README.md#where-notes-live) is the same as for notes — commit it to
keep decisions, explanations, and authored diagrams with the spec as a team artifact, or gitignore it to
keep review ephemeral. It is written atomically and guarded by a lock, so a running server and a second CLI
invocation can't corrupt each other.

## HTTP API

The browser UI is a thin client over these routes (all local, same-origin, `127.0.0.1`):

| Route                    | Method        | Returns / does                                                     |
| ------------------------ | ------------- | ------------------------------------------------------------------ |
| `/api/review`            | GET           | `{ review }` — decisions, stamps, explanations, glossary, diagrams |
| `/api/explain`           | GET           | `{ tasks }` — the same work list as the CLI                        |
| `/api/changes`           | GET           | `{ changes }` — delta entries with before/after                    |
| `/api/blast?anchor=<id>` | GET           | `{ graph, mermaid }` — the downstream subgraph                     |
| `/api/heatmap?doc=<id>`  | GET           | `{ mermaid }` — the requirement map tinted by verdict              |
| `/api/decisions`         | POST          | create a decision                                                  |
| `/api/decisions/:id`     | POST / DELETE | update / delete a decision                                         |
| `/api/stamps`            | POST          | set a verdict (upsert per anchor)                                  |
| `/api/stamps/:id`        | DELETE        | remove a stamp                                                     |
| `/api/apply`             | POST          | merge a `ReviewBatch`                                              |
| `/api/events`            | GET (SSE)     | emits a `review` event when review.json changes                    |

Every mutating route is behind the same CSRF and `Host`-header guards as the notes routes — a cross-site
page cannot write to your local review server. See [SECURITY.md](../SECURITY.md).

## What the analysis does and doesn't know

- **Blast radius** matching is lexical, not semantic. Structural edges (a requirement to its scenarios,
  a task that names a requirement) are real; inferred edges are a shared-term guess and are always drawn
  dashed and capped in number. Treat the dashed edges as "look here too", not as truth.
- **Change entries** report only what the delta markers record. OpenSpec deltas usually carry the new
  text, not the old, so most `MODIFIED` entries honestly say the prior text isn't recorded rather than
  guessing at it.
- **Glossary** definitions come from the agent; an undefined term is flagged, never auto-defined.
