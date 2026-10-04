# Install Oh My CPA (instructions for a coding agent)

Install Oh My CPA (OMC) for the person you are working with. Start with inventory,
not a predetermined stack. Use the versioned Docker Hub image
**`wiziscool/oh-my-cpa:v0.1.0`** for Docker deployments. Its amd64 and arm64 variants
contain the console, binary and health probe: installing it needs no source build.
The human guide is `docs/install.md`; release maintenance is `docs/releasing.md`.

CPA (CLIProxyAPI) remains the gateway. OMC requires **CPA v8.0.0+** and its plaintext
management key; that key is also the OMC sign-in password. OMC has its own encrypted
SQLite data and master key. An existing panel's data does not migrate automatically.

## Safety contract

- Never print, log, commit or include secrets in a tool response. Ask the user to enter
  the existing plaintext management key **privately in a local environment file**, not
  in chat. Do not display `.env`, container environment arrays, credential files,
  authenticated response bodies or `docker compose config` with interpolated secrets.
- Preserve existing CPA configuration, keys, auth files, provider settings, ports,
  panels, networks and services. Do not upgrade CPA, enable remote management, stop a
  panel, alter its proxy, or replace its config without a specific approved plan.
- Preserve any existing `OMCPA_MASTER_KEY` and data directory. Never generate a new
  key over encrypted state. If state exists but the key is missing, stop and recover it.
- One OMC process per data directory on local disk. One collector per CPA: its usage
  queue is destructive. If another collector exists, use `OMCPA_USAGE_INGEST_MODE=off`
  unless the user explicitly authorizes a transfer of collection ownership.
- Ask before installing Docker/toolchains, using `sudo`, taking a port, creating a
  persistent system service, changing firewall rules, exposing a listener beyond
  loopback or spending provider quota. Default to loopback and an SSH tunnel.
- Never modify migrations or database tables by hand. Do not run an older image against
  a newer schema. Keep environment files mode `600` and data directories mode `700`.

## 1. Inventory first

Determine OS/CPU, Docker/Compose availability, used ports and existing installations.
Use metadata-only commands, adapting to the OS:

```bash
uname -s; uname -m
docker version --format '{{.Server.Version}}' 2>/dev/null
docker compose version 2>/dev/null
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null
ss -ltn 2>/dev/null
curl -fsS --max-time 3 http://127.0.0.1:8317/healthz
```

A health response alone does not prove CPA version or management compatibility.
Inspect the running image/version metadata and, once credentials are privately
configured, verify OMC's `cpa_management_api` health state. Do not start a duplicate
CPA because its port is occupied or one probe failed. Check existing service-manager
units, Compose files and documented locations without dumping their secrets.

Record a short **sanitized** inventory:

- CPA: absent/existing, version, container/native/remote, reachable listener,
  network name and alias, config/auth paths, management credential file location.
- OMC: absent/existing, running version, data path, master-key file location.
- Other panels/exporters: what is running and who owns usage collection.
- Access: local browser, SSH tunnel, private LAN, or existing HTTPS origin and proxy.
- Available installation directory and unused ports; actual CPA timezone.

Ask only for unknown facts. Credential entry belongs in the private file, not the
inventory. If collection ownership cannot be determined, start with ingest `off` and
report that new usage capture is intentionally disabled pending clarification.

## 2. Choose and explain the installation scenario

| Environment | Action |
| --- | --- |
| Neither CPA nor OMC exists; Docker is available | A: new CPA + OMC with `deploy/compose.full.yml` |
| CPA exists but OMC does not | B: add only OMC with `deploy/compose.omc.yml` |
| CPA and another management panel exist | B: keep both; resolve collection ownership first |
| OMC already exists | D: verify or upgrade it in place, preserving keys/state; do not create a second replica |
| User needs no reverse proxy | A/B: direct loopback ports; SSH tunnel for a remote machine |
| Existing HTTPS proxy is owned by the user | A/B: retain it; propose only the OMC upstream/prefix mapping |
| CPA is on another machine | B: use a private reachable or HTTPS CPA URL; do not install another CPA |
| CPA is native and loopback-only | C: native OMC on the same host, or an explicitly approved Linux host-network override |
| Docker is absent but CPA exists | C if a compatible toolchain exists; otherwise request permission for prerequisites |
| Neither Docker nor CPA exists | Obtain approval for Docker + A, or install CPA natively from its official guide before C; do not start OMC without a gateway plan |

Before changes, state the chosen scenario, new files/services/ports, what existing
state will be preserved, collection mode and verification steps. Resolve uncertain
security boundaries with the user before executing. Do not install a reverse proxy as
an implicit dependency.

## 3. Install the selected path

### A. New stack

Use a **new** install directory. Download the versioned release assets, not moving
source files. The Compose file and starter CPA config are in the same GitHub Release:

```bash
mkdir -p oh-my-cpa/deploy oh-my-cpa/cpa/{auths,logs,plugins} oh-my-cpa/oh-my-cpa-data
cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/compose.full.yml \
  -o deploy/compose.full.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/cpa.config.example.yaml \
  -o cpa/config.yaml
```

If any target file exists, inspect its purpose **without revealing secrets** and stop
before overwriting it. With approval, give the new OMC data directory ownership
`10001:10001` and mode `700`. Create `deploy/.env` under `umask 077` containing:

- A new `CPA_MANAGEMENT_KEY` (`openssl rand -hex 24`).
- A new `OMCPA_MASTER_KEY` (`openssl rand -hex 32`), only for a fresh data directory.
- `OMCPA_PUBLIC_URL=http://127.0.0.1:8080` and `TZ` matching the desired calendar.
- Unused `OMCPA_BIND` / `CPA_BIND` if the default loopback ports are occupied.
- `OMCPA_USAGE_INGEST_MODE=auto` for this new gateway with no competing collector.

