# Sample Storefront Constitution

## Core Principles

### I. Spec-First Delivery

Every behaviour change starts as a written specification that a non-author can read and disagree
with. Code review checks the code against the spec, not against the reviewer's memory of a
hallway conversation.

### II. One Deployable

The storefront ships as a single artefact. A change that requires two services to deploy in a
fixed order is a change that needs a different design.

### III. Tests Describe Behaviour

Tests are written against the HTTP surface and the domain API, never against private helpers. A
test that must change when an internal name changes is testing the wrong thing.

### IV. Reversible By Default

Schema changes land in two steps: add the new shape, then remove the old one in a later release.
Any single release must be safe to roll back without data loss.

## Additional Constraints

- Personal data leaves the database only through an audited export path
- Third-party scripts are not loaded on the checkout pages
- A dependency is added only when the standard library cannot do the job

## Governance

This constitution outranks other practice documents. Amendments need a written rationale, a
migration plan for work already in flight, and sign-off from two maintainers.

**Version**: 1.2.0
