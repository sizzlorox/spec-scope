# Tasks: Team Invitations

**Input**: Design documents from `specs/001-team-invites/`

## Phase 1: Setup

- [x] T001 Create the `src/invitations/` module skeleton (routes, service, model)
- [x] T002 [P] Add the `invitations` and `memberships` migrations

## Phase 2: Foundational

- [ ] T003 Define the `Invitation` row type and its status guards in `model.ts`
  - [ ] T004 Implement the append-only audit log in `src/audit/log.ts`
  - [ ] T005 Wire lazy expiry: treat a past `expiresAt` as expired on read

## Phase 3: User Story 1 - Invite a teammate

- [ ] T006 [US1] Implement `POST /workspaces/{id}/invitations` create in `service.ts`
  - [ ] T007 [US1] Reject an email that is already a member (FR-003)
  - [ ] T008 [US1] Send the join link through the email service (FR-002)
- [ ] T009 [US1] Implement `POST /invitations/{token}/accept` creating one membership (FR-008)

## Phase 4: User Story 2 - Revoke an invitation

- [ ] T010 [US2] Implement `POST /invitations/{token}/revoke` (FR-005)
  - [ ] T011 [US2] Refuse a join link whose invitation is not pending (FR-004)

## Phase 5: User Story 3 - Invitations expire on their own

- [ ] T012 [US3] Add the periodic sweep that marks past-window invitations expired (FR-006)
- [ ] T013 [US3] Assert the refused page for each terminal state (SC-003)

## Phase 6: Polish

- [ ] T014 [P] Backfill audit-log assertions so any transition is reconstructable (SC-004)
