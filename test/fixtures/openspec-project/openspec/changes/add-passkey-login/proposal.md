# Add Passkey Login

## Why

Password sign-in is the single largest source of support contacts on the storefront, and reused
passwords are the most common cause of account takeover. Platform authenticators are now
available on every browser we support, so shoppers can sign in with a fingerprint or a device
PIN instead of a memorised secret.

## What Changes

- Shoppers can enrol one or more passkeys from the account security page
- Shoppers can sign in with an enrolled passkey instead of a password
- Sessions issued from a passkey sign-in are trusted for the full 30 days without a step-up prompt
- Password sign-in is retired once an account has at least one working passkey

## Impact

- Affected capability: `auth`
- Affected surfaces: the sign-in page, the account security page, the session issuer
- Migration: existing accounts keep password sign-in until they enrol a passkey
