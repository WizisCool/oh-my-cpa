# Configuration & Operations

What an operator needs after `docs/install.md`: the settings Oh My CPA reads, the
constraints a deployment must respect, and how the parts that outlive a page visit
behave. Database backup, restore and maintenance from the host have their own runbook,
`docs/ops/sqlite-operations.md`.

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
| `OMCPA_USAGE_RETENTION_DAYS` | `400` | Days of request records kept; the dashboard's heatmap spans a year |

### Update checks and demo

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_UPDATE_CHECK_ENABLED` | `true` | The six-hourly release sweep |
| `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | The check the System Information page makes when opened |
| `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` | `WizisCool/oh-my-cpa` / `router-for-me/CLIProxyAPI` | `owner/name` the checks read, for a fork |
| `OMCPA_DEMO_MODE` | `false` | Serve the console from the built-in fixture; see [Demo mode](#demo-mode) |

The MCP bridge (`oh-my-cpa mcp`) reads `OMCPA_SERVER_URL` and
`OMCPA_CPA_MANAGEMENT_KEY` only; see [Agent and MCP](#agent-and-mcp).

## Deployment constraints

- **Single collector**: The CPA usage queue is destructive. Only one collector may read
  from a CPA instance. If another service collects usage, set
  `OMCPA_USAGE_INGEST_MODE=off`.
- **Single replica**: SQLite WAL requires exclusive single-process access. Run one
  replica mounting the data directory; do not mount over network filesystems
  (NFS/CIFS).
- **Master key**: `OMCPA_MASTER_KEY` is required to decrypt stored credentials and
  payloads. Back it up securely.
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
- **Base path**: Direct OMC serving supports `/omc` or `/`. An operator-owned proxy
  must preserve the prefix; CPA keeps its separate port regardless of OMC's base path.
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

External agents connect through `oh-my-cpa mcp`, a stdio MCP server over the same
capability registry. It reads `OMCPA_SERVER_URL` (the console URL, including any base
path) and `OMCPA_CPA_MANAGEMENT_KEY` (the same management key that signs into the
console); plain HTTP is accepted only for loopback addresses, redirects are refused, and
the bridge itself opens no data directory. There is no separate external credential:
holding the management key is administrator-equivalent, so an external agent can prepare
an operation and read its status but cannot approve it, submit secrets, or complete
OAuth. The read-only database queries and `ask_question` are offered to the built-in
Agent only. Raw SQL results and private model history are omitted from Agent session
responses and run snapshots, and query receipts have no raw-result preview; the selected
model still receives the rows and may use them in its answer or an explicit chart or
table. See `docs/agent-capabilities.md`.

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
recovered before journal expiry may be unavailable.

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

A page a CPA plugin registers is shown inside the console and loaded through
`<base>/api/v1/plugin-host/`, which requires the console session. The server reads the
plugin's resources from CPA and calls the plugin's own management routes with the
management key; the key is never sent to the browser, and CPA's own management roots are
refused there. A plugin page is same-origin with the console and therefore acts with the
signed-in operator's authority, so install only plugins you trust: a plugin already runs
inside the gateway process. Non-`GET` calls a page makes to its plugin are recorded in the
audit trail as `plugin.route_call`. Nothing needs configuring, and CPA does not have to be
reachable from the browser (ADR 0060).

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
