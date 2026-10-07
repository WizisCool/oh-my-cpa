# ADR 0067: Trusted plugin pages use the native CPA management contract

- Status: Accepted
- Date: 2026-10-07
- Supersedes ADR 0060's core-root refusal, credential replacement, v0-only management
  scope and write-only auditing; retains its same-origin hosting and installation trust decision.
- Ordinary DTO allowlists in ADR 0038 remain unchanged.

## Context

Issue #151 exposed a protocol mismatch rather than a plugin-specific missing feature.
Native pages can read effective configuration, v8 provider groups and the gateway model
directory before calling namespaced plugin state and credential synchronization routes.
The old first-segment denylist refused both native config reads and `/plugins/<id>/state`.
Replacing explicit page credentials with the stored server key also made an invalid plugin
login input appear accepted. Runtime rebasing did not cover v8 management or models.

Masked configuration is not equivalent to native configuration for pages that derive
credential identities from key, proxy, prefix and header material. The operator approved
opening this trusted-plugin boundary in Issue #151. Installing a plugin already allows
its code to execute with CPA's secrets, and its same-origin page has the operator's session.

## Decision

Keep the session-protected host at `<base>/api/v1/plugin-host/` and allow only this
instance's fixed-origin surfaces:

- Plugin resources under `/v0/resource/plugins/<id>/`, without credentials.
- Native `/v0/management/*` and `/v8/management/*` with GET, HEAD, POST, PUT, PATCH and DELETE.
- Only GET `/v1/models`, with caller client Authorization and no server-key fallback.

Deny the arbitrary outbound `/v0/management/api-call` and
`/v8/management/requests/api-call` bridges and their descendants. Reject unclean paths,
traversal, backslashes and controls. Do not accept target URLs. Redirects are not followed;
cookies and Set-Cookie never cross, and content headers remain allowlisted.

Preserve explicit Authorization and X-Management-Key on management calls, even empty
headers, so CPA authenticates the caller's chosen key. Inject the stored management key
only when neither header was supplied. Never place that server key in page resources,
browser storage or the model directory. A plugin may separately ask the operator for a key.

Native API responses are unprojected and may contain configuration secrets. Record every
API read and write as `plugin.route_call` attempt and outcome, retaining only fixed surface,
method and status. Do not record caller suffixes, queries, bodies, credentials or transport
error strings. Failed attempt auditing aborts upstream execution; failed read-outcome
auditing withholds the body. Preserve the success of an already-landed write when outcome
auditing fails. Force API responses to `Cache-Control: no-store`.

Native writes join the existing process-wide provider/config write gate. Authenticate the
caller against the fixed version read before creating an encrypted pre-write config copy;
backup failure blocks mutation. All v8 writes and core v0 writes are conservatively gated,
including plugin config/enabled/quota/store operations. Ordinary deep plugin actions such
as credential synchronization retain plugin-owned execution without the config gate.
Successful native writes invalidate the existing configuration-derived caches. Do not add
OMC revision fields to CPA's wire contract: native writes retain native last-write semantics.

Rebase HTML/CSS/JavaScript and same-origin fetch, Request, XHR and EventSource requests
for all three API surfaces. Leave external origins and already-hosted URLs unchanged.
Demo refuses the whole host; Agent/MCP tools remain the sanitized declared capabilities.

## Consequences and trade-offs

A trusted plugin page can now read raw configuration including client/provider secrets.
This is an intentional documented administrative boundary, not an ordinary DTO relaxation.
Audit availability is required even for native reads. Conservative native-write backup
classification may snapshot operational writes that do not ultimately save config; existing
deduplication avoids duplicate copies. Generic deep plugin mutations remain plugin-owned.

The host provides protocol compatibility, not arbitrary inference, WebSocket transport or
an external URL proxy. EventSource paths are rebased but upstream bodies remain bounded
and buffered; this does not promise indefinite streaming. Plugin behavior and its own
storage policy remain the plugin author's responsibility. Built generic startup tests and
isolated real-plugin smoke complement, rather than replace, each other.
