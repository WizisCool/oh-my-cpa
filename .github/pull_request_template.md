<!--
Title: type(scope): lowercase subject — e.g. feat(usage): keep dashboard statistics permanently
Leave the PR number out; the squash merge appends it.
-->

## Summary

<!-- The problem, and what this change does about it. Describe the adopted state, grouped by behavior rather than by file. Link issues with "Closes #123". -->

## Documentation

<!-- Name the documents this change made wrong and updated (AGENTS.md §7), or state that none is. -->

## Validation

<!-- Tick what was run and add the result. Delete the rows the change cannot reach. -->

- [ ] `pnpm test:fast`
- [ ] `pnpm check:ui` — the change touches UI interactions, layout or browser lifecycle
- [ ] `pnpm verify:full` — build, embedded distribution, browser harness or workflow changes
- [ ] `pnpm demo:generate` — console data, a route's response shape or a console read changed, and the dataset diff is committed
- [ ] `pnpm readme:screenshots` — a pictured page changed how it looks

## Checklist

- [ ] No API key, token, auth file or production data in the diff, the description or the screenshots.
- [ ] New user-visible copy is in every language under `web/src/i18n/locales/`, using the terms in `web/src/i18n/GLOSSARY.md`.
- [ ] Schema changes arrive as a new migration; a consequential, hard-to-reverse decision arrives as an ADR (AGENTS.md §4).
- [ ] New API responses go through the `internal/api` DTO allowlists.
