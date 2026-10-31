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
| `OMCPA_BASE_PATH` | `/` | URL prefix. The default serves the console at the root; a configured sub-path is normalised without a trailing slash |
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
| `OMCPA_USAGE_RETENTION_DAYS` | `90` | Days of request records (the request list and its detail) kept, `0` to keep them all. Ninety matches the request list's longest preset. Dashboard statistics do not depend on it: they are kept permanently as usage facts. A retention saved in OMC Settings → Data retention replaces it without a restart |
| `OMCPA_USAGE_INBOX_RETENTION_DAYS` | `7` | Days a captured payload is kept after it was decoded into a request record, `0` to keep it as long as the record. Payloads are the largest part of the database and nothing reads them once decoded except a re-decode after a decoder fix. |

### Update checks and demo

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_UPDATE_CHECK_ENABLED` | `true` | The six-hourly release sweep |
| `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | The check the System Information page makes when opened |
| `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` | `WizisCool/oh-my-cpa` / `router-for-me/CLIProxyAPI` | `owner/name` the checks read, for a fork |
| `OMCPA_DEMO_MODE` | `false` | Serve the console from the built-in fixture; see [Demo mode](#demo-mode) |
| `OMCPA_UPDATER_ENABLED` | `true` | `false` makes the console ignore an updater and offer no update action; see [Console updates](#console-updates) |
| `OMCPA_UPDATER_URL` | `http://oh-my-cpa-updater:8090` | Where the console looks for the updater. The default is the service and container name every install method uses |
| `OMCPA_GOOGLE_FONTS_URL` | `https://fonts.googleapis.com` | The Google Fonts stylesheet API the font library installs from, or a compatible mirror for a deployment that cannot reach Google. Requests honour `HTTPS_PROXY`; font files are downloaded only from Google's font hosts or the mirror's own site. Used only when an operator installs a family; uploading needs no network |

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
- **Framed content**: The console's document declares `frame-src 'self' blob:`. It frames plugin pages from its own origin; a reverse proxy must not replace that policy with one that allows other frame sources.
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
- **Gateway configuration**: Omitted request retries and maximum cooldown wait
  both mean `0`; the example's `3` and `30` apply only when explicitly configured.
  Header passthrough forwards filtered upstream response headers to clients.
  See the configuration editor for supported settings and [CPA integration](cpa-v8-compat.md) for write semantics.
- **Base path**: New installations serve the console at `/`. A configured
  `OMCPA_BASE_PATH` is served with a trailing slash; OMC answers the bare prefix with
  a 308 redirect to it. An operator-owned proxy must preserve a configured prefix and
  route both the bare prefix and everything beneath it. At the root, the proxy forwards
  the site unchanged (`deploy/nginx.conf` and `docs/install.md` show examples); CPA
  keeps its separate port regardless of OMC's base path. A deployment copied from an
  older minimal example that relied on the former implicit `/omc` default without
  setting the variable must add `OMCPA_BASE_PATH=/omc` before replacing the image if
  it must retain that URL.
- **Container image**: Compose pulls `wiziscool/oh-my-cpa:latest` from Docker Hub by
  default; the full-stack CPA image also defaults to `:latest`. Pin `OMCPA_IMAGE` to the desired version or digest; updates recreate only
  OMC with its existing data and master key. The image runs as uid/gid `10001:10001`,
  includes its own health probe and needs no mounted deployment scripts. A health
  result of `degraded` keeps the container healthy but does not establish CPA access.
- **Existing CPA and panels**: OMC-only Compose can attach to an existing external
  Docker network. It does not replace the gateway or other panels; collection ownership
  must be resolved separately. See `docs/install.md` and `docs/install-for-agents.md`.

## Rotating the CPA management key

The CPA management key is deployment-owned: it authenticates OMC's management
clients and usage collector, signs console sessions, and authorizes remote MCP
calls. The visual configuration editor shows it read-only; OMC refuses ordinary
configuration writes or backup restores that would change it. A CPA-only write
would leave the running clients and login verifier on the old value, and an
unchanged `OMCPA_CPA_MANAGEMENT_KEY` would restore that value on the next start.

Trusted plugin pages are the native-response exception. A Plugin Host request can
reach CPA's native configuration tree, including `/v8/management/config.yaml`, so
it can change the management key without this check. Do not rotate the management
key through a plugin.

Rotate both processes from one deployment change:

1. Back up the environment file and OMC's data directory.
2. Set CPA's management key and OMC's `OMCPA_CPA_MANAGEMENT_KEY` to the same new
   value. In the full-stack Compose file, set `CPA_MANAGEMENT_KEY` once: it supplies
   both CPA's `MANAGEMENT_PASSWORD` and OMC.
3. Recreate both Compose containers so they load the updated environment:
   `docker compose up -d --force-recreate cpa oh-my-cpa`. `docker compose restart`
   keeps the old container environment and is not sufficient.
4. Sign in with the new key. Sessions signed with the old key are invalid.

For an existing CPA on separate hosts, update its `management.secret-key` (or
`MANAGEMENT_PASSWORD`) and OMC's environment in the same maintenance window, then
stop and start both processes so they load the new values.

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

When either product has a newer published release, the **System Information** entry in
the navigation carries a small amber dot. It reflects the stored answer and costs no
request of its own, so it appears once a sweep or a check has found the release; an open
console re-reads that answer hourly. **Ignore this version** on the product's row clears the
dot for that one release and is remembered by the deployment, not the browser; pressing it
again restores the reminder, and a later release is flagged regardless.

The header's GitHub link shows the project's star count, read by the server from the same
host and held in memory. It costs at most one request an hour: the sweep refreshes it, and
so does a console page load when page-load checks are allowed. With both switches below
off, or until a first read has succeeded, the link simply shows no count. Once a read has
succeeded the count stays for the life of the process: a refresh that fails keeps the
previous count.

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
and links to the source while the notes themselves are unavailable.

## Console updates

On a container deployment with an updater, the System Information page offers
**Update now** beside a product that has a newer release. `docs/install.md` ("Upgrading")
is the operator's guide, including the one command that adds an updater to a deployment
that predates it.

The updater is the Oh My CPA image run as `oh-my-cpa updater serve`. It listens on
`:8090` inside the Docker network and publishes no port. Its settings are read from its
own environment, and an installation needs none of them:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_UPDATER_LISTEN_ADDR` | `:8090` | Listen address inside the container |
| `OMCPA_UPDATER_SOCKET` | `/var/run/docker.sock` | The Docker socket as mounted in the container |
| `OMCPA_UPDATER_OMC_CONTAINER` | found by image | The console container, when more than one Oh My CPA runs on the host |
| `OMCPA_UPDATER_CPA_CONTAINER` | found from `OMCPA_CPA_BASE_URL` | The gateway container, when it cannot be found that way |
| `OMCPA_UPDATER_SELF_CONTAINER` | found from hostname or a unique updater | This updater's own container name or ID. Handover sets it to the successor's stable name because shared network namespaces inherit the owner's hostname |
| `OMCPA_UPDATER_LINK_NETWORK` | empty | Set by `updater install`: the network the updater keeps the console attached to. Empty when both are services of one Compose file |
| `OMCPA_UPDATER_PUBLIC_KEY` | built in | Base64 Ed25519 public key that replaces the built-in release key, for a fork that signs its own releases |

Security boundary:

- The updater holds the Docker socket, which is control of Docker on that host. The
  console does not, and stays read-only and unprivileged. Anyone who can already run
  `docker` on the host gains nothing; anyone who can reach the updater's port without
  its token gets `401`.
- The token is an HMAC of `OMCPA_MASTER_KEY`. Neither container stores it, and it is
  not logged. Changing the master key needs no step here: the updater reads the
  console's current value from Docker.
- The updater accepts a product name only. It never takes an image, a container name or
  a command from the console. It identifies the two products from Docker state and
  refuses to upgrade an image pinned to a version tag or digest. Replacing a namespace
  owner also recreates its running `network_mode: container:<owner>` dependents, even
  across Compose projects; stopped containers are left alone.
- Oh My CPA is replaced only by the image a release's signed manifest names, and never
  by an older version. CLIProxyAPI is an upstream image this project cannot sign: its
  update pulls the tag the container already uses.
- A build without the release public key reports `signature_unavailable` and offers no
  console update for Oh My CPA.

Namespace rebinding preserves each dependent's exact running image, mounts and settings;
it does not resolve a floating tag again. The `io.oh-my-cpa.image-reference` container
label retains the configured image reference while Docker records an immutable image ID,
so future update discovery and version pins keep their meaning. An updater following a
signed console update may use that verified image; a pinned updater keeps its own image.

Automatic rebinding supports direct dependents of a container-owned namespace. Updates
are refused before pulling or stopping anything if a running container joins indirectly
through another dependent, or if the target itself uses a shared or host namespace and
has dependents. Configure shared helpers to reference the actual namespace owner
directly, or recreate this topology on the Docker host.

An existing `<name>-omc-previous` backup also blocks another update before mutation.
When a self-handover cannot start its successor, the running predecessor restores the
previous owner and retries from that live namespace. If that restore also fails, recover
the updater from the Docker host rather than restarting it in the dead namespace. In the
ordinary interrupted-replacement case, restart the updater to run startup recovery before
retrying that product. New jobs are refused while the current updater is handing over to
its successor.

Dependents rejoin in Compose dependency order. They must also rejoin after a failed owner
update restores the original container, because restarting that owner creates a new
network sandbox. The owner backup remains until rebinding finishes, or until the
successor updater completes startup recovery. A helper failure is reported in the job
without blocking the updater's own handover. A dependent that cannot rejoin remains
stopped under its original name and needs to be recreated on the Docker host. Containers
that were already stopped before the update are not started by this process.

Network use: applying an Oh My CPA update makes the console download
`release-manifest.json` and its `.sig` from the release's assets on `github.com`,
following redirects only to GitHub's own asset hosts over HTTPS, through the same proxy
settings as the update check. The image pull is made by the Docker daemon with its own
registry and proxy configuration.

Audit: `system.update.apply` records the admission, or the refusal with its reason,
before the updater is asked; `system.update.completed` records how that admission ended:
the job's outcome, or the updater's refusal or silence when no job started. An Oh
My CPA update, or a CLIProxyAPI update when the console shares its network namespace,
ends the process that admitted it, so the next process follows the job from start-up and
records the outcome once the updater reports it finished.

## Database maintenance

The System Information page can truncate the WAL or rebuild the database, and refuses
the second while the first runs. Both wait for in-flight writes rather than interrupting
them, and a rebuild is declined up front when the filesystem lacks the free space SQLite
documents needing (up to twice the database file). A job cannot outlive a restart.
[SQLite maintenance](ops/sqlite-operations.md#6-data-retention--periodic-maintenance) covers the same operations from the host.

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
| Streamable HTTP, served by the console | `<console URL>/api/mcp`, for example `https://omc.example.com/api/mcp` | `Authorization: Bearer <CPA management key>` |
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
model still receives the rows and may use them in its answer or in a projected
`data_rows` reference a drawn interface uses. See `docs/agent-capabilities.md`.

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
and offers one browser-local recorded example without inference.

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

## Display currency and exchange rates

OMC Settings → Data display → Display currency selects one of eleven currencies:
USD (default), CNY, EUR, JPY, GBP, HKD, SGD, MYR, KRW, AUD or CAD. Every amount
prints one symbol flush against its number (`RM8.50`, `S$1.30`). Amounts read at two
decimals, with trailing zeros trimmed; a fraction of a cent keeps up to four, and one
below a ten-thousandth up to six, the finest amount the console prints. A rate — a
per-1M token price or the 1-USD quote — keeps its own precision instead, and the price
editor's preview keeps sub-cent detail in its sample costs so `$0.075` stays exact. The
preference follows this deployment across browsers. Dashboard, Request Records and
Insights convert at the latest cached rate; Cost & Usage, price editing and accounting
remain USD. JSON exports and USD-denominated filters retain their stored units. Image
exports follow the displayed currency.

The server reads the fixed Frankfurter v2 USD-base rates endpoint every 24 hours,
including an initial download when no attempt is cached, and keeps only the eleven
display currencies; a snapshot missing any of them is refused like any other
incomplete one. The refresh glyph beside the picker updates them immediately; a
non-USD choice states its rate for 1 USD and that quote's observation date, which
can trail the download.

Rates, last-attempt/last-success times and refresh failure state live in SQLite's
`exchange_rate_cache` and are included in normal database backups. A failed refresh
keeps the complete last successful table, including across a restart. Refreshing does
not rewrite historical costs; historical windows display at the latest cached rate.
With no usable rate, non-USD display amounts remain unavailable until a successful
update. Ordinary reads and cached conversions require no internet access; the optional
refresh needs outbound HTTPS to `api.frankfurter.dev`, without an API key. Demo mode
uses synthetic cached rates and never downloads them.

## TPS calculation mode

OMC Settings → Display chooses whether request-record and Playground TPS includes
first-token latency. The rate describes observed output delivery, not the model's
internal decoding clock.

- **Include first-token latency (default).** TPS is total output tokens divided by total
  latency. Known reasoning tokens remain in the output total.
- **Exclude first-token latency.** When `exclude_ttft` is selected, TPS divides
  output tokens by the interval from the first observable token to completion. A record
  that reports reasoning tokens uses this denominator only when the first timestamp is
  known to mark non-reasoning content. A Playground turn has that boundary when reasoning
  arrives on a separate thought channel; inline reasoning shares the reply clock. A usage
  record without reported reasoning may subtract a valid `ttft_ms`; when reasoning is
  reported, its single timestamp does not locate the answer boundary and exclusion is
  unavailable.
- **Unavailable is a result.** Missing or contradictory timing and token accounting, or a
  reasoning count that cannot be attributed to the observed interval, displays `—` with the
  reason rather than silently switching to another denominator. There is no duration or
  rate threshold. Choosing exclusion displays a warning that the narrower denominator can
  make the rate unusually high.

Both modes recalculate historical readouts from stored observations. The setting never
rewrites usage or timing, and it does not change the independent TTFT readout. TPS exports
also carry `tps_basis` and `tps_mode`.

## Plugin store

The console has two plugin entry points: **Builtins**, which manages the official plugins
Oh My CPA itself installs and keeps current, and the **plugin store**, which lists CPA's
official registry together with Oh My CPA's own community registry
(`https://raw.githubusercontent.com/WizisCool/oh-my-cpa/main/plugins/registry.json`) and
labels every entry with the source it came from. The community source is managed in
`plugins.store-sources` according to the **OMC Settings → Plugin store** switch
(`omc_plugin_source_enabled`), which defaults to on. Manual plugin installs,
configuration saves and plugin-settings saves synchronize the stored source list with
that preference. Catalog reads leave CPA configuration unchanged.

`plugins/registry.json` is Oh My CPA's community catalog and stays that way: it keeps
its address, source id and plugin ids, so an installation that already uses it keeps its
entries, configuration and history without reinstalling anything. Builtin publishers
are fixed in [`internal/pluginregistry`](../internal/pluginregistry), independently of
community source settings.

An entry keeps the kind of source it came from: `official` or `community` for CPA
sources, `omc_community` for this repository's community registry, `builtin` for the
official builtin repositories. The kind is display origin only — it decides which entry point and
source label an entry gets and stops one catalog from standing in for another;
`omc_community` carries no managed authority. A community entry installs like any store
entry and still asks for the plugin id, because that confirmation is about running code
inside the gateway.

### Builtin plugin policy

First-class plugins are Oh My CPA's own: OMC installs them and keeps them current.
Everything in the plugin store stays an operator install, and listing a source is not an
endorsement of the code behind it. Every entry keeps the kind of source it came from
(`official`, `community`, `omc_community`, `builtin`), so an entry is never attributed to
the wrong catalog.

The builtin feature is on by default for a new or newly bound CPA instance. The global
switch uninstalls the exact builtin install records OMC owns when it is turned off and
reinstalls and updates the approved set when it is turned on. Each builtin also has the
same enable/disable switch as an ordinary plugin. There is no version pinning or
per-plugin removal: those would prevent OMC from maintaining one coherent builtin set.
Turning a plugin off keeps its managed copy installed but disabled; the next approved
update can still replace that copy. The global and per-plugin choices are stored against
the CPA binding, survive management-key rotation, and do not leak to a different CPA
address.

Builtins follow normal stable GitHub Releases from their fixed official repositories.
OMC checks at startup and every fifteen minutes; **Check for updates** requests a check
immediately. It validates the stable version, the complete platform archive set, exact
repository download paths, sizes and GitHub's SHA-256 asset digests. CPA receives an exact
version and direct checksummed artifacts, so a release published during installation
cannot change which bytes it selects.

The official repository and its release permissions are the publisher trust boundary.
HTTPS and checksums protect the transfer and artifact identity; they do not protect
against a compromised publisher. OMC persists observed identities and refuses changed
bytes for an existing version or an automatic downgrade. If discovery fails, the round
makes no automatic change and currently running plugins stay as they are.

Another CPA management panel can change the same plugin records. A read-only check runs
once a minute and queues reconciliation when an owned copy disappears, has the wrong
version or enablement, or remains installed after the global switch is turned off.
The check itself never writes. While CPA's plugin system is off, OMC waits. A same-id
file or install from another source remains a source conflict rather than being claimed
or replaced.

Updates that require a newer host interface still need a host update. Runtime outcomes
such as a required CPA restart or an unconfirmed operation remain visible in the list.
The routes in [`internal/api`](../internal/api) own the response fields and states.

### Registry snapshot and callbacks

OMC serves its resolved releases as a local, public snapshot at
`<base>/plugin-registry/v2.json`. It carries the exact release assets OMC observed. That address is server-to-server: the gateway reads it while installing,
so an external CPA needs an origin it can reach, configured explicitly by the operator.
It is never inferred from `Host`, forwarding headers or any public base-URL setting.

A plain-HTTP callback only belongs on a trusted Compose network or an isolated test
network. CPA refuses an insecure store registry unless the source address is exact and
carries a store-auth rule that injects no credential at all: type `none`, applied to the
registry, and `allow-insecure`. Oh My CPA writes that rule only for its own snapshot
address and stops on any broader or credentialed rule that already matches instead of
widening it. An external CPA reached across an untrusted network uses HTTPS. Verifying
artifact hashes does not make an insecure callback safe: it protects the plugin bytes,
not the transport that delivered the manifest.

Because the handler is public, it must not take the write gate or configuration mutex a
reconciliation holds while installing. Doing so would make CPA's install wait on a lock
held by the request that install is waiting for. Keep it cacheable, credential-free and
independent of install state.

### OMC community catalog

`plugins/registry.json` remains Oh My CPA's long-lived community registry, owned here.
Its entries appear in the plugin store under the Oh My CPA community source, and the
source toggle only registers and displays them: it grants nothing, and it stays
independent of the builtin feature switch. Community entries are manual installs that
require typing the plugin id.

`omcpa-codex-candy-eval` is the adaptation published from this catalog; CPA's official
store lists a different upstream plugin under `cpa-codex-candy-eval`. The ids are not
interchangeable and both may be installed. Curation stays in this repository, and an Oh
My CPA release tag adds no trust to community code.

A plugin may also publish a localized description; [Plugin description
declaration](plugin-declaration.md) fixes what that file contains and how an unknown or
mismatched document is treated.

## Plugin pages

Installed plugin pages open through OMC's authenticated same-origin host; CPA does
not need to be reachable from the browser. Treat installation as granting trusted
code access, not as opening an isolated dashboard: native management responses can
include configuration credentials. Review the plugin's source and provenance before
installing or opening it.

The host can supply the stored management key server-side when the page sends no
credential. A key explicitly entered into a plugin page is checked instead, so an
empty or incorrect key is not silently replaced. The model directory uses the page's
client key and cannot borrow the management key. Plugin assets never receive an
injected management key.

Configuration-affecting calls are audited, serialized and backed up. Native plugin
writes still follow CPA's last-write semantics: do not edit the same settings in a
plugin while keeping an unsaved console draft. These routes are unavailable in demo
mode and are not Agent/MCP capabilities. The exact fixed-origin, header and path
restrictions are defined in [Architecture](architecture.md#trusted-plugin-pages).

## Demo mode

`OMCPA_DEMO_MODE` (default `false`) serves the console from a built-in fixture instead
of a CPA, so it needs no management key and no provider credential. Its storage is not
durable — the database is deleted and rebuilt on every boot — and the server refuses
sign-in flows, credential movement, plugin execution and plugin pages, gateway configuration writes and
anything that would leave the process. It opens at the site root unless
`OMCPA_BASE_PATH` says otherwise. A visitor's theme stays in their own browser:
a demonstration is shared, so it is neither sent to the server nor read from it.

```bash
pnpm build
OMCPA_DEMO_MODE=true go run ./cmd/oh-my-cpa
```

This mode is what generates the public demonstration's dataset, so it stays in use even
though the public deployment does not run it; `OMCPA_PUBLIC_URL` states that
deployment's origin. The public demo is the same console as static assets with its API
answered by a Cloudflare Worker from that generated dataset. See
[the demo runbook](ops/cloudflare-demo.md) for its build and deployment procedure.

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
model exclusions. Aliases are provider-scoped; exclusions are defaults for
OAuth/file-backed credentials without a non-empty own `excluded_models` list.
A non-empty credential list replaces, rather than extends, the provider's
`oauth.excluded-models`. A missing, empty or null credential list inherits the
current provider rules. Use the credential configuration tab to edit an override;
clearing it restores inheritance, not unrestricted availability.

Exact exclusions and `*` patterns match case-insensitively. Provider `*` excludes
all models only for inheriting credentials: with provider `["*"]` and credential
`["model-b"]`, the credential uses only `["model-b"]`, so `model-a` is not blocked
by provider `*`. Clearing that override makes the credential inherit `*` again.
Exclusions run before alias mapping; an alias cannot restore a source hidden by
the applicable rules. Deleting provider rules removes those defaults but leaves
non-empty credential overrides unchanged; it does not guarantee that models are
served again. CPA's per-credential model list is authoritative for availability.
Disable a credential explicitly when it must stop serving.

This precedence requires **CPA v8.0.33 or later**; upgrade an older gateway before
relying on credential overrides. OMC's general v8.0.0 Management API baseline is
unchanged. The behavior follows CPA's [credential override change](https://github.com/router-for-me/CLIProxyAPI/commit/69d0ff8e295aea349966b16f20e2966421bfeb18).
The upstream regression
[`TestCodexExcludedModelsCredentialPriorityAfterPatchAndReload`](https://github.com/router-for-me/CLIProxyAPI/blob/2422c6b0f5fe16495320fa29456493874c1977a0/sdk/cliproxy/service_excluded_models_priority_test.go)
checks immediate PATCH effects, reloads and restored inheritance after clearing.

The facade exposes GET/PATCH at `/api/v1/management/auth-files/model-aliases` and
`/api/v1/management/auth-files/excluded-models`. An exclusion PATCH carries
`provider` and `models`; an empty `models` array removes that provider's rules.
The provider model catalog is read at
`/api/v1/management/auth-files/provider-models?provider=codex`; plugin-owned
providers read the catalog CPA's plugin host publishes (CPA v8.0.34 or later). Without a catalog, the
editors still accept typed names. A successful write requires CPA readback;
changes are serialized with other whole-config writes, backed up and audit logged
(`oauth_model_alias.update` or `oauth_excluded_models.update`). Demo mode allows
reads but refuses durable changes.

## Routing

The `/routing` page arranges CPA's request order. Each provider key, OpenAI-compatible
provider and OAuth credential is a card. A tier is a set of cards that share one
`priority`, so CPA routes to a higher tier first, and the tiers are drawn top-down.
Inside a tier, the routing strategy divides traffic. Under fill-first, CPA's internal
auth ID decides which card fills first, and OMC cannot see that ID. A strict A → B → C
order therefore needs one tier per card. When an arrangement is numbered, cards whose
tier is unchanged keep their stored priority where possible. Runtime-only credentials
keep a fixed priority; an arrangement that cannot fit between fixed priorities is refused.
New tiers fit within CPA's priority range, with smaller gaps near its limits.

The model lens previews which tiers can serve one model, and each card's expected share
within its tier. The preview cannot see session-affinity pins, live cooldowns or
transport preferences, so a request may not follow it exactly. Failed model reads remain
unknown rather than marking credentials ineligible. Aliases and exclusions
are read-only on this page and are edited in their existing editors.

Edits stay in a local draft, and leaving the page asks before discarding them.
Applying a plan locks editing through its confirming readback. If that read fails,
reload successfully before editing or applying again.

`GET /api/v1/management/routing` returns the board and a revision computed from the
routing-relevant fields only. `PATCH` takes that revision and only the changes. A
changed board is refused with `routing_conflict` (409) before any write. Applying a
plan works in this order:

1. The routing audit attempt is recorded. If that fails, nothing is written.
2. One configuration write covers provider priorities and weights together with the
   routing settings. It takes one encrypted backup with reason `routing_plan`.
3. Each OAuth credential is patched with its identity precondition and readback.
   Patching stops at the first failure.

CPA has no transaction across these steps, so the response reports each target as
`applied`, `failed`, `uncertain` or `not_attempted`, and it never claims a rollback. A
configuration backup restores only the configuration part. The Agent's
`routing_apply` capability previews the same plan against a revision and applies it
after approval. Demo mode allows reads and refuses the write.

## Kimi international quota

The `kimi-ai` connection method uses the international Kimi account system. Its
quota observation is a server-initiated `GET` to the compiled, single-endpoint
allowlist entry `https://api.kimi.ai/coding/v1/usages`. Domestic Kimi
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
being filed under a period it does not describe.

## Automatic quota refresh

OMC Settings → Quota holds the deployment-wide automatic quota refresh policy (the
`omc_quota_auto_refresh` preference). **Refresh after a quota resets** is on
by default: about a minute after a window a stored reading reported has reset, that
credential is read again once. **Scheduled quota refresh** reads every enabled credential whose reading is
older than the interval - six hours by default, adjustable from 5 minutes to 24 hours,
or off - including credentials nobody has read, so the first minutes after an upgrade
read every such credential. Each automatic read is a provider request made with the credential through CPA
(`api-call`, or the plugin's quota endpoint for a plugin credential), at most sixteen per
minute; a failed reset-driven read is retried every ten minutes for an hour. Claude quota reads go one at a time
on every path, because Anthropic answers a burst of usage reads with HTTP 429 for every credential in it. After a
429, OMC sends no Claude quota read for the `Retry-After` the provider named, or at least two minutes, including a
manual refresh, which shows the last good reading marked stale with the 429 as its reason. The refused credential
is not read automatically again for 5 minutes, doubling with each consecutive 429 up to 30 minutes, and its next
successful read ends the backoff. That backoff covers every automatic quota read, including
credential warmup's evidence read and its pending confirmation, so a probe nobody is waiting
on cannot spend another refused request; a manual refresh keeps its own rule and waits only for
the provider pause. A Claude re-read sends only the usage request: the plan is
re-read every six hours and the reset grants every hour, and a refused grants listing waits its
hour without holding back the usage reads. This pacing lives in memory and restarts with the process. Meta credentials are only read on a manual
refresh, because that read exchanges a key upstream. Turning both off restores
operator-only reads. A demonstration never runs it.

Any read, manual or automatic, that shows room in every window releases a credential CPA
still holds in cooldown, because providers can reset a quota before the recovery time they
announced. While the policy is on, each round also releases an enabled credential whose
recorded recovery times have all passed, including Meta and providers without a quota
probe. Each release is logged as `CPA cooldown cleared after quota restored` or `expired
CPA cooldown cleared` with the `auth_index`, and appears in the audit log as
`quota.clear_cooldown.automatic`.

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
console nor Agent/MCP accepts a caller-chosen URL.

A refresh that succeeds without publishing any window is recorded as an
`unpublished` reading rather than as a credential nobody has read, and the console
says so with its own status and copy. Every provider's window parser can produce
that reading, and it is what an unrecognized upstream document shape now surfaces
as.

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

## Public demonstration conversations

The public demonstration's Agent and Playground offer one browser-local recorded example
each. Send/retry/cancel do not invoke a provider or write the Worker. Other questions are
refused. The demo security boundary still refuses server-side writes.

## Credential window warmup

Configure provider defaults from OAuth management's Warmup settings, or a complete
credential override from its Window warmup tab. Reset mode is Off, Weekly, or Weekly and five-hour.
Daily warmup defaults off with 06:00 as its editable time in the effective OMC timezone.
Choose an available model; Claude's available Haiku models are listed first. Changing a
model never silently selects a replacement. Saving an enabled policy authorizes automatic
attempts once the applicable billing and window checks permit them; a first manual activation
is not required. Warm up now remains an optional, separately confirmed consuming action.
Previously enabled policies begin participating on the next scheduler round after upgrade,
including credentials with no prior activation observation; defaults remain off.

Claude warmup requires a fresh usage read confirming `extra_usage.is_enabled` is false.
Codex warmup does not depend on credit status: each short request consumes quota and
may incur charges, including when credit status is unknown or paid usage is available.
OMC does not change upstream billing settings or redeem a reset credit to make warmup eligible. A zero reading with
an active fixed boundary is not an idle window. Model-scoped Sonnet, Opus and Fable
limits can pause the selected family without blocking unrelated Haiku. Fable evidence
accepts the legacy `iguana_necktie` (unless it carries dollar amounts, which make it the
cloud session credit pool) or modern model-scoped `limits`; malformed modern
evidence, including a present non-array or null `limits` field, remains unknown rather
than falling back to an apparently available legacy limit.

The background loop checks once per minute, with bounded four-way rounds of 16, and
reuses stored quota observations targeted for refresh every five minutes. A round whose windows
are already active stores the observation it reconciled and sends nothing, not even another
quota read; a consuming request still reads fresh evidence immediately before it is sent. Daily starts
missed by more than one hour are not replayed. If starting now would overlap the next
daily time, reset-driven requests wait, including weekly triggers. Changing the OMC
zone changes future calendar decisions, not stored instants.

The credential section shows a cost notice for Codex and paid-fallback evidence for Claude.
No activation observed is a neutral historical fact; missing Claude billing evidence pauses
requests. Current reasons distinguish active windows, missing quota and Claude billing refusals. An unsupported response pauses automatic requests for the selected
model until a confirmed recheck succeeds or an available replacement model is explicitly
selected. Rechecks still obey unresolved-outcome suppression. Manual actions report an outcome
through a toast; sent requests also update the durable last result in the Window warmup tab.
Warm up now opens its confirmation on both HTTP and HTTPS deployments. Switching tabs or
saving credential fields keeps a separate warmup draft open.

A consuming request is recorded before it is sent. If pre-send revalidation refuses the
request, its provisional cycle and daily identities are restored. A temporary startup
recovery failure is logged and retried on later minute checks, not left stopped until restart. Activated, pending, skipped, failed,
executing and uncertain outcomes are distinct. After a pending completion only quota
reads are repeated; transport timeouts and restart-abandoned requests are uncertain
and are not automatically resent. Definite rate-limit refusals get at most three
retries after one, five and fifteen minutes, each preceded by fresh eligibility checks.
Policy and execution records are included in normal SQLite backups. The latest 100
receipts per credential are kept alongside the durable cycle and daily suppression.

API routes under the configured API prefix:

- `GET/PUT /management/quota/warmup/settings`: provider policy and revision.
- `GET/PUT /management/quota/warmup/credentials/{authIndex}`: effective policy and state.
- `POST /management/quota/warmup/credentials/{authIndex}/run`: confirmed, revision-bound
  manual request with caller-stable `request_id`. Reuse that id only to recover its
  original receipt; never retry an uncertain result with a new id.

These are authenticated, typed projections, not a generic request proxy. Writes require
confirmation and the current revision; no URL, prompt, request body or secret can be
supplied. The public demonstration refuses consuming and policy-write routes.

Warmup round ordering is oldest observation first. Fleets exceeding a round's capacity
remain queued rather than increasing concurrency or skipping protection.
