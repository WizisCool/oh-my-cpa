# ADR 0027: The Agent discloses where its data goes instead of gating on a consent checkbox

- Status: Accepted
- Date: 2026-09-27

## Context

An Agent turn sends the operator's message, and the OMC business data the agent reads to answer
it, to the CPA model the operator selected and on to that model's upstream provider. The first
version of the page required a consent checkbox before every send: the box was never restored,
was cleared whenever the key or model changed, and the run endpoint refused a request without a
`has_consent` flag.

In use the checkbox did not protect anything the page did not already say. The operator is the
administrator of this deployment, chose the model, and is looking at the statement of where the data
goes; the box added a click to every page load and every target change, and a disabled send button
was the most common first experience of the page. The flag the server checked was set by the same
browser the operator was already using, so it attested to a click rather than to an understanding.

## Decision

The Agent page states, on the line beneath the composer, that messages and the OMC data the agent
reads are sent to the selected CPA model and its upstream, and not to enter secrets in chat. Sending
is the act the statement describes; there is no checkbox. The run input no longer carries
`has_consent`, and the runtime no longer refuses a run for its absence - the endpoint refuses the
field as unknown, like any other field it does not model.

Nothing else about the boundary changes: the model never receives the CPA management key or
capability internals, secrets are entered only through an operation card's private input, and
every write still waits for the operator's approval in the browser.

## Consequences

An operator can ask a question as soon as the page opens. The statement of where data goes is
always visible rather than shown once beside a control and then forgotten. A deployment that needs
a recorded, per-session consent would have to add it as a server-side record rather than restore
the checkbox, because a client-set flag cannot serve that purpose.
