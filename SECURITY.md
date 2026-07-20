# Security Policy

## Supported versions

spec-scope is pre-1.0. Only the latest published minor release receives security fixes; there are no long-term support branches.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

Once 1.0 ships, this table will be updated to cover the current major line.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through GitHub Security Advisories:

**[Report a vulnerability](https://github.com/sizzlorox/spec-scope/security/advisories/new)** — or use the **Security** tab on the repository, then _Report a vulnerability_.

This creates a private thread visible only to you and the maintainers. That is the only supported reporting channel; this project does not publish a security contact email address.

Please include:

- The version of spec-scope, and your Node version and OS.
- What an attacker gains, concretely.
- Steps to reproduce, ideally with a minimal spec fixture.
- Any proof-of-concept you have.

### What to expect

| Stage                                                     | Target                           |
| --------------------------------------------------------- | -------------------------------- |
| Acknowledgement of your report                            | within 5 business days           |
| Initial assessment and severity call                      | within 10 business days          |
| Fix released, or a public timeline if it will take longer | within 30 days for high severity |

This is a small volunteer-maintained project, not a vendor with an on-call rotation. These are honest targets, not a contractual SLA. If you haven't heard back within the acknowledgement window, feel free to nudge on the same private thread.

Please give us a reasonable window to ship a fix before disclosing publicly. We'll credit you in the advisory unless you'd rather we didn't.

## Threat model

Knowing what spec-scope does and does not defend against is more useful than a list of promises. In short: **spec-scope is a local developer tool that assumes you trust the machine it runs on and the specs it reads.**

### The local server has no authentication

`spec-scope` starts an HTTP server that reads and writes your specs and notes. It has **no authentication and no authorisation**. Any process on your machine that can reach the port can read every specification in the project and create, modify or delete notes.

This is acceptable only because it binds `127.0.0.1` by default.

**Passing `--host 0.0.0.0` (or any non-loopback address) publishes your unreleased specifications to your entire network, unauthenticated.** On a shared or public network, treat that as equivalent to posting them somewhere public. If you need remote access, put it behind an SSH tunnel rather than binding a public interface:

```bash
ssh -L 4390:127.0.0.1:4390 you@dev-box
```

Against a different threat — a malicious web page open in your browser trying to drive the loopback API — the server does defend itself, and does not rely on CORS alone:

- **Cross-site writes are rejected.** A mutating `/api` request (`POST` or `DELETE`) is refused unless it clears a cross-site write guard. Any one of three independent signals is enough to block it: a `Sec-Fetch-Site` header that is not first-party, an `Origin` that is not one of the server's own authorities, or a `Content-Type` that is not `application/json` (a cross-site page cannot set that content type without a preflight this server never answers).
- **The `Host` header is validated.** Every request must carry a `Host` matching the loopback authorities the server answers to; a mismatch is a `403`. This is a DNS-rebinding defence — it stops a rebound page from reaching the model, which would otherwise leak the absolute project root.

These guards protect the browser attack surface only. They do **not** authenticate a local process that crafts requests directly — that is still wide open by design, which is why the loopback bind is the load-bearing control. If you find a way to drive a mutating request cross-origin, or to get past the `Host` check, that's a vulnerability worth reporting.

### Spec Markdown is untrusted input

spec-scope parses Markdown that may come from a pull request, a dependency, or an AI agent — none of which are trusted. Markdown is rendered as HTML in both the browser UI and the exported tech doc, so malicious spec content is a real XSS vector.

Rendered Markdown is sanitised before it reaches the DOM, and text interpolated into generated Mermaid source is escaped. **A spec file that executes script in the UI or in an exported tech doc is a vulnerability — please report it.**

Path handling is also a concern here: spec-scope resolves spec paths against the detected project root and does not follow references outside it. A crafted spec or request that reads a file outside the project root is a vulnerability.

### Exported tech docs inline third-party JavaScript

`spec-scope export` produces one self-contained HTML file with **Mermaid (~3.5 MB) and Marked inlined verbatim** from your `node_modules`. This is what makes the export work offline with no CDN, but it has consequences:

- The exported file carries whatever those versions carry. If a vulnerability is disclosed in Mermaid or Marked, previously exported documents are **not** retroactively patched — regenerate them after updating.
- The export inherits your dependency tree's integrity. Verify `package-lock.json` the way you would for anything else you ship.
- An exported doc is a static file with active content. Treat sharing one the same way you'd treat sharing any HTML that runs JavaScript.

Notes are included in an export by default; pass `--no-notes` to omit them. Check what you're sending before you send it — discussion notes often contain franker language about a design than the spec does.

### Notes are stored unencrypted

`.spec-scope/notes.json` is plain JSON on disk with normal file permissions. It is not encrypted and not signed. Don't put credentials in review notes.

### Out of scope

The following are known properties of the design, not vulnerabilities:

- Anyone with local filesystem access can read or modify `.spec-scope/notes.json`.
- Anyone who can reach the bound port has full API access — that's why it binds loopback.
- Author names on notes are self-reported and unverified. They are a convenience label, not an identity claim.
- spec-scope makes no network calls and has no auto-update mechanism, so there is nothing to intercept.

## Security-relevant design commitments

These are properties we intend to keep. A change that breaks one is a bug:

- **No network calls at runtime.** No telemetry, no CDN fetches, no update checks. Vendored assets are read from `node_modules` on disk.
- **Loopback by default.** The default host is `127.0.0.1` and will stay that way.
- **Read-only on your specs.** spec-scope never writes to your spec files. It writes to `.spec-scope/notes.json` and, on export, the output file — nothing else.
- **No code execution from spec content.** Specs are parsed as text. Nothing in a spec file is ever evaluated.
