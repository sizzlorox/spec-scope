# Auth Delta

## ADDED Requirements

### Requirement: Passkey Enrolment

Shoppers MUST be able to register a platform authenticator against a signed-in account, and the
resulting credential MUST be usable for sign-in immediately after enrolment.

#### Scenario: First passkey enrolment

- **GIVEN** a signed-in shopper with no enrolled credential
- **WHEN** Storefront Web: requests an enrolment challenge
- **THEN** Auth Service: returns a challenge bound to the current session
- **AND** the stored credential is listed on the account security page

#### Scenario: Unsupported authenticator

- **GIVEN** a signed-in shopper on a browser without a platform authenticator
- **WHEN** the shopper opens the account security page
- **THEN** the storefront explains that this device cannot hold a passkey

### Requirement: Passkey Sign-In

A shopper with an enrolled credential MUST be able to sign in without typing a password, and the
server MUST reject an assertion whose challenge, origin or signature does not verify.

#### Scenario: Returning shopper signs in with a passkey

- **GIVEN** an account with one enrolled credential
- **WHEN** Storefront Web: submits a signed assertion
- **THEN** Auth Service: verifies the signature against the stored public key
- **AND** a session token valid for 30 days is issued

## MODIFIED Requirements

### Requirement: Session Expiry

A session MUST stop being accepted 30 days after it was issued. The 14-day idle limit no longer
applies to sessions issued from a passkey sign-in, because the credential is bound to the device.

#### Scenario: Idle session with a passkey present

- GIVEN a passkey session whose last request was 15 days ago
- WHEN the shopper opens the account dashboard
- THEN the storefront serves the dashboard without a fresh sign-in

## REMOVED Requirements

### Requirement: Password Sign-In

Password sign-in is retired for accounts holding at least one working credential. The stored
password hash is deleted once the shopper confirms the passkey works.

## RENAMED Requirements

### Requirement: Credential Revocation

- FROM: `### Requirement: Sign Out`
- TO: `### Requirement: Credential Revocation`

Ending a session and removing a credential are now separate actions, so the requirement covers
both and is named for the broader idea.
