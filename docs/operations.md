# Configuration & Operations

What an operator needs after `docs/install.md`: the settings Oh My CPA reads, the
constraints a deployment must respect, and how the parts that outlive a page visit
behave. Database backup, restore and maintenance from the host have their own runbook,
`docs/ops/sqlite-operations.md`.

## Native deployments

Native releases support Darwin, Windows, Linux and FreeBSD on amd64/arm64. The
executable embeds the SPA and IANA time-zone database, but HTTPS still uses OS
certificate roots. The packaged environment template binds loopback and stores
SQLite in `./data`; run under a dedicated user/service account, preserve its working
directory and restrict environment/data access with Unix permissions or Windows ACLs.
Container uid/gid `10001:10001` is not a requirement for native installs. Leave
`OMCPA_VERSION` unset to retain the injected release tag. Stop OMC before replacing
the executable, keep the master key and data directory, and back up both before an
upgrade. Only a matching data backup can undo forward migrations. The download,
checksum and host configuration steps are in `docs/install.md`.

## Settings

Everything is an environment variable. The binary also reads `.env` from its working
directory (`OMCPA_ENV_FILE` names another file); real environment variables win.
`internal/config/config.go` is authoritative, and a malformed value stops start-up with
a message naming the variable.

### Required

| Variable | Purpose |
| --- | --- |
| `OMCPA_CPA_BASE_URL` | CPA's address, for example `http://127.0.0.1:8317` |
| `OMCPA_CPA_MANAGEMENT_KEY` | CPA's plaintext management key. Also the console's sign-in password |
| `OMCPA_MASTER_KEY` | At-rest encryption key: a 64-character hex key (`openssl rand -hex 32`) or at least 32 bytes |

