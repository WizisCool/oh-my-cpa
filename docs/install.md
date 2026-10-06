# Installation

Oh My CPA (OMC) runs beside [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA) **v8.0.0 or later**. You sign in to OMC with CPA's management key. The image is
**`wiziscool/oh-my-cpa`** on Docker Hub, for `linux/amd64` and `linux/arm64`.

Pick the line that describes you:

| You have | Do this |
| --- | --- |
| Nothing yet | [Install CPA and OMC together](#install-cpa-and-omc-together) |
| CPA, deployed with Docker Compose | [Add OMC to CPA's Compose file](#add-omc-to-cpas-compose-file) |
| CPA, deployed some other way | [Add OMC to an existing CPA](#add-omc-to-an-existing-cpa) |
| CPA and another panel or usage tracker | Either of those, then read [switching from another tool](#switching-from-another-tool) |
| A coding agent you would rather hand this to | Give it [`docs/install-for-agents.md`](install-for-agents.md) |
| No Docker, or a CPA that only listens on `127.0.0.1` | [Build from source](#from-source) |

The Docker paths need Docker Engine with the Compose plugin and nothing else.

## Install CPA and OMC together

Run this where you want the install to live. It creates a new `oh-my-cpa` directory and
touches nothing outside it.

```bash
mkdir -p oh-my-cpa/{deploy,oh-my-cpa-data,cpa/auths,cpa/logs,cpa/plugins} && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o deploy/compose.full.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o cpa/config.yaml
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 deploy/.env

docker compose -f deploy/compose.full.yml up -d
```

Open **`http://127.0.0.1:8080/omc/`** (`/omc` without the slash redirects there) and
sign in with the `CPA_MANAGEMENT_KEY` from `deploy/.env`. The new CPA has no providers and no client keys; add both in the console
before sending requests. CPA itself listens on `127.0.0.1:8317`.

The `chown` is there because the OMC container runs as user `10001` and writes its
database to `oh-my-cpa-data`.

## Add OMC to CPA's Compose file

If CPA already runs from a Compose file, OMC can be one more service in it. Paste this
under `services:`, next to your CPA service:

```yaml
  oh-my-cpa:
    image: wiziscool/oh-my-cpa:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      OMCPA_CPA_BASE_URL: http://cli-proxy-api:8317
      OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_DATA_DIR: /data
    volumes:
      - oh-my-cpa-data:/data

volumes:
  oh-my-cpa-data:
```

If the file already has a top-level `volumes:` key, add `oh-my-cpa-data:` under it
instead of repeating the key. Then, in the directory that holds the Compose file:

```bash
cat >> .env <<EOF
OMCPA_CPA_MANAGEMENT_KEY=your-cpa-management-key
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env

docker compose up -d oh-my-cpa
```

Put your real management key in `.env` before the last command. It is the plaintext
key you type to sign in, not the bcrypt hash CPA stores in `config.yaml`. Open
**`http://127.0.0.1:8080/omc/`**.

What this does and does not touch:

- `docker compose up -d oh-my-cpa` creates the OMC container only. The CPA container
  keeps running; it is not recreated or restarted, and its configuration, keys and
  volumes are unchanged.
- `cli-proxy-api` is the service name in CPA's own Compose file. If yours is different,
  use that name in `OMCPA_CPA_BASE_URL`. Two services in one file share a network, so
  the name is all OMC needs.
- OMC's database lives in the `oh-my-cpa-data` Docker volume, which needs no `chown`.
- `>>` appends to `.env` and creates it if it is missing, so existing lines stay.
- Other settings go in the `environment:` block under the names in
  `docs/operations.md`, for example `TZ` to match CPA's time zone.

CPA sees OMC as a remote client. If the console reports that it cannot connect, read
the note on `management.allow-remote` under [reaching your CPA](#reaching-your-cpa);
that is the one case where CPA's configuration has to change.

To upgrade later: `docker compose pull oh-my-cpa && docker compose up -d oh-my-cpa`.

## Add OMC to an existing CPA

This starts OMC only. Your CPA, its configuration and its keys are not changed.

```bash
mkdir -p oh-my-cpa/{deploy,oh-my-cpa-data} && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o deploy/compose.omc.yml
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
OMCPA_CPA_BASE_URL=http://host.docker.internal:8317
OMCPA_CPA_MANAGEMENT_KEY=your-cpa-management-key
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 deploy/.env
```

Edit `deploy/.env`: put in your management key, and change the URL if the table below
says so. The key is the plaintext one you type to sign in, not the bcrypt hash CPA
stores in `config.yaml`. If CPA's clock is not UTC, add `TZ=` with CPA's time zone so
both agree on where a day starts. Then:

```bash
docker compose -f deploy/compose.omc.yml up -d
```

Open **`http://127.0.0.1:8080/omc/`**.

### Reaching your CPA

OMC runs in a container, so the URL has to work from inside that container.

| Your CPA | Set in `deploy/.env` |
| --- | --- |
| Runs on the same machine, listening on all interfaces | `OMCPA_CPA_BASE_URL=http://host.docker.internal:8317` (the default above) |
| Runs in Docker, and you want OMC in a separate Compose file | `OMCPA_NETWORK_NAME=<CPA's network>`, `OMCPA_NETWORK_EXTERNAL=true`, `OMCPA_CPA_BASE_URL=http://<CPA's container name>:8317` |
| Runs on another machine | Its private or HTTPS address |
| Listens on `127.0.0.1` only | A container cannot reach it. [Build from source](#from-source) and run OMC on the host |

CPA sees OMC's container as a remote client. If OMC starts but reports that it cannot
connect, CPA is refusing remote management: set `management.allow-remote: true` in
CPA's `config.yaml` (`remote-management.allow-remote` in older layouts). That setting
lets any host that can reach the port try the management key, so keep the port off the
public internet.

### Switching from another tool

**Another management panel** can keep running. It and OMC both edit the same CPA, so
a change made in one shows up in the other. OMC does not import the other panel's
history or settings.

**Another usage tracker** matters more. CPA hands each usage record to one reader and
then deletes it, so two trackers would each get part of the traffic. Choose one:

- Stop the old tracker. OMC records every request from then on.
- Keep the old tracker and add `OMCPA_USAGE_INGEST_MODE=off` to `deploy/.env`. OMC
  still manages CPA, but its dashboard and request records stay empty.

## Reaching the console from elsewhere

Both Compose files publish on `127.0.0.1` only. From another machine, tunnel over SSH
and open `http://127.0.0.1:18080/omc/`:

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```

To serve OMC over HTTPS, point your existing reverse proxy at `127.0.0.1:8080`, keep
the `/omc` prefix, and set `OMCPA_PUBLIC_URL` to the address browsers use. Set
`OMCPA_TRUSTED_PROXY_CIDRS` to the proxy's address so OMC reads the client IP it
forwards. Do not publish port 8080 on a public interface without TLS: the sign-in
password is CPA's administrator key.

### `/omc` and `/omc/`

The console lives at `/omc/`. OMC answers the bare `/omc` with a permanent redirect
(308) to `/omc/`, so either address opens it when browsers reach OMC directly.

Behind a reverse proxy the bare path only works if the proxy handles it. A rule that
matches `/omc/` alone never passes `/omc` to OMC, and the visitor gets whatever the
proxy serves for unmatched paths instead of the console. Cover both: redirect the bare
path at the proxy, or forward it and let OMC redirect.

nginx (`deploy/nginx.conf` is a complete example that also routes the rest of the host
to CPA):

```nginx
location = /omc {
    return 308 /omc/;
}

# No trailing slash on proxy_pass: the /omc prefix must reach OMC unchanged.
location ^~ /omc/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Caddy:

```caddyfile
@omc path /omc /omc/*
reverse_proxy @omc 127.0.0.1:8080
```

Check both addresses through the proxy:

```bash
curl -sI https://your-host/omc | head -n 1                           # 308
curl -fsS https://your-host/omc/api/healthz
```

With a different `OMCPA_BASE_PATH`, the same holds for that prefix. With `/` there is
no bare path to handle.

## Settings

These are the variables the two Compose files in `deploy/` accept. Compose reads `deploy/.env`, which sits next to the Compose file. Relative paths are
resolved from the `deploy` directory.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_MASTER_KEY` | required | Encrypts the database. Back it up; never change it once data exists |
| `CPA_MANAGEMENT_KEY` | required, full stack | The new CPA's management key and OMC's sign-in password |
| `OMCPA_CPA_BASE_URL` | required, OMC only | The existing CPA's address |
| `OMCPA_CPA_MANAGEMENT_KEY` | required, OMC only | The existing CPA's plaintext management key |
| `OMCPA_IMAGE` | `wiziscool/oh-my-cpa:latest` | Set a release tag or digest to pin a version |
| `CPA_IMAGE` | `eceasy/cli-proxy-api:latest` | Full stack only |
| `OMCPA_BIND` | `127.0.0.1:8080` | Host address of the console; change it if the port is taken |
| `CPA_BIND` | `127.0.0.1:8317` | Host address of CPA, full stack only |
| `OMCPA_PUBLIC_URL` | `http://127.0.0.1:8080` | The address browsers use. `https://` only when they really use TLS |
| `OMCPA_BASE_PATH` | `/omc` | URL prefix; `/` serves the console at the root |
| `TZ` | `UTC` | Calendar for daily totals; match CPA's |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | `off` when another tool collects this CPA's usage |
| `OMCPA_CPA_USAGE_ADDR` | derived from the CPA URL | Override for CPA's usage queue address, OMC only |
| `OMCPA_TRUSTED_PROXY_CIDRS` | empty | Addresses of your reverse proxy |
| `OMCPA_DATA_PATH` | `../oh-my-cpa-data` | OMC's data directory |
| `CPA_CONFIG_PATH`, `CPA_AUTH_PATH`, `CPA_LOG_PATH`, `CPA_PLUGIN_PATH` | under `../cpa/` | CPA's files, full stack only |
| `OMCPA_NETWORK_NAME` | `oh-my-cpa` / `oh-my-cpa-standalone` | Docker network name (full stack / OMC only) |
| `OMCPA_NETWORK_EXTERNAL` | `false` | OMC only: `true` joins a network that already exists |
| `OMCPA_UPDATE_CHECK_ENABLED`, `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | Set both to `false` on a machine with no internet |

Everything else OMC reads is in `docs/operations.md`.

## From source

Needs Go 1.25+, Node.js 22+, pnpm 11+ and a running CPA.

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile
cp .env.example .env
```

In `.env`, set `OMCPA_MASTER_KEY` (`openssl rand -hex 32`), `OMCPA_CPA_MANAGEMENT_KEY`
and `OMCPA_CPA_BASE_URL`. Then:

```bash
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

Open `http://127.0.0.1:8080/omc/`. The process runs in the foreground; put it under
systemd or whatever you already use to keep it running. Variables in the environment
win over `.env`, and `OMCPA_ENV_FILE` points at a different file. A build from an
untagged checkout reports itself as `v0.1.0-dev`. For hot reload while developing, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Check that it works

```bash
curl -fsS http://127.0.0.1:8080/omc/api/healthz
```

You want `"status":"ok"` and `"cpa_connected":true`. A container that Docker reports as
healthy is not enough: OMC stays up, with `"status":"degraded"`, when it cannot reach
CPA.

| Symptom | Cause |
| --- | --- |
| `permission denied`, or the database will not open | `oh-my-cpa-data` is not owned by `10001:10001`, or is on a network filesystem |
| `status` is `degraded` | Wrong CPA URL or management key, or CPA refuses remote management. See [reaching your CPA](#reaching-your-cpa) |
| Sign-in succeeds, then asks again | `OMCPA_PUBLIC_URL` says `https://` but you are browsing over plain HTTP |
| The console asks you to upgrade CPA | CPA is older than v8.0.0 |
| Request records stay empty | Another tool is collecting usage, `OMCPA_USAGE_INGEST_MODE=off` is set, or usage statistics are disabled in CPA |
| Port already in use | Set `OMCPA_BIND` or `CPA_BIND` to a free port |

## Upgrading

Back up `deploy/.env` and `oh-my-cpa-data` first (`docs/ops/sqlite-operations.md`),
then pull the new image. Use `compose.omc.yml` if that is what you installed with; if
OMC is a service in CPA's own Compose file, the command is in that section.

```bash
docker compose -f deploy/compose.full.yml pull oh-my-cpa
docker compose -f deploy/compose.full.yml up -d --no-deps oh-my-cpa
```

This upgrades OMC and leaves CPA as it is. To move to a specific version, set
`OMCPA_IMAGE=wiziscool/oh-my-cpa:vX.Y.Z` in `deploy/.env` first. Upgrades migrate the
database and there is no downgrade: to go back to an older version, restore the backup
you took. How releases are published is in `docs/releasing.md`.

## Keep in mind

- Keep `OMCPA_MASTER_KEY` safe and unchanged. Lose it and the stored data is unreadable.
- One OMC per data directory, on a local disk.
- One usage collector per CPA.
