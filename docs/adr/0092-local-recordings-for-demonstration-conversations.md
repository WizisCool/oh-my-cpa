# ADR 0092: Local recordings for demonstration conversations

- Status: Accepted
- Date: 2026-10-10
- Amends: ADR 0021's read-only public demonstration with browser-local conversation replay.

## Context

A static public demonstration cannot expose provider credentials or spend model entitlement.
Disabling the Agent and Playground composer also hides their streaming, capability-chain and
generated-interface behavior, which are important parts of the console.

## Decision

Offer one localized recorded question per workspace. The Agent recording is an optimized,
sanitary transcript of a recorded run: dates are relative placeholders, execution handles do
not confer authority, and tool results contain demonstration data. Replays emit the same
AG-UI or Playground event vocabulary that the production reducers read, including argument
streaming, reasoning, capability receipts, usage and final conversation snapshots.

The browser owns pacing and cancellation. It makes no inference or Agent write request.
Other messages are refused before acceptance. Agent conversations live only for the page
lifetime; Playground retains its existing browser-local demonstration session behavior.
Reload, cancellation, retry and a new conversation never create a provider request. The
Worker's server-side write refusals remain authoritative.

The public token fixture spans the full calendar year. Daily volume is a deterministic normal
draw around a steady trend, with explicit idle days and quieter weekends; failed requests
still preserve plausible usage semantics. The result is synthetic, not production traffic.

## Consequences

The visitor can observe the production renderer without a live provider. A replay is a curated
example, not an answer to an arbitrary visitor request. Recordings are public assets and pass
privacy checks alongside generated handler responses. Node tests own event fidelity and
cancellation; built demo acceptance owns the rendered chain, generated UI and answer.
