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

A container receives only the variables its Compose file names under `environment:`. The
supplied files list the ones this release reads; a variable added to `.env` alone reaches a
native install, which reads that file itself, but not a container whose Compose file was
copied from an earlier release. Add the line to that service's `environment:` as well.

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
| `OMCPA_LISTEN_ADDR` | `:8080` | Process listen address (`deploy/native.env.example` sets `127.0.0.1:8080`; Docker bridge deployments change host port via `OMCPA_BIND` instead) |
| `OMCPA_BASE_PATH` | `/` | URL prefix. The default serves the console at the root; a configured sub-path is normalised without a trailing slash |
| `OMCPA_DEFAULT_LANGUAGE` | unset: each visitor's browser | Pins the console's reading language for every visitor: `zh`, `zh-Hant`, `en`, `ms`, or `auto` to follow each visitor's browser. A language chosen in the console is saved in that browser and outranks it, so changing the pin reaches every visitor who never chose one and leaves the others alone. Any other value stops start-up |
| `OMCPA_DATA_DIR` | `/data` (image) / `./data` (binary) | Directory holding `oh-my-cpa.db`. Local disk only |
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
| `OMCPA_UPDATE_CHECK_ENABLED` | `true` | The background release and plugin-update checks |
| `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | The check the System Information page makes when opened |
| `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` | `WizisCool/oh-my-cpa` / `router-for-me/CLIProxyAPI` | `owner/name` the checks read, for a fork |
| `OMCPA_DEMO_MODE` | `false` | Serve the console from the built-in fixture; see [Demo mode](#demo-mode) |
| `OMCPA_UPDATER_ENABLED` | `true` | `false` makes the console ignore an updater and offer no update action; see [Console updates](#console-updates) |
| `OMCPA_UPDATER_URL` | `http://oh-my-cpa-updater:8090` | Where the console looks for the updater. The default is the service and container name every install method uses |
| `OMCPA_GOOGLE_FONTS_URL` | `https://fonts.googleapis.com` | The Google Fonts stylesheet API the font library installs from, or a compatible mirror for a deployment that cannot reach Google. Requests use the OMC outbound network policy; font files are downloaded only from Google's font hosts or the mirror's own site. Used only when an operator installs a family; uploading needs no network |