`cpa/config.yaml` enables usage statistics and has no placeholder client API keys;
provider credentials and client keys are configured later. Do not populate them
without user intent. Start with `pull`, then `up -d`:

```bash
docker compose --env-file deploy/.env -f deploy/compose.full.yml pull
docker compose --env-file deploy/.env -f deploy/compose.full.yml up -d
```

### B. Existing CPA, including another panel

Download only the OMC-only release asset into a new install directory:

```bash
mkdir -p oh-my-cpa/deploy oh-my-cpa/oh-my-cpa-data
cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/compose.omc.yml \
  -o deploy/compose.omc.yml
```

Prepare the data-directory ownership and private `deploy/.env` as in A, but use:

- `OMCPA_CPA_BASE_URL`: **container-reachable** existing gateway URL.
- `OMCPA_CPA_MANAGEMENT_KEY`: the existing plaintext key entered privately by the
  user; never replace CPA's key to make OMC work.
- A fresh `OMCPA_MASTER_KEY` only if no OMC encrypted state exists.
- Existing CPA timezone, OMC public URL, free loopback bind and agreed ingest mode.

Choose networking deliberately:

1. **CPA container:** use its existing user-defined network and DNS alias. Set
   `OMCPA_NETWORK_NAME=<existing network>`, `OMCPA_NETWORK_EXTERNAL=true` and
   `OMCPA_CPA_BASE_URL=http://<alias>:8317`. Do not recreate its network or container.
2. **Host CPA on a reachable interface:** `http://host.docker.internal:8317` uses the
   host-gateway entry supplied by Compose. Check access rules/firewall first.
3. **Host CPA on loopback only:** the host-gateway mapping cannot reach it. Prefer C.
   An approved Linux override can use `network_mode: host`, reset `ports` and
   `networks` with Compose's `!reset` override syntax, and set
   `OMCPA_LISTEN_ADDR=127.0.0.1:<free OMC port>` in the service environment. Require
   Compose 2.24.4+ for `!reset`; document that host networking removes network isolation.
4. **Remote CPA:** use its existing private/HTTPS address; preserve TLS verification.
   Never set `OMCPA_CPA_TLS_SKIP_VERIFY` just to make a probe pass.

For host networking, validate the merged topology without printing its interpolated
secrets; do not use the base file unchanged because its `:8080` listener would bind
all host interfaces. A sibling container needs CPA remote management enabled; ask
before modifying `management.allow-remote` or its legacy equivalent.

```bash
docker compose --env-file deploy/.env -f deploy/compose.omc.yml pull
docker compose --env-file deploy/.env -f deploy/compose.omc.yml up -d
```

Leave any other panel running. Shared CPA configuration can be edited by both;
coordinate changes and describe the effect of ingest `off`: management works, but
new OMC request records and traffic history are not captured. OMC's preferences and
history are not imported from the other panel.

### C. Native source build

Verify Go 1.25+, Node.js 22+ and pnpm 11+; ask before installing missing tools. Clone
into an unused directory, install with `pnpm install --frozen-lockfile`, and create
`.env` from `.env.example` only if it does not already exist. Privately configure the
existing CPA key, a fresh/recovered master key, reachable gateway URL, agreed ingest
mode, loopback listen address, local data directory and timezone.

```bash
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

This is a foreground process. Propose a platform-appropriate persistent service only
when requested. Never kill another process to claim the default port. Source builds
remain development versions unless their release version is intentionally injected;
do not relabel a development build as stable through an environment override.

### D. Existing OMC / upgrade

First verify the current install; do not reinstall it just because files already exist.
Locate its image tag/digest, data directory and master key. Back up using
`docs/ops/sqlite-operations.md`, then change only `OMCPA_IMAGE` to the chosen version.

```bash
docker compose --env-file deploy/.env -f deploy/compose.omc.yml pull oh-my-cpa
docker compose --env-file deploy/.env -f deploy/compose.omc.yml up -d --no-deps oh-my-cpa
```

Use the existing full-stack file instead if that is the deployment. Preserve the key,
volumes, gateway and other panels. Forward-only migrations may prevent an image-only
rollback; restore a compatible backup, never edit migration state.

## 4. Verify evidence, not just a running container

Use the selected port and canonical prefix (`omc` and `/omc/` become `/omc`; `/`
becomes empty). Do not disable TLS verification for the check.

```bash
curl -fsS http://127.0.0.1:8080/omc/api/healthz
```

Success requires `database_status: ok`, `cpa_connected: true`, supported CPA management
and `status: ok`. Container health accepts `degraded` for gateway failures; a healthy
container alone is not a successful connected installation. Verify sign-in, the System
Information running version, provider discovery and the configured collection mode.
In the first stable image, the version must be `v0.1.0`, not `v0.1.0-dev`.

If traffic is already flowing and OMC owns collection, verify records arrive without
sending a new paid request. Ask before a real provider call. With ingest off, report
that capture is disabled rather than treating an empty dashboard as a malfunction.
If verification fails, report its specific reason; never claim installation complete.

## 5. Handoff

Give the user the console URL, sign-in credential **file location**, image tag/digest,
CPA connection and timezone, collector owner/mode, data/master-key backup locations,
start/stop/upgrade commands and any remaining failure or approved topology change.
Never include credential values. For remote loopback installs, provide the SSH tunnel
command from `docs/install.md`. Keep existing services and panels accounted for.
