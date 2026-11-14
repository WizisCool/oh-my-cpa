# Oh My CPA Documentation

This directory holds the repository's canonical technical, operational, and release
documentation. Curated operator and integration guides—together with
[`README.md`](../README.md), [`README.zh-CN.md`](../README.zh-CN.md), and the Simplified
Chinese translations in [`docs/zh/`](zh/README.md)—are compiled into the bilingual
Fumadocs documentation site published at `https://omc.junze.dev/docs/`.

## Directory layout

| Path | Audience | Purpose |
| --- | --- | --- |
| [`install.md`](install.md), [`install-for-agents.md`](install-for-agents.md) | Operators & coding agents | Deployment, verification, upgrades, troubleshooting, and agent runbook |
| [`operations.md`](operations.md) | Operators | Environment settings, security constraints, updates, Agent/MCP, quota, and routing |
| [`pricing.md`](pricing.md) | Operators & integrators | OpenRouter matching, billing tiers, and locked cost snapshots |
| [`agent-capabilities.md`](agent-capabilities.md) | Operators & integrators | Built-in Agent tools, human approval handoff, and MCP transports |
| [`cpa-v8-compat.md`](cpa-v8-compat.md) | Operators & integrators | CLIProxyAPI v8 management contract and legacy config migration |
| [`ops/sqlite-operations.md`](ops/sqlite-operations.md) | System administrators | SQLite WAL backup, cloud recovery, master key, and maintenance |
| [`ops/cloudflare-demo.md`](ops/cloudflare-demo.md) | Maintainers | Public `omc.junze.dev` site and `omc-demo.junze.dev` Worker architecture |
| [`zh/`](zh/README.md) | Operators (简体中文) | Simplified Chinese translations of the published operator and integration guides |
| [`dev/`](dev/architecture.md) | Contributors & maintainers | [`architecture.md`](dev/architecture.md), [`design.md`](dev/design.md), [`testing.md`](dev/testing.md), and [`releasing.md`](dev/releasing.md) |
| [`releases/`](releases/README.md) | Operators & maintainers | Version release and upgrade notes |
| [`openapi/swagger.json`](openapi/swagger.json) | Integrators | Generated Swagger 2.0 specification rendered at `/api-reference/` |

## Single-source sync workflow

The public documentation site under `deploy/site/docs/` does not store duplicate copies
of prose in Git. Instead, `scripts/sync-docs-site.mjs` (invoked automatically by
`pnpm build:docs` and `pnpm build:site`) projects canonical Markdown files into
`deploy/site/docs/content/docs/`:

- Edit English guides in `docs/` (plus [`README.md`](../README.md) and [`CONTEXT.md`](../CONTEXT.md)) and Chinese equivalents in [`README.zh-CN.md`](../README.zh-CN.md) and `docs/zh/`.
- Do not hand-edit generated `.mdx` files inside `deploy/site/docs/content/docs/`—they are ignored by Git and regenerated deterministically from the canonical sources above.
- Run `pnpm check-docs` to verify offline Markdown links and anchor fragments across the repository.
