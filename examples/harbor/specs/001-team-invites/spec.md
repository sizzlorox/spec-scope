# Feature Specification: Team Invitations

**Feature Branch**: `001-team-invites`

**Created**: 2026-07-20

**Status**: Draft

**Input**: User description: "Let a workspace admin invite teammates by email, with roles, expiring invitations, and revocation"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Invite a teammate (Priority: P1)

An admin adds a colleague to the workspace by entering their email address and
choosing a role. The colleague receives a link that lets them join without the
admin sharing a password or creating the account for them.

**Why this priority**: Without this, there is no way to grow a workspace beyond
its first member. It is the smallest slice that delivers value on its own.

**Independent Test**: Send an invitation to a fresh email address, open the
link, and confirm the recipient lands in the workspace with the chosen role.

**Acceptance Scenarios**:

1. **Given** an admin viewing the members page, **When** they submit a valid
   email and the role "Editor", **Then** a pending invitation is created and an
   email with a join link is sent to that address.
2. **Given** a pending invitation, **When** the recipient opens the join link
   while signed out, **Then** they are asked to sign in or create an account,
   and on success become an Editor of the workspace.
3. **Given** an email that is already a member of the workspace, **When** the
   admin tries to invite it again, **Then** the invitation is rejected with a
   message that the person is already a member.

---

### User Story 2 - Revoke an invitation (Priority: P2)

An admin who invited the wrong person, or changed their mind, cancels a pending
invitation so its link stops working.

**Why this priority**: Invitations grant access. The ability to take that grant
back before it is used is required by the "secure by default" principle, but it
is only meaningful once invitations exist.

**Independent Test**: Create an invitation, revoke it, then open its link and
confirm the recipient is refused with a clear message.

**Acceptance Scenarios**:

1. **Given** a pending invitation, **When** the admin revokes it, **Then** its
   status becomes revoked and the join link no longer admits anyone.
2. **Given** a revoked invitation, **When** the recipient opens the link,
   **Then** they see a message that the invitation is no longer valid and are
   not added to the workspace.

---

### User Story 3 - Invitations expire on their own (Priority: P3)

An invitation that is never opened stops working after a fixed window, so a
forgotten link cannot be used months later.

**Why this priority**: Expiry limits the blast radius of a leaked link. It is
valuable but the feature is usable without it, so it is lowest priority.

**Independent Test**: Create an invitation, advance the clock past the expiry
window, open the link, and confirm it is refused as expired.

**Acceptance Scenarios**:

1. **Given** an invitation created 8 days ago with a 7-day window, **When** the
   recipient opens the link, **Then** it is refused as expired and no
   membership is created.

---

### Edge Cases

- What happens when two admins invite the same email at the same time? The
  second create must not produce a second pending invitation for that address.
- How does the system handle a recipient who is signed in as a different
  account than the one the invitation was addressed to?
- What happens when a revoked invitation's email is invited again — is it a new
  invitation, or a reactivation of the old row?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An admin MUST be able to create an invitation for an email
  address with exactly one role from the workspace's role set.
- **FR-002**: The system MUST send the invited address an email containing a
  single-use join link tied to that invitation.
- **FR-003**: The system MUST reject an invitation whose email already belongs
  to a member of the same workspace.
- **FR-004**: A join link MUST admit the recipient only while its invitation is
  in the pending state; accepted, revoked and expired invitations MUST refuse
  it.
- **FR-005**: An admin MUST be able to revoke a pending invitation, after which
  its link is refused.
- **FR-006**: An invitation MUST expire automatically after a configurable
  window measured from its creation, defaulting to 7 days.
- **FR-007**: The system MUST record every invitation state change (created,
  accepted, revoked, expired) with the actor and timestamp in the audit log.
- **FR-008**: Accepting an invitation MUST create exactly one membership
  granting the invitation's role, even if the link is opened twice.

### Key Entities *(include if feature involves data)*

- **Workspace**: The team a member belongs to. Owns many invitations and many
  memberships.
- **Invitation**: A pending grant of access. Holds the target email, the
  offered role, a single-use token, a status (pending, accepted, revoked,
  expired), a creation time and an expiry time. Belongs to one workspace.
- **Membership**: A person's confirmed place in a workspace, carrying their
  role. Created when an invitation is accepted.
- **Role**: The permission set an invitation offers and a membership carries
  (Owner, Admin, Editor, Viewer).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can send an invitation in under 30 seconds from the
  members page.
- **SC-002**: 95% of invited recipients who open their link reach the workspace
  without contacting support.
- **SC-003**: No invitation link admits anyone after it is revoked or expired,
  verified by an automated test for each terminal state.
- **SC-004**: Support can reconstruct the full history of any invitation from
  the audit log alone.

## Assumptions

- Recipients have a working email address and can follow a link in a browser.
- An existing authentication system handles sign-in and account creation; this
  feature only decides who may join, not how they prove who they are.
- Role definitions already exist in the workspace; this feature consumes them
  and does not create new roles.
- Sending email is handled by an existing transactional email service.
