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

## Features

### Gateway & Provider Management
- **AI Providers**: Configure and monitor endpoints for Codex, Claude, Gemini, DeepSeek, and OpenAI-compatible services.
- **Protocol-Level Toggling**: Enable or disable providers with real gateway exclusion (`excluded-models: ['*']`), preventing requests from routing to inactive credentials.
- **Model Catalog Pulling**: Fetch model lists directly from upstream providers to keep available models up to date.
- **Client Key Management**: Create, view, and delete gateway API keys. Assign aliases so client keys appear by name in request records and filters.
- **OAuth Credentials**: Upload, download, delete, and inspect OAuth auth files. Edit priority and weight settings, view supported models, and clear rate-limit cooldowns.

### Observability & Telemetry
- **Usage Dashboard**: Track request volume, token throughput, cache hit rates, and estimated costs across presets (15m, 1h, 6h, 24h, 7d, 30d, 90d) and custom date ranges.
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
- **Audit Logging**: Sensitive operations (downloading auth files, exporting logs, editing YAML) are written to an append-only audit log.
- **Offline Operation**: Frontend assets are bundled into the binary; no runtime CDN requests or external database servers required.

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

### Docker (In Progress)

> Docker packaging and automated image releases (`ghcr.io` / Docker Hub) are currently in progress.
>
> Running from source or compiling the standalone binary is recommended for now. Preview compose templates are available in the repository:
> - [`deploy/compose.full.yml`](deploy/compose.full.yml): Stack co-deploying CPA, Oh My CPA, and Caddy.
> - [`deploy/compose.omc.yml`](deploy/compose.omc.yml): Standalone Oh My CPA connecting to an existing CPA instance.

## Operational Notes

- **Single Collector**: The CPA usage queue is destructive. Only one collector may read from a CPA instance. If another service collects usage, set `OMCPA_USAGE_INGEST_MODE=off`.
- **Single Replica**: SQLite WAL requires exclusive single-process access. Run one replica mounting the data directory; do not mount over network filesystems (NFS/CIFS).
- **Master Key**: `OMCPA_MASTER_KEY` is required to decrypt stored credentials and payloads. Back it up securely.
- **Network Security**: Keep CPA on a private network or loopback interface, and serve Oh My CPA over HTTPS.

## Developer Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start Air + Vite development environment |
| `pnpm build` | Build frontend SPA and sync to `internal/web/dist` |
| `pnpm test:fast` | Run affected tests based on current worktree changes |
| `pnpm check:ui` | Fast UI scenario tests against dev server with mocked APIs |
| `pnpm verify` | Static gate: toolchain check, static analysis, and secret scan |
| `pnpm verify:full` | Full gate: build, bundle budgets, browser acceptance & probes |

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — Domain model, time windows, and price snapshot rules
- [`docs/architecture.md`](docs/architecture.md) — Module boundaries, data flows, and invariants
- [`docs/design.md`](docs/design.md) — Visual design system and theme tokens
- [`docs/ops/sqlite-operations.md`](docs/ops/sqlite-operations.md) — SQLite operations, backup, and restore runbook
- [`docs/cpamc-parity.md`](docs/cpamc-parity.md) — Feature parity matrix with official CPAMC
- [`AGENTS.md`](AGENTS.md) — Development conventions and code/doc sync contract

## License

This project is licensed under the [MIT License](LICENSE).
