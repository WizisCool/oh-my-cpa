<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/src/assets/brand/omc-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="web/src/assets/brand/omc-wordmark-light.svg">
  <img src="web/src/assets/brand/omc-wordmark-dark.svg" alt="Oh-My-CPA Logo" width="360">
</picture>

# Oh-My-CPA

### Web management console and usage observability for CLIProxyAPI.

<br />

[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](LICENSE)
[![Stars](https://img.shields.io/github/stars/WizisCool/oh-my-cpa?style=flat&label=stars)](https://github.com/WizisCool/oh-my-cpa/stargazers)
[![CI](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml/badge.svg)](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?style=flat&logo=go&logoColor=white)](https://go.dev)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?style=flat&logo=sqlite&logoColor=white)](https://www.sqlite.org)

<br />

**English** · [简体中文](README.zh-CN.md)

</div>

---

> [!IMPORTANT]
> **Oh My CPA is in active development.** Core features are stable for daily proxy management and usage telemetry, while multi-instance support, container packaging, and additional management surfaces are evolving.

Oh My CPA is a self-hosted control plane for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA). This project provides a web dashboard, request browser, credential management, model pricing, and configuration editing for your AI proxy gateway, running as a single Go binary with an embedded React frontend and local SQLite storage.

## Live Demo

**[oh-my-cpa-demo.vercel.app](https://oh-my-cpa-demo.vercel.app)** — the console, running on fixture data.

No account, no key, nothing to install: open the link and the dashboard is there. It is served from a built-in sample — a year of traffic across eight providers and fourteen models — so the panels have something real to show, and it is shown behind the same routing policy the product ships: sign-in, credential downloads, plugin execution, gateway configuration writes and anything that would leave the process are refused by the server, and the console says so when a change is not durable.

Nothing about the demo is a second implementation. It is this binary with `OMCPA_DEMO_MODE=true` and no gateway behind it, deployed as a Vercel container image (`docs/architecture.md` §13, `docs/ops/vercel-demo.md`). To run the same thing locally:

```bash
pnpm build
OMCPA_DEMO_MODE=true go run ./cmd/oh-my-cpa
```

It opens at the site root rather than `/omc`, and serves the same fixture this page
does.

## Features

### Gateway & Provider Management
- **AI Providers**: Configure and monitor endpoints for Codex, Claude, Gemini, Meta Muse, DeepSeek, and OpenAI-compatible services. Each config API-key family (claude, codex, gemini, meta) is managed the same way: credentials, models, priority/weight, proxy, and a gateway-level enable switch.
- **Protocol-Level Toggling**: Enable or disable providers with real gateway exclusion (`excluded-models: ['*']`), preventing requests from routing to inactive credentials.
- **Model Catalog Pulling**: Fetch model lists directly from upstream providers to keep available models up to date. Pulls require HTTPS except for localhost, loopback, or private IP literals; cross-origin redirects are refused.
- **Client Key Management**: Create, view, and delete gateway API keys. Assign aliases so client keys appear by name in request records and filters.
- **OAuth Credentials**: Upload, download, delete, and inspect OAuth auth files. Edit priority and weight settings, view supported models, and clear rate-limit cooldowns. Sign in from the console for Codex, Claude, Antigravity, xAI, Kimi, Devin and Meta Muse; a redirect flow whose callback your browser cannot reach is completed by pasting the final URL back, and a device-code flow shows the code to confirm.

### Observability & Telemetry
- **Usage Dashboard**: Track request volume, token throughput, cache hit rates, and estimated costs across presets (15m, 1h, 6h, 24h, 7d, 30d, 90d) and custom date ranges, with a year-long contribution-style token heatmap of daily token volume, where clicking a day shows its request count and token volume, and links to that day's request list.
- **Model-Level Usage Panels**: The token trend and model-usage ring rank the window's traffic by call point (the client-requested model alias) or by upstream model, with per-group costs and shares; the grouping choice persists as a console preference.
- **Token Unit Style**: Switch the console-wide number abbreviation (English K/M/B or Chinese 万/亿) across the dashboard, its token activity tooltip, the request records and the detail drawer; an abbreviated value always keeps its exact count.
- **OMC Settings Hub**: The console-wide token unit style, stored with the deployment, on one page together with the theme and the language shortcut. The theme is a mode - light, dark or follow-the-system - and each mode carries one of three registered palettes (OMC Dark/Midnight/Forest for dark, OMC Light/Porcelain/Sandstone for light) or one you colour yourself from nine tokens, with its own reset and a live contrast reading per token. The model panels' own grouping stays on the panels that plot it.
- **Faceted Request Browser**: Filter requests by model, provider, client key alias, status, cost, and latency using multi-select facets and full-text search.
- **Request Detail & Waterfall**: Inspect duration, time-to-first-token (TTFT), token breakdowns, and download raw per-request logs.
- **Streaming & Pull Ingestion**: Collects usage events via background RESP stream or polling, with automatic backoff during idle periods.
- **Live Logs**: Stream gateway logs in real time and download error log archives.

### Model Pricing & Cost Accounting
- **Request-Time Snapshots**: Each request locks its cost at completion using immutable price versions, ensuring historical numbers never drift when rates are updated.
- **models.dev Sync**: Automatically syncs pricing catalogs from `models.dev` with deterministic candidate matching.
- **Manual Price Overrides**: Set custom input, output, cache-read, and cache-write rates per model.

### Configuration & Security
- **Dual-Mode Config Editor**: Modify gateway settings through structured visual forms or directly in an embedded Monaco YAML editor with comment preservation.
- **Plugin Management**: Install, configure, and manage plugins from the plugin store.
- **Encrypted Storage**: Sensitive credentials and raw inbox messages are encrypted at rest using AES-GCM.
- **Audit Logging**: Sensitive operations (downloading auth files, exporting logs, viewing or editing YAML, and revealing stored client or provider keys) are written to an append-only audit log; a failed audit write refuses the operation.
- **Offline Operation**: Frontend assets are bundled into the binary; no runtime CDN requests or external database servers required. A plugin logo a plugin publishes elsewhere is fetched by the server and inlined, so the browser still loads only what the binary serves — in an air-gapped deployment that fetch fails and the console draws its own bundled brand mark instead.

## Architecture

```text
Browser ──▶ Reverse Proxy (Caddy / Nginx) ──▶ Oh My CPA (:8080)
                                                 ├─ Embedded React SPA (/omc/)
                                                 ├─ Local SQLite WAL (/data)
                                                 └─ Background Collector ──▶ CLIProxyAPI (:8317)
```

- **Single Binary**: The React SPA is embedded into the Go executable (`internal/web/dist`).
- **Single Replica**: Uses SQLite in WAL mode with a single connection pool. Must run as one instance per data directory.
- **Sub-Path Native**: Mounts under `/omc` by default (configurable via `OMCPA_BASE_PATH`).

## Getting Started

### Prerequisites

- Running [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance with its plaintext management key (`remote-management.secret-key`)
- Go 1.24+ (build toolchain pins `1.24.13`)
- Node.js 22+ & pnpm 11+

### Run from Source

1. **Clone the repository and install dependencies**:
   ```bash
   git clone https://github.com/WizisCool/oh-my-cpa.git
   cd oh-my-cpa
   pnpm install --frozen-lockfile
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   ```
   Set `OMCPA_MASTER_KEY` (32 random bytes in hex, e.g. `openssl rand -hex 32`) and `OMCPA_CPA_MANAGEMENT_KEY` (your CPA secret key). If CPA runs on another host, update `OMCPA_CPA_BASE_URL` and `OMCPA_CPA_USAGE_ADDR`.

3. **Build and start**:
   ```bash
   pnpm build
   go run ./cmd/oh-my-cpa
   ```

4. **Access the console**:
   Open **`http://127.0.0.1:8080/omc/`** and log in with your CPA management key.

<details>
<summary><strong>Development with Hot Reload</strong></summary>

<br />

Install [Air](https://github.com/air-verse/air) for Go automatic reloading:
```bash
go install github.com/air-verse/air@latest
pnpm dev
```
Open **`http://127.0.0.1:5173/omc/`**. Vite serves the UI with HMR and proxies `/omc/api/*` to the Go backend on `:8080`.

</details>

## Deployment

### Online Demo (Vercel)

The public demo runs the same binary as a Vercel container image. `Dockerfile.vercel` and `vercel.json` are the whole of the platform's configuration, and pushing to `master` updates production once the project is connected to the repository in the Vercel console. `docs/ops/vercel-demo.md` is the runbook, including the one account-level step that has to be done in a browser.

### Docker (In Progress)

> Docker packaging and automated image releases (`ghcr.io` / Docker Hub) are currently in progress.
>
> Running from source or compiling the standalone binary is recommended for now. Preview compose templates are available in the repository:
> - [`deploy/compose.full.yml`](deploy/compose.full.yml): Stack co-deploying CPA, Oh My CPA, and Caddy.
> - [`deploy/compose.omc.yml`](deploy/compose.omc.yml): Standalone Oh My CPA connecting to an existing CPA instance.
>
> The full stack pins CPA `v7.3.5` by default; override `CPA_IMAGE` when connecting the stack to a different compatible release. Its Caddy routes the console under `OMCPA_BASE_PATH` (default `/omc`) and everything else to CPA, so a non-default value is accepted in any of the forms the server normalises (`omc`, `/omc/`, `/omc`) and `/` makes the console take the whole host with CPA no longer reachable through the proxy.

## Operational Notes

- **Single Collector**: The CPA usage queue is destructive. Only one collector may read from a CPA instance. If another service collects usage, set `OMCPA_USAGE_INGEST_MODE=off`.
- **Single Replica**: SQLite WAL requires exclusive single-process access. Run one replica mounting the data directory; do not mount over network filesystems (NFS/CIFS).
- **Master Key**: `OMCPA_MASTER_KEY` is required to decrypt stored credentials and payloads. Back it up securely.
- **Network Security**: Keep CPA on a private network or loopback interface, and serve Oh My CPA over HTTPS.
- **Reverse Proxy Headers**: Set `OMCPA_TRUSTED_PROXY_CIDRS` to the comma-separated CIDRs of reverse proxies whose forwarding headers may be trusted (the bundled Compose file trusts Docker's `172.16.0.0/12` network). Leave it unset when clients connect directly; never trust a public range.
- **Demo Mode**: `OMCPA_DEMO_MODE` (default `false`) serves the console from a built-in fixture instead of a CPA, so it needs no management key and no provider credential. Its storage is not durable — the database is deleted and rebuilt on every boot — and the server refuses sign-in flows, credential movement, plugin execution, gateway configuration writes and anything that would leave the process. Turn it on only for a demonstration deployment; the public one is described under [Live Demo](#live-demo).
- **Update Checks**: The System Information page reports the running and published versions of both Oh My CPA and your gateway. It reads release metadata from `api.github.com` only — fixed host, no operator-supplied URL — following `HTTP_PROXY`/`HTTPS_PROXY` like the price sync does. A sweep runs every six hours; opening the page and the **Check for updates** button also check, subject to a fifteen-minute floor per product — inside it the answer comes from the stored index and the message says so, because the feed is one shared per-address budget. Set `OMCPA_UPDATE_CHECK_ENABLED=false` to stop the sweep on an offline deployment; the page then keeps working from the last answer it stored, and a check that fails is reported with its reason and the time it was attempted. `OMCPA_OMC_REPO` and `OMCPA_CPA_REPO` (`owner/name`) point the check at a fork. GitHub's unauthenticated budget is 60 requests per hour for the address making them, and the page says so when a check is refused for that reason. Release notes are held in memory rather than stored, so after a restart the page names the versions and links to the source while the notes themselves are unavailable — see `docs/architecture.md` §10.
- **Database Maintenance**: The same page can truncate the WAL or rebuild the database, and refuses the second while the first runs. Both wait for in-flight writes rather than interrupting them, and a rebuild is declined up front when the filesystem lacks the free space SQLite documents needing (up to twice the database file). A job cannot outlive a restart. `docs/ops/sqlite-operations.md` §6 covers the same operations from the host.

## Developer Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start Air + Vite development environment |
| `pnpm build` | Build frontend SPA and sync to `internal/web/dist` |
| `pnpm test:fast` | Run affected tests based on current worktree changes |
| `pnpm check:ui` | Fast UI scenario tests against dev server with mocked APIs |
| `pnpm verify` | Static gate: toolchain check, static analysis, and secret scan |
| `pnpm verify:full` | Full gate: build, bundle budgets, browser acceptance & probes |
| `pnpm verify:demo` | Browser smoke test for the demo deployment (`OMCPA_DEMO_URL` to check a remote one) |

## Contributing & Security

- **Contributing**: Please review [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, verification workflows, and coding standards.
- **Security**: For vulnerability reporting and security boundaries, please refer to [`SECURITY.md`](SECURITY.md).

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — Domain model, time windows, and price snapshot rules
- [`docs/architecture.md`](docs/architecture.md) — Module boundaries, data flows, and invariants
- [`docs/design.md`](docs/design.md) — Visual design system and theme tokens
- [`docs/ops/sqlite-operations.md`](docs/ops/sqlite-operations.md) — SQLite operations, backup, and restore runbook
- [`docs/ops/vercel-demo.md`](docs/ops/vercel-demo.md) — Vercel deployment runbook for the online demo
- [`docs/cpamc-parity.md`](docs/cpamc-parity.md) — Feature parity matrix with official CPAMC
- [`AGENTS.md`](AGENTS.md) — Development conventions and code/doc sync contract

## License

This project is licensed under the [MIT License](LICENSE).
