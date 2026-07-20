<!--
Thanks for contributing to spec-scope.

Your PR title must follow Conventional Commits — release-please reads it to
decide the next version and to generate the changelog.

    feat(diagram): render GIVEN steps as Note over
    fix(parse): ignore scenario headings inside fenced code blocks
    docs: document the actor-detection ceiling

See CONTRIBUTING.md#commits for the full list of allowed types.
-->

## What this changes

<!-- One or two sentences. What is different after this PR that wasn't before? -->

## Why

<!-- The problem, not the solution. Link the issue if there is one: Closes #123 -->

## How to verify

<!--
The steps a reviewer runs to see it working. For parser or diagram changes,
paste the spec snippet and the resulting model or Mermaid source.
-->

```

```

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- [ ] `npm run lint && npm run typecheck && npm test && npm run format:check` passes locally
- [ ] Non-trivial logic ships with a `node:test`
- [ ] New parsing behaviour ships with a fixture under `test/fixtures/`
- [ ] Docs updated where relevant (`README.md`, `docs/architecture.md`, `docs/spec-formats.md`)
- [ ] No absolute local paths, usernames, or email addresses in the diff
- [ ] `dist/` is not in the diff

## Anything else

<!--
Breaking changes, follow-up work you deliberately left out, decisions you'd
like a second opinion on, or "none".
-->
