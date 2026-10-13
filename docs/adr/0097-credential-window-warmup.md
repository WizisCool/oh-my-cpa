# ADR 0097: Credential window warmup through bounded CPA requests

Status: Accepted

## Context

Codex and Claude subscription windows may remain unstarted after their old boundary
passes. A tiny consuming request can start the next window, but an ordinary model
request may be routed to a different credential. Unknown billing state, duplicate
execution and mistaking a successful HTTP response for activation are material risks.

## Decision

OMC owns opt-in provider defaults, complete credential overrides and durable scheduling.
The existing CPA management api-call transports only two internally constructed POSTs:
Codex Responses and Claude Messages at exact official endpoints. No arbitrary URL,
prompt, request body or credential secret enters this interface. Token substitution and
credential proxy selection remain CPA's responsibility. Quota observation's allowlist
is not broadened into an inference proxy.

Automation requires a manually confirmed and observed activation for the exact
credential and selected model. This is a runtime acceptance gate, not a claim that
mocked requests establish upstream compatibility. An unknown or enabled paid fallback
pauses both manual and automatic consuming requests. Providers without affirmative
billing evidence remain paused. No reset credit or Claude reset grant is spent.

A window's zero usage alone is not idle evidence. Explicit unused windows, and repeated
zero readings whose full-duration boundary slides with observation time, distinguish
idle from a running zero-use window. Fixed boundaries remain active. Only main five-hour
and overall weekly windows participate; model-specific and code-review windows do not.

Daily starts use the effective OMC calendar. A reset request that would overlap the next
daily start waits for it, including a weekly trigger that would also start the five-hour
window. Daily recovery is limited to one hour. Request receipts, cycle suppression and
one daily identity survive process restart. Unknown consuming outcomes are never
replayed automatically. A completed request is verified with a fresh quota read, then at
most two further minute checks; an unconfirmed outcome remains explicitly uncertain.

## Consequences

This adds operational SQLite tables, a background loop and high-risk Agent/MCP writes.
Policies are separate from display preferences. The initial upstream adapter must be
verified by an explicitly consenting operator; deployments need neither a new CPA
endpoint nor a Claude Code installation. A provider protocol change pauses activation
instead of silently selecting another model or bypassing protection. Audit records and
provider-returned token counts describe consuming requests without fabricating ordinary
CPA usage events. Existing reset redemption success remains independent of warmup.
