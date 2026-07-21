# Implementation Plan: Team Invitations

**Branch**: `001-team-invites` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-team-invites/spec.md`

## Summary

Add an invitation flow to Harbor: an admin creates an invitation for an email
and role, the invitee follows a single-use link to join, and the invitation
can be revoked or expire on its own. The design keeps the invitation as the one
source of truth for a pending grant, and turns it into a membership only on
acceptance.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node 22

**Primary Dependencies**: existing HTTP framework and query builder; the shared
transactional email service. No new runtime dependency is proposed.

**Storage**: PostgreSQL — two new tables (`invitations`, `memberships`) and a
foreign key to the existing `workspaces` table.

**Testing**: node:test against the HTTP surface and the domain API.

**Target Platform**: Linux web service.

**Project Type**: web-service.

**Performance Goals**: invitation create and accept both under 200ms p95.

**Constraints**: a join link must be refused the instant its invitation leaves
the pending state; no background job may be required for correctness (expiry is
enforced on read as well as by a sweep).

## Constitution Check

- **Secure by Default** — a token is single-use and the invitation carries its
  own expiry; a leaked link stops working on its own. PASS.
- **One Reversible Step** — the two new tables are additive; the feature can be
  disabled by hiding the endpoint without dropping data. PASS.
- **Observable by Default** — every state transition writes an audit row with
  actor and reason. PASS.

## Request Flow

The flow crosses three participants: the browser, the API, and the email
service, plus the invitee's browser later.

1. The admin's **Browser** sends `POST /workspaces/{id}/invitations` with the
   email and role.
2. The **API** validates the role, checks that the email is not already a
   member, writes a pending `Invitation` row with a fresh token and a
   `expiresAt` seven days out, and writes a `created` audit row.
3. The **API** asks the **Email Service** to send the join link, then returns
   the invitation to the admin's browser.
4. Later, the **Invitee Browser** opens `GET /invitations/{token}`. The API
   loads the invitation, and if it is pending and unexpired, shows the accept
   page; otherwise it renders the refused page.
5. The **Invitee Browser** sends `POST /invitations/{token}/accept`. The API
   re-checks the state, creates one `Membership`, moves the invitation to
   `accepted`, writes an `accepted` audit row, and redirects into the
   workspace.

## Invitation Lifecycle

An invitation is a small state machine. It starts **pending**. From pending it
can move to **accepted** (the invitee joined), **revoked** (an admin cancelled
it), or **expired** (the window passed). Accepted, revoked and expired are
terminal — no transition leaves them, and a link is refused in all three.
Expiry is evaluated both by a periodic sweep and lazily on read, so a link
never admits anyone after its `expiresAt` even if the sweep has not run.

## Data Model

```text
Workspace (existing)
  id
  name

Invitation (new)
  id
  workspaceId   -> Workspace.id     (many invitations per workspace)
  email
  role          (Owner|Admin|Editor|Viewer)
  token         (single-use, indexed)
  status        (pending|accepted|revoked|expired)
  createdAt
  expiresAt

Membership (new)
  id
  workspaceId   -> Workspace.id     (many memberships per workspace)
  userId        -> User.id
  role
  invitationId  -> Invitation.id    (the accepted invitation, nullable for founders)
  joinedAt
```

Cardinality: a Workspace has many Invitations and many Memberships. An accepted
Invitation produces exactly one Membership.

## Project Structure

```text
specs/001-team-invites/
├── plan.md
├── spec.md
└── tasks.md

src/
├── invitations/
│   ├── routes.ts        # HTTP surface
│   ├── service.ts       # create / accept / revoke / expire
│   └── model.ts         # row types + state guards
└── audit/
    └── log.ts           # append-only transition log

tests/
├── invitations.http.test.ts
└── invitations.service.test.ts
```

## Complexity Tracking

No constitution gate is waived. The one judgement call — enforcing expiry both
lazily on read and by a sweep — is deliberate: the sweep keeps the table tidy,
the lazy check keeps correctness independent of the sweep's schedule.
