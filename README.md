<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/src/assets/brand/omc-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="web/src/assets/brand/omc-wordmark-light.svg">
  <img src="web/src/assets/brand/omc-wordmark-dark.svg" alt="Oh-My-CPA" width="340">
</picture>

### Manage APIs and OAuth in one place. Visualize requests, cost and usage.

MCP · Visualization · Management

<br />

[![Release](https://img.shields.io/github/v/release/WizisCool/oh-my-cpa?label=release)](https://github.com/WizisCool/oh-my-cpa/releases)
[![CI](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml/badge.svg)](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/WizisCool/oh-my-cpa?style=flat&label=stars)](https://github.com/WizisCool/oh-my-cpa/stargazers)
[![Go](https://img.shields.io/badge/Go-1.25+-00ADD8?style=flat&logo=go&logoColor=white)](https://go.dev)
[![CLIProxyAPI](https://img.shields.io/badge/CLIProxyAPI-v8+-4f46e5?style=flat)](https://github.com/router-for-me/CLIProxyAPI)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)

<br />

**[Live Demo](https://omc-demo.junze.dev)** ·
[Install](#install) ·
[For Agents](#let-your-agent-install-it) ·
[Documentation](#documentation) ·
[简体中文](README.zh-CN.md)

<br />

<a href="https://omc-demo.junze.dev">
  <img src="docs/images/readme/hero-split.en.webp" alt="The Oh My CPA dashboard, half in the light theme and half in the dark theme" width="100%">
</a>

</div>

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) adapts protocols, holds
credentials and proxies requests. **Oh My CPA** is the control plane beside it: a web
console to run the gateway from, and the usage record the gateway itself does not keep.
It ships as a single Go binary with the React console embedded and SQLite on local disk,
with no CDN, no external database and no second password.

<table>
<tr>
<td width="25%" valign="top">

### Observe

A live dashboard, a year-long token heatmap, and a faceted browser over every request
with latency, TTFT, tokens and cost.

</td>
<td width="25%" valign="top">

### Manage

Providers, OAuth sign-in, client keys, quotas, plugins and CPA's `config.yaml`, as forms
or as YAML.

</td>
<td width="25%" valign="top">

### Price

Each request locks its cost when it completes. Prices come from OpenRouter or from you,
and history never drifts.

</td>
<td width="25%" valign="top">

### Automate

A built-in Agent and an MCP server operate the console through declared capabilities.
Changes wait for your approval.

</td>
</tr>
</table>

## Live demo

> [!TIP]
> **[Try Oh My CPA →](https://omc-demo.junze.dev)**
> Explore the console with sample data.

## Screenshots

<table>
<tr>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/usage-events-dark.en.webp">
  <img src="docs/images/readme/usage-events-light.en.webp" alt="Request records with latency, tokens and cost per request">
</picture>
<p align="center"><b>Request records</b><br />Every request, filterable by model, provider, key, status and cost</p>
</td>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/pricing-dark.en.webp">
  <img src="docs/images/readme/pricing-light.en.webp" alt="Model price book grouped by provider">
</picture>
<p align="center"><b>Cost &amp; usage</b><br />A price book matched from OpenRouter, with your own overrides</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/oauth-management-dark.en.webp">
  <img src="docs/images/readme/oauth-management-light.en.webp" alt="OAuth credentials with their state and quota">
</picture>
<p align="center"><b>OAuth management</b><br />Sign in, inspect quota and configure each credential in one place</p>
</td>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/ai-providers-dark.en.webp">
  <img src="docs/images/readme/ai-providers-light.en.webp" alt="AI provider list with enable switches and traffic">
</picture>
<p align="center"><b>AI providers</b><br />Endpoints, models, priority and a real gateway-level enable switch</p>
</td>
</tr>
</table>

The screenshots above follow your GitHub theme. The console does the same: light, dark
or system, each with three built-in palettes and one you colour yourself.

<div align="center">
  <img src="docs/images/readme/mobile.en.webp" alt="The dashboard, request records and OAuth management on a phone" width="88%">
  <p><b>Built for the phone too.</b> Every page reflows for a narrow screen.</p>
</div>

## Install

OMC runs beside [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) v8 or later,
and you sign in with CPA's management key. All you need is Docker.

### I don't have CPA yet

This starts CPA and OMC together:

```bash
mkdir -p oh-my-cpa/{deploy,oh-my-cpa-data,cpa/auths,cpa/logs,cpa/plugins} && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o deploy/compose.full.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o cpa/config.yaml
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 deploy/.env

docker compose -f deploy/compose.full.yml up -d
```

Open **`http://127.0.0.1:8080/omc/`** and sign in with the `CPA_MANAGEMENT_KEY` from
`deploy/.env`. Then add your providers and client keys in the console.

### My CPA runs in Docker Compose

Add OMC to the Compose file you already have. Paste this under `services:`, next to
your CPA service:

```yaml
  oh-my-cpa:
    image: wiziscool/oh-my-cpa:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      OMCPA_CPA_BASE_URL: http://cli-proxy-api:8317
      OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_DATA_DIR: /data
    volumes:
      - oh-my-cpa-data:/data

volumes:
  oh-my-cpa-data:
```

Then, in the same directory, add two keys to `.env` and start the new service:

```bash
cat >> .env <<EOF
OMCPA_CPA_MANAGEMENT_KEY=your-cpa-management-key
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env

docker compose up -d oh-my-cpa
```

Put your real management key in `.env` before the last command: the plaintext one, not
the hash in CPA's `config.yaml`. `cli-proxy-api` is the service name in CPA's own
Compose file; change it if yours differs. The CPA container is not restarted and none of
its settings or keys change. Open **`http://127.0.0.1:8080/omc/`**.

### My CPA runs some other way

This runs OMC from its own Compose file and leaves your CPA alone:

```bash
mkdir -p oh-my-cpa/{deploy,oh-my-cpa-data} && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o deploy/compose.omc.yml
sudo chown 10001:10001 oh-my-cpa-data

cat > deploy/.env <<EOF
OMCPA_CPA_BASE_URL=http://host.docker.internal:8317
OMCPA_CPA_MANAGEMENT_KEY=your-cpa-management-key
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 deploy/.env

docker compose -f deploy/compose.omc.yml up -d
```

Put your real management key in `deploy/.env` before the last command: the plaintext
one, not the hash in CPA's `config.yaml`. If OMC cannot reach CPA, see
[reaching your CPA](docs/install.md#reaching-your-cpa).

**Switching from another usage tracker?** CPA hands each usage record to one reader
only. Stop the old tracker and OMC records from then on, or keep it and set
`OMCPA_USAGE_INGEST_MODE=off` to use OMC for management alone. Other management panels
can stay; they don't conflict.

### Let your agent install it

Paste this into Claude Code, Codex, Cursor or any coding agent. It looks at what you
already run and picks one of the paths above:

```text
Install Oh My CPA for me by following
https://raw.githubusercontent.com/WizisCool/oh-my-cpa/master/docs/install-for-agents.md
```

> [!IMPORTANT]
> Back up the `.env` file you just wrote. `OMCPA_MASTER_KEY` encrypts the database, and without it the
> data cannot be read.

Remote servers, HTTPS, building from source, upgrades and troubleshooting are in the
[installation guide](docs/install.md).

## Agents and MCP

**In the console.** The `/agent` page lets a model you already route through CPA answer
questions and operate the console: usage and request analysis, providers, OAuth, quota,
client keys, configuration and pricing. Reads run directly. Changes are prepared
server-side and wait for one Allow or Deny. Secrets, tokens and OAuth authorization
never enter the model's context.

**From your own agent.** The same capabilities are available over MCP from the binary
itself:

```json
{
  "mcpServers": {
    "oh-my-cpa": {
      "command": "/path/to/oh-my-cpa",
      "args": ["mcp"],
      "env": {
        "OMCPA_SERVER_URL": "https://cpa.example.com/omc",
        "OMCPA_CPA_MANAGEMENT_KEY": "<your CPA management key>"
      }
    }
  }
}
```

An external agent can read state and prepare an operation, but cannot approve it, submit
a secret or complete an OAuth sign-in. The management key is administrator-equivalent,
so connect only agents you would trust with the console.
[`docs/agent-capabilities.md`](docs/agent-capabilities.md) is the contract.

## Features

<details open>
<summary><b>Gateway & providers</b></summary>

- **AI providers**: Codex, Claude, Gemini, Meta Muse, xAI, Vertex AI, Gemini Interactions, DeepSeek and OpenAI-compatible services, each with credentials, models, priority, weight, proxy and an enable switch the gateway actually enforces.
- **OAuth management**: sign in from the console for Codex, Claude, Antigravity, xAI, Kimi, Devin and Meta Muse; manage auth files, model lists, aliases and quota per credential, with scoped capacity estimates for Codex, Claude and supported Antigravity groups, plus labelled previous-cycle references.
- **Client keys**: create, name and revoke gateway API keys. Names appear in request records and filters.
- **Model catalog**: pull model lists straight from upstream providers.
- **Playground**: test any routed model with text and images, streamed multi-turn answers and request diagnostics.
- **Plugins**: installed plugins, a plugin store and typed settings forms on one page.

</details>

<details>
<summary><b>Observability</b></summary>

- **Dashboard**: request volume, token throughput, cache hit rate and cost over presets from 15 minutes to 90 days or any custom range, plus a year-long token heatmap.
- **Model panels**: token trend and usage ring by call point or by upstream model, with cost shares.
- **Request records**: multi-select facets and full-text search; a detail drawer with duration, TTFT, token breakdown and the raw per-request log. Each record keeps the model the upstream reported serving, and flags the ones where it differs from the model requested.
- **Background collection**: usage is ingested by stream or polling whether or not a browser is open.
- **Logs and audit trail**: tail the gateway log, read the console's own service log, and review an append-only audit trail with filters and JSON export.

</details>

<details>
<summary><b>Pricing & cost</b></summary>

- **Request-time snapshots**: a request's cost is fixed by immutable price versions when it completes.
- **OpenRouter price book**: every served model priced from OpenRouter's public list, including long-context and time-of-day tiers.
- **Linked and custom prices**: pin a model to an OpenRouter entry or set your own rates, with tier presets and a calculator.
- **Channel multipliers**: scale everything one provider answers, for example a relay billed at 30% of list.

</details>

<details>
<summary><b>Configuration & security</b></summary>

- **Dual-mode config editor**: structured forms, or a Monaco YAML editor that preserves comments.
- **Automatic config backups**: an encrypted copy of `config.yaml` before every change, restorable from the console.
- **Encryption at rest**: stored credentials and raw usage messages are AES-GCM encrypted.
- **Audited sensitive actions**: revealing keys, downloading auth files and exporting logs are written to the audit log, and refused if that write fails.
- **Offline by design**: every asset is in the binary, with no CDN to reach.
- **Yours to arrange**: four interface languages, light and dark themes with custom palettes, a deployment time zone, and K/M/B or 万/亿 number units.

</details>

## Architecture

```text
Browser ──▶ Direct listener / existing HTTPS ingress ──▶ Oh My CPA (:8080)
                                                 ├─ Embedded React SPA (/omc/)
                                                 ├─ SQLite WAL (/data)
                                                 └─ Usage collector ──▶ CLIProxyAPI (:8317)
```

- **Single binary**: the React console is embedded in the Go executable.
- **Single replica**: SQLite in WAL mode, one process per data directory.
- **Sub-path native**: served under `/omc` by default (`OMCPA_BASE_PATH`), so it shares a host with CPA.
- **Allowlisted facade**: the console never proxies raw CPA responses or arbitrary URLs.

[`docs/architecture.md`](docs/architecture.md) has the module map, data flows and invariants.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_CPA_BASE_URL` | required | CPA's address |
| `OMCPA_CPA_MANAGEMENT_KEY` | required | CPA's management key, and the console's sign-in password |
| `OMCPA_MASTER_KEY` | required | At-rest encryption key (`openssl rand -hex 32`) |
| `OMCPA_BASE_PATH` | `/omc` | Sub-path the console is served under |
| `OMCPA_DATA_DIR` | `./data` | Where the SQLite database lives |
| `OMCPA_PUBLIC_URL` | unset | The address browsers use; `https://` marks the session cookie `Secure` |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | `off` when another service collects this CPA's usage |
| `TZ` | system zone | Server calendar; keep it equal to CPA's |

The full reference, with deployment constraints and operational notes, is
[`docs/operations.md`](docs/operations.md).

## Documentation

| | |
| --- | --- |
| [`docs/install.md`](docs/install.md) | Installation, verification, upgrades, troubleshooting |
| [`docs/install-for-agents.md`](docs/install-for-agents.md) | The same install, as steps for a coding agent |
| [`docs/releasing.md`](docs/releasing.md) | Tag-triggered Docker Hub and GitHub releases |
| [`docs/operations.md`](docs/operations.md) | Settings reference and operational notes |
| [`docs/ops/sqlite-operations.md`](docs/ops/sqlite-operations.md) | Backup, restore and master-key runbook |
| [`docs/agent-capabilities.md`](docs/agent-capabilities.md) | Agent capability contract and the MCP bridge |
| [`docs/architecture.md`](docs/architecture.md) | Module boundaries, data flows and invariants |
| [`docs/cpa-v8-compat.md`](docs/cpa-v8-compat.md) | CPA v8 baseline and configuration relocation |
| [`docs/cpamc-parity.md`](docs/cpamc-parity.md) | Feature parity with the official CPA management center |
| [`CONTEXT.md`](CONTEXT.md) · [`docs/design.md`](docs/design.md) | Domain vocabulary · visual system |
| [`docs/ops/cloudflare-demo.md`](docs/ops/cloudflare-demo.md) | How the public demo is deployed |

## Development

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev          # Air + Vite with hot reload at http://127.0.0.1:5173/omc/
```

| Command | Purpose |
| --- | --- |
| `pnpm test:fast` | The checks your working-tree changes affect |
| `pnpm check:ui` | The browser scenarios your change can reach |
| `pnpm verify` | The static gate to run before pushing |
| `pnpm verify:full` | Everything CI runs, locally |
| `pnpm readme:screenshots` | Regenerate the screenshots on this page from demo mode |

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup and the verification workflow;
[`AGENTS.md`](AGENTS.md) is the contract coding agents follow in this repository.

## Contributing & security

Issues and pull requests are welcome; start with [`CONTRIBUTING.md`](CONTRIBUTING.md).
Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md), not in a
public issue.

## Acknowledgements

Oh My CPA exists because of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
which does the hard part.

Thanks also to the [Linux.do community](https://linux.do).

## License

[MIT](LICENSE)
