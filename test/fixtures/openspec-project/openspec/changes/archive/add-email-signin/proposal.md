# Add Email Sign-In

## Why

Shoppers who bought as a guest have no password, and asking them to invent one just to see an
order status was the most abandoned step in the account funnel. A one-time link sent to the email
address already on the order removes that step entirely.

## What Changes

- Shoppers can request a one-time sign-in link for any email address with an order history
- The link is valid for 15 minutes and can be redeemed once
- Requests are rate limited per address and per source network

## Impact

- Affected capability: `auth`
- Affected surfaces: the sign-in page, the transactional mail templates