The MCP stdio bridge (`oh-my-cpa mcp`) reads `OMCPA_SERVER_URL`,
`OMCPA_CPA_MANAGEMENT_KEY` and the optional `OMCPA_VERSION` only; the remote MCP
endpoint has no setting of its own. See [Agent and MCP](#agent-and-mcp).

## Deployment constraints

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
- **Search engines**: Every response carries `X-Robots-Tag: noindex, nofollow, …`, which
  is what keeps a publicly proxied console out of search results. Crawlers read
  `robots.txt` only at the origin root; OMC answers it there and under a configured base
  path, so a proxy that forwards only the prefix and wants the advisory file too must
  also route `/robots.txt` to OMC.
- **Container image**: Compose pulls `wiziscool/oh-my-cpa:latest` from Docker Hub by
  default; the full-stack CPA image also defaults to `:latest`. Pin `OMCPA_IMAGE` to the desired version or digest; updates recreate only
  OMC with its existing data and master key. The image runs as non-root uid/gid `10001:10001`
  by default (overridable via `OMCPA_USER` in the supplied Compose files when matching a
  host bind mount), includes its own health probe and needs no mounted deployment scripts. A health
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
setting without rewriting stored instants. CPA log timestamps with `Z` or a numeric UTC
offset are converted to the effective display timezone. Timestamps without an offset
retain their original wall-clock text: CPA's log response does not identify their source
timezone. Raw log downloads and explicit UTC pricing-tier rules retain their source
semantics.

## Update checks

The System Information page reports the running and published versions of both Oh My
CPA and your gateway. It reads release metadata from `api.github.com` only — fixed host,
no operator-supplied URL — using the OMC outbound network policy. A sweep runs on the interval chosen in OMC Settings → Update checks — hourly by
default, adjustable from fifteen minutes to a day; opening the page and the
**Check for updates** button also check, subject to a fifteen-minute floor per product —
inside it the answer comes from the stored index and the message says so, because the feed
is one shared per-address budget. A refused read — including a 429 — is reported on the page
and the next sweep asks again: an exhausted budget delays a release notice, it never ends
the checks.

When either product has a newer published release, the **System Information** entry in
the navigation carries a small amber dot. It reflects the stored answer and costs no
request of its own, so it appears once a sweep or a check has found the release. An open
console subscribes to a signal-only stream (`/management/system/live`) that says the stored
answer changed, re-reads once whenever the stream opens again (a tab returning from the
background, or the stream's five-minute lifetime ending), and keeps an hourly re-read as the
fallback for a deployment whose stream is unavailable. **Ignore this version** on the product's row clears the
dot for that one release and is remembered by the deployment, not the browser; pressing it
again restores the reminder, and a later release is flagged regardless.

The background sweep also checks installed plugins through CPA's store, once at startup
and on the same interval. The **Plugin Management** entry uses the same amber dot for available
plugin updates. The installed-plugins page enables a separate store query after its
list contains plugins. Installation or removal refreshes the reminder.

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
making them, and the page says so when a check is refused for that reason. The checks use the
gateway's own GitHub token — Configuration → Access & Auth → GitHub token
(`server.github-token`) — so a deployment configures GitHub once and both processes benefit:
a token raises that budget to 5,000 and exempts conditional requests from it. OMC reads it
from the gateway's configuration, holds it in memory, and never returns it to a browser.
Release notes
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
| `OMCPA_UPDATER_HEALTH_TIMEOUT` | `5m` | How long the updater waits for a replacement container to become healthy; setting it explicitly also waits past an image's `start-period` during slow migrations |
| `OMCPA_UPDATER_PUBLIC_KEY` | built in | Base64 Ed25519 public key that replaces the built-in release key, for a fork that signs its own releases |

Security boundary:

- The updater holds the Docker socket, which is control of Docker on that host. The
  console does not, and stays read-only and unprivileged. Anyone who can already run
  `docker` on the host gains nothing; anyone who can reach the updater's port without
  its token gets `401`.
- The token is an HMAC of `OMCPA_MASTER_KEY`. Neither container stores it, and it is
  not logged. Changing the master key needs no step here: the updater reads the
  console's current value from Docker.
- The updater accepts a product name and an optional route from OMC Settings → Network
  proxy: a proxy URL, `direct`, or nothing for the daemon's own configuration. It
  validates the proxy's protocol and address before downloading.
  It never takes an image, a container name or a command from the console.
  It identifies the two products from Docker state and
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

An existing `<name>-omc-previous` backup blocks another update before mutation unless
it is already stopped, the target container is healthy, and cleaning it up requires
no updater self-handover, in which case the updater removes that stale backup first.
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
settings as the update check. By default, the Docker daemon pulls images using its own
registry and proxy configuration.

**OMC Settings → Network proxy** chooses the outbound route. The default follows the
existing deployment: OMC uses its environment, CPA retains its configuration, and the
Docker daemon pulls images. Choosing a proxy or direct route also sets CPA's
`requests.proxy-url` through the normal revision-checked, audited configuration write
and encrypted backup; returning to the default withdraws only a value OMC wrote,
leaving a proxy configured in CPA untouched.
CPA's individual provider and OAuth proxy choices remain independent. A CPA write and
OMC's settings save cannot be one transaction; a partial failure is reported and requires
a reload. If CPA's configuration is changed elsewhere, the settings page reports the mismatch;
applying the OMC setting reconciles it.

A selected proxy applies to OMC's release and manifest reads, price and currency sync,
font downloads, and provider probes without their own proxy. OMC exclusions apply to
the console's requests; CPA's proxy configuration does not support this exclusion list,
and an image download sends every registry request through the proxy.
Browser-loaded plugin artwork and independently operated clients use their own networks.
The proxy address must be reachable from OMC, CPA, and updater namespaces: `localhost`
inside one container is not another container. Only an encrypted OMC settings record is
stored in SQLite; a proxy configured in CPA also resides in CPA's configuration.

When the selected route is proxy or direct, the updater downloads the registry manifest
and layers, selects the daemon's platform, and streams a verified archive into Docker.
OMC's signed index digest and image content hashes are verified before replacement. The
daemon's proxy configuration is not changed. A standalone updater can temporarily join
a console network containing the proxy container and removes its own attachment before
replacement. Proxy failure never triggers a direct retry. The console and updater both
need builds supporting the selected route; an older updater needs an independent upgrade —
rerun its install command, or switch to the deployment default route, update the console,
and switch back.
The authenticated console-to-updater control connection uses HTTP by default, so place
that network on trusted infrastructure or provide transport encryption.

Remote backup destinations also have their own network adapters. HTTP-based S3, WebDAV,
Google Drive and OneDrive destinations can use an explicit proxy when no OMC exclusions
are configured. Other managed routes, including SMB, and routes whose exclusions cannot
be guaranteed are refused rather than silently connected directly. With a selected direct route,
SMB, SFTP and FTP destinations connect directly; HTTP-based destinations are refused
because their adapters can inherit an environment proxy. Local backups remain available;
backup OAuth exchanges use OMC's HTTP policy.

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
in Key management first. Real requests consume quota under the selected key. Stop cancels
the connection; the single latest conversation and parameters are stored as a server-side
preference (referencing the key's usage fingerprint, never the raw key).

Keep reverse-proxy streaming unbuffered and its read timeout above the 15-second
heartbeat interval. Weak connections and page refreshes reattach to the active server run
journal (retained for 15 minutes after completion) rather than resending a model call.

## Display preferences and custom icons

- **Display currency**: **OMC Settings → Data display → Display currency** converts
  Dashboard, Request Records and Insights readouts using cached Frankfurter USD-base
  exchange rates (`api.frankfurter.dev`, refreshed daily or on demand and persisted in
  `exchange_rate_cache`). Cost & Usage, price editing and stored accounting remain in USD.
- **TPS calculation mode**: **OMC Settings → Display** selects whether request-record and
  Playground TPS includes first-token latency (default) or excludes TTFT when a non-reasoning
  first-token boundary is known. Stored usage and timing are never rewritten.
- **Custom provider icons**: Upload up to 100 static PNG/JPEG/WebP/SVG icons (≤ 512 KiB,
  ≤ 1024 × 1024) in the provider icon picker. Icons persist in SQLite and are included in
  database backups; deleting an icon restores affected providers to their default mark.

## Plugin store

The plugin store reads CPA's built-in `official` registry plus `plugins.store-sources`.
Oh My CPA's own registry is managed through **OMC Settings → Plugin store** or the
plugin sources list (`omc_plugin_source_enabled`, on by default). Both first-party
registries also list community code, so the console names each entry by who listed it
and who maintains its repository: a first-party registry's own publisher (`omc-community`
for Oh My CPA, `router-for-me` for CPA) installs after one confirmation; every other entry
requires typing the plugin ID to confirm running code inside the gateway.

## Plugin pages

Installed plugin pages open through OMC's authenticated same-origin host; CPA does not
need to be reachable from the browser. Treat installation as granting trusted code access:
native management responses can include configuration credentials, and a page written for
CPAMC reads the gateway credential from browser storage, where the console mirrors it
before the page loads. Sign-out, a refused session check and the next sign-in withdraw it.
Configuration-affecting
calls through the Plugin Host are audited, serialized and backed up. See
[Architecture](dev/architecture.md#trusted-plugin-pages) for fixed-origin and header boundaries.

## Demo mode

`OMCPA_DEMO_MODE` (default `false`) serves the console from a built-in fixture instead
of a CPA instance, requiring no management key or provider credentials. Its database
(`oh-my-cpa-demo.db`) is rebuilt on every boot, and the server refuses sign-in flows,
credential mutations, plugin execution, gateway configuration writes and outbound calls.

```bash
pnpm build
OMCPA_DEMO_MODE=true go run ./cmd/oh-my-cpa
```

This mode also generates the static dataset for the Cloudflare Worker deployment; see
[the demo runbook](ops/cloudflare-demo.md).

## Available model directory

The `/model-square` page reads CPA's live `/v1/models` using the first configured client
key (or returns `client_key_required` when none exists) and enriches models from the
bundled models.dev snapshot in `internal/modelcatalog/snapshot.json`.

When preparing a release, refresh the bundled snapshot with `pnpm models:sync` and
update Model Square API goldens (`UPDATE_GOLDEN=1`). The release workflow rejects tags
whose snapshot is more than 30 days older than the tagged commit.

## OAuth model rules and routing

- **Model rules**: In OAuth management, edit provider-wide model aliases or
  `oauth.excluded-models`. A non-empty per-credential `excluded_models` list replaces
  the provider default (requires CPA v8.0.33+); clearing the credential override restores
  inheritance. Exclusions apply before alias mapping.
- **Routing**: `/routing` arranges provider keys, OpenAI-compatible providers and OAuth
  credentials into priority tiers. Applying a routing plan records an audit attempt,
  saves an encrypted configuration backup (`routing_plan`), updates provider priorities/weights
  and patches affected OAuth credentials against the board revision (`routing_conflict` on
  concurrent changes).

## Quota observation and window warmup

- **Quota refresh**: Quota observations are initiated server-side against fixed provider
  endpoints (`internal/quota/service.go`) or CPA's plugin quota endpoint. **OMC Settings →
  Quota** (`omc_quota_auto_refresh`) controls automatic post-reset reads and scheduled
  sweeps, and automatically clears CPA cooldowns when all windows have room or recovery
  times have passed. That release is credential-wide, so it is withheld while any model on
  the credential is still resting. Claude quota reads serialize and respect `Retry-After`
  backoff; Meta Muse credentials refresh only on manual request.
- **Cooldown scope**: CPA cools a credential or one of its models. The Quota page lists a
  model-scoped cooldown with its own recovery and retry instant and the gateway's backoff
  level, and reports it as partial: the credential keeps serving its other models. Spellings
  that resolve to one upstream model - a mixed-case id, or an OAuth alias recorded before CPA
  resolved it - are listed once, keeping the later recovery time.
- **Credential window warmup**: OAuth management's **Warmup settings** drawer holds warmup
  tasks. A task names one credential and one trigger: after a quota window resets, daily at
  a chosen time and zone, or every N hours from an anchor. Its model stays empty by default:
  the run then uses the credential's cheapest model priced above zero, so the request neither
  burns a premium model nor lands on the free model that starts no window; when the book
  prices none of them, the lightest name answers. An OAuth model alias counts as the model it
  reaches, and the alias is what is sent. A run is a credential-pinned text completion through
  CPA's `credentials/verify`, so a successful run is recorded as `ok`. Window tasks read the
  credential's quota first and retry a failed read after five minutes.
- **Warmup safety**: A run's record is written before the request is sent, and a run whose
  record cannot be written is not sent. A run reads its task again as it starts: a task deleted
  a moment earlier sends nothing, one switched off does not run on schedule, and a task cannot
  be deleted while its run is in flight. Disabled and unavailable credentials are refused as
  `credential_disabled` and `credential_unavailable` instead of being woken. An outcome left
  uncertain by the transport or by an OMC restart is recorded as unknown and never resent
  automatically. Each task keeps its newest 50 run records.

