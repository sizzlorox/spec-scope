# Tasks: Passkey Login

**Input**: Design documents from `specs/001-passkey-login/`

## Phase 1: Setup

- [x] T001 Create the `domain/auth/credential.ts` module skeleton
- [x] T002 [P] Add the WebAuthn verification dependency

## Phase 2: Foundational

- [ ] T003 Define the credential storage interface
  - [ ] T004 Write the in-memory adapter used by the domain tests
  - [ ] T005 Write the PostgreSQL adapter and its migration

## Phase 3: User Story 1 - Enrol a passkey

- [ ] T006 [US1] Implement `POST /account/passkeys` for enrolment
  - [ ] T007 [US1] Verify the attestation object against the stored challenge
- [ ] T008 [US1] Add the enrolment control to the account security page
