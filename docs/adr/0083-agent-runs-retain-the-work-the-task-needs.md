# ADR 0083: Agent runs retain the work the task needs

- Status: Accepted
- Date: 2026-10-08
- Amends: the Agent request/session sizing policies in ADRs 0042, 0072, 0074, 0075 and 0078,
  and the Agent journal-size and run-duration policies in ADR 0044. Playground keeps its own
  limits and persistence contract.

## Context

An investigation can require more rounds, output or retained evidence than an application-wide
estimate allows. The adopted Agent contract lets the task and operator determine when work ends,
while the upstream provider determines whether a request fits its actual context window. A local
byte-to-token estimate cannot establish that boundary reliably.

## Decision

The Agent has no application-level token, model-round, tool-call, display-count or run-duration
ceiling. Model requests include the active turn's exchanges in full. Earlier settled turns
contribute conclusions and bounded provenance metadata through `buildCompletedTurnMessages`;
the stored transcript remains authoritative and is not trimmed to fit a session-size budget.
Session documents are exempt from the repository's per-document byte bound.

Agent browser-run journals grow with the run instead of cancelling it at a byte ceiling. They
remain process-local, retain the latest completed run for 15 minutes, and are replaced by later
runs. Stop and application shutdown still cancel execution; disconnecting a browser subscription
does not. Direct-stream callers retain request-context cancellation.

Payload validation, authorization, revision-bound approvals and the sandbox are unchanged.
Message/image limits, newest-eight image inclusion, capability result bounds, display payload
validation, 1 MiB SSE lines and the gateway's 120-second header/stream-idle timeouts still apply.
The prompt and catalogue compactness checks are regression assertions, not runtime task budgets.

## Consequences

Long conversations increase database and backup size, serialization cost, memory, model-request
size and upstream charges. A provider can refuse an oversized context; OMC does not silently
remove the active investigation to make it fit. Operators monitor resources, stop active work
when appropriate and start a new conversation to release retained history and images.

This trades a fixed application resource envelope for preserving work. It does not provide
durable background execution: a process restart loses journals and interrupts active runs.
Capability effects already performed are never repeated by replay. Operational guidance belongs
in `docs/operations.md`; ordinary Go and browser recovery tests continue to enforce cancellation,
permission boundaries and the distinct Agent/Playground journal behavior.
