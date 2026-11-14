# Standalone

Runs OMC and its updater from `compose.omc.yml` beside an existing CPA (on the host, in
another Docker Compose project, or on another machine). CPA, its configuration, its keys
and any other management panel are not modified or restarted.

1. Create a directory and download `compose.omc.yml` (for existing installs, see [Upgrading](upgrade.md)):

   ```bash
   (
     [ ! -e oh-my-cpa/compose.yml ] && [ ! -e oh-my-cpa/.env ] &&
     mkdir -p oh-my-cpa && cd oh-my-cpa &&
     curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o compose.yml
   ) && cd oh-my-cpa
   ```

2. Create `.env` (skip or stop if `.env` already exists so you never overwrite an existing
   `OMCPA_MASTER_KEY`) with a generated `OMCPA_MASTER_KEY`, CPA's reachable URL and CPA's
   existing plaintext management key (the key typed to sign in, not the bcrypt hash in
   `config.yaml`). Wrap `OMCPA_CPA_MANAGEMENT_KEY` in single quotes in `.env` so Docker
   Compose does not treat `$` in the key as variable interpolation (escape any literal `'`
   as `\'`):

   ```bash
   test ! -e .env || { echo ".env already exists; reuse its OMCPA_MASTER_KEY" >&2; exit 1; }
   (
     umask 077
     printf 'OMCPA_CPA_BASE_URL=http://host.docker.internal:8317\nOMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" > .env
     cat >> .env <<'EOF'
   OMCPA_CPA_MANAGEMENT_KEY='<CPA plaintext management key>'
   EOF
   )
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


## Reaching CPA

OMC runs in a container, so `OMCPA_CPA_BASE_URL` must be reachable from inside that
container.

| Where CPA runs | `.env` configuration |
| --- | --- |
| On the same machine, listening on all interfaces (`:8317` or `0.0.0.0:8317`) | `OMCPA_CPA_BASE_URL=http://host.docker.internal:8317` |
| In another Docker project on the same host | `OMCPA_CPA_BASE_URL=http://<CPA service or container name>:8317`<br>`OMCPA_NETWORK_NAME=<CPA's Docker network>`<br>`OMCPA_NETWORK_EXTERNAL=true` |
| On another machine | `OMCPA_CPA_BASE_URL=https://<CPA host>:8317` (or its private network URL) |
| On the same machine, listening on `127.0.0.1` only | A bridge container cannot reach host loopback. Install the [native executable](native.md) on the host, or [build from source](source.md) |

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

## Other management panels

Another management panel (such as `cpamp`) can keep running alongside OMC. Both panels
talk to the same CPA management API, so provider or configuration changes made in one
appear in the other. OMC does not import another panel's local history or settings. If
another consumer already drains CPA's Redis usage queue, coordinate usage collection mode
(`OMCPA_USAGE_INGEST_MODE`) so two consumers do not compete for `RPOP`/`BLPOP` records.
