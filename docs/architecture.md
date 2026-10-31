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
CPA usage queue → one collector → sanitized inbox → usage/cost facts
External MCP clients → MCP adapter → the same capability executor
```

| Area | Entry point and responsibility |
| --- | --- |
| Composition | [`internal/app`](../internal/app): startup, services and background lifetimes |
| HTTP boundary | [`internal/api`](../internal/api): authentication, DTOs, routes and audit admission |
| Business operations | [`internal/operations`](../internal/operations): shared console/Agent behavior |
| CPA integration | [`internal/cpa`](../internal/cpa): discovery, management and inference clients |
| Persistence | [`internal/repository`](../internal/repository), [`migrations`](../migrations): transactions, retention and schema |
| Usage and cost | [`internal/usage`](../internal/usage), [`internal/pricing`](../internal/pricing): ingestion, accounting and immutable quotes |
| Credential observation | [`internal/quota`](../internal/quota), [`internal/warmup`](../internal/warmup): quota evidence and approved activation |
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
Keep the management key out of browser persistence and ordinary DTOs.

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
sandbox. The authenticated host deliberately exposes native, possibly secret-bearing
responses only from the configured CPA origin:

- plugin resources under `/v0/resource/plugins/<id>/`, with no injected credential;
- the `/v0/management/` and `/v8/management/` trees;
- `GET /v1/models` with the caller's client authorization, never a server-key fallback.

Reject traversal, malformed paths and arbitrary targets. The outbound `api-call`
bridges and descendants are blocked. Cookies do not cross; redirects are not followed.
An explicit management credential, even empty, is validated locally before CPA is
called. The server key is injected only when neither management header was supplied.

API reads and writes record fixed surface/method/status, not caller path suffixes,
queries, bodies, credentials or upstream transport errors. Responses are `no-store`.
Configuration-affecting native writes join the same serialization and encrypted backup
gate as console writes. Native plugin writes retain CPA's last-write semantics;
do not promise the console's revision-checked editing contract for those calls.
These rules live in `management_plugin_host.go` and
`internal/cpa/management/client_plugin_host.go`; they do not widen ordinary DTOs.

### First-class plugins

The console has two plugin entry points. **Builtins** manages the official plugins Oh My
CPA installs and keeps current from the fixed official repositories in
[`internal/pluginregistry`](../internal/pluginregistry). The **plugin store** lists CPA's official registry and
Oh My CPA's own community registry together, labelling each entry with its source;
community entries stay manual installs that ask for the plugin id. Listing a source is
not an endorsement of the code behind it, and community entries never inherit builtin
management authority.

Builtin management is a default-on desired-state loop, not a one-time grant. The global
switch installs and updates the approved set while it is on, and uninstalls only the
exact OMC-owned copies while it is off. Each builtin can be enabled or disabled like an
ordinary plugin; disabled copies remain installed but unloaded. There is no version pin
or per-plugin removal, because either would make “maintain the latest approved set”
false.

The policy belongs to the CPA binding. Changing the bound address creates a new
default-on policy, while rotating the management key preserves the existing switches.
An entry keeps its origin kind (`official`, `community`, `omc_community`, `builtin`) so a
community source cannot silently stand in for a builtin of the same id. A same-id copy
from another source, or a native file without an OMC install record, is reported as a
source conflict instead of being claimed by precedence. The kind is display origin only
and never grants managed authority.

Because CPA plugins can also be changed by another management panel, OMC runs a
read-only drift check once a minute. It compares the desired policy with the exact
owned install record and native plugin observation; a difference queues the normal
audited reconciliation, which reinstalls, disables, updates or uninstalls as required.
OMC discovers stable GitHub Releases from those repositories, validates the exact
asset names, repository paths and SHA-256 digests, and gives CPA an immutable local
snapshot for installation. A failed release check stops changes for that round.
Previously observed artifact identities cannot change and versions cannot move backwards.
The trust boundary is the official repositories and their release permissions; an
asset checksum protects integrity, not against a compromised publisher.

OMC never writes plugin files. It asks CPA to install and reads back what CPA reports,
so archive layout, checksums and load semantics stay CPA's. Enablement reaches CPA's
configuration through CPA's own operation rather than the console's revision-checked
editor: treat it like a plugin page write, keep unsaved drafts out of the way, and
expect CPA's last-write semantics. The encrypted pre-write backup and adoption rules in
[CPA integration](cpa-v8-compat.md) still apply to these operations; the editor's
revision check applies to editor writes.

### Agent and MCP

The [capability executor](agent-capabilities.md) owns authorization, approval and audit
for both Agent and MCP. Tools opt in to that surface; they do not inherit the plugin
host's authority. Secret input goes through private operator forms, never model-visible
arguments. Read-only SQL uses schema classification and a read-only connection;
redaction after a query is not a substitute for denying sensitive columns.

### Container updates

The console is socket-free, read-only and unprivileged. Only the updater sidecar has
Docker authority. Its authenticated API accepts a product name, not a caller-supplied
image, container or command. OMC replacements verify the signed manifest using the
compiled-in public key and pull its digest; a missing/invalid key never falls back
to trust. CPA replacements pull the running container's configured tag because OMC
cannot sign upstream releases. Version/digest pins are never upgraded.

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
stored file taken immediately before mutation. A failed copy blocks the write.
[CPA integration](cpa-v8-compat.md) explains adoption and legacy-layout handling.

The usage queue is destructive and has exactly one collector. Probe with AUTH, never
with a pop. Persist and sanitize input before deriving facts; report ingestion gaps
rather than inventing events. Request details and decoded inbox rows have retention;
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

The production SPA, fonts, icons and time-zone data ship with the application. No CDN
is required to render it. Preserve the configured base path through routing, assets,
API calls and reverse proxies. Optional upstream/model/reference-data requests do not
make the UI dependent on third-party asset hosting. A Go build without the frontend
contains a placeholder, not a complete release; generated assets are not committed.

The demo uses synthetic data and an explicit route boundary around the real console.
It must not call a live gateway or expose production data. Its dataset is generated
from the actual handlers. [Demo operations](ops/cloudflare-demo.md) owns deployment and
replay details; [Testing](testing.md) owns verification layers and CI scheduling.
