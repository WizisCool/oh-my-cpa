<div align="center">

<a href="#gh-light-mode-only">
  <img src="web/src/assets/brand/omc-wordmark-light.svg#gh-light-mode-only" alt="Oh-My-CPA" width="340">
</a>
<a href="#gh-dark-mode-only">
  <img src="web/src/assets/brand/omc-wordmark-dark.svg#gh-dark-mode-only" alt="Oh-My-CPA" width="340">
</a>

### Centralize APIs, OAuth and routing, observe requests, quota and cost

Management · Routing · Observability · Agent & MCP

<br />

[![Release](https://img.shields.io/github/v/release/WizisCool/oh-my-cpa?label=release)](https://github.com/WizisCool/oh-my-cpa/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/WizisCool/oh-my-cpa/ci.yml?branch=main&label=CI)](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/WizisCool/oh-my-cpa?style=flat&label=stars)](https://github.com/WizisCool/oh-my-cpa/stargazers)
[![Docker Pulls](https://img.shields.io/docker/pulls/wiziscool/oh-my-cpa?style=flat&logo=docker&logoColor=white)](https://hub.docker.com/r/wiziscool/oh-my-cpa)
[![CLIProxyAPI](https://img.shields.io/badge/CLIProxyAPI-v8+-4f46e5?style=flat)](https://github.com/router-for-me/CLIProxyAPI)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)

<br />

**[Live Demo](https://omc-demo.junze.dev)** ·
**[Documentation](https://omc.junze.dev/docs/)** ·
**[API Reference](https://omc.junze.dev/api-reference/)** ·
[Quick Start](#quick-start) ·
[Features](#features) ·
[简体中文](README.zh-CN.md)

<br />

<a href="https://omc-demo.junze.dev">
  <img src="docs/images/readme/hero-split.en.webp" alt="The Oh My CPA dashboard, half in the light theme and half in the dark theme" width="100%">
</a>

</div>

**Oh My CPA** (OMC) is a self-hosted web console and observability layer for
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) **v8+**, built on `shadcn/ui`
with desktop and mobile layouts. OMC centralizes providers, OAuth accounts, visual
routing, a plugin ecosystem, live request records, OpenRouter-backed pricing analytics,
quota window warmup, and built-in Agent/MCP workflows—protected by AES-GCM encryption,
audit logging, and automatic pre-write configuration backups.

> [!TIP]
> Explore the **[Live Demo](https://omc-demo.junze.dev)**, browse the **[Documentation Site](https://omc.junze.dev/docs/)**, or inspect the **[API Reference](https://omc.junze.dev/api-reference/)**.

## Highlights

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/images/readme/usage-events.en.webp" alt="Request records with latency, tokens and cost per request">
<p align="center"><b>Request records</b><br />Filter every attempt by model, provider, key, status, and cost</p>
</td>
<td width="50%" valign="top">
<img src="docs/images/readme/pricing.en.webp" alt="Model price book grouped by provider">
<p align="center"><b>Cost &amp; usage</b><br />OpenRouter price book matching, channel multipliers, and custom tiers</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/readme/insights.en.webp" alt="Insights: multi-dimensional usage comparison and trend analytics">
<p align="center"><b>Insights</b><br />Compare usage across keys, models, and providers with traffic flows</p>
</td>
<td width="50%" valign="top">
<img src="docs/images/readme/agent.en.webp" alt="Agent: built-in conversational assistant with interactive management">
<p align="center"><b>Agent &amp; MCP</b><br />Query usage and operate the console with human-approved capabilities</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/readme/oauth-management.en.webp" alt="OAuth credentials with their state and quota">
<p align="center"><b>OAuth &amp; quota warmup</b><br />Sign in, track window capacity, and schedule quota window warmups</p>
</td>
<td width="50%" valign="top">
<img src="docs/images/readme/ai-providers.en.webp" alt="AI provider list with enable switches and traffic">
<p align="center"><b>AI providers</b><br />Endpoints, models, priority, and gateway-enforced enable switches</p>
</td>
</tr>
</table>

<div align="center">
  <img src="docs/images/readme/mobile.en.webp" alt="The dashboard, request records and OAuth management on a phone" width="88%">
  <p><b>Desktop &amp; mobile</b><br />Responsive operator layouts across every console route</p>
</div>

## Quick Start

### Install with a coding agent

Paste this prompt into Claude Code, Codex, Cursor, or another agent:

```text
Install Oh My CPA for me by following
https://raw.githubusercontent.com/WizisCool/oh-my-cpa/main/docs/install-for-agents.md
```

### New stack with Docker Compose

Deploys CLIProxyAPI v8+, Oh My CPA (`10001:10001`, read-only rootfs), and the isolated
container updater:

```bash
mkdir -p oh-my-cpa && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o compose.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
printf 'CPA_MANAGEMENT_KEY=%s\nOMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d
```

Open **`http://127.0.0.1:8080/`** and sign in with `CPA_MANAGEMENT_KEY` from `.env`.
Clients send model traffic to CPA at `http://127.0.0.1:8317`.

### Beside an existing CLIProxyAPI

Deploy OMC without modifying or restarting your running CPA instance (`compose.omc.yml`),
download standalone **native binaries** (macOS, Windows, Linux, FreeBSD on amd64/arm64),
or configure ports, reverse proxies, and host mounts in the **[Installation Guide](docs/install.md)**.

> [!IMPORTANT]
> Back up `.env`. `OMCPA_MASTER_KEY` encrypts stored credentials and database secrets.

## Features

- **Gateway & Routing**: Manage Codex, Claude, Gemini, Meta Muse, xAI, Vertex AI, DeepSeek, and OpenAI-compatible providers, client API keys, OAuth accounts with quota capacity & window warmup, visual routing tiers, Model Playground, and the [OMC Community plugin registry](https://github.com/omc-community/omc-plugins).
- **Observability & Pricing**: Live SSE request streaming and routing map, permanent usage facts, multi-period Insights, OpenRouter price matching with time/tier/channel multipliers, 11 display currencies, and full audit trails.
- **Configuration & Security**: Dual-mode form/Monaco YAML config editor with pre-write encrypted backups, AES-GCM secret storage, custom palettes & fonts, and safe Agent/MCP capability approvals.

## Architecture

```text
Browser ──▶ Direct listener / HTTPS ingress ──▶ Oh My CPA (:8080)
                                                 ├─ Embedded React SPA (/)
                                                 ├─ SQLite WAL (/data)
                                                 └─ Usage collector ──▶ CLIProxyAPI (:8317)
```

- **Single binary**: Embedded SPA + Go control plane, one replica per local SQLite WAL directory.
- **Isolated updater**: Only `oh-my-cpa-updater` mounts the Docker socket and pulls Ed25519-signed manifests by digest.

## Documentation

Read online at **[omc.junze.dev/docs](https://omc.junze.dev/docs/)** or directly in the repository ([`docs/README.md`](docs/README.md)):

| Guide | Topics |
| --- | --- |
| [Installation](docs/install.md) · [Agent Install](docs/install-for-agents.md) | Docker Compose, standalone CPA, native binaries, reverse proxy, upgrades, troubleshooting |
| [Configuration & Operations](docs/operations.md) | Environment variables, security boundaries, updater, Agent/MCP, quota & warmup |
| [SQLite Operations](docs/ops/sqlite-operations.md) | `.omcbackup` / cloud recovery, master key governance, WAL & retention |
| [Pricing & Usage Accounting](docs/pricing.md) | Price selection, billing tiers, multipliers, locked cost snapshots |
| [Agent Capabilities & MCP](docs/agent-capabilities.md) | Capability registry, human approvals, read-only SQL, Streamable HTTP & stdio |
| [CPA v8 Contract](docs/cpa-v8-compat.md) | Gateway v8 baseline, write coalescing, plugin boundaries |
| [API Reference](https://omc.junze.dev/api-reference/) | Interactive Swagger 2.0 / OpenAPI documentation |
| [Contributor Guides](CONTRIBUTING.md) | [Architecture](docs/dev/architecture.md) · [Design](docs/dev/design.md) · [Testing](docs/dev/testing.md) · [Releasing](docs/dev/releasing.md) · [Demo Ops](docs/ops/cloudflare-demo.md) |

## Contributing

Development requires Go 1.26+, Node.js 22+, and pnpm 11+:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for local verification (`pnpm test:fast`, `pnpm verify`) and [`SECURITY.md`](SECURITY.md) for private vulnerability reporting.

## Acknowledgements & License

Built on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Thanks to the [Linux.do community](https://linux.do). Released under the [MIT License](LICENSE).
