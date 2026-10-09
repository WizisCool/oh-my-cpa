# ADR 0090: Handler-certified wire corpora

- Status: Accepted
- Date: 2026-10-09

Use a small reviewed wire corpus for critical API parity, independently asserted
against real Go handlers/authentication/SQLite, the actual typed frontend client,
and the default Browser Mock dispatcher. Preferences is the first pilot: raw JSON
and client-owned enums make a broad generated schema a poor replacement for actual
status, null, readback, allowlist and non-UTC metadata behavior. Shared examples
reduce repeated expected-response maintenance without treating a mock or generated
response as the server oracle.

Move frontend integration suites/setup to `web/tests`, outside the production import
graph but inside type checking and automatic discovery. This supersedes only the
`web/src` test-location choice in ADR 0089: test-only fixture edges must not silently
widen product impact, and a production import of a test remains unresolved and
fail-closed in the product graph.

Reuse the existing frontend integration runner for `*.contract.test.ts` under
Vitest's Node environment; pure decisions stay in node:test, rendered claims stay
in jsdom, and engine/cross-stack claims stay in Chromium. The fixture is per-context
and intentionally bounded: it is not another repository, authorization layer or
complete IANA validator. Unsupported fixture methods remain harness faults.
Corpus/fixture edits must select all independent consumers; full CI retains complete
discovery. This decision does not change any public API or production runtime.

Case ownership, negative mutations, measurements and remaining coverage are recorded
in `docs/plans/architecture-governance.md`; commands live in `docs/testing.md`.
