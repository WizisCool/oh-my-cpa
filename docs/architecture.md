# Architecture

OMC is the identity and management layer above CPA, not a second model gateway.
CPA owns protocol translation, credential execution and request routing. OMC owns
names, organization, management projections, usage history and operator workflows.
See the [domain vocabulary](../CONTEXT.md) for terms.

## Runtime and code ownership

```text
Browser → embedded React SPA → OMC HTTP/session boundary
                                   ├─ operations → CPA management/gateway
                                   ├─ repository → SQLite WAL
                                   ├─ Agent → capability executor → operations
                                   └─ updater client → isolated Docker updater
CPA usage stream/queue → collector → sanitized inbox → usage/cost facts
External MCP clients → MCP adapter → the same capability executor
```

| Area | Entry point and responsibility |
| --- | --- |
| Composition | [`internal/app`](../internal/app): startup, services and background lifetimes |
| HTTP boundary | [`internal/api`](../internal/api): authentication, DTOs, routes and audit admission |
| Projected state & SSE | [`internal/statecoord`](../internal/statecoord): in-memory hot projection, 250ms write-behind coalescing and `/api/events` reconciliation |
| Business operations | [`internal/operations`](../internal/operations): shared console/Agent behavior |
| CPA integration | [`internal/cpa`](../internal/cpa): discovery, management and inference clients |
| Persistence | [`internal/repository`](../internal/repository), [`migrations`](../migrations): transactions, retention and schema |
| Usage and cost | [`internal/usage`](../internal/usage), [`internal/pricing`](../internal/pricing): ingestion, accounting and immutable quotes |
| Credential observation | [`internal/quota`](../internal/quota), [`internal/warmup`](../internal/warmup): quota evidence and warmup task scheduling |
| Automation | [`internal/agent`](../internal/agent), [`internal/capability`](../internal/capability), [`internal/mcpbridge`](../internal/mcpbridge) |
| Updates | [`internal/release`](../internal/release) observes; [`internal/updater`](../internal/updater) installs |
| Browser | [`web/src`](../web/src): route-owned pages, shared components, typed API and theme |

Discover individual endpoints from `internal/api/handler.go`, wire shapes from its
DTOs, settings from `internal/config`, and schema from migrations. These are the
executable definitions; prose does not maintain a parallel inventory.

## Security boundaries

### Sessions and ordinary responses

