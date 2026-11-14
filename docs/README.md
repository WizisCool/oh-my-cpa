# Oh My CPA Documentation

This directory holds the repository's canonical technical, operational, and release
documentation. Curated operator and integration guides, together with the Simplified
Chinese translations in [`docs/zh/`](zh/README.md), are compiled into the bilingual
Fumadocs documentation site published at `https://omc.junze.dev/docs/`.

## Directory layout

Operator guides run from simple to advanced, and the docs site keeps the same order.

| Path | Audience | Purpose |
| --- | --- | --- |
| [`quickstart.md`](quickstart.md), [`install-for-agents.md`](install-for-agents.md), [`how-it-works.md`](how-it-works.md) | New operators & coding agents | First install and the model behind it |
| [`install.md`](install.md) and [`install/`](install/standalone.md) | Operators | Install paths, remote access, upgrades and troubleshooting |
| [`operations.md`](operations.md), [`operate/`](operate/ports-storage.md) and [`ops/sqlite-operations.md`](ops/sqlite-operations.md) | Operators & system administrators | Ports, storage, updates, backup and restore, keys and time zone |
| [`features/`](features/agent.md), [`pricing.md`](pricing.md) | Operators | Agent and MCP, routing, quota, pricing, playground, plugins and display |
| [`reference/environment.md`](reference/environment.md), [`cpa-v8-compat.md`](cpa-v8-compat.md), [`agent-capabilities.md`](agent-capabilities.md) | Operators & integrators | Every setting, the CLIProxyAPI v8 contract and the capability registry |
| [`ops/cloudflare-demo.md`](ops/cloudflare-demo.md) | Maintainers | Public `omc.junze.dev` site and `omc-demo.junze.dev` Worker architecture |
| [`zh/`](zh/README.md) | Operators (简体中文) | Simplified Chinese translations of the published operator guides |
| [`dev/`](dev/architecture.md) | Contributors & maintainers | [`architecture.md`](dev/architecture.md), [`design.md`](dev/design.md), [`testing.md`](dev/testing.md), and [`releasing.md`](dev/releasing.md) |
| [`releases/`](releases/README.md) | Operators & maintainers | Version release and upgrade notes |
| [`openapi/swagger.json`](openapi/swagger.json) | Integrators | Generated Swagger 2.0 specification rendered at `/api-reference/` |

## Single-source sync workflow

The public documentation site under `deploy/site/docs/` does not store duplicate copies
of prose in Git. Instead, `scripts/sync-docs-site.mjs` (invoked automatically by
`pnpm build:docs` and `pnpm build:site`) projects canonical Markdown files into
`deploy/site/docs/content/docs/`, plus a Markdown copy of every page and `llms.txt` for
agents:

- Edit English guides in `docs/` (plus [`CONTEXT.md`](../CONTEXT.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md)) and Chinese equivalents in `docs/zh/`. `DOCS_SECTIONS` in the sync script owns the site's navigation, titles and descriptions.
- Do not hand-edit generated `.mdx` files inside `deploy/site/docs/content/docs/`—they are ignored by Git and regenerated deterministically from the canonical sources above.
- Run `pnpm check-docs` to verify offline Markdown links and anchor fragments across the repository.
