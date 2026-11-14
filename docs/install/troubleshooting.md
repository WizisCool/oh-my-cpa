# Troubleshooting

Start every diagnosis with the health endpoint. It reports whether OMC is running and
whether it can reach CPA.

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
```

(Replace `8080` if you changed `OMCPA_BIND` or `OMCPA_LISTEN_ADDR`.) A working install
returns `"status":"ok"` and `"cpa_connected":true`. A container that Docker reports as
healthy is not enough: OMC stays up, with `"status":"degraded"`, when it cannot reach CPA.

## Common problems

| Symptom | Layer & Cause | Fix |
| --- | --- | --- |
| `docker compose up` fails with `Bind for 127.0.0.1:8080 failed: port is already allocated` | **Docker host port mapping**: another process or container on the host already uses `8080` | Set `OMCPA_BIND=127.0.0.1:18317` in `.env` (or `CPA_BIND=127.0.0.1:18318` if CPA's `8317` is taken). Keep the container side `:8080` unchanged |
| Container runs and `docker compose ps` shows `8080/tcp`, but browser cannot connect after editing `ports:` | **Container vs. host port mismatch**: the right-hand side of `ports:` was changed away from `:8080` while OMC still listens on `:8080` inside the container | Keep `ports: - ${OMCPA_BIND:-127.0.0.1:8080}:8080` and change only `OMCPA_BIND` in `.env` |
| OMC log reports `listen on ... (set OMCPA_LISTEN_ADDR to change the process listen address): ... address already in use` | **Process listener namespace**: native binary (or a custom `network_mode: host` container) shares the host network stack where `:8080` is occupied | Set `OMCPA_LISTEN_ADDR=127.0.0.1:18317` in `.env` (for a custom `network_mode: host` container, also pass `OMCPA_LISTEN_ADDR` in `environment:`) |
| OMC log reports `data directory /data is not writable by uid:gid ...: permission denied` | **Data directory ownership mismatch**: `OMCPA_DATA_PATH` points to a host directory not writable by `OMCPA_USER` (default `10001:10001`), or `OMCPA_USER` was changed while still using the `10001:10001`-owned named volume | Keep the default `oh-my-cpa-data` volume with `OMCPA_USER=10001:10001`, or for a host directory write numeric `OMCPA_USER=<uid>:<gid>` to `.env` or `sudo chown -R 10001:10001 <dir>` (see [Storage and permissions](../operate/ports-storage.md#storage-and-permissions)) |
| CPA fails to start and `config.yaml` is a directory | `config.yaml` did not exist before the first `docker compose up` | Stop the stack, remove the `config.yaml/` directory, download `cpa.config.example.yaml` to `config.yaml`, and start again |
| `status` is `degraded` (`cpa_connected: false`) | Wrong `OMCPA_CPA_BASE_URL` or `OMCPA_CPA_MANAGEMENT_KEY`, or CPA refuses remote management | Check [Reaching CPA](standalone.md#reaching-cpa) and enable `management.allow-remote: true` in CPA's `config.yaml` if needed |
| Sign-in succeeds, then immediately asks to sign in again | `OMCPA_PUBLIC_URL` starts with `https://` (marking the session cookie `Secure`), but the browser connects over plain `http://` | Leave `OMCPA_PUBLIC_URL` empty for local HTTP access, or access the console through your `https://` reverse proxy |
| The console asks for a CPA upgrade | CPA is older than v8.0.0 | Upgrade CPA to v8.0.0 or later |
| Request records stay empty | `OMCPA_USAGE_INGEST_MODE=off` is set, usage statistics are disabled in CPA, or another consumer drains CPA's usage queue | Enable usage statistics in CPA and keep a single queue consumer |
