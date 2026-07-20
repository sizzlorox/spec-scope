# Auth Specification

## Purpose

Authentication decides who a visitor is and how long that answer stays trusted. It covers
sign-in, session lifetime and sign-out for the storefront.

## Requirements

### Requirement: Password Sign-In

Shoppers MUST be able to sign in with the email address and password recorded on their account.
Passwords are compared against a salted hash; the plaintext is never stored or logged.

#### Scenario: Valid credentials

- **GIVEN** a registered account with a verified email address
- **WHEN** Storefront Web: submits a matching email and password
- **THEN** Auth Service: issues a session token valid for 30 days
- **AND** the shopper lands on the account dashboard

#### Scenario: Wrong password

- **GIVEN** a registered account with a verified email address
- **WHEN** the visitor submits an incorrect password
- **THEN** the storefront reports that the credentials did not match
- **BUT** the account stays usable until the fifth consecutive failure

### Requirement: Session Expiry

A session MUST stop being accepted 30 days after it was issued, and MUST stop being accepted
14 days after the last request that used it, whichever comes first.

#### Scenario: Idle session

- GIVEN a session whose last request was 15 days ago
- WHEN the shopper opens the account dashboard
- THEN the storefront redirects to the sign-in page

### Requirement: Sign Out

Shoppers MUST be able to end a session on demand, and the ended session MUST NOT be accepted
again even if the token is replayed.

#### Scenario: Explicit sign out

- **GIVEN** an active session
- **WHEN** the shopper selects "Sign out"
- **THEN** Auth Service: revokes the session token
- **AND** a replay of the same token is rejected
