# Implementation Plan: Passkey Login

## Technical Context

The storefront already issues opaque session tokens from one module. Passkeys replace the
credential check in front of that module and add a credential store beside the account table.

**Language**: TypeScript
**Storage**: PostgreSQL
**Testing**: end-to-end tests against the HTTP surface

## User Scenarios

- As a shopper, I want to reuse a passkey across my devices, so that enrolling on my laptop does not force a second enrolment on my phone.
- As a support agent, I want to revoke a lost passkey for a shopper, so that a stolen device cannot reach the order history.

## Functional Requirements

### Rate Limiting

Assertion checks MUST be limited to ten attempts per account per hour. The limit is counted on
failures only, so a shopper signing in repeatedly from one device is never blocked.

The generated task file quotes requirement headings verbatim, which is why the block below is
fenced rather than authored inline:

```markdown
### FR-999: Fenced Decoy Requirement

- [ ] T999 Fenced decoy task
- Given a fenced block
- When the parser reads it
- Then nothing inside becomes a requirement
```

### Audit Logging

Enrolment and revocation MUST be written to the audit log with the acting account, the credential
id and the source network. Assertion failures are counted but not logged individually.

## Constitution Check

### Gate: One Deployable

Passes. The credential store is a table in the existing database, not a new service.

### Gate: Reversible By Default

Passes. The `credential` table is additive, and the password column is dropped in a later release.

## Project Structure

```text
domain/
  auth/
    credential.ts
    assertion.ts
http/
  auth/
    enrol.ts
    signin.ts
```
