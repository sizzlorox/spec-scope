# Harbor Constitution

## Core Principles

### I. Spec Before Code

Every behaviour change begins as a written specification a non-author can read
and disagree with. Review checks the code against the spec, not against the
reviewer's memory of a hallway conversation. A spec that no one has read is not
done.

### II. Secure by Default

Access is denied unless a rule grants it. Invitations, tokens and sessions
expire on their own; nothing lives forever because someone forgot to clean it
up. A feature that widens who can see or do something names that blast radius
in its spec.

### III. One Reversible Step

Each release does one thing and can be rolled back without data loss. A change
that needs two deploys in a fixed order is a change that needs a different
design. Schema moves land additively first, then remove the old shape in a
later release.

### IV. Tests Describe Behaviour

Tests are written against the HTTP surface and the domain API, never against
private helpers. A test that must change when an internal name changes is
testing the wrong thing. Every acceptance scenario in a spec maps to at least
one test.

### V. Observable by Default

Every state transition an entity can make is logged with who caused it and
why. If support cannot answer "what happened to this invitation" from the
audit trail alone, the feature is not observable enough.

## Additional Constraints

- Personal data (names, email addresses) leaves the database only through an
  audited export path.
- Third-party scripts are not loaded on any page that handles a token.
- A new dependency is added only when the standard library cannot do the job,
  and the choice is recorded in the plan.

## Development Workflow

Changes ship behind review. A reviewer verifies that every functional
requirement has a test, that the spec's success criteria are measurable, and
that any new open question is either answered or explicitly deferred with an
owner. Complexity that is not justified in the plan is removed, not merged.

## Governance

This constitution outranks other practice documents. Amendments need a written
rationale, a migration plan for work already in flight, and sign-off from two
maintainers.

**Version**: 1.1.0 | **Ratified**: 2026-05-04 | **Last Amended**: 2026-07-18
