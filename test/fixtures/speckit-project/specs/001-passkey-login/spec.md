# Feature Specification: Passkey Login

**Feature Branch**: `001-passkey-login`
**Status**: Draft

## User Story 1 - Enrol a passkey (Priority: P1)

As a returning shopper, I want to register a passkey on my device, so that I never have to type a
password on the storefront again.

**Acceptance Criteria**

- Given a signed-in shopper on the account security page
- When the shopper chooses "Add a passkey"
- Then the browser prompts for the platform authenticator
- And the new credential is listed against the account

## User Story 2 - Sign in with a passkey (Priority: P1)

As a returning shopper, I want to sign in with the passkey I already enrolled, so that getting to
my order history takes one gesture.

**Acceptance Criteria**

- Given an account holding one enrolled credential
- When the shopper opens the sign-in page on the enrolled device
- Then the storefront offers the passkey before the password field
- And a successful gesture issues a session valid for 30 days

## Requirements

### FR-001: Passkey Enrolment

The system MUST allow a signed-in shopper to enrol a platform authenticator, and MUST bind the
enrolment challenge to the session that requested it.

### FR-002 Passkey Sign-In

The system MUST verify an assertion's challenge, origin and signature before issuing a session,
and MUST reject the assertion if any of the three does not match.

### Credential Revocation

Shoppers MUST be able to remove an enrolled credential from the account security page, and a
removed credential MUST NOT be accepted for sign-in afterwards.

## Key Entities

### Credential

A public key held by one account, together with the signature counter reported by the
authenticator that created it.

### Enrolment Challenge

A short-lived random value bound to a session, spent by the first enrolment that presents it.
