# ADR 0089: Rendered component claims below the browser

- Status: Accepted
- Date: 2026-10-09

The existing Go and Node layers cannot observe React Query subscriptions,
optimistic updates shared by mounted readers, asynchronous hook ownership or the
real provider-to-component connection. Browser probes can, but adding every
interleaving to a full-page scenario makes feedback and diagnosis unnecessarily
expensive. The first pilot renders the real preference hook, QueryClient, API
client, feedback surface, token-display provider and context readout; controlled
responses expose the intermediate state rather than merely calling pure functions.

Use a separate Vitest/jsdom/React Testing Library lane for these claims, alongside
(not instead of) existing Node logic tests. Discover `*.component.test.tsx` under
`web/src` automatically. Keep isolated environments and one worker initially,
explicit unmount/global/cache/request cleanup, fail on empty discovery, and reuse
the repository's bounded process ownership and diagnostics. Run the complete
component layer in static/CI verification and for affected frontend changes; add
conservative selection only when measured growth makes it worthwhile.

A separate config avoids the product dev server, proxy, asset staging and editor
workers. Vitest's in-process Vite transformation is not a product HTTP listener.
All dependencies are development-only; production entrypoints, styles, API
contracts and browser scheduling remain unchanged.

jsdom is not evidence of geometry, real focus, scroll, painting, image encoding,
browser history or navigation lifecycle. Keep those in Chromium, including the
settings control's real wiring/reload/phone behavior and cross-stack persistence.
Move a browser claim only after recording its lower-layer owner and a mutation
that proves the replacement catches the fault. The initial pilot strengthens
async coverage and removes no browser assertion. This avoids a wholesale Jest-like
replacement and the false economy of simulated layout or blanket error suppression.

Measurements, fault injections, claim mapping and rollout obligations are in
`docs/plans/architecture-governance.md`; commands and discovery live in
`docs/testing.md`.
