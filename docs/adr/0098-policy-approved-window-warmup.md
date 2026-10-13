# ADR 0098: Policy-approved credential window warmup

Status: Accepted
Date: 2026-10-13
Supersedes: ADR 0097's prior-manual-activation admission rule; its transport, billing,
confirmation, scheduling and uncertainty boundaries remain in force.

An operator's confirmed enabled policy authorizes bounded automatic warmup for the selected
credential and model when current quota and billing evidence permit it. Requiring a prior
observed manual activation leaves newly configured credentials waiting for a second action
and makes activation history obscure real active-window or billing reasons.

Activation observation is therefore an outcome, not a prerequisite. The first reset-driven
or daily automatic request follows the same selected-model availability, exact credential,
affirmatively disabled paid-fallback, quota and durable deduplication checks as later requests.
Defaults remain off. Manual warmup remains optional and explicitly confirmed. A successful
HTTP response is still pending until fresh quota evidence establishes activation; unknown
outcomes are not automatically replayed. An observed unsupported response pauses that model's
automatic requests, while an explicit manual recheck or an approved model change can proceed
when unresolved-outcome and duplicate-request guards allow it.

The existing secret-free state schema and wire fields remain compatible: `protocol_verified`
and `verified_model` retain historical observed activation, without controlling automatic
admission. Previously enabled policies participate on the next eligible scheduler round even
without that history. This broadens admission under existing policy consent, not destination,
billing or credential authority. No new schema migration or upstream endpoint is needed.
