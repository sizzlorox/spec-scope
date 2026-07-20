# Project Context

## Purpose

Sample Storefront is a small online shop used to exercise spec-driven workflows. It sells a
handful of physical goods, keeps a shopping cart per visitor, and takes card payments through a
third-party processor.

## Tech Stack

- TypeScript on the server, rendered templates on the client
- PostgreSQL for orders, carts and accounts
- A hosted payment provider for card capture

## Project Conventions

### Code Style

Two-space indentation, single quotes, no default exports.

### Architecture

The storefront is a single deployable. Domain logic lives under `domain/`, HTTP handlers under
`http/`, and persistence adapters under `store/`. Handlers never touch the database directly.

### Testing

Every capability keeps at least one end-to-end test that drives the real HTTP surface.
