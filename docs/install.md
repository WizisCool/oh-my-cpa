# Installation

Oh My CPA (OMC) runs beside [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
(CPA) **v8.0.0 or later**. The console's sign-in password is CPA's management key. The
image is **`wiziscool/oh-my-cpa`** on Docker Hub, for `linux/amd64` and `linux/arm64`.

| Scenario | Method |
| --- | --- |
| CPA is not deployed yet | [New install](#new-install) |
| CPA runs on the host, in another Docker project, or on another machine | [Standalone](#standalone) |
| CPA is deployed with Docker Compose and you prefer one Compose file | [Add to the existing Compose file](#add-to-the-existing-compose-file) |
| Run without Docker on macOS, Windows, Linux or FreeBSD on amd64/arm64 | [Native executable](#native-executable) |
| Explicit source build, or no published native asset matches the host OS/architecture | [Build from source](#from-source) |

A coding agent can run the same steps from
[`docs/install-for-agents.md`](install-for-agents.md).

<a id="release-compose-files"></a>

The Docker methods need Docker Engine with the Compose plugin. The commands assume a
Linux or macOS shell with `curl` and `openssl`. Each release publishes two official
Compose files in `deploy/` and as release assets:

- **`compose.full.yml`** — [New install](#new-install): CPA + OMC + updater.
- **`compose.omc.yml`** — [Standalone](#standalone): OMC + updater beside an existing CPA.

Both files run OMC as non-root user `10001:10001` with a read-only root filesystem, no
Linux capabilities and `no-new-privileges:true`, store OMC's SQLite database in the
`oh-my-cpa-data` named volume by default (so first-time setup needs no `mkdir` or
`chown`), include `oh-my-cpa-updater` for one-click console updates, and accept common
overrides from `.env` in the same directory.

## New install

Deploys CPA, OMC and the console updater together using `compose.full.yml`.

1. Create a directory and download `compose.full.yml` and CPA's starter configuration:

   ```bash
   mkdir -p oh-my-cpa && cd oh-my-cpa
   curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o compose.yml
   curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
   ```

   `config.yaml` must exist before the first start: Docker creates a directory in place of
   a missing bind-mounted file. The starter file enables remote management and usage
   statistics, which OMC needs, and holds no client keys.

2. Generate the two keys in `.env`. `CPA_MANAGEMENT_KEY` is CPA's management key and the
   console's sign-in password; `OMCPA_MASTER_KEY` encrypts OMC's database.

   ```bash
   cat > .env <<EOF
   CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
   OMCPA_MASTER_KEY=$(openssl rand -hex 32)
   EOF
   chmod 600 .env
   ```

3. Start the stack:

   ```bash
   docker compose up -d
   ```

4. Open **`http://127.0.0.1:8080/`** and sign in with the `CPA_MANAGEMENT_KEY` value
   from `.env`.

The new CPA has no providers and no client keys; add both in the console before sending
requests. Clients send requests to CPA at `http://127.0.0.1:8317`.

What the directory holds afterwards:

- `config.yaml`, `auths/`, `logs/` and `plugins/` belong to CPA. Docker creates the
  three directories on first start.
- OMC's database lives in the `oh-my-cpa-data` Docker named volume, initialized from the
  image's `/data` directory owned by `10001:10001`. To use a host directory instead, see
  [Storage and permissions](#storage-and-permissions).
- `.env` holds both keys and any optional overrides (such as `OMCPA_BIND` when port `8080`
  is already taken on the host; see [Ports, storage and common settings](#ports-storage-and-common-settings)).
- `oh-my-cpa-updater` applies updates triggered from the console; see
  [Upgrading](#upgrading). It is the only container that mounts `/var/run/docker.sock`.
  To update manually instead, remove the `oh-my-cpa-updater` service from `compose.yml`
  (and run `docker rm -f oh-my-cpa-updater` if it was already started).

## Standalone

Runs OMC and its updater from `compose.omc.yml` beside an existing CPA (on the host, in
another Docker Compose project, or on another machine). CPA, its configuration, its keys
and any other management panel are not modified or restarted.

1. Create a directory and download `compose.omc.yml`:

   ```bash
   mkdir -p oh-my-cpa && cd oh-my-cpa
   curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o compose.yml
   ```

2. Create `.env` with a generated `OMCPA_MASTER_KEY`, CPA's reachable URL and CPA's
   existing plaintext management key (the key typed to sign in, not the bcrypt hash in
   `config.yaml`). Wrap `OMCPA_CPA_MANAGEMENT_KEY` in single quotes in `.env` so Docker
   Compose does not treat `$` in the key as variable interpolation (escape any literal `'`
   as `\'`):

   ```bash
   printf 'OMCPA_CPA_BASE_URL=http://host.docker.internal:8317\nOMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" > .env
   cat >> .env <<'EOF'
   OMCPA_CPA_MANAGEMENT_KEY='<CPA plaintext management key>'
   EOF
   chmod 600 .env
   ```

   Edit `.env` to replace `<CPA plaintext management key>`, and set `OMCPA_CPA_BASE_URL`
   (plus network variables if CPA runs in another Docker project) according to
   [Reaching CPA](#reaching-cpa). If CPA's clock is not UTC, add `TZ=<CPA's time zone>` to
   `.env` so both agree on daily boundaries.

3. Start OMC and the updater:

   ```bash
   docker compose up -d
   ```

4. Open **`http://127.0.0.1:8080/`** and sign in with CPA's management key.

### Reaching CPA

OMC runs in a container, so `OMCPA_CPA_BASE_URL` must be reachable from inside that
container.

| Where CPA runs | `.env` configuration |
| --- | --- |
| On the same machine, listening on all interfaces (`:8317` or `0.0.0.0:8317`) | `OMCPA_CPA_BASE_URL=http://host.docker.internal:8317` |
| In another Docker project on the same host | `OMCPA_CPA_BASE_URL=http://<CPA service or container name>:8317`<br>`OMCPA_NETWORK_NAME=<CPA's Docker network>`<br>`OMCPA_NETWORK_EXTERNAL=true` |
| On another machine | `OMCPA_CPA_BASE_URL=https://<CPA host>:8317` (or its private network URL) |
| On the same machine, listening on `127.0.0.1` only | A bridge container cannot reach host loopback. Install the [native executable](#native-executable) on the host, or [build from source](#from-source) |

Joining CPA's existing Docker network via `OMCPA_NETWORK_NAME` and
`OMCPA_NETWORK_EXTERNAL=true` in `.env` requires no edits to either `compose.yml` or
CPA's own Compose project. Find CPA's network name with
`docker inspect <cpa-container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`.

CPA sees OMC's container as a remote client. If OMC starts cleanly but `/api/healthz`
reports `"status":"degraded"` and `"cpa_connected":false`, check whether CPA refuses
remote management: set `management.allow-remote: true` in CPA's `config.yaml`
(`remote-management.allow-remote` in older v7 layouts). Because that setting allows any
host that can reach CPA's port to attempt the management key, keep CPA's port off the
public internet.

## Add to the existing Compose file

If CPA already runs under Docker Compose and you prefer not to edit CPA's Compose file,
use [Standalone](#standalone) with `OMCPA_NETWORK_NAME` and `OMCPA_NETWORK_EXTERNAL=true`.

If you prefer to manage CPA and OMC in a single Compose file, add `oh-my-cpa` and
`oh-my-cpa-updater` under `services:` in CPA's Compose file, and add `oh-my-cpa-data:`
under the top-level `volumes:` key:

```yaml
  oh-my-cpa:
    image: ${OMCPA_IMAGE:-wiziscool/oh-my-cpa:latest}
    restart: unless-stopped
    user: ${OMCPA_USER:-10001:10001}
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    ports:
      - ${OMCPA_BIND:-127.0.0.1:8080}:8080
    environment:
      TZ: ${TZ:-UTC}
      OMCPA_BASE_PATH: ${OMCPA_BASE_PATH:-/}
      OMCPA_DATA_DIR: /data
      OMCPA_CPA_BASE_URL: ${OMCPA_CPA_BASE_URL:-http://cli-proxy-api:8317}
      OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_USAGE_INGEST_MODE: ${OMCPA_USAGE_INGEST_MODE:-auto}
      OMCPA_PUBLIC_URL: ${OMCPA_PUBLIC_URL:-}
      OMCPA_TRUSTED_PROXY_CIDRS: ${OMCPA_TRUSTED_PROXY_CIDRS:-}
    volumes:
      - ${OMCPA_DATA_PATH:-oh-my-cpa-data}:/data

  oh-my-cpa-updater:
    image: ${OMCPA_IMAGE:-wiziscool/oh-my-cpa:latest}
    container_name: ${OMCPA_UPDATER_CONTAINER_NAME:-oh-my-cpa-updater}
    restart: unless-stopped
    command: ["updater", "serve"]
    user: "0:0"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - ${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock

volumes:
  oh-my-cpa-data:
```

`cli-proxy-api` is the service name in CPA's official Compose file; if your CPA service
has another name, set `OMCPA_CPA_BASE_URL=http://<cpa-service-name>:8317` in `.env`.

Append `OMCPA_MASTER_KEY` and CPA's plaintext management key (single-quoted in `.env` so
`$` is not expanded) to `.env` in the Compose directory (`>>` preserves existing lines):

```bash
printf 'OMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
cat >> .env <<'EOF'
OMCPA_CPA_MANAGEMENT_KEY='<CPA plaintext management key>'
EOF
chmod 600 .env
```

Edit `.env` to replace `<CPA plaintext management key>` (and add
`OMCPA_USAGE_INGEST_MODE=off` if another management panel already drains CPA's Redis usage
queue; see [Other management panels](#other-management-panels)).

Start only the new services so the running CPA container is not recreated or restarted:

```bash
docker compose up -d oh-my-cpa oh-my-cpa-updater
```

Open **`http://127.0.0.1:8080/`** and sign in with CPA's management key.

## Other management panels

Another management panel (such as `cpamp`) can keep running alongside OMC. Both panels
talk to the same CPA management API, so provider or configuration changes made in one
appear in the other. OMC does not import another panel's local history or settings. If
another consumer already drains CPA's Redis usage queue, coordinate usage collection mode
(`OMCPA_USAGE_INGEST_MODE`) so two consumers do not compete for `RPOP`/`BLPOP` records.

<a id="settings"></a>

## Ports, storage and common settings

Compose reads `.env` from the directory containing `compose.yml`. Relative host paths in
`.env` are resolved from that directory.

### Required settings

| Variable | Used by | Purpose |
| --- | --- | --- |
| `OMCPA_MASTER_KEY` | All installs | 64-character hex key (`openssl rand -hex 32`) encrypting OMC's SQLite database. Back it up; never change it once data exists |
| `CPA_MANAGEMENT_KEY` | `compose.full.yml` | Sets both the new CPA's `MANAGEMENT_PASSWORD` and OMC's `OMCPA_CPA_MANAGEMENT_KEY` |
| `OMCPA_CPA_BASE_URL` | `compose.omc.yml` / native | Reachable URL of the existing CPA gateway |
| `OMCPA_CPA_MANAGEMENT_KEY` | `compose.omc.yml` / native | Existing CPA's plaintext management key (also OMC's sign-in password) |

### Common optional settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_BIND` | `127.0.0.1:8080` | Docker host `[ip:]port` mapped to container port `8080` (for example `127.0.0.1:18317` when `8080` is occupied on the host) |
| `CPA_BIND` | `127.0.0.1:8317` | Docker host `[ip:]port` mapped to CPA container port `8317` (`compose.full.yml` only) |
| `OMCPA_DATA_PATH` | `oh-my-cpa-data` | Named Docker volume by default, or a host directory path such as `./oh-my-cpa-data` |
| `OMCPA_USER` | `10001:10001` | Non-root `uid:gid` running the `oh-my-cpa` container (requires a writable host directory in `OMCPA_DATA_PATH`; the default named volume is owned by `10001:10001`) |
| `TZ` | `UTC` (Docker) / OS zone (native) | Server calendar for daily statistics; match CPA's time zone (for example `Asia/Shanghai`) |
| `OMCPA_PUBLIC_URL` | empty | External browser origin (for example `https://omc.example.com`). An `https://` URL marks the session cookie `Secure` |
| `OMCPA_TRUSTED_PROXY_CIDRS` | empty | Comma-separated reverse-proxy IPs/CIDRs trusted for `X-Forwarded-For` client IP throttling |
| `OMCPA_BASE_PATH` | `/` | URL prefix when serving OMC under a sub-path such as `/omc` |
| `OMCPA_NETWORK_NAME` | `oh-my-cpa` / `oh-my-cpa-standalone` | Docker network name |
| `OMCPA_NETWORK_EXTERNAL` | `false` | Set `true` in `compose.omc.yml` to attach OMC to an existing Docker network |
| `CPA_CONFIG_PATH`, `CPA_AUTH_PATH`, `CPA_LOG_PATH`, `CPA_PLUGIN_PATH` | `./config.yaml`, `./auths`, `./logs`, `./plugins` | Host paths for CPA's files in `compose.full.yml` |
| `OMCPA_IMAGE` / `CPA_IMAGE` | `wiziscool/oh-my-cpa:latest` / `eceasy/cli-proxy-api:latest` | Pin a specific release tag or digest |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Host Docker socket mounted into `oh-my-cpa-updater` |

### Built-in defaults (no need to declare in `.env`)

The image and binary already provide sensible defaults for these settings; set them only
when overriding:

- `OMCPA_LISTEN_ADDR=:8080` (container and binary listener address; `deploy/native.env.example` sets `127.0.0.1:8080` for native installs)
- `OMCPA_DATA_DIR=/data` in the container image (`./data` in the native binary)
- `OMCPA_BASE_PATH=/`
- `OMCPA_USAGE_INGEST_MODE=auto` and `OMCPA_CPA_USAGE_ADDR` (automatically derived from `OMCPA_CPA_BASE_URL` host:port)
- `OMCPA_UPDATE_CHECK_ENABLED=true` and `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=true`
- `OMCPA_UPDATER_ENABLED=true` and `OMCPA_UPDATER_URL=http://oh-my-cpa-updater:8090`

Full environment variable reference: [`docs/operations.md`](operations.md).

### Changing the port

Port `8080` is frequently occupied on hosts running other services. Which setting to
change depends on how OMC runs:

1. **Standard Docker Compose (bridge networking)**:
   Change **only the host mapping** via `OMCPA_BIND` in `.env` (for example, to use port
   `18317`):

   ```dotenv
   OMCPA_BIND=127.0.0.1:18317
   ```

   Keep the container side of `ports:` at `:8080` (`${OMCPA_BIND:-127.0.0.1:8080}:8080`).
   Inside its own container network namespace, OMC still listens on `:8080` and the
   built-in container health check probes `127.0.0.1:8080`. If you edit the container
   side of `ports:` (for example `18317:18317`) without changing `OMCPA_LISTEN_ADDR` and
   the health check, Docker forwards traffic to an unlistening container port while
   `docker compose ps` still shows `8080/tcp` from the image's `EXPOSE 8080` metadata.

2. **Native executable** (or a custom `network_mode: host` container that passes
   `OMCPA_LISTEN_ADDR` in `environment:`):
   There is no Docker port mapping layer. Set `OMCPA_LISTEN_ADDR` in `.env`:

   ```dotenv
   OMCPA_LISTEN_ADDR=127.0.0.1:18317
   ```

When you change the host port (for example to `18317`), update:
- Your browser URL and local health check: `http://127.0.0.1:18317/`
- Your reverse-proxy upstream target: `127.0.0.1:18317`

### Storage and permissions

By default, both Compose files set `volumes: - ${OMCPA_DATA_PATH:-oh-my-cpa-data}:/data`.
When `OMCPA_DATA_PATH` is unset, Docker uses the `oh-my-cpa-data` named volume and copies
the image's `/data` ownership (`10001:10001`, mode `0700`) on first creation. No host
directory setup is needed. Because the named volume is owned by `10001:10001` with mode
`0700`, keep the default `OMCPA_USER` (`10001:10001`) when using `oh-my-cpa-data`.

If you prefer to keep the SQLite database in a host directory next to `compose.yml` (for
example `./oh-my-cpa-data`), set `OMCPA_DATA_PATH` in `.env`:

```dotenv
OMCPA_DATA_PATH=./oh-my-cpa-data
```

When bind-mounting a host directory, Docker does **not** automatically change its
ownership. The container runs as non-root (`user: ${OMCPA_USER:-10001:10001}`) and does
not start as `root` to `chown` files. Choose one of two ways so the container's runtime
`uid:gid` matches the host directory owner:

- **Option A — Run the container as your current host user (no `sudo chown` needed)**:

  ```bash
  mkdir -p -m 700 ./oh-my-cpa-data
  printf 'OMCPA_DATA_PATH=./oh-my-cpa-data\nOMCPA_USER=%s:%s\n' "$(id -u)" "$(id -g)" >> .env
  ```

  Do not set `OMCPA_USER=0:0`; keep the main OMC service non-root.

- **Option B — Keep the default `10001:10001` container user and set directory ownership**:

  ```bash
  mkdir -p -m 700 ./oh-my-cpa-data
  sudo chown -R 10001:10001 ./oh-my-cpa-data
  echo "OMCPA_DATA_PATH=./oh-my-cpa-data" >> .env
  ```

Important rules for existing data:
- Changing `OMCPA_USER` only changes the process `uid:gid`; it does not rewrite ownership
  of existing files on disk.
- Changing `OMCPA_DATA_PATH` switches where OMC looks for `/data`; it does not move
  existing data between a named volume and a host directory.
- Never copy a live SQLite directory while OMC is running. Stop `oh-my-cpa` first or use
  the console backup/restore workflow in [`docs/ops/sqlite-operations.md`](ops/sqlite-operations.md).

## Reaching the console from elsewhere

Every Compose file here publishes on `127.0.0.1` only. From another machine, tunnel over
SSH and open `http://127.0.0.1:18080/`:

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```

To serve OMC over HTTPS, point your reverse proxy at `127.0.0.1:8080` (or the custom host
port set in `OMCPA_BIND`), forward the site root unchanged, and set `OMCPA_PUBLIC_URL` to
the external `https://` address browsers use. Set `OMCPA_TRUSTED_PROXY_CIDRS` to the
proxy's IP/CIDR so OMC reads the forwarded client IP. Do not publish port 8080 on a
public interface without TLS: the sign-in password is CPA's administrator key.

### Reverse proxy

OMC embeds both the web UI and the `/api/*` backend in a single server listening on one
port (`127.0.0.1:8080` by default). Unlike split frontend/backend setups, **you only need
to proxy one upstream port** for OMC, and the root path `/` requires no path stripping or
prefix rewrite. (CPA itself stays on its separate gateway port `8317` if you also proxy
client API traffic on another hostname.)

Caddy:

```caddyfile
omc.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx (`deploy/nginx.conf` is a complete example with separate OMC and CPA hostnames):

```nginx
server {
    listen 80;
    server_name omc.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

When serving over HTTPS behind a reverse proxy, add the public URL and the proxy peer
IP/CIDR that OMC sees on the incoming TCP connection in `.env` and recreate `oh-my-cpa`
(in Docker bridge mode, requests from a host proxy arrive from the Docker bridge gateway
IP rather than `127.0.0.1`; `127.0.0.1/32,::1/128` applies when the proxy and OMC share
the same network namespace, such as a native install):

```dotenv
OMCPA_PUBLIC_URL=https://omc.example.com
OMCPA_TRUSTED_PROXY_CIDRS=<proxy-peer-ip-or-cidr>
```

Check the root through the proxy:

```bash
curl -fsS https://omc.example.com/api/healthz
```

If `OMCPA_BASE_PATH` is set to a sub-path (such as `/omc`), configure the proxy to
preserve that prefix and forward both the bare prefix and everything beneath it.

## Install as an app

The console is an installable web app: Chrome and Edge on desktop and Chrome on Android
install it from the served page, Samsung Internet does the same on Samsung devices, and
iOS and iPadOS add it to the Home Screen. It then opens in its own window with the brand
mark as its icon, instead of in a browser tab.

Installation is a browser feature, not a console setting, so there is no install button
to look for on a page:

| Where | How |
| --- | --- |
| Chrome or Edge on a computer | The install icon in the address bar, or the browser menu → **Install page as app** / **Apps → Install this site as an app** |
| Chrome on Android with Google Mobile Services | Menu → **Install app** (or **Add to Home screen**) |
| Samsung Internet on a Samsung device | **Add to Home screen** |
| Safari on iOS or iPadOS | Share → **Add to Home Screen**. There is no in-page install prompt, and the console cannot open the Share sheet for you. On iOS and iPadOS 16.4 or later, the Share menu of Chrome, Edge, Firefox and Orion installs it too |
| Safari on macOS | **File → Add to Dock** (Safari 17 on macOS 14 or later) |

Two conditions come from the browser rather than from OMC:

- **Chromium's install criteria require a secure context.** Chrome and Edge treat the
  console as installable only when it is served over `https://` through your reverse
  proxy, or over `http://localhost` / `http://127.0.0.1` during local development. A
  plain-HTTP deployment reached by a LAN IP or hostname does not meet that criterion,
  even though the console itself works there. Do not expose the console over plain HTTP
  on a network interface: the sign-in password is CPA's administrator key.
- **The deployment stays reachable.** The PWA adds no service worker and no offline
  cache of API responses or user content, so the installed app cannot load without a
  connection. Existing session and caching rules are unchanged: the sign-in session
  cookie and the hashed static assets keep the behavior they already have. Reinstalling
  is not needed to pick up an update; every launch loads the current bundle from the
  deployment.

The mount point is part of the installed identity. The root and each configured
`OMCPA_BASE_PATH` are different apps to the browser, so installing one does not
replace another, and an app installed at a path that later changes has to be installed
again. The manifest's URLs are relative and resolve against the manifest's own address,
which is what keeps this working behind a proxy that preserves the prefix.

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
`127.0.0.1:8080` via `OMCPA_LISTEN_ADDR`, serves the site root and writes SQLite to
`./data` under the working directory. Change `OMCPA_LISTEN_ADDR` if port `8080` is
already in use on the host. When CPA is on the same host, its loopback URL works without
changing CPA's remote management policy.

Run `./oh-my-cpa` on Unix or `.\oh-my-cpa.exe` on Windows from that directory. Verify
[health and connectivity](#verifying-the-install), then open `http://127.0.0.1:8080/`
(or your configured `OMCPA_LISTEN_ADDR`) and sign in with CPA's management key. For an
operator-owned service manager, keep the same working directory, environment file,
service account and data path. Do not open the listener to the network without
configuring remote access and HTTPS.

To upgrade a native install, stop OMC alone, back up `.env` and its data directory,
verify/extract the new archive separately, then replace only the executable and start
it from the original working directory. Preserve the master key and state. Verify
health and the new running version. Migrations are forward-only; returning to an
older executable requires restoring the corresponding data backup.

## From source

Needs Go 1.26+, Node.js 22+, pnpm 11+ and a running CPA.

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

Open `http://127.0.0.1:8080/`. The process runs in the foreground; a service manager
such as systemd keeps it running. Variables in the environment win over `.env`, and
`OMCPA_ENV_FILE` points at a different file. A build from an untagged checkout reports
itself as `v0.1.0-dev`. For hot reload while developing, see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Verifying the install

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
```

(Replace `8080` if you changed `OMCPA_BIND` or `OMCPA_LISTEN_ADDR`.) A working install
returns `"status":"ok"` and `"cpa_connected":true`. A container that Docker reports as
healthy is not enough: OMC stays up, with `"status":"degraded"`, when it cannot reach CPA.

| Symptom | Layer & Cause | Fix |
| --- | --- | --- |
| `docker compose up` fails with `Bind for 127.0.0.1:8080 failed: port is already allocated` | **Docker host port mapping**: another process or container on the host already uses `8080` | Set `OMCPA_BIND=127.0.0.1:18317` in `.env` (or `CPA_BIND=127.0.0.1:18318` if CPA's `8317` is taken). Keep the container side `:8080` unchanged |
| Container runs and `docker compose ps` shows `8080/tcp`, but browser cannot connect after editing `ports:` | **Container vs. host port mismatch**: the right-hand side of `ports:` was changed away from `:8080` while OMC still listens on `:8080` inside the container | Keep `ports: - ${OMCPA_BIND:-127.0.0.1:8080}:8080` and change only `OMCPA_BIND` in `.env` |
| OMC log reports `listen on ... (set OMCPA_LISTEN_ADDR to change the process listen address): ... address already in use` | **Process listener namespace**: native binary (or a custom `network_mode: host` container) shares the host network stack where `:8080` is occupied | Set `OMCPA_LISTEN_ADDR=127.0.0.1:18317` in `.env` (for a custom `network_mode: host` container, also pass `OMCPA_LISTEN_ADDR` in `environment:`) |
| OMC log reports `data directory /data is not writable by uid:gid ...: permission denied` | **Data directory ownership mismatch**: `OMCPA_DATA_PATH` points to a host directory not writable by `OMCPA_USER` (default `10001:10001`), or `OMCPA_USER` was changed while still using the `10001:10001`-owned named volume | Keep the default `oh-my-cpa-data` volume with `OMCPA_USER=10001:10001`, or for a host directory write numeric `OMCPA_USER=<uid>:<gid>` to `.env` or `sudo chown -R 10001:10001 <dir>` (see [Storage and permissions](#storage-and-permissions)) |
| CPA fails to start and `config.yaml` is a directory | `config.yaml` did not exist before the first `docker compose up` | Stop the stack, remove the `config.yaml/` directory, download `cpa.config.example.yaml` to `config.yaml`, and start again |
| `status` is `degraded` (`cpa_connected: false`) | Wrong `OMCPA_CPA_BASE_URL` or `OMCPA_CPA_MANAGEMENT_KEY`, or CPA refuses remote management | Check [Reaching CPA](#reaching-cpa) and enable `management.allow-remote: true` in CPA's `config.yaml` if needed |
| Sign-in succeeds, then immediately asks to sign in again | `OMCPA_PUBLIC_URL` starts with `https://` (marking the session cookie `Secure`), but the browser connects over plain `http://` | Leave `OMCPA_PUBLIC_URL` empty for local HTTP access, or access the console through your `https://` reverse proxy |
| The console asks for a CPA upgrade | CPA is older than v8.0.0 | Upgrade CPA to v8.0.0 or later |
| Request records stay empty | `OMCPA_USAGE_INGEST_MODE=off` is set, usage statistics are disabled in CPA, or another consumer drains CPA's usage queue | Enable usage statistics in CPA and keep a single queue consumer |

## Upgrading

Upgrades migrate the database and there is no downgrade: the way back to an older
version is to restore a backup. OMC takes an encrypted backup automatically before it
applies a schema migration; [`docs/ops/sqlite-operations.md`](ops/sqlite-operations.md)
is the runbook for manual or scheduled backups and restores. Back up `.env` separately.

### Compatibility for existing deployments

Normal upgrades (`Update now` in the console, or `docker compose pull && docker compose up -d`
using your existing `compose.yml` and `.env`) preserve your current data mount, running user,
ports, network and `OMCPA_BASE_PATH` without extra steps.

Only if you **replace your Compose file** with a newly downloaded `compose.full.yml` or
`compose.omc.yml`, check whether your earlier deployment relied on older defaults:

- **Earlier `deploy/compose.full.yml` or `deploy/compose.omc.yml` host bind mounts**:
  Older release Compose files kept under a `deploy/` subdirectory defaulted to
  `OMCPA_DATA_PATH=../oh-my-cpa-data` (and `../cpa/...` for CPA files), whereas the
  current Compose files default `OMCPA_DATA_PATH` to the `oh-my-cpa-data` named volume
  and CPA files to `./config.yaml`, `./auths`, `./logs` and `./plugins`. Before replacing
  an older `deploy/compose.*.yml` file, pin your existing host paths explicitly in
  `deploy/.env` so Compose does not switch to an empty volume:

  ```dotenv
  OMCPA_DATA_PATH=../oh-my-cpa-data
  # Full stack (deploy/compose.full.yml) only:
  CPA_CONFIG_PATH=../cpa/config.yaml
  CPA_AUTH_PATH=../cpa/auths
  CPA_LOG_PATH=../cpa/logs
  CPA_PLUGIN_PATH=../cpa/plugins
  ```

- **Earlier `/omc` sub-path deployments**:
  An existing container keeps its explicit `OMCPA_BASE_PATH` through the console updater
  and through `docker compose pull && docker compose up -d`. If an older custom Compose
  file omitted `OMCPA_BASE_PATH` while relying on `/omc`, set `OMCPA_BASE_PATH=/omc` in
  `.env` before upgrading if your reverse proxy still expects `/omc`.

### From the console

When a newer release exists, **System Information** shows **Update now** beside Oh My
CPA or CLIProxyAPI. Confirming it makes the `oh-my-cpa-updater` container:

1. pull the new image. For Oh My CPA this is the exact image named by the release's
   signed manifest; for CLIProxyAPI it is the tag the container already uses;
2. stop the running container and start a replacement with the same environment,
   volumes, ports, networks and Compose labels;
3. wait for the replacement to report healthy, then remove the old container. A
   replacement that exits or stays unhealthy is removed and the old container is started
   again under its own name.

Updating Oh My CPA disconnects the console for a few seconds and the page reloads on
the new version. Updating CLIProxyAPI restarts the gateway, which interrupts requests in
flight. Each update and its outcome are written to the audit log.

The action is not offered in three cases, and the page says which:

| Case | What to do |
| --- | --- |
| The image is pinned to a version tag or digest, for example `OMCPA_IMAGE=wiziscool/oh-my-cpa:vX.Y.Z` | Change the pin and redeploy. The console leaves a pinned image alone, because the next `docker compose up` would put the pinned version back over a database that has already been migrated |
| CPA does not run as a container on the same Docker host | Update CPA where it runs |
| The build carries no release signing key, as a build from source does | Update by hand, below |

### Enabling console updates on an existing deployment

A deployment whose Compose file has no `oh-my-cpa-updater` service gains one with a
single command on the Docker host. The Compose file is not edited:

```bash
docker run --rm --pull always -u 0 -v /var/run/docker.sock:/var/run/docker.sock wiziscool/oh-my-cpa:latest updater install
```

The command:

- finds the running Oh My CPA container, whichever Compose file started it. When more
  than one is running, add `--container <name>`; when CPA runs as a container the updater
  cannot identify, add `--cpa-container <name>`;
- creates a container named `oh-my-cpa-updater` from the same image, on a network of the
  same name, and attaches the console to that network. The console finds the updater by
  that name; no setting is added to either container, and CPA is not touched;
- replaces the console with the current release when it is older, with the rollback
  described above. A pinned console is left as it is.

`--pull always` fetches the current image: the host may hold an older
`wiziscool/oh-my-cpa:latest` that predates the updater. `-u 0` is needed because the
Docker socket belongs to root. Running the command again repairs or refreshes the
installation. `docker rm -f oh-my-cpa-updater` removes it, and the console then shows the
command again in place of the update action.

The updater container holds the Docker socket, which amounts to control of Docker on
that host. It runs with a read-only filesystem and no capabilities, publishes no port,
and accepts only two requests from the console: report status, and update Oh My CPA or
CLIProxyAPI. Meanwhile, `oh-my-cpa` itself never mounts the Docker socket and remains
non-root (`10001:10001`). `docs/operations.md` describes the security boundary.

A Compose file that later declares the `oh-my-cpa-updater` service itself conflicts with
the installed container's name: remove the standalone updater container first with
`docker rm -f oh-my-cpa-updater`.

### By hand

In the directory that holds the Compose file:

```bash
docker compose pull oh-my-cpa oh-my-cpa-updater
docker compose up -d --no-deps oh-my-cpa oh-my-cpa-updater
```

Leave `oh-my-cpa-updater` out of both commands when the file does not declare it. If your
Compose file is named `deploy/compose.full.yml` or `deploy/compose.omc.yml`, add
`-f deploy/compose.full.yml` or `-f deploy/compose.omc.yml` to both commands.

This upgrades OMC and leaves CPA as it is. To move to a specific version, set
`OMCPA_IMAGE=wiziscool/oh-my-cpa:vX.Y.Z` in `.env` (or change the `image:` tag in a
custom Compose file). By default the database lives in the Docker volume
`<project>_oh-my-cpa-data` (`docker volume inspect` prints its host path), or in the host
directory configured by `OMCPA_DATA_PATH`. How releases are published is in
`docs/releasing.md`.

## Constraints

- Keep `OMCPA_MASTER_KEY` safe and unchanged. Without it the stored data is unreadable.
- One OMC per data directory, on a local disk.
