# Upgrading

Upgrades migrate the database and there is no downgrade: the way back to an older
version is to restore a backup. OMC takes an encrypted backup automatically before it
applies a schema migration; [backup and restore runbook](../ops/sqlite-operations.md)
is the runbook for manual or scheduled backups and restores. Back up `.env` separately.


## From the console

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


## By hand

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
[Releasing](../dev/releasing.md).

## Enabling console updates on an existing deployment

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


## Compatibility for existing deployments

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


Native executables upgrade by replacing the binary; see
[Upgrading a native install](native.md#upgrading-a-native-install).
