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
[![Docker Pulls](https://img.shields.io/docker/pulls/wiziscool/oh-my-cpa?style=flat&logo=docker&logoColor=white)](https://hub.docker.com/r/wiziscool/oh-my-cpa)
[![CLIProxyAPI](https://img.shields.io/badge/CLIProxyAPI-v8+-4f46e5?style=flat)](https://github.com/router-for-me/CLIProxyAPI)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)

<br />

**[Live Demo](https://omc-demo.junze.dev)** ·
[Install](#install) ·
[Features](#features) ·
[Agents and MCP](#agents-and-mcp) ·
[Documentation](#documentation) ·
[简体中文](README.zh-CN.md)

<br />

<a href="https://omc-demo.junze.dev">
  <img src="docs/images/readme/hero-split.en.webp" alt="The Oh My CPA dashboard, half in the light theme and half in the dark theme" width="100%">
</a>

</div>

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) is an API gateway: it
adapts protocols, holds credentials and proxies requests. **Oh My CPA** (OMC) is a web
console for it. OMC manages the gateway's providers, credentials and configuration, and
records the usage and cost of every request, which CPA does not store. It is a single Go
binary with the React console embedded and a local SQLite database, runs offline, and
signs in with CPA's management key.

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
or as YAML. Model Square lists the model names clients can call, by maker, with price, recent requests and models.dev specifications.

</td>
<td width="25%" valign="top">

### Price

The cost of a request is fixed when it completes. Prices come from OpenRouter or custom
rates, and later price changes do not alter past records.

</td>
<td width="25%" valign="top">

### Automate

A built-in Agent and a remote MCP endpoint operate the console through declared capabilities.
Changes run only after approval.

</td>
</tr>
</table>

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
<p align="center"><b>Cost &amp; usage</b><br />A price book matched from OpenRouter, with custom overrides</p>
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
<p align="center"><b>AI providers</b><br />Endpoints, models, priority and an enable switch enforced by the gateway</p>
</td>
</tr>
</table>

The screenshots follow the GitHub theme. The console has light, dark and system modes,
each with three built-in palettes and one custom palette.

<div align="center">
  <img src="docs/images/readme/mobile.en.webp" alt="The dashboard, request records and OAuth management on a phone" width="88%">
  <p><b>Mobile layout.</b> Every page adapts to a narrow screen.</p>
</div>

## Install

### Install with an agent

Paste the following into Claude Code, Codex, Cursor or another coding agent. The agent
inspects the machine, picks the matching method and installs it:

```text
Install Oh My CPA for me by following
https://raw.githubusercontent.com/WizisCool/oh-my-cpa/master/docs/install-for-agents.md
```

### Install with Docker Compose

Requires Docker Engine with the Compose plugin and CLIProxyAPI v8.0.0 or later. The
commands assume a Linux or macOS shell with `curl` and `openssl`. The console's sign-in
password is CPA's management key.

| Scenario | Method |
| --- | --- |
| CPA is not deployed yet | [New install](#new-install) |
| CPA is deployed with Docker Compose | [CLIProxyAPI is already installed](#cliproxyapi-is-already-installed) |
| CPA is deployed another way | [Standalone](#standalone) |

#### New install

Save the following as `compose.yml` in a new directory:

```yaml
services:
  cli-proxy-api:
    image: eceasy/cli-proxy-api:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8317:8317"
    environment:
      MANAGEMENT_PASSWORD: ${CPA_MANAGEMENT_KEY:?}
    volumes:
      - ./config.yaml:/CLIProxyAPI/config.yaml
      - ./auths:/root/.cli-proxy-api
      - ./logs:/CLIProxyAPI/logs
      - ./plugins:/CLIProxyAPI/plugins

  oh-my-cpa:
    image: wiziscool/oh-my-cpa:latest
    restart: unless-stopped
    depends_on:
      - cli-proxy-api
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      OMCPA_CPA_BASE_URL: http://cli-proxy-api:8317
      OMCPA_CPA_MANAGEMENT_KEY: ${CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_DATA_DIR: /data
    volumes:
      - oh-my-cpa-data:/data

volumes:
  oh-my-cpa-data:
```

In that directory, download CPA's starter configuration, generate the two keys and start
both services:

```bash
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
printf 'CPA_MANAGEMENT_KEY=%s\nOMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d
```

Open **`http://127.0.0.1:8080/omc/`** and sign in with the `CPA_MANAGEMENT_KEY` value
from `.env`. Providers and client keys are added in the console; clients send requests
to CPA at `http://127.0.0.1:8317`.

#### CLIProxyAPI is already installed

Add the service under `services:` in the Compose file that runs CPA, and merge
`oh-my-cpa-data:` into the top-level `volumes:` key if one exists. `cli-proxy-api` is
the service name in CPA's own Compose file; replace it if the service is named
differently.

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

Add two lines to `.env` in the same directory:

```dotenv
OMCPA_CPA_MANAGEMENT_KEY=<CPA's management key in plaintext, not the hash in config.yaml>
OMCPA_MASTER_KEY=<output of: openssl rand -hex 32>
```

Run `docker compose up -d oh-my-cpa`, which leaves the CPA container running as it is.
Open **`http://127.0.0.1:8080/omc/`** and sign in with the management key.

#### Standalone

Save the following as `compose.yml` in a new directory. `OMCPA_CPA_BASE_URL` is CPA's
address as seen from inside the container: the value below reaches a CPA on the same
machine that listens on all interfaces, and [reaching CPA](docs/install.md#reaching-cpa)
lists the other cases.

```yaml
services:
  oh-my-cpa:
    image: wiziscool/oh-my-cpa:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    extra_hosts:
      - host.docker.internal:host-gateway
    environment:
      OMCPA_CPA_BASE_URL: http://host.docker.internal:8317
      OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_DATA_DIR: /data
    volumes:
      - oh-my-cpa-data:/data

volumes:
  oh-my-cpa-data:
```

Create `.env` in the same directory:

```dotenv
OMCPA_CPA_MANAGEMENT_KEY=<CPA's management key in plaintext, not the hash in config.yaml>
OMCPA_MASTER_KEY=<output of: openssl rand -hex 32>
```

Run `docker compose up -d`, then open **`http://127.0.0.1:8080/omc/`** and sign in with
the management key.

### Install a native executable

[Tagged releases](https://github.com/WizisCool/oh-my-cpa/releases) include executables
for macOS (Darwin), Windows, Linux and FreeBSD, on amd64 and arm64. Each archive embeds
the console and includes an environment template; verify its SHA-256 hash against the
release's `checksums.txt`. No Go, Node or Docker is required. CPA must be installed
separately. Follow the [native installation guide](docs/install.md#native-executable)
for configuration, permissions and upgrades.

### Notes

> [!IMPORTANT]
> Back up `.env`. `OMCPA_MASTER_KEY` encrypts the database, and the data cannot be read
> without it.

CPA hands each usage record to a single reader. If another usage tracker reads the same
CPA, stop it, or add `OMCPA_USAGE_INGEST_MODE: "off"` under `environment:` to use OMC
for management only. Other management panels do not conflict.

The [installation guide](docs/install.md) covers the hardened Compose files published
with each release, remote access, HTTPS, building from source, upgrades and
troubleshooting.

## Features

<details open>
<summary><b>Gateway & providers</b></summary>

- **AI providers**: Codex, Claude, Gemini, Meta Muse, xAI, Vertex AI, Gemini Interactions, DeepSeek and OpenAI-compatible services, each with credentials, advanced model options, runtime retry/error policies, priority, weight, proxy and an enable switch enforced by the gateway.
- **OAuth management**: sign in from the console for Codex, Claude, Antigravity, xAI, Kimi (kimi.com and kimi.ai), Devin and Meta Muse, or import a Vertex service account key. Auth files, manual token refresh, model lists, Meta quota, live xAI/Antigravity plan readings and credential-specific aliases are managed per credential; shared model aliases and exclusion rules apply provider-wide. Window capacity is estimated for Codex, Claude and supported Antigravity groups, with the previous cycle shown as a labelled reference.
- **Client keys**: create, name and revoke gateway API keys. Names appear in request records and filters.
- **Model catalog**: pull model lists straight from upstream providers.
- **Playground**: test any routed model with text and images, streamed multi-turn answers and request diagnostics.
- **Plugins**: installed plugins, a plugin store, typed settings forms, and trusted plugin pages with native CPA management/model-directory compatibility. See [the trust boundary](docs/operations.md#plugin-pages).

</details>

<details>
<summary><b>Observability</b></summary>

- **Dashboard**: request volume, token throughput, cache hit rate and cost over presets from 15 minutes to 90 days, an all-time window since installation, or any custom range, plus a year-long token heatmap. Statistics are kept permanently; request records roll out of a configurable retention.
- **Model panels**: token trend and usage ring by call point or by upstream model, with cost shares.
- **Request records**: multi-select facets and full-text search; a detail drawer with duration, TTFT, token breakdown and the raw per-request log. Each record keeps the model the upstream reported serving, and flags the ones where it differs from the model requested.
- **Background collection**: usage is ingested by stream or polling whether or not a browser is open.
- **Logs and audit trail**: tail the gateway log, read the console's own service log, and review an append-only audit trail with filters and JSON export.

</details>

<details>
<summary><b>Pricing & cost</b></summary>

- **Request-time snapshots**: a request's cost is fixed by immutable price versions when it completes.
- **OpenRouter price book**: every served model priced from OpenRouter's public list, including long-context and time-of-day tiers.
- **Linked and custom prices**: pin a model to an OpenRouter entry or set custom rates, with tier presets and a calculator.
- **Channel multipliers**: scale everything one provider answers, for example a relay billed at 30% of list.

</details>

<details>
<summary><b>Configuration & security</b></summary>

- **Dual-mode config editor**: structured forms, or a Monaco YAML editor that preserves comments.
- **Automatic config backups**: an encrypted copy of `config.yaml` before every change, restorable from the console.
- **Encryption at rest**: stored credentials and raw usage messages are AES-GCM encrypted.
- **Audited sensitive actions**: revealing keys, downloading auth files and exporting logs are written to the audit log, and refused if that write fails.
- **Offline operation**: every asset is embedded in the binary; no CDN is contacted.
- **Personalization**: four interface languages, light and dark themes with custom palettes, a deployment time zone, and K/M/B or 万/亿 number units.

</details>

## Agents and MCP

**In the console.** On the `/agent` page, a model routed through CPA answers questions
and operates the console: usage and request analysis, providers, OAuth, quota, client
keys, configuration and pricing. Reads run directly. Changes are prepared server-side
and run only after an Allow in the console. Secrets, tokens and OAuth authorization
never enter the model's context.

**From an external agent.** The same capabilities are served over MCP at
`<console URL>/api/mcp` (Streamable HTTP), so an agent on another machine connects by
URL with the CPA management key as a bearer token. Nothing is installed on the agent's
side. The **Connect** tab of the `/agent` side panel shows the deployment's own endpoint
with ready-to-copy configuration.

Claude Code:

```bash
claude mcp add --transport http oh-my-cpa https://cpa.example.com/omc/api/mcp \
  --header "Authorization: Bearer $OMCPA_CPA_MANAGEMENT_KEY"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.oh-my-cpa]
url = "https://cpa.example.com/omc/api/mcp"
bearer_token_env_var = "OMCPA_CPA_MANAGEMENT_KEY"
```

Clients configured in JSON, such as Cursor:

```json
{
  "mcpServers": {
    "oh-my-cpa": {
      "url": "https://cpa.example.com/omc/api/mcp",
      "headers": { "Authorization": "Bearer <CPA management key>" }
    }
  }
}
```

<details>
<summary>Clients that only support stdio</summary>

The binary carries a stdio bridge that forwards to the console:

```json
{
  "mcpServers": {
    "oh-my-cpa": {
      "command": "/path/to/oh-my-cpa",
      "args": ["mcp"],
      "env": {
        "OMCPA_SERVER_URL": "https://cpa.example.com/omc",
        "OMCPA_CPA_MANAGEMENT_KEY": "<CPA management key>"
      }
    }
  }
}
```

</details>

An external agent can read state and prepare an operation, but cannot approve it, submit
a secret or complete an OAuth sign-in: a prepared change returns a link that opens its
approval in the console. The management key is administrator-equivalent, so connect only
trusted agents, and serve the console over HTTPS before connecting one remotely.
[`docs/agent-capabilities.md`](docs/agent-capabilities.md) is the contract.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMCPA_CPA_BASE_URL` | required | CPA's address |
| `OMCPA_CPA_MANAGEMENT_KEY` | required | CPA's management key, and the console's sign-in password |
| `OMCPA_MASTER_KEY` | required | At-rest encryption key (`openssl rand -hex 32`) |
| `OMCPA_BASE_PATH` | `/omc` | Sub-path the console is served under |
| `OMCPA_DATA_DIR` | `./data` | Directory of the SQLite database; the Compose files set `/data` |
| `OMCPA_PUBLIC_URL` | unset | The address browsers use; `https://` marks the session cookie `Secure` |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | `off` when another service collects this CPA's usage |
| `TZ` | system zone | Server calendar; keep it equal to CPA's. Containers default to UTC |

The full reference, with deployment constraints and operational notes, is
[`docs/operations.md`](docs/operations.md).

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
- **Allowlisted facade**: ordinary console APIs project safe DTOs; trusted plugin pages use the bounded native contract. Arbitrary target URLs remain refused.

[`docs/architecture.md`](docs/architecture.md) has the module map, data flows and invariants.

## Documentation

**Using OMC**

| Document | Contents |
| --- | --- |
| [`docs/install.md`](docs/install.md) | Installation, verification, upgrades, troubleshooting |
| [`docs/install-for-agents.md`](docs/install-for-agents.md) | The same install, as steps for a coding agent |
| [`docs/operations.md`](docs/operations.md) | Settings reference and operational notes |
| [`docs/ops/sqlite-operations.md`](docs/ops/sqlite-operations.md) | Backup, restore and master-key runbook |
| [`docs/agent-capabilities.md`](docs/agent-capabilities.md) | Agent capability contract and the MCP bridge |
| [`docs/cpa-v8-compat.md`](docs/cpa-v8-compat.md) | CPA v8 baseline and configuration relocation |
| [`docs/cpamc-parity.md`](docs/cpamc-parity.md) | Feature parity with the official CPA management center |

**Developing OMC**

| Document | Contents |
| --- | --- |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup and the verification workflow |
| [`AGENTS.md`](AGENTS.md) | The contract coding agents follow in this repository |
| [`docs/architecture.md`](docs/architecture.md) | Module boundaries, data flows and invariants |
| [`CONTEXT.md`](CONTEXT.md) · [`docs/design.md`](docs/design.md) | Domain vocabulary · visual system |
| [`docs/releasing.md`](docs/releasing.md) | Tag-triggered Docker Hub images, native archives and GitHub releases |
| [`docs/ops/cloudflare-demo.md`](docs/ops/cloudflare-demo.md) | How the public demo is deployed |

## Contributing

Issues and pull requests are welcome. Development needs Go 1.25+, Node.js 22+ and
pnpm 11+:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev          # Air + Vite with hot reload at http://127.0.0.1:5173/omc/
```

Run `pnpm verify` and `pnpm check:ui` before pushing.
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup and the verification workflow.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md), not in a
public issue.

## Acknowledgements

Oh My CPA is built on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), which
handles protocol adaptation, credentials and request proxying.

Thanks also to the [Linux.do community](https://linux.do).

## License

[MIT](LICENSE)
