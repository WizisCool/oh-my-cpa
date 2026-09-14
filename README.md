# Oh My CPA

> Make CPA yours.

Oh My CPA is an AI resource identity and organization console for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA).

When multiple accounts across OpenAI, Codex, Claude, Gemini, DeepSeek, or relay providers are pooled under CPA's technical drivers, Oh My CPA adds user-defined names, icons, sources, and organizational state above them. CPA handles protocol adaptation and request execution; Oh My CPA provides business identity and operations management.

## Current State

Oh My CPA is a complete control plane co-deployed with CPA. The backend is a Go modular monolith, and the frontend is a React + TypeScript + Ant Design single-page application embedded directly into the Go binary.

- **Operations & Observability**: Usage dashboard (15m, 1h, 6h, 24h, 7d, 30d, 90d sliding presets and custom absolute date ranges), request browser (filtering, multi-select facets, detail drawer, and individual request log downloads), live tailing with error log downloads, system health checks, and sanitized diagnostics export.
- **Gateway Management**: AI providers (catalog model pull and active enable/disable toggles), key management (dedicated `/api-keys` route for proxy client API Keys CRUD, sharing draft and revision guards with the configuration panel; supports operator aliases indexed by `(instance_id, usage fingerprint)` without modifying CPA's configuration document), OAuth management (upload, download, delete, status and field editing, and model lists), and complete OAuth authorization flows.
- **Quota & Billing**: Per-credential quota inspection and resets, cooldown clearance, Codex credit redemption; automated pricing synchronization from models.dev with manual row overrides, and immutable request-time price snapshots.
- **Configuration & Extensions**: Visual scalar editor and YAML source editor (preserving comments and unknown fields), plugin and plugin store management.
- **Platform Capabilities**: Native `/omc` sub-path support, administrator session management, append-only audit logging, server-side console preferences, and a complete zh/en bilingual UI.
- **Deployment**: Caddy and Nginx co-deployment templates alongside CPA via Docker Compose, single-replica SQLite WAL persistence, and zero-CDN offline execution.

The CPA management key is encrypted with AES-GCM at rest using `OMCPA_MASTER_KEY`. It is never returned in ordinary API responses or stored in browser storage. Client key aliases only map names to `(instance_id, usage fingerprint)` pairs without persisting plaintext keys; renaming a key modifies Oh My CPA's metadata and never touches CPA's configuration document.

The early "unclaimed resources triage" screen was retired as navigation aligned with gateway surfaces; the discovery and binding models still run in the backend, while CPA resources are presented through the Providers and OAuth management pages. The `/api/v1/resources` and `/instances/default/discover` endpoints remain available for discovery operations.

## Local Development

Prerequisites: Go 1.24+ (module baseline `1.24.0`; reproducible pinned CI toolchain uses Go **1.24.13**, Node.js **22.23.2**, and pnpm **11.19.0** per `scripts/tools-versions.json`). For Go live reloading, install [Air](https://github.com/air-verse/air):

```bash
go install github.com/air-verse/air@latest
pnpm install --frozen-lockfile
```

Copy the environment template and set your master key and CPA management key:

```bash
cp .env.example .env
pnpm dev
```

Daily development uses a single browser entrypoint: **`http://127.0.0.1:5173/omc/`** (or **`http://<Tailscale-IP>:5173/omc/`** in a LAN or Tailscale setup; the backend and CPA remain bound to `127.0.0.1` loopback and Vite proxies requests).

```text
Browser → Vite :5173 → Go API :8080 → CLIProxyAPI :8317
```

The ports shown above reflect the default development topology: Go's listen address defaults to `127.0.0.1:8080` in `.env.example` (and falls back to `:8080` in `config.Load()` if unset). Vite proxies `/omc/api` to that address, so if port 8080 is occupied, change `OMCPA_LISTEN_ADDR` in `.env`. When the backend runs on a different host, override Vite's proxy target with `OMCPA_API_TARGET`.

Vite handles frontend HMR and proxies `/omc/api/*` to Go; Go is monitored by Air on `.go` and `.sql` file changes for automatic rebuilds. CLIProxyAPI is an external dependency; when it is not running, Oh My CPA boots and displays a degraded health status.

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start Air + Vite (default development workflow) |
| `pnpm dev:api` | Start Go/Air only for API debugging |
| `pnpm dev:web` | Start Vite only, connecting to the backend configured by `OMCPA_LISTEN_ADDR` (default `:8080`) |
| `pnpm cpa:start` | Start local CLIProxyAPI from `cpa/` |
| `pnpm build` | Build the frontend and synchronize to `internal/web/dist`; type checking is run by independent gates |
| `pnpm type-check` | Check frontend TypeScript |
| `pnpm test:fast` | Run affected checks based on worktree changes (default during development iterations) |
| `pnpm check:ui` | UI fast path: dev server + mock API, running only affected scenarios; `--list` / `--plan` inspects without launching a browser |
| `pnpm verify` | Toolchain check (warns on version divergence) + full static gates + worktree secret scan |
| `pnpm verify:build` | Type checking, production build, and entry bundle budget check |
| `pnpm verify:full` | Parallel orchestrated full final verification gate |
| `pnpm verify:full:serial` | Serial final gate, used to diagnose parallel orchestration discrepancies |
| `pnpm verify:browser` | Run deterministic browser acceptance against the built SPA |
| `pnpm verify:browser:smoke` | Run browser smoke tests for core login, dashboard, and request list paths |
| `pnpm verify:probes` | Run browser probes for geometry, stacking, pixels, and refresh sequencing |

`pnpm cpa:start` looks for `cpa/cli-proxy-api` (or `.exe` on Windows) and `cpa/config.yaml` by default; override them with `CPA_BIN` and `CPA_CONFIG`. Air can be specified via `AIR_BIN`, or discovered from `PATH`, `GOBIN`, and `GOPATH/bin`.

To run the production binary locally, build the embedded assets first:

```bash
pnpm build
go run ./cmd/oh-my-cpa
# Open http://127.0.0.1:8080/omc/
```

To synchronize existing frontend build artifacts into the Go embed directory, run `pnpm sync-web-dist`.

## Usage Ingestion and Idle Overhead

The usage collector starts with the **Oh My CPA backend process** and operates continuously without an open browser. In the default `auto` mode, it probes availability via RESP `AUTH` handshakes and prefers persistent subscriptions; it does not require CPA to support general Redis `PING` commands, nor does it probe by popping messages (which would destroy queue records). If the reverse proxy does not support RESP, it degrades to HTTP pull.

When HTTP or RESP pulls encounter consecutive empty queues, the poller backs off: `1s → 2s → 4s → 8s → 10s`, capping at 10 seconds. When records arrive, the poller resets to 1 second; full batches drain immediately without delay to prevent queue backlog.

| Environment Variable | Default | Description |
| --- | --- | --- |
| `OMCPA_USAGE_INGEST_ENABLED` | `true` | When `false`, completely disables background ingestion (the dashboard still serves existing data) |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | `auto`, `subscribe`, `resp_pull`, `http_pull`, or `off` |
| `OMCPA_USAGE_IDLE_INTERVAL` | `1s` | Delay when data is present but under a full batch, subscription flush interval, and decoder idle tick |
| `OMCPA_USAGE_MAX_IDLE_INTERVAL` | `10s` (≥ idle interval) | Maximum backoff delay for consecutive empty queues; cannot be less than the base interval |
| `OMCPA_USAGE_BATCH_SIZE` | `1000` | Maximum records fetched per pull (capped at 10000) |
| `OMCPA_USAGE_AGGREGATE_INTERVAL` | `15s` | Check interval for hourly and daily rollups (retention pruning runs on an independent 1-hour cycle) |
| `OMCPA_USAGE_RETENTION_DAYS` | `90` | Retention window in days for detail and rollup rows (`0` preserves indefinitely) |
| `OMCPA_USAGE_COLLECT_ERRORS` | `true` | Whether to subscribe to CPA's push error stream |

Setting both idle intervals to the same value restores a fixed polling cadence. **The maximum idle delay plus request duration must remain significantly lower than CPA's queue retention window**, or expired records will be lost. Under default backoff, the first batch after an idle period may wait up to ~10 seconds to be pulled; lower the upper bound if higher immediacy is required, or use RESP subscription. Changing these settings requires restarting the Oh My CPA backend.

Additional service variables (`OMCPA_LISTEN_ADDR`, `OMCPA_BASE_PATH`, `OMCPA_DATA_DIR`, `OMCPA_MASTER_KEY`, `OMCPA_CPA_BASE_URL`, `OMCPA_CPA_USAGE_ADDR`, `OMCPA_CPA_MANAGEMENT_KEY`, `OMCPA_REQUEST_TIMEOUT`, `OMCPA_CPA_TLS_SKIP_VERIFY`, `OMCPA_VERSION`) are documented in [`.env.example`](.env.example). Deployment-level variables such as `OMCPA_PUBLIC_URL` (used for HTTPS cookie flags and reverse proxy routing) can be supplied via environment variables or Compose.

`/v0/management/usage-queue` is a destructive read; multiple collectors cannot share an instance's queue. Do not disable ingestion to suppress log noise, and avoid repeatedly executing performance tests against a live queue.

## Docker Compose

The complete deployment template is located at [`deploy/compose.full.yml`](deploy/compose.full.yml), containing CPA, Oh My CPA, and Caddy:

```powershell
$env:CPA_MANAGEMENT_KEY = 'your-cpa-management-key'
$env:OMCPA_MASTER_KEY = 'at-least-32-random-bytes-for-encryption'
$env:OMCPA_PUBLIC_URL = 'https://xxxx.com/omc'
$env:DOMAIN = 'xxxx.com'
docker compose -f deploy/compose.full.yml up -d --build
```

Routing conventions:

```text
https://xxxx.com/       → CPA
https://xxxx.com/omc/   → Oh My CPA
```

Caddy retains the `/omc` prefix rather than stripping it (`handle_path` is not used). Oh My CPA connects directly to `http://cpa:8317` within the Compose network; RESP usage collection also targets `cpa:8317` directly without traversing the public reverse proxy.

When connecting to an existing CPA instance, use [`deploy/compose.omc.yml`](deploy/compose.omc.yml) and forward `/omc/*` to the Oh My CPA container through an external reverse proxy.

## Local Integration with Real CLIProxyAPI

The repository does not track CPA binaries, configuration files, or credentials. Extract CLIProxyAPI into the gitignored `cpa/` directory, configure your `config.yaml`, auth files, and API keys, then launch the services:

```bash
pnpm cpa:start
pnpm dev
```

If CPA is already running in Docker (or another local process), `pnpm cpa:start` is not needed: point `OMCPA_CPA_BASE_URL` to `http://127.0.0.1:8317` and `OMCPA_CPA_USAGE_ADDR` to `127.0.0.1:8317`. Both addresses must be directly reachable from the Oh My CPA process.

**A single CPA instance must have only one collector.** In subscription mode, backfill routines and fallback paths perform destructive queue reads; running two collectors concurrently results in data loss. To delegate collection to Oh My CPA, stop other collectors or set `OMCPA_USAGE_INGEST_MODE=off`.

`.env` is loaded when the Go process starts; existing environment variables take precedence. The administrator login password is the plaintext CPA Management Key (`OMCPA_CPA_MANAGEMENT_KEY`), matching `remote-management.secret-key` in CPA. Note that CPA stores only the bcrypt hash of this key in its `config.yaml`; copying that hash directly results in `401 invalid management key`.

Deterministic browser acceptance starts its own fake CPA, temporary SQLite, and Go service, but loads the SPA built in `internal/web/dist`, so run `pnpm build` first:

```bash
pnpm build
pnpm verify:browser
pnpm verify:browser:smoke
pnpm verify:probes
pnpm verify:e2e
```

Testing architecture: logic tests independent of the browser (URL rewriting, saved-view derivation, debounce cancellation, polling decisions, range validation, display mappings) run under `pnpm test:logic` (Node, no Vite / no Go / no Chromium); `pnpm verify:probes` is reserved strictly for properties requiring real Chromium (drawer/modal stacking and hit testing, column geometry and truncation, responsive alignment overrides, sparkline rendering, and request sequencing). The testing philosophy and assertion classifications are documented in [`docs/architecture.md`](docs/architecture.md) §11 and [`scripts/acceptance/MIGRATION.md`](scripts/acceptance/MIGRATION.md).

**Do not run the full test suite on every iteration**: use `pnpm test:fast` (1–13s) and `pnpm check:ui` (3–19s, no `pnpm build` required) for fast feedback; save `pnpm verify` for the end of a logical feature, and `pnpm verify:full` before declaring done or pushing. Because `check:ui` runs on the dev server with mock APIs, it does not replace testing built production artifacts—both are required at different stages. Full definitions of the three verification moments are in [`AGENTS.md`](AGENTS.md) §3.

To check against a real CPA or a running Vite development server, use the live smoke suite; setting `OMCPA_WRITE_TEST=1` enables mutating operations such as uploads, toggles, and deletions:

```bash
pnpm verify:live
OMCPA_URL=http://127.0.0.1:5173/omc/ pnpm verify:live
OMCPA_WRITE_TEST=1 pnpm verify:live
```

On deterministic acceptance failures, screenshots, HTML snapshots, and application logs are saved locally in `tmp/browser-acceptance-failure/`; GitHub Actions uploads these as short-lived failure artifacts.

UI language preferences persist in `localStorage('omc-lang')`. Visual styling and theme tokens are authoritatively defined in [`docs/design.md`](docs/design.md). Air watcher rules are defined in [`.air.toml`](.air.toml). Never commit `cpa/`, `.env`, or real credentials.

## API

All endpoints under `/omc/api/v1/*` require an administrator session cookie. Representative endpoints include:

```text
GET    /omc/api/healthz
POST   /omc/api/auth/login     {"password":"..."}
GET    /omc/api/auth/session
POST   /omc/api/auth/logout
POST   /omc/api/v1/instances/default/discover
GET    /omc/api/v1/resources?status=unclaimed
PATCH  /omc/api/v1/resources/{id}/override
```

For the complete route map and DTO definitions, see `Handler.Router` in `internal/api/handler.go`.

Login sends the CPA management key (`{"password":"<management-key>"}` to `POST /omc/api/auth/login`); there is no separate Oh My CPA administrator password. The session cookie is `HttpOnly`, `SameSite=Strict`, expires after 12 hours, and is marked `Secure` when `OMCPA_PUBLIC_URL` uses HTTPS. The cookie signing secret is derived from the management key, so rotating the key invalidates all existing sessions once Oh My CPA adopts the new key.

## Security Boundaries

- The administrator login credential is the CPA Management Key (`OMCPA_CPA_MANAGEMENT_KEY`), distinct from the storage encryption key (`OMCPA_MASTER_KEY`). There is no secondary administrative password. The key is entered by the operator at login and submitted to the Go backend, which verifies it and derives the session signature. The key is never persisted in browser storage and is omitted from normal API responses; the browser holds only an expiring `SameSite=Strict` `HttpOnly` session cookie. Authenticated secret-management actions (such as viewing raw config YAML or revealing client API keys) explicitly deliver secrets to authorized administrators.
- Rotating the CPA Management Key invalidates Oh My CPA sessions once Oh My CPA reloads the changed key (such as upon service restart or config update).
- The CPA Management Key and raw usage inbox payloads are encrypted at rest in SQLite using AES-GCM, with the master key provided by `OMCPA_MASTER_KEY`.
- Regular API responses (`/resources`, `/management/auth-files`, `/management/config`, `/usage/events`, `/management/dashboard`, `/healthz`) enforce strict DTO allowlists and field redaction; they never expose API keys, OAuth tokens, account secrets, raw auth file contents, or URLs with embedded credentials.
- Exporting raw auth files, viewing or editing raw configuration YAML, and downloading request logs are explicit high-intent administrator actions requiring valid sessions and same-origin validation, served with `Cache-Control: no-store`, and logged to the append-only `audit_events` table; audit write failures fail closed, preventing sensitive data export and destructive modifications.
- Upgrading to database migration 004 performs irreversible redaction and historical data sanitization. Before applying pending migrations, the system checks available disk space, creates an AES-GCM encrypted backup with a SHA-256 checksum, verifies restore smoke into a temporary database, and retains recent backups according to policy.
- Generic upstream `POST /api-call` forwarding carries SSRF risks and remains disabled for browser traffic. All console administrative writes use strongly-typed allowlisted endpoints.
- SQLite deployments must remain a single Oh My CPA replica.
- The CPA Management API must not be exposed directly to the public internet.
- If `OMCPA_MASTER_KEY` is lost, previously encrypted ciphertext cannot be decrypted.

Domain concepts and terms are in [`CONTEXT.md`](CONTEXT.md), module maps and data flows are in [`docs/architecture.md`](docs/architecture.md), and architectural decisions are in [`docs/adr/0001-go-react-sqlite-modular-monolith.md`](docs/adr/0001-go-react-sqlite-modular-monolith.md).

## Documentation Maintenance

Context documentation (this file, `CONTEXT.md`, `docs/architecture.md`, `docs/design.md`, `PRODUCT.md`, `docs/adr/`, `docs/cpamc-parity.md`, etc.) and code are co-deliverables. **Which changes trigger which document, what must be updated synchronously**, and the pre-completion checklist are established in [`AGENTS.md`](AGENTS.md)—a shared contract for human maintainers and AI agents ensuring documentation drift is resolved within the same change.

## License

This project is licensed under the [MIT License](LICENSE).
