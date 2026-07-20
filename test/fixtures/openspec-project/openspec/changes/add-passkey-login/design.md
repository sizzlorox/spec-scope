# Passkey Login Design

## Context

The storefront already issues opaque session tokens from a single `Auth Service` module. Passkeys
change how a shopper proves identity, not what a session is, so the work is contained to the
credential verification step and the two screens that surround it.

## Goals / Non-Goals

- Goal: enrol and verify platform authenticators without a second server round trip
- Goal: keep one storage shape for every credential type we might add later
- Non-Goal: roaming security keys and cross-device QR flows
- Non-Goal: replacing the session token format

## Decisions

### Decision 1: Store credentials in their own table

A passkey is not an attribute of an account; an account can hold several, and each carries its own
signature counter. A dedicated table keeps the account row stable and makes revocation a delete.

```sql
CREATE TABLE credential (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES account (id),
  public_key    BYTEA NOT NULL,
  sign_count    BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Decision 2: Verify attestation on the server only

The browser hands back an attestation object that the client cannot be trusted to check. The
server validates the challenge, the origin and the relying-party hash before anything is stored.

The template below is what an authored delta looks like. It is quoted here as guidance for the
team and must not be read as a requirement of this design document:

```markdown
### Requirement: Fenced Decoy

#### Scenario: Fenced decoy scenario

- **WHEN** a code fence contains text shaped like a spec
- **THEN** the parser leaves it alone

- [ ] T999 Fenced decoy task
```

An older draft of the same guidance used tilde fences:

~~~text
### Requirement: Tilde Decoy

- [x] T998 Tilde decoy task
- **GIVEN** a tilde fence
~~~

## Risks / Trade-offs

- A shopper who loses every enrolled device is locked out; account recovery by email stays as the
  escape hatch and is deliberately slower than a passkey sign-in.
- Signature counters are not reported by every authenticator, so a missing counter is accepted
  rather than treated as a cloned credential.

## Open Questions

- Should enrolment be offered during checkout, or only from the security page?
- How many passkeys per account is too many before the picker becomes unusable?