CPA's management key verifies sign-in on the server. Browser sessions use signed,
HttpOnly, SameSite=Strict cookies; browser mutations require the origin check.
A session lasts a working day, or a month when the operator asks to stay signed in;
the expiry is signed into the cookie, and rotating the key ends every session. Keep the
management key out of ordinary DTOs, logs and preferences. The sign-in form is a
standard one (an account field and a `current-password` field), so the browser's
password manager or an extension may offer to save the key; that is the operator's own
manager, acting with their consent. The console writes the key to browser storage in
exactly one place - the entry a CPAMC-native plugin page reads (see
[Trusted plugin pages](#trusted-plugin-pages)) - and withdraws it when the session ends.

Facade responses are handwritten allowlists. Default credential reads return
masks and keyed-HMAC identities. Dedicated editing/reveal/export paths can expose
only their intended credential material after the required audit succeeds; their
caches must not answer ordinary masked reads. Never echo a submitted secret.
Management keys, OAuth tokens and TLS private keys remain outside ordinary responses,
logs and preferences. At-rest secret encryption and identity HMACs depend on the
operator's master key; losing or casually replacing it is not a reset procedure.

Audit admission is fail-closed. If recording the required attempt fails, do not
execute the sensitive action. If recording a credential-read outcome fails, withhold
the body. An upstream write already completed cannot be rolled back by pretending
it failed; preserve that outcome while reporting audit trouble appropriately.

### Trusted plugin pages

Installing a CPA plugin is a trust decision: its same-origin page is not an untrusted
sandbox. A plugin's published logo is drawn wherever its identity is, under one rule: the
installed list, the store's cards, and the identity a catalog entry supplies for an
installed plugin. The store is where an operator decides what to install, so its cards
are not a lesser surface. The browser loads those HTTP(S) images itself, without a
referrer and without OMC proxying a publisher URL: OMC needs no egress route, and a
publisher learns nothing about the console's address. The public demo withholds external
artwork, because its dataset must not make a reader's browser contact a publisher. What
stays refused is a source the browser cannot load as an image: relative paths,
credential-bearing URLs and anything that is neither HTTP(S) nor a bounded inline image.
Trusted image URLs still use the browser's ordinary DNS and redirect behavior.

The authenticated host deliberately exposes native, possibly secret-bearing responses
only from the configured CPA origin:

- plugin resources under `/v0/resource/plugins/<id>/`, with no injected credential;
- the `/v0/management/` and `/v8/management/` trees;
- `GET /v1/models` with the caller's client authorization, never a server-key fallback.

Reject traversal, malformed paths and arbitrary targets. The outbound `api-call`
bridges and descendants are blocked. Cookies do not cross; redirects are not followed.
An explicit management credential, even empty, is validated locally before CPA is
called. The server key is injected only when neither management header was supplied.

A plugin page written for CPAMC reads the gateway credential from browser storage
rather than from its host, so the console mirrors the stored key into the entry CPAMC
keeps its own connection in (`cli-proxy-auth`, obfuscated the way CPAMC obfuscates it)
before the frame loads. Sign-out, a refused session check and the next sign-in withdraw
it; a session that expires while no console tab is open leaves the entry in place until
the console is next opened. That entry is the only
copy of the key the browser holds; ordinary DTOs, logs and preferences still never
carry it, and the plugin host still judges a page's own credential before CPA sees it.
The frame's parent document also carries the console's colour mode and reading
language, which is what CPAMC's own document supplies to a page it embeds.

API reads and writes record fixed surface/method/status, not caller path suffixes,
queries, bodies, credentials or upstream transport errors. Responses are `no-store`.
Configuration-affecting native writes join the same serialization and encrypted backup
gate as console writes. Native plugin writes retain CPA's last-write semantics;
do not promise the console's revision-checked editing contract for those calls.
These rules live in `management_plugin_host.go` and
`internal/cpa/management/client_plugin_host.go`; they do not widen ordinary DTOs.

### Operator-entered provider endpoints

Model-list pulls and connectivity probes may send provider credentials over HTTP
only to localhost, loopback/private IPs, or hostnames whose resolved addresses are
all loopback/private. This supports Docker service names without allowing a name
that resolves to public or mixed public/private addresses. A failed or empty DNS
answer is refused. Direct connections to these hostnames use the checked IPs,
while preserving the configured HTTP Host and same-origin redirect checks, so a
later DNS change cannot move the credential elsewhere.

HTTP hostname requests cannot use a proxy, because proxy-side DNS would bypass
that pinning. Add the hostname to `NO_PROXY` for environment proxies, or configure
a private IP endpoint when the proxy is required. OMC never silently bypasses an
operator-selected proxy. HTTPS and allowed IP-literal endpoints keep their existing
proxy behavior. These server-side requests are separate from optional plugin logos,
which browsers load as images rather than through an OMC outbound proxy.

### Agent and MCP

The [capability executor](agent-capabilities.md) owns authorization, approval and audit
for both Agent and MCP. Tools opt in to that surface; they do not inherit the plugin
host's authority. Secret input goes through private operator forms, never model-visible
arguments. Read-only SQL uses schema classification and a read-only connection;
redaction after a query is not a substitute for denying sensitive columns.

### Container updates

The console is socket-free, read-only and unprivileged. Only the updater sidecar has
Docker authority. Its authenticated API accepts a product name and the selected outbound
route; the updater chooses the image and container.
OMC replacements verify the signed manifest using the
compiled-in public key and pull its digest; a missing/invalid key never falls back
to trust. CPA replacements pull the running container's configured tag because OMC
cannot sign upstream releases. Version/digest pins are never upgraded.

The OMC outbound policy is encrypted separately from preferences and synchronized to
CPA's request proxy with the ordinary audited, revision-checked configuration write.
OMC-owned external clients use that policy without changing internal CPA or updater
connections. Individual provider and OAuth proxies retain their own routing semantics.
Browser-loaded resources and protocols without an OMC-controlled proxy adapter have
separate execution boundaries. Proxy credentials travel in the authenticated updater
control request and are redacted from job errors and logs; authentication alone does not
encrypt that connection.

Selected proxy or direct image downloads run in the updater, which verifies registry
content and streams an image archive to the local daemon. An independently networked
updater can temporarily join the console's network containing
the configured proxy container. It removes that attachment before replacement or handover,
while preserving networks it already belonged to.

A failed replacement health check restores the previous container and image tag.
Namespace dependents require coordinated rebinding; recovery details and limits are
in [Operations](operations.md#console-updates), publication in [Releasing](releasing.md).

## State and request lifetimes

One OMC replica owns each data directory. The normal SQLite pool serializes access;
maintenance takes a write gate so ingestion waits instead of failing. Separate bounded
read-only query and maintenance connections do not authorize a second application
replica. Migrations run forward and back up the WAL-backed database consistently;
audit events and price versions are append-only. See the [SQLite runbook](ops/sqlite-operations.md).

Discovery binds resources by stable, family-scoped evidence, not list positions or
key masks. Missing or rotated credentials must not rewrite historical attribution.
CPA writes use loaded revisions, explicit changed paths and an encrypted copy of the
stored file taken immediately before mutation. A failed copy blocks the write. High-frequency
idempotent settings and enablement switches project into `StateCoordinator` memory with
monotonic versions and coalesce under the same write gate across a 250ms write-behind window;
structural writes drain pending domains before reading or replacing `config.yaml`, and a
failed background flush attempts to reload CPA's authoritative state (marking the projection
unready for lazy re-fetch if CPA is unreachable) and broadcasts a secret-scrubbed
`sync_error` frame on `/api/events` while recording the deferred audit outcome.
[CPA integration](cpa-v8-compat.md) explains adoption and legacy-layout handling.

Probe availability with AUTH, never with a pop. Persist and sanitize input before
deriving facts; report ingestion gaps rather than inventing events. Request details and decoded inbox rows have retention;
dashboard usage facts are permanent. Late arrivals must count once, and unpriced
usage must remain distinguishable from zero. [Pricing](pricing.md) owns cost semantics.

Calendar presets are resolved on the deployment's clock and expressed as instants;
the browser does not reinterpret them in its own zone. Tier billing clocks and quota
reset windows keep their own semantics. Timestamps in older identity tables can be
seconds while usage timestamps are milliseconds; conversions belong at joins.

Agent and Playground execution outlives a browser subscription. Reconnect to the
server-owned journal; only an explicit Stop cancels a running request. Persisted
conversation data is private; browser snapshots exclude model history and sensitive
raw tool results. A restart cannot resume a vanished in-process execution.

## Frontend and distribution

Routes own page state. Shared components and pure utilities do not import a page to
obtain general behavior. Dispose subscriptions, timers and observers by effect lifetime,
including development remounts. Use one dataset for desktop and phone presentations;
keep unsaved drafts separate from server refreshes. See [Design](design.md).

The production SPA ships with the application. Preserve the configured base path
through routing, assets, API calls and reverse proxies. An asset may come from a public
CDN when that is chosen for it; a deployment that cannot reach the CDN must still render
the console, with the asset's local fallback. Plugin publishers may declare
optional HTTP(S) logos; the browser loads those directly, with bundled or neutral
fallbacks when unavailable. The public demo withholds external plugin logos. A Go build
without the frontend contains a placeholder, not a complete release; generated assets
are not committed.

The demo uses synthetic data and an explicit route boundary around the real console.
It must not call a live gateway or expose production data. Its dataset is generated
from the actual handlers. [Demo operations](ops/cloudflare-demo.md) owns deployment and
replay details; [Testing](testing.md) owns verification layers and CI scheduling.
