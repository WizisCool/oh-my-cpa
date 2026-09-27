# ADR 0022: A session-authenticated, bounded model playground

- Status: Accepted
- Date: 2026-09-26

## Context

Operators need to test their connected models without copying credentials into another
client. OMC owns the management session; CPA owns inference, provider selection and protocol
adaptation. A browser-side client would expose a gateway key and require a separately
reachable CPA origin. A general management proxy would violate the facade's allowlist.

## Decision

The playground is an authenticated OMC surface calling exactly two configured CPA paths:
`GET /v1/models` and `POST /v1/chat/completions`. The separate
`internal/cpa/gateway` client uses a gateway client key resolved server-side from the
existing usage fingerprint. It never uses the management key for inference and never
follows redirects. The browser cannot supply a destination, arbitrary headers, a tool,
or arbitrary protocol parameters. CPA keeps its normal routing policy.

The OMC facade returns a typed model directory and allowlisted SSE events. Inference is
explicitly user-triggered, never automatically retried. Four process-wide admission slots
bound concurrent validation and calls. The existing server write deadline is extended only
for this route, with bounded upstream idle and total lifetimes and downstream write deadlines.
Cancelling the browser request cancels the upstream request; it cannot promise a billing refund.

Conversations, request snapshots and pasted images live only in the mounted page. They
are neither preferences nor database records. Existing CPA usage collection remains the
source of request history. Links filter by client-key fingerprint, a model-name search and time
rather than claiming an exact correlation. CPA and upstream logging policies remain outside
OMC's ephemeral-content promise.

The model selector uses the call points returned by CPA's live `/v1/models` directory,
not pricing or historical usage; the public demonstration exports that directory from its
loopback fixture and refuses inference in both the API policy and the Worker. No successful response is simulated.

## Consequences

The management session gains the ability to spend entitlement through an existing client
key, without revealing that key. The page explicitly states that cost boundary. Server-side
validation, resource bounds, safe error projections and cancellation are part of the feature,
not optional frontend constraints. There is no conversation schema, retention loop, upload
store, extra credential, or new operator configuration. Protocol expansion or durable
conversation storage requires a new design decision.