### Serving

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_VERSION` | embedded stable tag; `v0.1.0-dev` for untagged source builds | Optional display/User-Agent version override; does not change the installed build |
| `OMCPA_LISTEN_ADDR` | `:8080` | Listen address |
| `OMCPA_BASE_PATH` | `/omc` | Sub-path the console is served under. `omc`, `/omc/` and `/omc` are equivalent; `/` serves it at the root |
| `OMCPA_DATA_DIR` | `./data` | Directory holding `oh-my-cpa.db`. Local disk only |
| `OMCPA_PUBLIC_URL` | unset | The address browsers use. An `https://` value marks the session cookie `Secure` |
| `OMCPA_TRUSTED_PROXY_CIDRS` | unset | Comma-separated CIDRs of reverse proxies whose forwarding headers may be trusted for login throttling |
| `TZ` | system zone | Server calendar; see [Time zone](#time-zone) |

### Gateway connection

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_CPA_USAGE_ADDR` | host and port of `OMCPA_CPA_BASE_URL` | `host:port` of CPA's usage stream |
| `OMCPA_REQUEST_TIMEOUT` | `15s` | Timeout for ordinary CPA management calls |
| `OMCPA_CPA_TLS_SKIP_VERIFY` | `false` | Skip certificate verification when CPA uses a private certificate |

### Usage collection

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | `auto`, `subscribe`, `resp_pull`, `http_pull` or `off` |
| `OMCPA_USAGE_IDLE_INTERVAL` | `1s` | First wait after an empty poll |
| `OMCPA_USAGE_MAX_IDLE_INTERVAL` | `10s` | Ceiling the idle backoff grows to. Keep it well below CPA's `redis-usage-queue-retention-seconds` |
| `OMCPA_USAGE_BATCH_SIZE` | `1000` | Records read per poll (1–10000) |
| `OMCPA_USAGE_RETENTION_DAYS` | `90` | Days of request records (the request list and its detail) kept, `0` to keep them all. Ninety matches the request list's longest preset. Dashboard statistics do not depend on it: they are kept permanently as usage facts |
| `OMCPA_USAGE_INBOX_RETENTION_DAYS` | `7` | Days a captured payload is kept after it was decoded into a request record, `0` to keep it as long as the record. Payloads are the largest part of the database and nothing reads them once decoded except a re-decode after a decoder fix |

### Update checks and demo

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_UPDATE_CHECK_ENABLED` | `true` | The six-hourly release sweep |
| `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | The check the System Information page makes when opened |
| `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` | `WizisCool/oh-my-cpa` / `router-for-me/CLIProxyAPI` | `owner/name` the checks read, for a fork |
| `OMCPA_DEMO_MODE` | `false` | Serve the console from the built-in fixture; see [Demo mode](#demo-mode) |

The MCP stdio bridge (`oh-my-cpa mcp`) reads `OMCPA_SERVER_URL`,
`OMCPA_CPA_MANAGEMENT_KEY` and the optional `OMCPA_VERSION` only; the remote MCP
endpoint has no setting of its own. See [Agent and MCP](#agent-and-mcp).

## Deployment constraints

- **Single collector**: The CPA usage queue is destructive. Only one collector may read
  from a CPA instance. If another service collects usage, set
  `OMCPA_USAGE_INGEST_MODE=off`.
- **Single replica**: SQLite WAL requires exclusive single-process access. Run one
  replica mounting the data directory; do not mount over network filesystems
  (NFS/CIFS).
- **Master key**: `OMCPA_MASTER_KEY` is required to decrypt stored credentials and
  payloads. Back it up securely.
- **Framed content**: The console's document declares `frame-src 'self' blob:`. It frames plugin pages from its own origin and the Agent's sandboxed canvases (ADR 0072); a reverse proxy must not replace that policy with one that allows other frame sources.
- **Network security**: Keep CPA on a private network or loopback interface. The supplied
  Compose files publish CPA and OMC only on loopback; use direct local access or an SSH
  tunnel. Public access requires HTTPS through operator-owned infrastructure.
- **Reverse proxy headers**: Set `OMCPA_TRUSTED_PROXY_CIDRS` to the CIDRs of reverse
  proxies whose forwarding headers may be trusted. Both Compose files default to an
  empty trust list. Name only actual proxy peers; leave it unset for direct clients;
  never trust a public range.
- **Gateway version**: The console requires CPA v8.0.0 or later and speaks its v8
  Management API; a gateway older than v8 is refused and every page shows upgrade
  guidance instead. CPA v8 reads an existing v7 `config.yaml` unchanged, so upgrading
  CPA needs no configuration change. The console's first configuration save converts
  such a file to the v8 layout, after keeping an encrypted copy of the original that the
  configuration page offers for download (see `docs/cpa-v8-compat.md`).
- **Base path**: Direct OMC serving supports `/omc` or `/`. The console is served at
  the prefix with a trailing slash (`/omc/`); OMC answers the bare prefix (`/omc`) with
  a 308 redirect to it. An operator-owned proxy must preserve the prefix and route the
  bare prefix as well as everything beneath it (`deploy/nginx.conf` shows both rules;
  `docs/install.md` has the Caddy equivalent); CPA keeps its separate port regardless
  of OMC's base path.
- **Container image**: Compose pulls `wiziscool/oh-my-cpa:latest` from Docker Hub by
  default; the full-stack CPA image also defaults to `:latest`. Pin `OMCPA_IMAGE` to the desired version or digest; updates recreate only
  OMC with its existing data and master key. The image runs as uid/gid `10001:10001`,
  includes its own health probe and needs no mounted deployment scripts. A health
  result of `degraded` keeps the container healthy but does not establish CPA access.
- **Existing CPA and panels**: OMC-only Compose can attach to an existing external
  Docker network. It does not replace the gateway or other panels; collection ownership
  must be resolved separately. See `docs/install.md` and `docs/install-for-agents.md`.

## Time zone

Set `TZ=Asia/Kuala_Lumpur` (or another IANA timezone) in the deployment environment to
choose the server calendar. The supplied Compose files pass `TZ` to both OMC and CPA and
default to `UTC`. For a standalone container, pass `-e TZ=Asia/Kuala_Lumpur`. Native
deployments otherwise use the operating system timezone.

In **OMC Settings → Time zone**, the server zone is selected automatically and marked
**Server time zone**. Every option includes its current UTC offset. A manual choice is
persisted for the deployment; selecting the server zone restores the deployment default.
Timestamp displays, calendar selections, daily totals and OMC service logs use this
setting without rewriting stored instants. Keep CPA and OMC deployment timezones equal:
CPA log lines without an offset are interpreted in that shared timezone. Raw log
downloads and explicit UTC pricing-tier rules retain their source semantics.

## Update checks

The System Information page reports the running and published versions of both Oh My
CPA and your gateway. It reads release metadata from `api.github.com` only — fixed host,
no operator-supplied URL — following `HTTP_PROXY`/`HTTPS_PROXY` like the price sync
does. A sweep runs every six hours; opening the page and the **Check for updates**
button also check, subject to a fifteen-minute floor per product — inside it the answer
comes from the stored index and the message says so, because the feed is one shared
per-address budget.

Two switches, because they answer different questions.
`OMCPA_UPDATE_CHECK_ENABLED=false` stops the sweep on an offline deployment; the page
then keeps working from the last answer it stored, and a check that fails is reported
with its reason and the time it was attempted.
`OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false` additionally stops the check the page performs
when it is opened, which is what an air-gapped or test deployment wants, since a page
visit is not an operator asking a question. The **Check for updates** button works
either way. GitHub's unauthenticated budget is 60 requests per hour for the address
making them, and the page says so when a check is refused for that reason. Release notes
are held in memory rather than stored, so after a restart the page names the versions
and links to the source while the notes themselves are unavailable — see
`docs/architecture.md` §10.

## Database maintenance

The System Information page can truncate the WAL or rebuild the database, and refuses
the second while the first runs. Both wait for in-flight writes rather than interrupting
them, and a rebuild is declined up front when the filesystem lacks the free space SQLite
documents needing (up to twice the database file). A job cannot outlive a restart.
`docs/ops/sqlite-operations.md` §6 covers the same operations from the host.

## Agent and MCP

`/agent` sends the conversation and capability results to the CPA model selected on the
page and its upstream provider; the page states this beneath the message box, and the
choice of key, model and reasoning effort is remembered as a server-side preference.
A message may carry up to four PNG, JPEG or WebP images of at most 5 MiB each, beside up
to four text files (40 KiB together). Images are stored encrypted in `agent_documents`
for as long as their turn is part of the conversation, are sent to the model with every
round while they are among the conversation's newest eight, and are read back by the
console from `GET /api/v1/agent/images/{id}` under the console session only.

Agent runs and sessions are open-ended: OMC applies no token, round, tool-call, display-count,
run-duration or session-size ceiling. Provider context/output limits and capability payload and
security checks still apply, as do the gateway's 120-second response-header and stream-idle
timeouts and 1 MiB SSE-line limit. Completed turns send conclusions with bounded metadata to later
rounds, while the stored transcript is retained until reset or explicit replacement. A long
conversation increases SQLite and backup size, serialization work, memory and upstream request
cost. Use Stop to end active work and New conversation to release the retained transcript and
images; monitor disk and process memory on the single replica. Image admission failure attempts
to clean up only newly written image rows; database failures can prevent that best-effort cleanup.

External agents connect over MCP to the same capability registry, in one of two ways:

| Transport | Address | Credential |
| --- | --- | --- |
| Streamable HTTP, served by the console | `<console URL>/api/mcp`, for example `https://omc.example.com/omc/api/mcp` | `Authorization: Bearer <CPA management key>` |
| stdio, the `oh-my-cpa mcp` bridge process | `OMCPA_SERVER_URL` (the console URL, including any base path) | `OMCPA_CPA_MANAGEMENT_KEY` |

The HTTP endpoint needs nothing installed where the agent runs; the **Connect** action at
the top of `/agent` shows the deployment's address and copyable client
configuration. It accepts the management key as a bearer token only (a console session
cookie is refused), throttles wrong keys per client address like the login form, keeps
no MCP session, answers each request in plain JSON, and is refused in demo mode. A
reverse proxy needs no special rule beyond forwarding the base path; serve it over
HTTPS, because the endpoint cannot tell that TLS was terminated in front of it. Clients
that require OAuth discovery cannot use it and use the bridge instead.

The stdio bridge is for clients that only speak stdio. It accepts plain HTTP only for
loopback addresses, refuses redirects, opens no data directory, and prints its usage for
`oh-my-cpa mcp --help`.

There is no separate external credential: holding the management key is
administrator-equivalent, so an external agent can prepare an operation and read its
status but cannot approve it, submit secrets, or complete OAuth. A prepared change
returns `status: "pending"` with a link to `<console URL>/authorize/<id>`, a
standalone authorization screen where the signed-in operator (signing in first if
needed) allows or denies that one operation; `omc_operation_status` reads the
outcome and can wait up to 30 seconds for the decision (`wait_seconds`). The read-only database queries and `ask_question` are offered to the built-in
Agent only. Raw SQL results and private model history are omitted from Agent session
responses and run snapshots, and query receipts have no raw-result preview; the selected
model still receives the rows and may use them in its answer or an explicit
`render_ui` display. See `docs/agent-capabilities.md`.

## Model playground

Open **Operate → Playground** under the configured base path. Select an existing client
key and a call point from the live `/v1/models` directory; if no key exists, create one
in Key management first. The page reads `GET <base>/api/v1/playground/models` and sends
explicit turns through `POST <base>/api/v1/playground/chat`; both require the normal
administrator session. No additional environment variable or database migration is
required.

Real requests consume quota under the selected key. Stop cancels the connection but does
not guarantee a refund. The single latest conversation, its parameters and its attached
images are stored as a server-side preference so a reload resumes where you left off;
starting a new conversation discards the stored turns, and image payloads too large to
store are redacted rather than saved. The stored target is the key's usage fingerprint,
never the key itself, and a key or call point that no longer exists is not reselected.
CPA and upstream logging policies still apply. PNG/JPEG/WebP inputs allow four images
per turn, 5 MiB and 40 megapixels per image, and a 32 MiB request including history.
Capability is not guessed from the model name.

The parameter panel takes a system prompt, reasoning effort, temperature, top-p, maximum
output tokens, a User-Agent, and a custom JSON request body. The User-Agent defaults to
this build's own version and is sent as a header, so an upstream sees which build called
it. The custom request body has the highest priority: its keys override the panel's
parameters and any parameter the panel does not model passes through unchanged, but the
resulting request is validated before it is sent, so an override cannot bypass the image
and parameter limits. A non-streaming body is rejected, as this page reads a streamed
answer.

Keep reverse-proxy streaming unbuffered and its read timeout above the 15-second
heartbeat interval. The dedicated stream can last ten minutes, with a 120-second
upstream first-response or idle timeout. Ordinary API timeouts are unchanged. Request
diagnostics never return credentials; copied cURL needs CPA_BASE_URL, CPA_API_KEY and
replacement image data URLs. The public demonstration shows the page and model directory
but refuses inference.

## Recovering Agent and Playground runs

Weak connections and page refreshes reattach to the original server task rather than
resend a model call or workflow. Stop explicitly cancels that task; closing the page
does not. The latest completed replay journal is retained for 15 minutes, until another
run replaces it or OMC restarts. Agent keeps its authoritative transcript; Playground
saves the recovered result into its existing latest-session preference. Results never
recovered before journal expiry may be unavailable. Agent replay journals grow with output and
have no byte ceiling or execution deadline; Playground retains its bounded journal and
30-minute wrapper deadline (the Playground handler's 10-minute deadline still applies).
An active Agent run therefore consumes memory until it finishes
or is stopped, and its completed journal remains subject to the retention window above.

Console-authenticated recovery endpoints under the configured API base are
`GET /agent/runs/active`, `GET /agent/runs/{id}`, `POST /agent/runs/{id}/cancel` and
their `/playground/runs/` counterparts. Generation POSTs carry `X-OMC-Run-ID`; clients
without that header keep direct-stream semantics. Recovery does not grant extra
capability permissions.

## Custom provider icons

Open the provider icon picker and choose **Custom** to upload a PNG/JPEG/WebP/SVG file
or paste Base64 (with or without an image Data URL prefix). Validate the preview, save a
name, then select the icon. Saved icons can be renamed or replaced; replacement updates
all assignments. Deletion is available even for an icon in use: confirmation shows its
reference count, and deleting it automatically restores affected providers to their
default icons or placeholders. The deployment stores up to 100 static icons, each at
most 512 KiB, with raster dimensions at most 1024 × 1024. Icons persist in SQLite and
are covered by the usual database backup; no separate uploads directory or external
image service is required. Plugin-owned providers retain their plugin branding. Uploads,
edits and deletion are disabled in the public demo.

The authenticated API adds `/custom-icons` (GET/POST), `/custom-icons/preview` (POST),
`/custom-icons/{id}` (PATCH/DELETE) and `/custom-icons/{id}/content` (GET/HEAD) below
the configured API base. Image content is not included in ordinary list or preference
responses.

## TPS calculation mode

OMC Settings → Display chooses whether request-record and Playground TPS includes
first-token latency. The default excludes it when the remaining window is at least
50 ms; otherwise it falls back to total latency. Including it always uses total latency.
The server-stored `omc_tps_calculation_mode` preference (`exclude_ttft` /
`include_ttft`) also supports Agent/MCP reads and writes; historical timing and usage
remain unchanged.

## Plugin pages

A trusted installed page loads through `<base>/api/v1/plugin-host/` behind the console
session; CPA need not be reachable from the browser. It can use CPA-native v0/v8 management
routes and the fixed model directory, including configuration containing client and provider
secrets. Install only plugins you trust: the page is same-origin with the console and acts
with the signed-in operator's authority, while the plugin already runs inside CPA.

A plugin page may ask for a management key of its own. The host compares a page's explicit
Authorization or X-Management-Key with the stored CPA management key and answers a wrong one
`401` itself; the wrong key is never sent to CPA, so it cannot count toward CPA's
failed-attempt ban (five failures ban the client address for 30 minutes, and the console
and every hosted page share one address). Only the key stored for the instance is accepted
there. CPA has a single configured key, not a list, but may also honour `MANAGEMENT_PASSWORD`
and a loopback-only `--password`; when those differ from the stored key, enter the stored one. When both
headers are absent, management calls use the stored key; resources carry no key, and
`GET /v1/models` uses only the page's client Authorization. OMC does not publish or store its management key in browser storage;
a third-party page may independently ask for and store a key the operator supplies.

API reads and writes are audited as `plugin.route_call` and responses are uncached.
Configuration-affecting native writes are serialized with console writes and require a
pre-write configuration backup; a backup failure blocks the mutation. All v8 writes and known core v0 writes are conservatively
classified for these gates; ordinary deep plugin actions such as credential synchronization
remain plugin-owned. Native config writes retain CPA's last-write semantics, so do
not concurrently edit the same configuration in a plugin and an unsaved console draft.
Cookies and Set-Cookie are excluded, redirects are not followed, and arbitrary outbound
`api-call` bridges are refused. These routes remain unavailable in demo and are not Agent/MCP
capabilities (ADR 0067).

## Demo mode

`OMCPA_DEMO_MODE` (default `false`) serves the console from a built-in fixture instead
of a CPA, so it needs no management key and no provider credential. Its storage is not
durable — the database is deleted and rebuilt on every boot — and the server refuses
sign-in flows, credential movement, plugin execution and plugin pages, gateway configuration writes and
anything that would leave the process. It opens at the site root rather than `/omc`
unless `OMCPA_BASE_PATH` says otherwise. A visitor's theme stays in their own browser:
a demonstration is shared, so it is neither sent to the server nor read from it.

```bash
pnpm build
OMCPA_DEMO_MODE=true go run ./cmd/oh-my-cpa
```

This mode is what generates the public demonstration's dataset, so it stays in use even
though the public deployment does not run it; `OMCPA_PUBLIC_URL` states that
deployment's origin. The public demo is the same console as static assets with its API
answered by a Cloudflare Worker from that generated dataset: `docs/ops/cloudflare-demo.md`
is its runbook, `docs/architecture.md` §13 and
[ADR 0021](adr/0021-the-public-demonstration-is-generated-data-behind-the-real-console.md)
record why.

## Available model directory

The authenticated `/model-square` route reads `GET /api/v1/management/model-square`
(relative to the deployment base path). The server uses the first nonempty configured
client key to read CPA's live `/v1/models`; no key returns `client_key_required` (409).
No client or upstream secret is returned. Configuration enriches only advertised IDs,
with partial conditions for unavailable model definitions or mappings. Refresh rereads
CPA; it does not make a paid model request.

Model specifications come from the bundled models.dev snapshot in
`internal/modelcatalog/snapshot.json`. Run `pnpm models:sync` when maintaining a release
to update it from models.dev's canonical model data and exact source aliases, then run
`pnpm demo:generate` because the snapshot changes the demonstration's response. There
is no runtime synchronization loop or new environment setting. The page displays the
snapshot date and unknown fields, and renders without browser catalog/CDN requests.
External reference links are user-initiated navigation. Pricing remains on its existing
OpenRouter source and is not synchronized by viewing Model Square. The page additionally
reads the existing `GET /api/v1/pricing` and `GET /api/v1/usage/facets?preset=24h` to show
each name's price and recent requests; if either fails, the directory still renders and
those cells stay blank.

## OAuth model rules

Open **Model rules** in OAuth management to edit CPA's provider-wide aliases or
model exclusions. These settings affect every OAuth/file-backed credential of
the selected provider, not just one file. Exact exclusions and `*` patterns match
case-insensitively; `*` excludes all models. Exclusions run before alias mapping,
so aliasing an excluded upstream model does not make it available again. Use the
credential configuration tab for an individual file's exclusion fields.

The facade exposes GET/PATCH at `/api/v1/management/auth-files/model-aliases` and
`/api/v1/management/auth-files/excluded-models`. An exclusion PATCH carries
`provider` and `models`; an empty `models` array removes that provider's rules.
The provider model catalog is read at
`/api/v1/management/auth-files/provider-models?provider=codex`. Without a catalog,
the editors still accept typed names. A successful write requires CPA readback;
changes are serialized with other whole-config writes, backed up and audit logged
(`oauth_model_alias.update` or `oauth_excluded_models.update`). Demo mode allows
reads but refuses durable changes.

## Kimi international quota

The `kimi-ai` connection method uses the international Kimi account system. Its
quota observation is a server-initiated `GET` to the compiled, single-endpoint
allowlist entry `https://api.kimi.ai/coding/v1/usages` (ADR 0064). Domestic Kimi
credentials continue to use `https://api.kimi.com/coding/v1/usages`. Selection
uses credential type, provider and file name; the console does not download the
token to detect an account system or retry the token against the other host.
Neither the browser nor Agent/MCP can supply an arbitrary upstream target.

The usage document is decoded in both shapes Kimi publishes. Counted limits
(`limits[]`, or a lone `usage` object) carry absolute usage, and the newer ratio
pools under `usages` state a share instead: each pool's period is read from its own
key, with the monthly Total pool the common case for a plan without a weekly limit.
A counted limit that already describes a period wins it, because it carries the
absolute usage a share cannot, and a pool states no counts of its own. A pool key
naming no known period keeps its own name as an unclassified window rather than
being filed under a period it does not describe (ADR 0071).

## Meta quota and live subscription tiers

A Meta Muse quota refresh requires a stored credential with a valid `dca_token`.
OMC downloads that credential server-side and sends a fixed POST to
`https://api.meta.ai/muse-code/key`; runtime-only files and missing DCA tokens are
not replaced with an LLM API key. This endpoint can mint a key while reporting
quota. OMC discards returned keys and account fields, does not update the stored
credential, and records an attempt audit before downloading or calling it.
Audit unavailability refuses the operation. Batch refresh trims and deduplicates
auth indexes before auditing or exchanging keys, preserving first-seen order
and refreshing at most ten distinct credentials. The reading includes the usage window,
weekly window, plan name and explicit active/inactive state when supplied. Missing
shares are unknown, not a zero-used or fully-available quota.

xAI reads both CLI billing documents on `cli-chat-proxy.grok.com`: the credits
document (`/v1/billing?format=credits`), which carries a subscription's own window
and the period that percentage belongs to, and the metered ledger (`/v1/billing`),
which carries the account's monthly limit and spend. A subscription account
publishes nothing in the ledger, so both are read and the period stays atomic: a
window and its reset come from one document, and the ledger's figures arrive beside
it as extra usage. Subscription names come from fixed
`/v1/user?include=subscription` and `/v1/settings` requests after a successful
billing read, and API-key health fallback does not initiate them. Antigravity tiers
come from the daily host's `loadCodeAssist` endpoint, with paid tier taking
precedence over current tier. If these supplemental reads fail, usage remains
readable: xAI keeps its billing fallback, while Antigravity shows an unknown tier
rather than assuming Pro. New endpoints are individually allowlisted and neither
console nor Agent/MCP accepts a caller-chosen URL (ADR 0065, ADR 0071).

A refresh that succeeds without publishing any window is recorded as an
`unpublished` reading rather than as a credential nobody has read, and the console
says so with its own status and copy. Every provider's window parser can produce
that reading, and it is what an unrecognized upstream document shape now surfaces
as (ADR 0071).

## Credential management actions

`POST /api/v1/management/auth-files/refresh` accepts `name` and `auth_index` for
one credential. The console's selected-credential action runs bounded individual
refreshes and reports each outcome; CPA still owns its scheduled token renewal.
The response contains status only, never CPA's refreshed token payload.

`POST /api/v1/management/auth-files/vertex-import` accepts the service-account JSON
as its request body and an optional `location` query (CPA defaults to
`us-central1`). A second import for the same project replaces its credential.
The console previews the project/account and accepts files up to 64 KiB; the
backend bounds the body with the existing 16 MiB auth-file upload limit. The
response contains file name, project, account address and location, not key bytes
or CPA's filesystem path. Closing the dialog invalidates an unfinished file read
and clears its selected key; key bytes are not cached as mutation arguments.

Both actions require the console session, are refused in demo mode, and must
record an attempt audit before calling CPA. If the success audit fails after CPA
has completed the action, the successful action remains successful; the audit
failure is logged without tokens or uploaded key material.
