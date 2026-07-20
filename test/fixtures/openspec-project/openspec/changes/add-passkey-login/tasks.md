# Passkey Login Tasks

## 1. Data Model

- [x] T001 Add the `credential` table migration
  - [x] T002 **Columns**: account id, public key, sign count, created at
  - [ ] T003 Backfill a null sign count for rows written by the spike branch
- [ ] T004 Add a `passkey_enabled` flag to the account row

## 2. Registration Flow

- [ ] T005 Build the enrolment endpoint
  * [ ] T006 Validate the attestation object against the stored challenge
  * [ ] T007 Persist the credential
    - [ ] T008 Reject a credential id that is already enrolled
1. [ ] T009 Ship the account security page

## 3. Sign-In Flow

- [ ] T010 Offer passkey sign-in when the account has an enrolled credential
- [ ] T011 Fall back to password sign-in when the authenticator is unavailable
