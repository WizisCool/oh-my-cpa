# ADR 0024: The playground persists its single latest session

- Status: Accepted (supersedes ADR 0023)
- Date: 2026-09-27

## Context

ADR 0023 persisted only the playground's target - the client key's usage fingerprint and the call
point - as `playground_selection`. Operators debugging a model also move between browsers and
machines mid-session, and lose their parameters (system prompt, temperature, top_p, max_tokens,
reasoning_effort, User-Agent, custom request body) and the conversation they were reading. At the
same time the playground must not become an unbounded chat-history store: starting a new
conversation has to discard the previous one.

## Decision

Oh My CPA persists the single latest playground session as one UI preference, `playground_session`.
The document holds:

- the target: the client key's usage fingerprint and the call point;
- the generation parameters, including the custom request body as the operator typed it;
- the active conversation's turns, with any inline image larger than the storage limit replaced by
  a placeholder in every copy the turn carries, and each turn's diagnostic events capped.

`playground_selection` is retired: the session document carries the same target, and a second
preference holding a copy of it would be a second source of truth written on every change. The key
is removed from the preference allowlist.

The ADR 0023 rules for the target still hold. The stored fingerprint and call point are used only
after they are validated against the current key list and the live `/v1/models` directory, and a
deleted key or withdrawn call point is not reselected.

Storage goes through the authenticated server-side preferences API (`/api/v1/preferences`), never
browser storage. The page writes the document when a turn settles and after edits pause, never
while a turn is streaming. "New conversation" drops the stored turns and keeps the target and the
parameters.

## Consequences

An operator resumes the same model, parameters and conversation after a reload, on another
browser, or on another machine. The preference remains bounded: one session, redacted images and
capped diagnostics, with the document trimmed from its oldest turn when it would exceed its size
budget. A redacted image cannot be replayed, so retrying a restored turn that carried one is
refused with that reason rather than sending a placeholder upstream.
