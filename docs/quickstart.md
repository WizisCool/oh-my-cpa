# Quickstart

Run CLIProxyAPI (CPA), Oh My CPA and the console updater together on one machine with
Docker Compose. It takes about three minutes and four commands. Already running CPA? Use
[Standalone](install/standalone.md) instead, so your gateway is left untouched.

## Before you start

- Docker Engine with the Compose plugin, on Linux or macOS (Windows with WSL works too).
- `curl` and `openssl` in your shell.
- Ports `8080` (console) and `8317` (gateway) free on `127.0.0.1`. If one is taken,
  see [Changing the port](operate/ports-storage.md#changing-the-port).

## 1. Download the stack

```bash
test ! -e oh-my-cpa/compose.yml && test ! -e oh-my-cpa/config.yaml || { echo "Existing deployment found in oh-my-cpa/; aborting to avoid overwriting config.yaml" >&2; exit 1; }
mkdir -p oh-my-cpa && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o compose.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
```

`config.yaml` is CPA's starter configuration. It must exist before the first start:
Docker creates a directory in place of a missing bind-mounted file. It enables remote
management and usage statistics, which OMC needs, and holds no client keys.

## 2. Generate the two keys

```bash
test ! -e .env || { echo ".env already exists; keep it to preserve OMCPA_MASTER_KEY" >&2; exit 1; }
(
  umask 077
  cat > .env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
)
```

`CPA_MANAGEMENT_KEY` is CPA's management key and the console's sign-in password.
`OMCPA_MASTER_KEY` encrypts OMC's database: back up `.env` now and never overwrite an
existing `.env`, because stored data cannot be read without the original master key.

## 3. Start it

```bash
docker compose up -d
```

## 4. Sign in

Open **`http://127.0.0.1:8080/`** and sign in with the `CPA_MANAGEMENT_KEY` value from
`.env`. To confirm the console can reach the gateway:

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
```

A working stack answers `"status":"ok"` and `"cpa_connected":true`. Anything else is
covered in [Troubleshooting](install/troubleshooting.md).

## What you have now

The new CPA has no providers and no client keys yet. Add both in the console (AI providers
or OAuth management, then Key management), and point your clients at CPA on
`http://127.0.0.1:8317`. Every request then appears in the console with its latency,
tokens and cost.

The directory holds:

- `compose.yml` and `.env`: the stack and its keys.
- `config.yaml`, `auths/`, `logs/` and `plugins/`: CPA's files. Docker creates the three
  directories on first start.
- OMC's database, in the `oh-my-cpa-data` Docker volume. To keep it in a host directory
  instead, see [Storage and permissions](operate/ports-storage.md#storage-and-permissions).

`oh-my-cpa-updater` applies updates you start from the console. It is the only container
that mounts the Docker socket; to update by hand instead, remove that service from
`compose.yml` (and `docker rm -f oh-my-cpa-updater` if it already started).

## Next steps

- Reach the console from another machine or over HTTPS: [Remote access](install/remote-access.md).
- Keep it current: [Upgrading](install/upgrade.md).
- Protect your data: [Backup and restore](ops/sqlite-operations.md).
- Tune it: [Environment variables](reference/environment.md).
