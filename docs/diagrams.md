# Diagrams: what to draw, and when not to

spec-scope draws two kinds of diagram, and they sit at different altitudes.

- **Derived diagrams** are mechanical. spec-scope turns each `WHEN`/`THEN` scenario into a sequence
  chart, a document's requirements into a requirement map, a `tasks.md` into a flow — no judgement, no
  authoring. See [how the diagrams are generated](../README.md#how-the-diagrams-are-generated).
- **Authored diagrams** need judgement about what the spec _means_ — one state machine for an entity's
  whole lifecycle, one ER diagram for a data model, one sequence for an endpoint flow. spec-scope has no
  language model, so the **agent already in your loop** authors these. spec-scope validates and renders
  them, with the same provenance and staleness discipline as an explanation (see
  [the review layer](./review-layer.md)).

This reference is the rubric the agent — and any contributor tuning it — follows to decide **whether** a
structure earns an authored diagram, **which type** it earns, and **at what altitude** to draw it.

## Why the default is NO diagram

Most of a spec is best read as prose or a table. A reader looking up a single fact — what a field means,
what one requirement demands — finds it faster in a sentence than by decoding a picture. A diagram is not
free: it asks the reader to learn a notation and hold a second representation in mind. It has to buy back
that cost by showing something text represents poorly.

Two findings from the research on when diagrams help, worth keeping in view:

- **Cognitive Fit** (Vessey, 1991): a representation helps only when its form matches the task. A diagram
  fits a _spatial_ or _relational_ task — tracing a flow, comparing states, following who-calls-whom. For
  a lookup or a single fact, a list or table fits better, and the diagram is friction.
- **Coherence and redundancy** (Mayer's multimedia-learning work): adding a diagram that merely restates
  one sentence measurably _lowers_ comprehension rather than raising it — the reader pays to reconcile two
  representations that say the same thing. Non-expert readers are, in the empirical literature,
  measurably **slower** at UML-style diagrams than at the equivalent prose. A diagram you cannot justify
  is worse than none.

So a diagram must **earn its place** by showing at least one of:

- **branching** — a decision or validation path text has to spell out step by step;
- **cycles** — a loop or a retry that reads as spaghetti in prose;
- **two or more interacting actors** — a request/response that crosses named participants;
- **a lifecycle of three or more states** — an entity moving through named statuses;
- **entities and their relationships** — a data model with cardinality.

None of those present? Prose wins. Record that honestly as a `DiagramSkip` (below) — not silence.

## Content signal → diagram type

Read the document's structure and take the **first** row that matches. First match wins; stop there.

| Signal in the spec                                                                                     | Type        | Mermaid header                |
| ------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------- |
| A **Data Model / Entities** section — fields, cardinality ("has many", a foreign key)                  | `er`        | `erDiagram`                   |
| One **entity with enumerated statuses** and transitions ("draft/published/archived", "transitions to") | `state`     | `stateDiagram-v2`             |
| A **request/response across ≥2 named participants** ("sends", "returns", "calls")                      | `sequence`  | `sequenceDiagram`             |
| A **process with branching or decisions** ("if/else", validation, retry)                               | `flowchart` | `flowchart TD`                |
| **Module/component structure within one unit** ("depends on", "implements")                            | `class`     | `classDiagram`                |
| **None of the above fired**                                                                            | _(none)_    | prose — write a `DiagramSkip` |

## Discriminators for the overlapping pairs

Three pairs are easy to confuse. Decide by what the spec is _about_, not by the vocabulary alone.

- **`state` vs `sequence`.** A `state` diagram is **one entity moving through its own states** over
  time — the subject stays the same, only its status changes. A `sequence` diagram is **multiple parties
  collaborating in one interaction** — the subject is the exchange between them. If there is one noun
  changing status, it is `state`; if there are two-plus nouns passing messages, it is `sequence`.
- **`flowchart` (activity) vs `state`.** A `flowchart` traces **verbs — process steps** ("validate the
  token, then charge the card, else retry"). A `state` diagram names **status nouns and the transitions
  between them** ("`pending` → `paid` → `refunded`"). Steps you _do_ are a flowchart; statuses a thing
  _is_ are a state machine.
- **`class` vs C4/system.** A `class` diagram shows **internal module structure within one unit** — the
  components of the thing you are specifying and how they relate. A system/context diagram (C4) would show
  **external systems** the unit talks to. **C4 is out of scope for now** — if the spec is really about
  boundaries between systems, write a `DiagramSkip` rather than forcing it into a `class` diagram.

## Two altitudes — the key rule

The most common mistake is drawing **one diagram per scenario**. Don't. A spec has many scenarios that are
facets of a few underlying structures; draw the **structure once**, at the aggregate altitude:

- **one state machine per entity** — every scenario that moves an `Order` between statuses feeds the same
  `Order` lifecycle diagram;
- **one ER diagram for the whole data model** — not one per entity;
- **one sequence per endpoint flow** — the happy path plus its branches in a single chart, not one chart
  per acceptance criterion.

Set the diagram's `anchor` to the **document id** it consolidates, and list the specific
requirement/scenario/entity ids it depicts in `covers`. That is how one diagram earns its keep across many
scenarios while staying honest about exactly what it draws.

> Derived per-scenario sequence charts are a separate, mechanical thing (see the README). They are now
> **suppressed when trivial** — a scenario with fewer than two message arrows renders as prose, not a
> two-box picture. The authored `sequence` diagram is the higher-altitude endpoint flow, not the
> per-scenario derivation; don't duplicate the latter as the former.

## The floors spec-scope enforces on `apply`

When the agent hands a diagram back, spec-scope code-enforces three things and rejects the batch if any
fails — no partial write:

1. **A valid Mermaid header for the declared `type`** — the header in the table above. `flowchart` needs a
   direction (`flowchart TD`), not a bare keyword.
2. **At least 3 nodes** — the triviality floor. A two-box diagram loses to a sentence; if that is all the
   structure there is, it did not earn a diagram — write a `DiagramSkip`.
3. **At most 24 nodes** — the legibility ceiling. Past it, **split** into more than one diagram at a
   tighter altitude (e.g. one sequence per endpoint instead of one for a whole service).

## The shapes the agent writes

Both types live in `.spec-scope/review.json` and are defined in [`../src/types.ts`](../src/types.ts).

### `AuthoredDiagram` — a diagram a structure earned

```jsonc
{
  "id": "diag:order-lifecycle",
  "title": "Order lifecycle",
  "type": "state", // sequence | state | er | flowchart | class
  "anchor": "doc:orders/spec", // the doc id it was authored for
  "anchorLabel": "orders / Order Management",
  "covers": ["req:place-order", "req:cancel-order", "req:refund-order"], // the ids it depicts
  "mermaid": "stateDiagram-v2\n  [*] --> pending\n  pending --> paid: payment clears\n  paid --> refunded: refund issued\n  paid --> [*]",
  "trigger": "Order has enumerated statuses (pending/paid/refunded) with transitions", // the one signal that fired
  "provenance": "grounded", // grounded | inferred | unstated
  "sources": [
    {
      "kind": "requirement",
      "anchor": "req:place-order",
      "quote": "an order transitions to paid when payment clears",
    },
  ],
  "specHash": "…", // copied VERBATIM from the explain 'diagram' task
  "author": "agent",
  "createdAt": "2026-07-20T00:00:00.000Z",
}
```

### `DiagramSkip` — the tracked "no diagram warranted"

When no signal fires, record the judgement — do not stay silent. A skip is not permanent: its `specHash`
pins the doc's structural text, so when that text changes the `diagram` task **re-opens** and the agent
looks again.

```jsonc
{
  "anchor": "doc:auth/spec", // the doc id reviewed
  "specHash": "…", // copied VERBATIM from the explain 'diagram' task
  "reason": "all scenarios are single-step lookups; no branching, states, or actors", // optional, one line
  "author": "agent",
  "createdAt": "2026-07-20T00:00:00.000Z",
}
```

`spec-scope explain` emits one `diagram` task per document, carrying the `specHash` of that document's
structural text. For each task the agent writes **either** one or more `AuthoredDiagram`s **or** a single
`DiagramSkip`, copying the task's `specHash` verbatim into whichever it writes — that value is what marks
the task done so it does not come straight back as stale, and (for a skip) what re-opens it when the
structure changes. Hand both back in a `ReviewBatch` via `spec-scope apply -`; see
[the review layer](./review-layer.md).
