# ADR 0064: Kimi international quota uses one fixed endpoint

- Status: Accepted
- Date: 2026-10-06

## Context

The console supports Kimi international credentials alongside Kimi credentials. A
quota observation must use the account system that issued the credential; trying
both hosts would send the same bearer token to two account systems. The quota
facade already restricts server-initiated CPA `api-call` requests to a compiled
HTTPS allowlist and exposes no arbitrary target to the console or an agent.

## Decision

Add only `https://api.kimi.ai/coding/v1/usages` to `AllowedURLPrefixes`. Unlike an
entry ending in `/`, this entry names one endpoint: `IsAllowedQuotaURL` allows its
query/fragment boundary but refuses appended path segments, lookalike suffixes
and traversal. The international observation is a server-initiated `GET` using
CPA's credential substitution marker, not a browser-supplied token or URL.

`kimiUsageURLFor` selects the international endpoint from the safe credential
metadata (`type`, `provider`, or file name) containing `kimi-ai`, `kimi_ai` or
`kimi.ai`; other Kimi credentials keep the existing `api.kimi.com` usage endpoint.
The selection does not download credential contents and does not probe another
host after a failure.

## Consequences

This grants one additional upstream destination the authority to receive the
selected credential through CPA. Its path is deliberately narrower than the
existing Kimi endpoint-family entry. The allowlist remains compile-time and quota
responses remain normalized DTOs; this does not introduce a general API-call
capability. Further upstream destinations require a separate security review.

`internal/quota/kimi_test.go` pins account-system selection and the endpoint
boundary. No live operator credential is used to establish this contract.
