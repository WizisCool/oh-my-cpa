# Installation

Oh My CPA (OMC) is an embedded console and SQLite database in one Go binary. It
connects to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) **v8.0.0
or later**, using the gateway's plaintext management key as its sign-in password.
The published image is **`wiziscool/oh-my-cpa`** on Docker Hub, with `linux/amd64` and
`linux/arm64` variants. The first stable version is **`v0.1.0`**.

| Installation | Choose it when |
| --- | --- |
| [Docker Compose, full stack](#docker-compose-full-stack) | Neither CPA nor OMC is installed |
| [Docker Compose, beside an existing CPA](#docker-compose-beside-an-existing-cpa) | CPA already runs, with or without another management panel |
| [Let your agent install it](install-for-agents.md) | A coding agent should inventory your environment and select the safe path |
| [From source](#from-source) | You need a native process, are developing, or CPA is accessible only on the host loopback |

The [live demo](https://omc-demo.junze.dev) needs no installation. Docker deployments
need Docker Engine and the Compose plugin, not Go, Node.js, pnpm or a repository clone.
Source builds need Go 1.25+, Node.js 22+ and pnpm 11+; CI pins Go 1.27.1,
Node.js 22.23.2 and pnpm 11.19.0.

## Docker Compose, full stack

`deploy/compose.full.yml` pulls CPA and OMC images using `:latest` by default.
Override `CPA_IMAGE` or `OMCPA_IMAGE` to pin a tested version or digest. It publishes CPA on
`127.0.0.1:8317` and OMC on `127.0.0.1:8080`; the two containers communicate on a
private network. Install into a **new directory**; the commands below must not replace
an existing gateway configuration or environment file.

```bash
mkdir -p oh-my-cpa/deploy oh-my-cpa/cpa/{auths,logs,plugins} oh-my-cpa/oh-my-cpa-data
cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/compose.full.yml \
  -o deploy/compose.full.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/cpa.config.example.yaml \
  -o cpa/config.yaml
sudo chown 10001:10001 oh-my-cpa-data
sudo chmod 700 oh-my-cpa-data

umask 077
cat > deploy/.env <<EOF_ENV
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
OMCPA_PUBLIC_URL=http://127.0.0.1:8080
TZ=UTC
EOF_ENV

docker compose --env-file deploy/.env -f deploy/compose.full.yml pull
docker compose --env-file deploy/.env -f deploy/compose.full.yml up -d
```

Open **`http://127.0.0.1:8080/omc/`** and sign in with the `CPA_MANAGEMENT_KEY`
stored in `deploy/.env`. The starter CPA configuration enables usage statistics and
starts with no client API keys or provider credentials. Add those in the console
before making model requests. No TLS or DNS setup is required for loopback access.

On a remote server, keep these binds and use an SSH tunnel (choose an unused local port):

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```

Open `http://127.0.0.1:18080/omc/`. The default `OMCPA_PUBLIC_URL` is used to choose
cookie security, not to enforce the tunnel's local port.

### Compose settings

Both Compose files read `deploy/.env` when passed with `--env-file`. Relative bind
paths are resolved from the Compose file's directory, not your current shell directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_IMAGE` | `wiziscool/oh-my-cpa:latest` | Moving stable alias; override with a released tag or digest to pin |
| `OMCPA_MASTER_KEY` | required | At-rest encryption key: `openssl rand -hex 32`; back it up separately |
| `CPA_MANAGEMENT_KEY` | required in full stack | New gateway's administrator key, passed to both services |
| `OMCPA_PUBLIC_URL` | `http://127.0.0.1:8080` | Browser origin; use `https://` only when browsers actually use TLS |
| `OMCPA_BASE_PATH` | `/omc` | Console prefix; `/` serves OMC at the host root |
| `OMCPA_BIND` | `127.0.0.1:8080` | Console host bind; change it when this port is occupied |
| `CPA_BIND` | `127.0.0.1:8317` | Gateway host bind, full stack only |
| `CPA_IMAGE` | `eceasy/cli-proxy-api:latest` | Moving gateway alias, full stack only; pin or update separately from OMC |
| `TZ` | `UTC` | Shared calendar; match the existing CPA when adding OMC |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | Set `off` if another process drains this CPA's destructive usage queue |
| `OMCPA_TRUSTED_PROXY_CIDRS` | empty | Exact trusted proxy peers; leave empty for direct clients |
| `OMCPA_DATA_PATH` | `../oh-my-cpa-data` | OMC data directory, relative to the Compose file |
| `CPA_CONFIG_PATH`, `CPA_AUTH_PATH`, `CPA_LOG_PATH`, `CPA_PLUGIN_PATH` | under `../cpa/` | Gateway state, full stack only |
| `OMCPA_NETWORK_NAME` | `oh-my-cpa` / `oh-my-cpa-standalone` | Full-stack / OMC-only Docker network name |
| `OMCPA_NETWORK_EXTERNAL` | `false` | OMC-only: `true` attaches to an existing Docker network |
| `OMCPA_UPDATE_CHECK_ENABLED` / `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | Periodic / page-open update checks; set both false for offline operation |

## Docker Compose, beside an existing CPA

Use **`deploy/compose.omc.yml`**, which starts only OMC. Keep the existing CPA's
configuration, volumes, version, keys, ports and management panel intact.

```bash
mkdir -p oh-my-cpa/deploy oh-my-cpa/oh-my-cpa-data
cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/compose.omc.yml \
  -o deploy/compose.omc.yml
sudo chown 10001:10001 oh-my-cpa-data
sudo chmod 700 oh-my-cpa-data
umask 077
cat > deploy/.env <<EOF_ENV
OMCPA_CPA_BASE_URL=http://your-cpa-host:8317
OMCPA_CPA_MANAGEMENT_KEY=replace-with-your-existing-plaintext-management-key
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
OMCPA_PUBLIC_URL=http://127.0.0.1:8080
TZ=UTC
EOF_ENV
```

Replace the CPA URL and management key privately in the file, then:

```bash
docker compose --env-file deploy/.env -f deploy/compose.omc.yml pull
docker compose --env-file deploy/.env -f deploy/compose.omc.yml up -d
```

Open `http://127.0.0.1:8080/omc/`. The key must be the **plaintext secret**, not the
bcrypt hash CPA writes to its configuration. Keep `OMCPA_MASTER_KEY` unchanged when
an OMC data directory already exists.

### Reaching an existing gateway

The URL must be reachable **from OMC's container**, not just from your shell.

| Existing CPA | Connection |
| --- | --- |
| Container on a user-defined network | Set `OMCPA_NETWORK_NAME` to that network, `OMCPA_NETWORK_EXTERNAL=true`, and `OMCPA_CPA_BASE_URL=http://<CPA network alias>:8317` |
| Host process listening on a reachable host interface | Use `http://host.docker.internal:8317`; the Compose file supplies the host-gateway mapping. Check firewall and management allow-remote rules |
| Host process bound only to `127.0.0.1` | Use a native OMC source build, or explicitly approve Linux host networking with a loopback OMC listen address. Host-gateway mapping does not make a loopback-only listener reachable |
| Remote gateway | Use its private reachable URL or HTTPS endpoint; do not publish the management port just to install OMC |

Management requests from a sibling container are remote requests to CPA. If they are
refused, ask the owner before changing CPA's v8 `management.allow-remote` (legacy:
`remote-management.allow-remote`). Changing it expands a security boundary; keep the
listener on a private network. `OMCPA_CPA_USAGE_ADDR` can override the derived RESP
address, but CPA v8 deployments normally fall back to HTTP polling in `auto` mode.

### Other management panels

Another panel can coexist with OMC: both administer the same CPA state. They do not
share OMC's database or naming preferences. Inspect whether that panel or any exporter
consumes the usage queue. If it does, leave it running and set
`OMCPA_USAGE_INGEST_MODE=off` in `deploy/.env`; OMC can manage CPA but will not capture
new request records. Reassign collection only with explicit approval. Coordinate
configuration edits between panels; do not disable or uninstall one as an installation step.

### Existing HTTPS or private-network access

An existing proxy can forward to OMC's loopback/private listener, preserving the entire
configured base path. Set `OMCPA_PUBLIC_URL` to the actual browser origin and
`OMCPA_TRUSTED_PROXY_CIDRS` only to the proxy's real peers. The project does not install
or manage that proxy. A public HTTP listener would carry an administrator credential
without TLS: keep loopback/SSH access, or configure HTTPS with your own infrastructure.
Changing OMC to `/` does not affect CPA's separately published API port.

## Let your agent install it

Give your coding agent [`docs/install-for-agents.md`](install-for-agents.md). It begins
with inventory, chooses a topology and asks before altering any existing service,
exposing a port, changing collection ownership or installing system software.

## From source

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env` privately: set `OMCPA_MASTER_KEY`, `OMCPA_CPA_MANAGEMENT_KEY` and a reachable
`OMCPA_CPA_BASE_URL`. If the gateway is remote, also set `OMCPA_CPA_USAGE_ADDR` or
leave it empty to derive it from the URL. Then:

```bash
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

Open `http://127.0.0.1:8080/omc/`. This is a foreground process; use your existing service
manager for persistence. Real environment variables override `.env`; `OMCPA_ENV_FILE`
selects another file. Set a loopback `OMCPA_LISTEN_ADDR` and local-disk `OMCPA_DATA_DIR`.
Untagged source builds identify as `v0.1.0-dev`; official release builds inject the exact
version into the binary. `OMCPA_VERSION` is an explicit override, not an upgrade mechanism.
For hot reload, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Verify the install

```bash
docker compose --env-file deploy/.env -f deploy/compose.full.yml ps
curl -fsS http://127.0.0.1:8080/omc/api/healthz
```

Use `compose.omc.yml` for OMC-only installs and the normalized path/port you selected.
Success requires `status: ok`, `database_status: ok`, `cpa_connected: true` and a
supported `cpa_management_api`. Image health accepts `degraded` because restarting OMC
cannot fix an unreachable gateway; **healthy container does not establish CPA connectivity**.
Sign in and verify the System Information page names the running image tag, then check
provider discovery. Send a real model request only with approval; it may cost money.

| Symptom | Check |
| --- | --- |
| Permission denied or unable to open database | Bind directory ownership `10001:10001`, mode `700`, local disk |
| `degraded` health | Container reachability, management key, CPA management access rules |
| Sign-in repeats | `https://` public URL while browsing plain HTTP, so `Secure` cookies are dropped |
| Upgrade guidance | CPA must be v8.0.0 or later |
| Empty request records | Collection ownership and CPA usage-statistics setting |
| Wrong running version | Selected image tag/digest and any `OMCPA_VERSION` override; source `.env` defaults are development-only |
| Port conflict | Choose an unused `OMCPA_BIND`/`CPA_BIND` and update the browser URL |

Back up the master key and data directory; one OMC replica per data directory, on local
disk, and one collector per CPA. See `docs/ops/sqlite-operations.md`.

## Upgrading

Back up first. Set `OMCPA_IMAGE=wiziscool/oh-my-cpa:vX.Y.Z` in `deploy/.env` to the
chosen published version; keep the same data directory and master key.

```bash
docker compose --env-file deploy/.env -f deploy/compose.full.yml pull oh-my-cpa
docker compose --env-file deploy/.env -f deploy/compose.full.yml up -d --no-deps oh-my-cpa
```

This updates only OMC, not CPA. Use the OMC-only file if that is your deployment.
Repeat health, sign-in and running-version checks. Database migrations are forward-only;
do not run an older image against a migrated database. Restore a compatible backup when
rolling back. Tag publishing and release verification are documented in `docs/releasing.md`.
