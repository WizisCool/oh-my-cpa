# Environment variables

Everything is an environment variable. The binary also reads `.env` from its working
directory (`OMCPA_ENV_FILE` names another file); real environment variables win.
`internal/config/config.go` is authoritative, and a malformed value stops start-up with
a message naming the variable.

A container receives only the variables its Compose file names under `environment:`. The
supplied files list the ones this release reads; a variable added to `.env` alone reaches a
native install, which reads that file itself, but not a container whose Compose file was
copied from an earlier release. Add the line to that service's `environment:` as well.

## Required

| Variable | Purpose |
| --- | --- |
| `OMCPA_CPA_BASE_URL` | CPA's address, for example `http://127.0.0.1:8317` |
| `OMCPA_CPA_MANAGEMENT_KEY` | CPA's plaintext management key. Also the console's sign-in password |
| `OMCPA_MASTER_KEY` | At-rest encryption key: a 64-character hex key (`openssl rand -hex 32`) or at least 32 bytes |

`compose.full.yml` asks for `CPA_MANAGEMENT_KEY` instead of the last two CPA settings: it sets both the new CPA's `MANAGEMENT_PASSWORD` and OMC's `OMCPA_CPA_MANAGEMENT_KEY`, and the base URL points at the bundled CPA.

## Compose files

These are read by the supplied Compose files, not by OMC itself.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_BIND` | `127.0.0.1:8080` | Docker host `[ip:]port` mapped to container port `8080` (for example `127.0.0.1:18317` when `8080` is occupied on the host) |
| `CPA_BIND` | `127.0.0.1:8317` | Docker host `[ip:]port` mapped to CPA container port `8317` (`compose.full.yml` only) |
| `OMCPA_DATA_PATH` | `oh-my-cpa-data` | Named Docker volume by default, or a host directory path such as `./oh-my-cpa-data` |
| `OMCPA_USER` | `10001:10001` | Non-root `uid:gid` running the `oh-my-cpa` container (requires a writable host directory in `OMCPA_DATA_PATH`; the default named volume is owned by `10001:10001`) |
| `OMCPA_NETWORK_NAME` | `oh-my-cpa` / `oh-my-cpa-standalone` | Docker network name |
| `OMCPA_NETWORK_EXTERNAL` | `false` | Set `true` in `compose.omc.yml` to attach OMC to an existing Docker network |
| `CPA_CONFIG_PATH`, `CPA_AUTH_PATH`, `CPA_LOG_PATH`, `CPA_PLUGIN_PATH` | `./config.yaml`, `./auths`, `./logs`, `./plugins` | Host paths for CPA's files in `compose.full.yml` |
| `OMCPA_IMAGE` / `CPA_IMAGE` | `wiziscool/oh-my-cpa:latest` / `eceasy/cli-proxy-api:latest` | Pin a specific release tag or digest |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Host Docker socket mounted into `oh-my-cpa-updater` |

## Serving

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_VERSION` | embedded stable tag; `v0.1.0-dev` for untagged source builds | Optional display/User-Agent version override; does not change the installed build |
| `OMCPA_LISTEN_ADDR` | `:8080` | Process listen address (`deploy/native.env.example` sets `127.0.0.1:8080`; Docker bridge deployments change the host port with `OMCPA_BIND` instead, see [Changing the port](../operate/ports-storage.md#changing-the-port)) |
| `OMCPA_BASE_PATH` | `/` | URL prefix. The default serves the console at the root; a configured sub-path is normalised without a trailing slash |
| `OMCPA_DEFAULT_LANGUAGE` | unset: each visitor's browser | Pins the console's reading language for every visitor: `zh`, `zh-Hant`, `en`, `ms`, or `auto` to follow each visitor's browser. A language chosen in the console is saved in that browser and outranks it, so changing the pin reaches every visitor who never chose one and leaves the others alone. Any other value stops start-up |
| `OMCPA_DATA_DIR` | `/data` (image) / `./data` (binary) | Directory holding `oh-my-cpa.db`. Local disk only |
| `OMCPA_PUBLIC_URL` | unset | The address browsers use. An `https://` value marks the session cookie `Secure` |
| `OMCPA_TRUSTED_PROXY_CIDRS` | unset | Comma-separated CIDRs of reverse proxies whose forwarding headers may be trusted for login throttling |
| `TZ` | system zone | Server calendar; see [Time zone](../operate/time-zone.md) |

## Gateway connection

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_CPA_USAGE_ADDR` | host and port of `OMCPA_CPA_BASE_URL` | `host:port` of CPA's usage stream |
| `OMCPA_REQUEST_TIMEOUT` | `15s` | Timeout for ordinary CPA management calls |
| `OMCPA_CPA_TLS_SKIP_VERIFY` | `false` | Skip certificate verification when CPA uses a private certificate |

## Usage collection

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | `auto`, `subscribe`, `resp_pull`, `http_pull` or `off` |
| `OMCPA_USAGE_IDLE_INTERVAL` | `1s` | First wait after an empty poll |
| `OMCPA_USAGE_MAX_IDLE_INTERVAL` | `10s` | Ceiling the idle backoff grows to. Keep it well below CPA's `redis-usage-queue-retention-seconds` |
| `OMCPA_USAGE_BATCH_SIZE` | `1000` | Records read per poll (1–10000) |
| `OMCPA_USAGE_RETENTION_DAYS` | `90` | Days of request records (the request list and its detail) kept, `0` to keep them all. Ninety matches the request list's longest preset. Dashboard statistics do not depend on it: they are kept permanently as usage facts. A retention saved in OMC Settings → Data retention replaces it without a restart |
| `OMCPA_USAGE_INBOX_RETENTION_DAYS` | `7` | Days a captured payload is kept after it was decoded into a request record, `0` to keep it as long as the record. Payloads are the largest part of the database and nothing reads them once decoded except a re-decode after a decoder fix. |

## Update checks and demo

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_UPDATE_CHECK_ENABLED` | `true` | The background release and plugin-update checks |
| `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | The check the System Information page makes when opened |
| `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` | `WizisCool/oh-my-cpa` / `router-for-me/CLIProxyAPI` | `owner/name` the checks read, for a fork |
| `OMCPA_DEMO_MODE` | `false` | Serve the console from the built-in fixture; see [Demo mode](#demo-mode) |
| `OMCPA_UPDATER_ENABLED` | `true` | `false` makes the console ignore an updater and offer no update action; see [Console updates](../operate/updates.md#console-updates) |
| `OMCPA_UPDATER_URL` | `http://oh-my-cpa-updater:8090` | Where the console looks for the updater. The default is the service and container name every install method uses |
| `OMCPA_GOOGLE_FONTS_URL` | `https://fonts.googleapis.com` | The Google Fonts stylesheet API the font library installs from, or a compatible mirror for a deployment that cannot reach Google. Requests use the OMC outbound network policy; font files are downloaded only from Google's font hosts or the mirror's own site. Used only when an operator installs a family; uploading needs no network |



## Updater

Read by the `oh-my-cpa-updater` container from its own environment. An installation
needs none of them; see [Updates](../operate/updates.md#console-updates).

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

## MCP bridge

The stdio bridge (`oh-my-cpa mcp`) reads `OMCPA_SERVER_URL`, `OMCPA_CPA_MANAGEMENT_KEY`
and the optional `OMCPA_VERSION` only; the remote MCP endpoint has no setting of its own.
See [Agent and MCP](../features/agent.md).

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
[the demo runbook](../ops/cloudflare-demo.md).
