# Installation

Oh My CPA is one Go binary with the console embedded. It sits beside a running
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) and signs you in with
CPA's own management key.

Pick one path:

| Path | Use it when |
| --- | --- |
| [Docker Compose, full stack](#docker-compose-full-stack) | You want CPA, Oh My CPA and HTTPS from one command |
| [Docker Compose, beside an existing CPA](#docker-compose-beside-an-existing-cpa) | CPA already runs and you only add the console |
| [From source](#from-source) | You want a native binary, or you are developing |
| [Let an agent do it](install-for-agents.md) | You would rather hand the steps to a coding agent |

To look before installing, open the [live demo](https://omc-demo.junze.dev).

## Requirements

- CLIProxyAPI **v8.0.0 or later**. An older gateway is refused and every page shows
  upgrade guidance instead. CPA v8 reads an existing v7 `config.yaml` unchanged; see
  `docs/cpa-v8-compat.md`.
- The gateway's **plaintext management key**. It is both what Oh My CPA uses to reach
  CPA and the password you type into the console; there is no second account.
- For Docker: Docker Engine with the Compose plugin.
- For source builds: Go 1.25+ (CI pins `1.27.1`), Node.js 22+, pnpm 11+.

Two values are yours to generate and keep:

| Value | What it is | How to make one |
| --- | --- | --- |
| `OMCPA_MASTER_KEY` | Encrypts stored credentials and raw usage messages at rest. Losing it makes that data unreadable | `openssl rand -hex 32` |
| CPA management key | The gateway's administrator secret | `openssl rand -hex 24`, or the one your CPA already has |

## Docker Compose, full stack

`deploy/compose.full.yml` runs CPA, Oh My CPA and Caddy on one private network. Caddy
serves the console under `/omc` and passes everything else to CPA, so one host name
carries both the gateway API and its console. The image is built from this repository.

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa

# 1. CPA's configuration. Start from the gateway's own example file.
mkdir -p cpa
curl -fsSL https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/config.example.yaml \
  -o cpa/config.yaml

# 2. The data directory. The container runs as uid 10001 and must be able to write it.
mkdir -p oh-my-cpa-data
sudo chown 10001:10001 oh-my-cpa-data

# 3. Secrets and the address you will open.
cat > deploy/.env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
DOMAIN=localhost
OMCPA_PUBLIC_URL=https://localhost
EOF

# 4. Build and start.
docker compose --env-file deploy/.env -f deploy/compose.full.yml up -d --build
```

Open `https://localhost/omc/` and sign in with the `CPA_MANAGEMENT_KEY` from
`deploy/.env`. On `localhost` Caddy issues a certificate from its own local authority,
so the browser asks you to accept it once.

For a public host, set `DOMAIN=cpa.example.com` and
`OMCPA_PUBLIC_URL=https://cpa.example.com`, point the DNS record at the machine, and
leave ports 80 and 443 reachable: Caddy obtains the certificate itself.

What the stack reads from `deploy/.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CPA_MANAGEMENT_KEY` | required | Handed to CPA as its management key, and to Oh My CPA to reach it |
| `OMCPA_MASTER_KEY` | required | At-rest encryption key |
| `OMCPA_PUBLIC_URL` | required | The address browsers use. An `https://` value marks the session cookie `Secure` |
| `DOMAIN` | `localhost` | Host name Caddy serves |
| `OMCPA_BASE_PATH` | `/omc` | Console sub-path. `/` gives the console the whole host, and CPA is then not reachable through the proxy |
| `CPA_IMAGE` | `eceasy/cli-proxy-api:v8.0.2` | Gateway image |
| `HTTP_BIND` / `HTTPS_BIND` | `0.0.0.0:80` / `0.0.0.0:443` | Where Caddy listens |
| `TZ` | `UTC` | Calendar shared by CPA and Oh My CPA; keep them equal |
| `CPA_CONFIG_PATH`, `CPA_AUTH_PATH`, `CPA_LOG_PATH`, `CPA_PLUGIN_PATH` | under `cpa/` | Gateway state on the host |
| `OMCPA_DATA_PATH` | `oh-my-cpa-data/` | SQLite database on the host |

## Docker Compose, beside an existing CPA

`deploy/compose.omc.yml` runs only Oh My CPA and publishes it on `127.0.0.1:8080`.

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa

mkdir -p oh-my-cpa-data
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
OMCPA_CPA_BASE_URL=http://cpa.internal:8317
OMCPA_CPA_MANAGEMENT_KEY=<your CPA management key>
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
OMCPA_PUBLIC_URL=http://127.0.0.1:8080
EOF

docker compose --env-file deploy/.env -f deploy/compose.omc.yml up -d --build
```

Open `http://127.0.0.1:8080/omc/`.

`OMCPA_CPA_BASE_URL` must be an address the **container** can reach. Inside a container
`127.0.0.1` is the container itself, so a CPA bound to the host's loopback is not
reachable that way: use the host's LAN address, a shared Docker network, or the
full-stack file. `OMCPA_CPA_USAGE_ADDR` (`host:port`) defaults to the host and port of
`OMCPA_CPA_BASE_URL`.

Put your own reverse proxy in front for HTTPS (`deploy/nginx.conf` is a starting point),
then set `OMCPA_PUBLIC_URL` to the HTTPS address and `OMCPA_TRUSTED_PROXY_CIDRS` to the
proxy's network.

## From source

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile

cp .env.example .env
# Edit .env: OMCPA_MASTER_KEY (openssl rand -hex 32) and OMCPA_CPA_MANAGEMENT_KEY.
# If CPA is not on 127.0.0.1:8317, also OMCPA_CPA_BASE_URL and OMCPA_CPA_USAGE_ADDR.

pnpm build                                   # builds the console into internal/web/dist
go build -o bin/oh-my-cpa ./cmd/oh-my-cpa    # one binary, console embedded
./bin/oh-my-cpa
```

Open `http://127.0.0.1:8080/omc/` and sign in with the CPA management key.

The binary reads `.env` from the working directory as a convenience; real environment
variables win, and `OMCPA_ENV_FILE` names a different file. For a service manager, set
the variables in the unit and point `OMCPA_DATA_DIR` at a directory on a local disk.

For development with hot reload, see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Verify the install

```bash
curl -s http://127.0.0.1:8080/omc/api/healthz
```

A working install answers `"status":"ok"` with `"cpa_connected":true` and
`"database_status":"ok"`. `"degraded"` means the console is up but cannot reach CPA:
check `OMCPA_CPA_BASE_URL` and the management key.

| Symptom | Cause |
| --- | --- |
| The container restarts with `unable to open database file` | The data directory is not writable by uid 10001 |
| Sign-in succeeds but the next page asks again | `OMCPA_PUBLIC_URL` is `https://` while you browse over plain HTTP, so the `Secure` cookie is dropped |
| Every page shows upgrade guidance | The gateway is older than CPA v8.0.0 |
| The dashboard stays empty while traffic flows | Another collector is draining CPA's usage queue; only one may read it |

## After installing

- **Back up `OMCPA_MASTER_KEY`** somewhere other than the data directory.
- **Run one replica per data directory**, on a local filesystem. SQLite WAL does not
  tolerate NFS or CIFS.
- **Keep CPA off the public internet**, or behind the same proxy as the console.
- Backups, restores and upgrades: `docs/ops/sqlite-operations.md`.
- Every setting and the operational notes: `docs/operations.md`.

## Upgrading

```bash
git pull
docker compose --env-file deploy/.env -f deploy/compose.full.yml up -d --build
```

For a source install, `git pull`, then repeat `pnpm install --frozen-lockfile`,
`pnpm build` and `go build`. Migrations are forward-only and run at start-up; take a
backup first (`docs/ops/sqlite-operations.md`).
