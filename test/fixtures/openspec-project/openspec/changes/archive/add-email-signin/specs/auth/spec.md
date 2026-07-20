# Auth Delta

## ADDED Requirements

### Requirement: Email Magic Link

The storefront MUST be able to send a one-time sign-in link to an email address that appears on
at least one order, and the link MUST expire 15 minutes after it was issued.

#### Scenario: Magic link delivered

- **GIVEN** an email address with at least one past order
- **WHEN** Storefront Web: requests a sign-in link
- **THEN** Mail Service: delivers a link that expires in 15 minutes

#### Scenario: Bounced address

### Requirement: Sign-in Rate Limiting

No more than five sign-in link requests MUST be accepted for one email address in an hour.

#### Scenario: Sixth request in an hour

- **GIVEN** five accepted link requests for one address in the last hour
- **WHEN** a sixth request arrives for the same address
- **THEN** the storefront reports that too many links were requested

## MODIFIED Requirements

### Requirement: Sign in Rate Limiting

The per-address limit is joined by a per-network limit of sixty requests an hour, so a single
source cannot enumerate which addresses have an order history.

#### Scenario: Enumeration attempt from one network

- **GIVEN** sixty accepted link requests from one source network in the last hour
- **WHEN** a further request arrives from that network
- **THEN** the storefront reports that too many links were requested
