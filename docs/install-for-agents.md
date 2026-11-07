# Installation by an agent

Use the same [installation guide](install.md) as a human operator. It owns the commands,
published Compose files (`compose.full.yml` and `compose.omc.yml`), native release assets
and supported deployment paths; this page adds the agent's preflight, authorization,
verification and handoff rules.

## Inspect before acting

Determine whether CPA and OMC already exist, how they are started, their network
reachability, OS/architecture, storage mounts and occupied host ports. Inspect container
names, image references, volume mounts, port mappings and network metadata — never print
container environments, `.env` contents, management/master keys, auth files or
`docker compose config` in tool output. Ask the user only for facts that cannot be
established safely from the host.

When an existing Compose file is present, read its `services.oh-my-cpa` definition before
assuming `.env` variables take effect:
- Official `compose.full.yml` and `compose.omc.yml` interpolate `OMCPA_BIND`,
  `OMCPA_DATA_PATH`, `OMCPA_USER` and `OMCPA_NETWORK_NAME` (plus
  `OMCPA_NETWORK_EXTERNAL` in `compose.omc.yml`).
- Older or hand-written Compose files may hardcode `"127.0.0.1:8080:8080"` or
  `oh-my-cpa-data:/data` without variable interpolation; inspect the file first rather
  than setting `.env` variables that the file ignores.

Never test CPA availability by consuming a record from the usage queue. OMC requires
the v8 management API and the existing plaintext management key.

## Preserve the existing installation

- Inspect target paths first and get user approval before overwriting any existing file
  (`compose.yml`, `config.yaml`, `.env`) in the target directory. An existing OMC
  deployment follows [Upgrading](install.md#upgrading), not fresh key generation.
- Let the user supply missing secrets privately; placeholders are not working credentials.
- Never replace an existing `OMCPA_MASTER_KEY`. If encrypted data exists and its key is
  lost, stop and explain recovery limits ([`docs/ops/sqlite-operations.md`](ops/sqlite-operations.md))
  before changing the deployment.
- Do not edit, upgrade, restart or remove an existing CPA or another management panel
  without the user's explicit authorization. Keep its configuration, ports and auth
  directories intact.
- Do not automatically move data, switch an existing host bind mount to a named volume
  (or vice versa), recursively `chown` existing host directories, or change
  `OMCPA_BASE_PATH`, networks or reverse-proxy rules. If replacing an older
  `deploy/compose.*.yml` that used `../oh-my-cpa-data`, preserve `OMCPA_DATA_PATH` in
  `.env` as documented in [Upgrading](install.md#upgrading).
- Never copy a live SQLite WAL directory while `oh-my-cpa` is running.
- Get explicit approval for privilege elevation (`sudo`), tool installation, opening a
  non-loopback port, granting Docker socket access (`oh-my-cpa-updater`) or sending a
  billable inference request.

## Choose one path and use its guide

| Situation | Procedure |
| --- | --- |
| CPA is not installed | [New install](install.md#new-install) |
| Existing CPA reachable from a separate container (host, another Docker network, or remote) | [Standalone](install.md#standalone) |
| Existing editable CPA Compose project where one file is preferred | [Add to Compose](install.md#add-to-the-existing-compose-file) |
| Host-loopback CPA (`127.0.0.1:8317`), or Docker unavailable | [Native executable](install.md#native-executable) |
| Explicit source request or unsupported native target | [From source](install.md#from-source) |
| Existing OMC deployment | [Upgrading](install.md#upgrading) |

Apply the configuration rules from [`docs/install.md`](install.md#ports-storage-and-common-settings):
- **Updater**: Recommended Docker paths include `oh-my-cpa-updater` by default. Disclose
  that `oh-my-cpa-updater` mounts `/var/run/docker.sock` (host-level Docker authority)
  while `oh-my-cpa` itself stays non-root (`10001:10001`), read-only and socket-free. If
  the user declines Docker socket access, omit `oh-my-cpa-updater` from `compose.yml`,
  remove any existing updater container (`docker rm -f oh-my-cpa-updater`), and keep
  manual OMC-only updates (`docker compose pull oh-my-cpa && docker compose up -d --no-deps oh-my-cpa`).
  Never merge the updater into `oh-my-cpa` or run `oh-my-cpa` as root.
- **Ports**: If host port `8080` is occupied in a Docker bridge deployment, change only
  the host mapping (`OMCPA_BIND=127.0.0.1:<port>`) and keep container port `8080`. Use
  `OMCPA_LISTEN_ADDR` for native executables (or custom `network_mode: host` containers
  that pass `OMCPA_LISTEN_ADDR` into `environment:`). Update the verification URL and any
  reverse-proxy target to match the chosen host port.
- **Storage**: Use the default `oh-my-cpa-data` named volume (with the default
  `10001:10001` user) for new Docker installs so no `mkdir` or `sudo chown` is required.
  Only when the user asks for a host bind mount (`OMCPA_DATA_PATH=./oh-my-cpa-data`),
  align the non-root container user (`OMCPA_USER`) with the directory owner (write
  numeric `OMCPA_USER=<uid>:<gid>` from `id -u` / `id -g` to `.env`, or `chown 10001:10001`).

## Verify and hand off

Follow [Verifying the install](install.md#verifying-the-install). Check the actual
host port and `OMCPA_BASE_PATH`, `/api/healthz` (`"status":"ok"` and
`"cpa_connected":true`), CPA management reachability and usage ingestion status. Do not
claim historical usage was imported or issue paid traffic just to populate a graph.

Report the console URL, deployment and data locations (named volume name or host path),
selected update method, how to start/stop it and any unresolved warnings. Say that the
existing CPA management key is the sign-in password without repeating the value. Link the
operator to [Operations](operations.md) and the
[backup/restore runbook](ops/sqlite-operations.md).
