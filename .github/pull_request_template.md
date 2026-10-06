<!--
Title: type(scope): lowercase subject — e.g. feat(usage): keep dashboard statistics permanently
Leave the PR number out; the squash merge appends it.
-->

## Summary

<!-- The problem, and what this change does about it. Describe the adopted state, grouped by behavior rather than by file. Link issues with "Closes #123". -->

## Documentation

<!-- Name each context document updated per the map in AGENTS.md §2, or state why none is triggered. -->

## Validation

<!-- Tick what was run and add the result. Delete the rows the change cannot reach. -->

- [ ] `pnpm verify`
- [ ] `pnpm check:ui`
- [ ] `pnpm verify:full` — build, embedded distribution, browser harness or workflow changes
- [ ] `pnpm demo:generate` — console data, a route's response shape or a console read changed, and the dataset diff is committed
- [ ] `pnpm readme:screenshots` — a pictured page changed how it looks

## Checklist

- [ ] No API key, token, auth file or production data in the diff, the description or the screenshots.
- [ ] New user-visible copy is in `web/src/i18n/index.tsx` and every catalog under `web/src/i18n/locales/`.
- [ ] Schema changes arrive as a new migration; an architectural trade-off arrives as a new ADR.
- [ ] New API responses go through the `internal/api` DTO allowlists.
- [ ] Screenshots or a recording are attached for visible UI changes.
