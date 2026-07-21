# Example: Harbor — a team-invites feature

A small, self-contained **Spec Kit** project. It backs the screenshots in the
[top-level README](../../README.md): a fictional workspace product, "Harbor",
with one feature specified — **team invitations** (invite by email, roles,
expiring invitations, revocation).

## Run it

From the repo root:

    spec-scope examples/harbor

or, if you are developing spec-scope in this checkout:

    node bin/spec-scope.js examples/harbor

Your browser opens on the review. Because a prepared review ships alongside the
spec (`.spec-scope/`), you land straight on the populated **report** — the
plain-language summaries, the authored sequence / state / ER diagrams, two
recorded decisions, one open question, and a reviewer note on FR-003 — the same
state the README screenshots show. Cycle **Density** in the top bar between
Report, Digest and Full.

## What's here

    .specify/memory/constitution.md    the Harbor constitution
    specs/001-team-invites/
      spec.md    user stories, functional requirements, entities
      plan.md    request flow, data model, invitation lifecycle
      tasks.md   the task breakdown
    .spec-scope/                        the prepared review (agent-authored)
      review.json   summaries, diagrams, glossary, decisions
      notes.json    one open discussion note

The spec files come from a normal Spec Kit flow (`specify init`, then the
`/speckit-*` steps). The `.spec-scope/` review is what an in-loop agent produces
by running `spec-scope explain`, writing the explanations and diagrams, and
handing them back with `spec-scope apply` — so you can delete `.spec-scope/` and
prepare the review yourself to see the other half of the loop.
