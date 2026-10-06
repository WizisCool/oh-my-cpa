# ADR 0065: Quota observations use fixed Meta and subscription endpoints

- Status: Accepted
- Date: 2026-10-06

## Context

The CPAMC comparison at `ee79a794526a30c03748a8864a9ac6589a31833b`
identified missing Meta Muse quota observations and live xAI and Antigravity plan
readings. CPA's general API-call surface can send credential-bearing requests to
arbitrary destinations. Adding these observations therefore changes an existing
security boundary, even though the console still offers no general API-call tool.

Meta is a special case: `/muse-code/key` returns subscription usage alongside a
minted LLM key. CPA's OAuth access token can already be that LLM key; the endpoint
requires the credential's separately persisted Device Client Access (DCA) token.
Its POST is not a pure read and can mint a key upstream. A credential marker must
not silently substitute the wrong token.

## Decision

Add four individual HTTPS endpoint paths to the compiled quota allowlist:

| Endpoint | Server-owned request |
| --- | --- |
| `https://api.meta.ai/muse-code/key` | POST `{}` with the stored DCA bearer and `x-api-version: 1.0.0` |
| `https://cli-chat-proxy.grok.com/v1/user` | GET with the fixed `include=subscription` query |
| `https://cli-chat-proxy.grok.com/v1/settings` | GET |
| `https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` | POST with `metadata.ideType: ANTIGRAVITY` |

These entries admit no additional path segment or lookalike suffix; existing
URL validation refuses traversal. Neither the browser nor Agent/MCP supplies a
target, method, bearer or arbitrary request body. xAI subscription reads enrich a
successful CLI billing observation, not an API-key health fallback. Antigravity
uses only the daily Code Assist endpoint, without trying extra subscription hosts.
Both providers continue to use CPA's server-side credential substitution.

For Meta only, the Go quota service downloads the selected stored credential from
CPA and extracts exactly its `dca_token`. Missing/invalid DCA tokens and runtime-only
credentials fail without an upstream call; an LLM key or another token field is
never substituted. Token material is request-local and never included in the
normalized DTO, snapshot, audit details, browser state or Agent output. The console
must write an attempt audit before this download and exchange, for individual and
batch observations. Batch selection is trimmed and deduplicated before auditing
or calling CPA, so one credential is exchanged once per request, with at most ten
distinct credentials refreshed. The existing capability engine audits Agent/MCP writes before
execution. An outcome-audit failure does not undo or retry an exchange that already
succeeded. No returned API key is saved back to CPA or retained by OMC.

Decode only plan name, explicit subscription-active state and the two quota
windows from Meta's success document. Discard minted keys and account data. Every
Meta transport, HTTP or decoding failure uses bounded diagnostic text rather than
upstream bodies/errors, which can echo tokens, keys or personal data. Unknown
usage remains unknown, never zero. Unknown subscription-active state remains
absent, not false.

Subscription observations are supplemental: their failure must not discard a
successful independent quota/billing reading. xAI retains its billing fallback
label and extra-usage data when neither plan endpoint answers. Antigravity never
assumes Pro after a failed subscription read; an unrecognized live tier is labelled
with its upstream name/id but graded unknown, and an absent live tier is unknown.

## Consequences and verification

The new authority is four paths, not four hosts or open endpoint families. Meta
refresh is explicitly a key-exchange-backed observation, not advertised as a
side-effect-free read. The console and existing `quota_list`/`quota_refresh` tools
expose only normalized subscription/window fields; no new general proxy capability
or secret-bearing Agent capability is introduced.

The contract is based on pinned CPAMC source and CPA v8.0.2 source, not a live
vendor-account experiment. Hermetic quota tests pin request shapes, DCA selection,
endpoint boundaries, unknown readings and independent subscription failures.
The real-router Meta regression verifies fail-closed auditing and absence of
secrets from responses and stored snapshots. Demo responses remain local fixture
observations and never contact a vendor.
