# Ports and storage

Compose reads `.env` from the directory containing `compose.yml`, and resolves relative
host paths in `.env` from that directory. Recreate the container after changing it:
`docker compose up -d`.

## Changing the port

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

If port `8317` (CPA's gateway port in `compose.full.yml`) is occupied on the host, set
`CPA_BIND` in `.env` (for example `CPA_BIND=127.0.0.1:18318`) and point your clients at
that new host port (`http://127.0.0.1:18318`). OMC inside the same Compose project keeps
talking to `http://cpa:8317` over the Docker network. For the full stack, recreate the
services with `docker compose -f compose.full.yml up -d`.

## Storage and permissions

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
  the console backup/restore workflow in [backup and restore runbook](../ops/sqlite-operations.md).
