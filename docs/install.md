# Installation

Oh My CPA (OMC) runs beside [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA) **v8.0.0 or later**. The console's sign-in password is CPA's management key. The
image is **`wiziscool/oh-my-cpa`** on Docker Hub, for `linux/amd64` and `linux/arm64`.

| Scenario | Method |
| --- | --- |
| Run without Docker on macOS, Windows, Linux or FreeBSD on amd64/arm64, with a matching release asset | [Native executable](#native-executable) |
| CPA is not deployed yet | [New install](#new-install) |
| CPA is deployed with Docker Compose | [Add to the existing Compose file](#add-to-the-existing-compose-file) |
| CPA is deployed another way | [Standalone](#standalone) |
| Explicit source build, or no published native asset matches the host OS/architecture | [Build from source](#from-source) |

A coding agent can run the same steps from
[`docs/install-for-agents.md`](install-for-agents.md).

The Docker methods need Docker Engine with the Compose plugin. The commands assume a
Linux or macOS shell with `curl` and `openssl`. The Compose files in the three methods
are the minimum that runs; [release Compose files](#release-compose-files) describes
the hardened files each release publishes.

## New install

Deploys CPA and OMC together.

1. Create a directory and save the following as `compose.yml`:

   ```yaml
   services:
     cli-proxy-api:
       image: eceasy/cli-proxy-api:latest
       restart: unless-stopped
       ports:
         - "127.0.0.1:8317:8317"
       environment:
         MANAGEMENT_PASSWORD: ${CPA_MANAGEMENT_KEY:?}
       volumes:
         - ./config.yaml:/CLIProxyAPI/config.yaml
         - ./auths:/root/.cli-proxy-api
         - ./logs:/CLIProxyAPI/logs
         - ./plugins:/CLIProxyAPI/plugins

     oh-my-cpa:
       image: wiziscool/oh-my-cpa:latest
       restart: unless-stopped
       depends_on:
         - cli-proxy-api
       ports:
         - "127.0.0.1:8080:8080"
       environment:
         OMCPA_CPA_BASE_URL: http://cli-proxy-api:8317
         OMCPA_CPA_MANAGEMENT_KEY: ${CPA_MANAGEMENT_KEY:?}
         OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
         OMCPA_DATA_DIR: /data
       volumes:
         - oh-my-cpa-data:/data

   volumes:
     oh-my-cpa-data:
   ```

2. In the same directory, download the starter configuration for CPA:

   ```bash
   curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
   ```

   The file must exist before the first start: Docker creates a directory in place of a
   missing bind-mounted file. It enables remote management and usage statistics, which
   OMC needs, and holds no client keys.

3. Generate the two keys. `CPA_MANAGEMENT_KEY` is CPA's management key and the console's
   sign-in password; `OMCPA_MASTER_KEY` encrypts OMC's database.

   ```bash
   cat > .env <<EOF
   CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
   OMCPA_MASTER_KEY=$(openssl rand -hex 32)
   EOF
   chmod 600 .env
   ```

4. Start both services:

   ```bash
   docker compose up -d
   ```

5. Open **`http://127.0.0.1:8080/omc/`** and sign in with the `CPA_MANAGEMENT_KEY` value
   from `.env`.

The new CPA has no providers and no client keys; add both in the console before sending
requests. Clients send requests to CPA at `http://127.0.0.1:8317`.

What the directory holds afterwards:

- `config.yaml`, `auths/`, `logs/` and `plugins/` belong to CPA. Docker creates the
  three directories on first start.
- OMC's database lives in the `oh-my-cpa-data` Docker volume, which the image already
  owns as user `10001`.
- `.env` holds both keys.

## Add to the existing Compose file

Runs OMC as one more service in the Compose file that already runs CPA.

1. Add the service under `services:`. If the file already has a top-level `volumes:`
   key, add `oh-my-cpa-data:` under it instead of repeating the key.

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

   `cli-proxy-api` is the service name in CPA's own Compose file. If the service has
   another name, use it in `OMCPA_CPA_BASE_URL`. Two services in one file share a
   network, so the name is all OMC needs.

2. In the directory that holds the Compose file, generate the master key. `>>` appends
   to `.env` and creates it if it is missing, so existing lines stay.

   ```bash
   echo "OMCPA_MASTER_KEY=$(openssl rand -hex 32)" >> .env
   chmod 600 .env
   ```

3. Add CPA's management key to `.env`. It is the plaintext key typed to sign in, not the
   bcrypt hash CPA stores in `config.yaml`.

   ```dotenv
   OMCPA_CPA_MANAGEMENT_KEY=<management key>
   ```

4. Start OMC:

   ```bash
   docker compose up -d oh-my-cpa
   ```

5. Open **`http://127.0.0.1:8080/omc/`** and sign in with the management key.

Effect on the existing deployment:

- `docker compose up -d oh-my-cpa` creates the OMC container only. The CPA container
  keeps running; it is not recreated or restarted, and its configuration, keys and
  volumes are unchanged.
- OMC's database lives in the `oh-my-cpa-data` Docker volume.
- Other settings go in the `environment:` block under the names in
  `docs/operations.md`, for example `TZ` to match CPA's time zone.

CPA sees OMC as a remote client. If the console reports that it cannot connect, see the
note on `management.allow-remote` under [reaching CPA](#reaching-cpa); that is the one
case where CPA's configuration has to change.

## Standalone

Runs OMC from its own Compose file next to a CPA that runs on the host, in another
Docker project or on another machine. CPA, its configuration and its keys are not
changed.

1. Create a directory and save the following as `compose.yml`:

   ```yaml
   services:
     oh-my-cpa:
       image: wiziscool/oh-my-cpa:latest
       restart: unless-stopped
       ports:
         - "127.0.0.1:8080:8080"
       extra_hosts:
         - host.docker.internal:host-gateway
       environment:
         OMCPA_CPA_BASE_URL: http://host.docker.internal:8317
         OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
         OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
         OMCPA_DATA_DIR: /data
       volumes:
         - oh-my-cpa-data:/data

   volumes:
     oh-my-cpa-data:
   ```

   Set `OMCPA_CPA_BASE_URL` according to [reaching CPA](#reaching-cpa). If CPA's clock is
   not UTC, add `TZ: <CPA's time zone>` under `environment:` so both agree on where a
   day starts.

2. Generate the master key:

   ```bash
   echo "OMCPA_MASTER_KEY=$(openssl rand -hex 32)" >> .env
   chmod 600 .env
   ```

3. Add CPA's management key to `.env`. It is the plaintext key typed to sign in, not the
   bcrypt hash CPA stores in `config.yaml`.

   ```dotenv
   OMCPA_CPA_MANAGEMENT_KEY=<management key>
   ```

4. Start OMC:

   ```bash
   docker compose up -d
   ```

5. Open **`http://127.0.0.1:8080/omc/`** and sign in with the management key.

### Reaching CPA

OMC runs in a container, so `OMCPA_CPA_BASE_URL` has to work from inside that container.

| CPA | Setting |
| --- | --- |
| Runs on the same machine, listening on all interfaces | `http://host.docker.internal:8317` (the value above) |
| Runs in another Docker project | `http://<CPA's container name>:8317`, with OMC joined to CPA's network (below) |
| Runs on another machine | Its private or HTTPS address |
| Listens on `127.0.0.1` only | A container cannot reach it. Install the [native executable](#native-executable) on the host when a release asset matches its OS/architecture; otherwise [build from source](#from-source) |

To join CPA's Docker network, add this to the standalone `compose.yml`:

```yaml
networks:
  default:
    name: <CPA's network>
    external: true
```

CPA sees OMC's container as a remote client. If OMC starts but reports that it cannot
connect, CPA is refusing remote management: set `management.allow-remote: true` in
CPA's `config.yaml` (`remote-management.allow-remote` in older layouts). That setting
lets any host that can reach the port try the management key, so keep the port off the
public internet.

## Other panels and usage trackers

**Another management panel** can keep running. It and OMC both edit the same CPA, so
a change made in one shows up in the other. OMC does not import the other panel's
history or settings.

**Another usage tracker** conflicts. CPA hands each usage record to one reader and then
deletes it, so two trackers would each get part of the traffic. The options:

- Stop the other tracker. OMC records every request from then on.
- Keep the other tracker and set `OMCPA_USAGE_INGEST_MODE` to `off`: as
  `OMCPA_USAGE_INGEST_MODE: "off"` under `environment:` in the Compose files above, or
  as `OMCPA_USAGE_INGEST_MODE=off` in `deploy/.env` with the release Compose files. OMC
  still manages CPA, but its dashboard and request records stay empty.

## Release Compose files

Each release publishes two Compose files, kept in `deploy/`. Compared with the files
above they run the console with a read-only root filesystem, no added capabilities and
no privilege escalation, start OMC only after CPA is healthy, keep OMC's data in a host
directory, and read every setting from `.env`.

| File | Equivalent method |
| --- | --- |
| `compose.full.yml` | [New install](#new-install) |
| `compose.omc.yml` | [Standalone](#standalone) |

CPA and OMC together:

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

OMC beside an existing CPA:

```bash
mkdir -p oh-my-cpa/{deploy,oh-my-cpa-data} && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o deploy/compose.omc.yml
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
OMCPA_CPA_BASE_URL=http://host.docker.internal:8317
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 deploy/.env
```

Add `OMCPA_CPA_MANAGEMENT_KEY=<management key>` to `deploy/.env`, in plaintext, and
change the URL where [reaching CPA](#reaching-cpa) says so. To join CPA's Docker
network, set `OMCPA_NETWORK_NAME=<CPA's network>` and `OMCPA_NETWORK_EXTERNAL=true`
instead of editing the file. Then:

```bash
docker compose -f deploy/compose.omc.yml up -d
```

The `chown` is there because the OMC container runs as user `10001` and writes its
database to the `oh-my-cpa-data` directory.

### Settings

These are the variables the two release Compose files accept. Compose reads
`deploy/.env`, which sits next to the Compose file. Relative paths are resolved from the
`deploy` directory.

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
| `OMCPA_TRUSTED_PROXY_CIDRS` | empty | Addresses of the reverse proxy |
| `OMCPA_DATA_PATH` | `../oh-my-cpa-data` | OMC's data directory |
| `CPA_CONFIG_PATH`, `CPA_AUTH_PATH`, `CPA_LOG_PATH`, `CPA_PLUGIN_PATH` | under `../cpa/` | CPA's files, full stack only |
| `OMCPA_NETWORK_NAME` | `oh-my-cpa` / `oh-my-cpa-standalone` | Docker network name (full stack / OMC only) |
| `OMCPA_NETWORK_EXTERNAL` | `false` | OMC only: `true` joins a network that already exists |
| `OMCPA_UPDATE_CHECK_ENABLED`, `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | Set both to `false` on a machine with no internet |

Everything else OMC reads is in `docs/operations.md`.

## Reaching the console from elsewhere

Every Compose file here publishes on `127.0.0.1` only. From another machine, tunnel over
SSH and open `http://127.0.0.1:18080/omc/`:

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```

To serve OMC over HTTPS, point the existing reverse proxy at `127.0.0.1:8080`, keep the
`/omc` prefix, and set `OMCPA_PUBLIC_URL` to the address browsers use. Set
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
curl -sI https://example.com/omc | head -n 1                           # 308
curl -fsS https://example.com/omc/api/healthz
```

With a different `OMCPA_BASE_PATH`, the same holds for that prefix. With `/` there is
no bare path to handle.

## Native executable

[GitHub Releases](https://github.com/WizisCool/oh-my-cpa/releases) publish OMC for
Darwin (macOS), Windows, Linux and FreeBSD, each on **amd64** and **arm64**. `x86_64`
is amd64; `aarch64` and Apple Silicon are arm64. Unix archives are `.tar.gz`; Windows
archives are `.zip`. CPA must already be installed separately (v8.0.0 or later).
The console and IANA time-zone database are embedded, so neither Node, Go nor Docker
is needed. HTTPS uses the operating system's certificate roots. Darwin/Windows
binaries are unsigned; inspect the release and verify its checksum before handling
any operating-system trust prompt.

Choose one published version and its matching OS/architecture asset. On Unix, set
these values to that release and host; the example uses Linux amd64:

```bash
VERSION=MAJOR.MINOR.PATCH
OS=linux
ARCH=amd64
ASSET="oh-my-cpa_${VERSION}_${OS}_${ARCH}.tar.gz"
mkdir -p oh-my-cpa && cd oh-my-cpa
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/${ASSET}"
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/checksums.txt"
```

Verify **only the downloaded archive's entry** (the manifest also lists the other
platforms and installation attachments). On Linux use `sha256sum -c`, on macOS
`shasum -a 256 -c`, or on FreeBSD compare `sha256 -q "$ASSET"` with its entry:

```bash
grep -F "  $ASSET" checksums.txt | sha256sum -c -
tar -xzf "$ASSET"
cp -n .env.example .env
chmod 600 .env
```

On Windows, download the matching ZIP and `checksums.txt` from the same release,
use PowerShell `Get-FileHash -Algorithm SHA256` and compare with that ZIP's manifest
entry, then `Expand-Archive` into a new directory and copy `.env.example` to `.env`.
Restrict access to `.env` and the data directory to the service account with Windows
file ACLs. Do not overwrite an existing configuration or data directory.

Set `OMCPA_MASTER_KEY` once to a random 64-character hex string (`openssl rand -hex 32`
on Unix; use a cryptographic random generator on Windows), set CPA's plaintext
management key and its reachable URL, and match CPA's `TZ`. Keep `OMCPA_VERSION`
unset so the tagged build reports its embedded version. The included template binds
`127.0.0.1:8080`, serves `/omc` and writes SQLite to `./data` under the working directory.
When CPA is on the same host, its loopback URL works without changing CPA's remote
management policy. Review [usage-reader ownership](#other-panels-and-usage-trackers)
before keeping `OMCPA_USAGE_INGEST_MODE=auto`; use `off` if another reader continues.

Run `./oh-my-cpa` on Unix or `.\oh-my-cpa.exe` on Windows from that directory. Verify
[health and connectivity](#verifying-the-install), then open `http://127.0.0.1:8080/omc/`
and sign in with CPA's management key. For an operator-owned service manager, keep the
same working directory, environment file, service account and data path. Do not open
the listener to the network without configuring remote access and HTTPS.

To upgrade a native install, stop OMC alone, back up `.env` and its data directory,
verify/extract the new archive separately, then replace only the executable and start
it from the original working directory. Preserve the master key and state. Verify
health and the new running version. Migrations are forward-only; returning to an
older executable requires restoring the corresponding data backup.

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

Open `http://127.0.0.1:8080/omc/`. The process runs in the foreground; a service manager
such as systemd keeps it running. Variables in the environment win over `.env`, and
`OMCPA_ENV_FILE` points at a different file. A build from an untagged checkout reports
itself as `v0.1.0-dev`. For hot reload while developing, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Verifying the install

```bash
curl -fsS http://127.0.0.1:8080/omc/api/healthz
```

A working install returns `"status":"ok"` and `"cpa_connected":true`. A container that
Docker reports as healthy is not enough: OMC stays up, with `"status":"degraded"`, when
it cannot reach CPA.

| Symptom | Cause |
| --- | --- |
| `permission denied`, or the database will not open | With the release Compose files: `oh-my-cpa-data` is not owned by `10001:10001`, or is on a network filesystem |
| CPA fails to start and `config.yaml` is a directory | `config.yaml` did not exist at first start. Remove the directory, download the file and start again |
| `status` is `degraded` | Wrong CPA URL or management key, or CPA refuses remote management. See [reaching CPA](#reaching-cpa) |
| Sign-in succeeds, then asks again | `OMCPA_PUBLIC_URL` says `https://` but the browser uses plain HTTP |
| The console asks for a CPA upgrade | CPA is older than v8.0.0 |
| Request records stay empty | Another tool is collecting usage, `OMCPA_USAGE_INGEST_MODE=off` is set, or usage statistics are disabled in CPA |
| Port already in use | Change the host side of the `ports:` entry, or set `OMCPA_BIND` / `CPA_BIND` with the release Compose files |

## Upgrading

Back up `.env` and OMC's data first, then pull the new image in the directory that
holds the Compose file. `docs/ops/sqlite-operations.md` is the backup runbook; its
commands use the release Compose files. With the files in this guide the data is in the
Docker volume `<project>_oh-my-cpa-data`, and `docker volume inspect` prints its path.

```bash
docker compose pull oh-my-cpa
docker compose up -d --no-deps oh-my-cpa
```

With a release Compose file, add `-f deploy/compose.full.yml` or
`-f deploy/compose.omc.yml` to both commands.

This upgrades OMC and leaves CPA as it is. To move to a specific version, change the
`image:` tag to `wiziscool/oh-my-cpa:vX.Y.Z`, or set `OMCPA_IMAGE` in `deploy/.env` with
a release Compose file. Upgrades migrate the database and there is no downgrade: the way
back to an older version is to restore the backup. How releases are published is in
`docs/releasing.md`.

## Constraints

- Keep `OMCPA_MASTER_KEY` safe and unchanged. Without it the stored data is unreadable.
- One OMC per data directory, on a local disk.
- One usage collector per CPA.
