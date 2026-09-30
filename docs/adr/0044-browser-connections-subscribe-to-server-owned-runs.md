# ADR 0044: Browser connections subscribe to server-owned runs

- Status: Accepted
- Date: 2026-09-30

## Context

A browser stream is not an execution boundary. A weak connection, an offline tab or a page reload
can lose the answer while CPA or a capability finishes its work. Treating every lost stream as a
stopped task is misleading; automatically starting another generation can incur another paid call
or repeat an external write. Agent state is already server-owned (ADR 0041), while Playground
persists its latest display session as a preference (ADR 0024).

## Decision

Console generation requests carry `X-OMC-Run-ID`. The API admits one managed run per workspace
(`agent` or `playground`), detaches its context from the subscriber and writes the existing protocol
into a bounded in-memory journal. Existing clients without this header retain direct-stream
semantics. The same id and byte-identical request attach to the existing run; a changed request
with that id is a conflict. A competing id cannot replace a running task.

Session-authenticated routes under the configured API base provide:

- `GET /agent/runs/active` and `GET /playground/runs/active`: the latest recoverable descriptor.
- `GET /agent/runs/{id}` and `GET /playground/runs/{id}`: replay from the beginning, then subscribe.
- `POST /agent/runs/{id}/cancel` and `POST /playground/runs/{id}/cancel`: explicitly cancel execution.

Subscribers wait on change notifications; their sockets receive 15-second SSE heartbeats. The
browser uses bounded reconnect backoff (500ms through 8s), waits for `online` while offline, and
reconnects a 45-second stalled header/body read. Replay resets the transient reducer first, so
neither partial frames nor already displayed tokens are appended twice. The initial generation
POST is never automatically repeated, even when its acknowledgement was lost. A coded facade refusal, a missing journal
or expired authentication ends recovery rather than starting another generation. Cancel retries
only the idempotent cancel command. Leaving a view aborts only its subscription.

The latest completed journal is available for 15 minutes, until replaced, or until process exit.
Each journal holds at most 4 MiB of streamed output plus one small terminal overflow error. Overflow
cancels the task rather than retaining unbounded output. Detached runs have a 30-minute ceiling;
Playground keeps its tighter existing 10-minute ceiling. Replaced/expired ids are tombstoned for
24 hours with an admission bound of 1,024 entries; a full history refuses new managed work.
Detached workers keep the original HTTP panic boundary and emit only non-secret machine errors.
Application shutdown stops admission, cancels and joins tasks before closing their dependencies.

Agent still persists its authoritative transcript before the final snapshot. Its console projection
excludes private model messages, pending calls and database-query result cells. Playground's
recovery descriptor derives its request and user message from the actual accepted POST, not from a
client-supplied transcript. Only bounded display metadata (`keyLabel`, `replaces_id`) is taken from
`recovery_turn`; large inline images are redacted in every retained descriptor copy. On recovery,
the UI restores the turn's target and settings, replays the journal and persists the settled session
through the existing preference writer. `last_run_id` records which completed journal that session
has already acknowledged, including after New conversation; an old journal cannot resurrect a
cleared conversation. There is no competing backend preference writer.

## Consequences

- Browser loss does not cancel inference or a workflow. Stop is now a server command rather than
  a local HTTP abort; external effects already completed remain completed.
- This is bounded, process-local recovery, not a durable job queue. Restarting OMC ends in-memory
  tasks; Agent exposes uncertain/interrupted stored outcomes and never replays an external write.
  A Playground result not recovered within retention can be lost if its tab never persisted it.
- A replay may repeat view invalidations, which are harmless cache reads, but never executes a
  capability. Only the original task owns execution.
- All recovery routes share console authentication, no-store responses and the existing DTO/privacy
  boundary. The public demonstration returns no active run and refuses subscriptions/cancellation.
- Channel-driven Go tests cover admission, replay, cancellation, expiry, output bounds and shutdown.
  Hermetic transport tests cover lost acknowledgements, partial streams, offline/online, abort and
  authentication; browser probes cover refresh, single-generation recovery, clear-session behaviour,
  the light Stop border and tenths-of-a-second elapsed labels.
