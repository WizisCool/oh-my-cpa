# Public demonstration

The public demo serves the production SPA through Cloudflare Static Assets and a
Worker answering from generated synthetic data. It has no live CPA gateway, database,
usage collector or production authentication. It demonstrates the console, not a
hosted instance of the service.

## Source and boundaries

[`deploy/cloudflare`](../../deploy/cloudflare) owns the Worker, route matching, filters,
time rebasing and simulated live-routing traffic.
[`wrangler.jsonc`](../../deploy/cloudflare/wrangler.jsonc) configures the custom domain,
static assets and `/api` Worker dispatch. `workers_dev` remains off: account-derived
hostnames must not publish the operator's identity.

The data in [`deploy/cloudflare/data`](../../deploy/cloudflare/data) is exported from
the real Go handlers over the demo fixture. It must pass through the same DTO
projections as self-hosted OMC. Do not hand-author an alternative response shape or
use real credentials, client addresses, account labels or request recordings.

Unknown reads, writes and outbound operations are refused. Plugin-host management,
model-directory forwarding and credential warmup execution remain disabled. UI affordances
can explain a refusal but cannot be the security boundary. Local theme changes and
curated conversation replay do not write to the shared Worker.

## Generated dataset in CI and builds

`deploy/cloudflare/data/responses.json` is gitignored and generated on demand rather than committed to git history. Running any demo check, test, or build script (`pnpm demo:generate`, `pnpm check:demo`, `pnpm build:demo`, `pnpm test:self`, `pnpm dev:demo`) exports the dataset from the real Go handlers (`TestExportDemoDataset` in `internal/api/demo_export_test.go`) whenever it is missing (bootstrapping the pinned Go SDK from `scripts/tools-versions.json` automatically in Node-only environments such as Cloudflare Workers Builds).

A new supported read needs an export case in `internal/api/demo_export_test.go` and Worker routing in `deploy/cloudflare/`, not a special frontend that only works in the demo.

Exports use closed, fixed windows and pinned synthetic runtime facts. Repeated export of unchanged code should be byte-identical. Do not emit changing wall-clock values, heap sizes, ephemeral ports or host toolchain facts. A timestamp-only difference is usually a determinism defect.

The Worker moves real instants relative to the export reference while keeping zero (`never`) unset and retaining durations. Local-day boundaries follow the dataset's reported time zone; epoch-aligned buckets retain their meaning. Simulated live traffic and the annual activity grid remain synthetic rather than evidence of a running CPA.

Agent and Playground examples are local recordings under `web/src/demo`, rendered through the normal stream/reducer contracts. Only the offered example is replayable; no model call is sent. Agent snapshots exclude private model history, queued calls and raw database-query results. Browser-local sandbox mutations (`omc-demo-sandbox:v1`) persist across reloads in `localStorage` without writing to the shared Worker, and can be reset from the header badge. Keep recordings covered by the demo privacy check when changing them.

## Build and verify

```bash
pnpm build
pnpm check:demo
pnpm build:demo
pnpm exec wrangler deploy --config deploy/cloudflare/wrangler.jsonc --dry-run
```

`build:demo` stages an already-built SPA and ensures `deploy/cloudflare/data/responses.json` is generated; it does not build the SPA itself. A fresh checkout has no embedded production assets. If `go` is absent from `PATH` (for example on Cloudflare Workers Builds), `scripts/generate-demo-data.mjs` downloads and verifies the Go toolchain pinned in `scripts/tools-versions.json`.

`pnpm check:demo` and `pnpm test:self` verify dataset privacy, schema coverage, refusal rules, and Worker route matching; `ci.yml` also verifies `pnpm build:demo` and `wrangler deploy --dry-run` whenever browser-facing or API code changes. Local built-artifact browser acceptance and its setup are described in [Testing](../dev/testing.md).

## Deploy

The configured production domain is `omc-demo.junze.dev`. Workers Builds connects to
this repository's `main` branch and deploys on push; Cloudflare manages the build token,
so no long-lived deployment secret belongs in GitHub or this repository.

One-time setup in Cloudflare:

1. Grant the GitHub integration access to this repository and connect Worker
   `oh-my-cpa-demo` to production branch `main`.
2. Disable preview builds. If the form requires a preview command, use an explanatory
   no-op such as `echo "Preview builds disabled"`; do not enable account-derived URLs.
3. Set the build command to `pnpm build && pnpm check:demo && pnpm build:demo`.
4. Set the deploy command to
   `pnpm exec wrangler deploy --config deploy/cloudflare/wrangler.jsonc`.

The build service installs dependencies from the repository package-manager pin.
Keep custom-domain and asset/API routing declarations in `wrangler.jsonc` so a new
checkout reproduces the intended publication surface.

Rollback restores the Worker and static assets together using Cloudflare's retained
versions. Revert the corresponding source change on `main` as well, otherwise the
next push deploys it again. There is no demonstration database to restore.

## Public site, `/docs`, `/api-reference`, and `/demo` (`deploy/site`)

[`deploy/site`](../../deploy/site) mounts the replaceable root entrypoint (`deploy/site/landing/`), `/docs/` (bilingual EN/ZH Fumadocs static export), `/api-reference/` (self-hosted Scalar UI), and `/demo/` together for `omc.junze.dev`:

- `pnpm build:api-reference`: Stages the standalone, self-hosted Scalar UI (`index.html`, content-hashed `scalar.<hash>.js`, `swagger.json`, and `favicon.svg`) to `tmp/api-reference` (or `--out <dir>`) with zero Cloudflare or landing-page coupling, so any landing framework or static server can embed `/api-reference/`.
- `pnpm build:docs`: Runs `scripts/sync-docs-site.mjs` to sync curated English and Chinese documentation plus `README.md` / `README.zh-CN.md` into `deploy/site/docs/content/docs/`, then builds the static Next.js Fumadocs export to `deploy/site/docs/out/`.
- `pnpm build:site`: Syncs and builds `/docs/` (unless `--from-built-docs` or `--skip-docs`), ensures the demo dataset, and composes `deploy/site/landing/` (or `--landing-dir <dir>`), `_headers`, `/docs/`, `/api-reference/`, and `/demo/` (from the built SPA with `basePath: '/demo'`, or skip with `--skip-demo`) into `tmp/site/dist`.
- `deploy/site/worker.mjs` and `deploy/site/wrangler.jsonc`: Mount the shared `deploy/cloudflare/worker.mjs` demo handler under `/demo` (`run_worker_first: ["/demo", "/demo/*"]`) for `omc.junze.dev` (`workers_dev: false`, `not_found_handling: "none"`). Workers Builds connects `oh-my-cpa-site` to `main` with preview builds disabled, build command `pnpm build && pnpm check:demo && pnpm build:site`, and deploy command `pnpm exec wrangler deploy --config deploy/site/wrangler.jsonc`.

## Troubleshooting

- **A panel is empty:** inspect its Worker route and generated response. Extend the
  real export case and regenerate rather than inventing data in the browser.
- **Dates are stale or future-dated:** check instant rebasing and synthetic runtime
  normalization. Do not shift durations or an unset timestamp.
- **The export differs after a merge:** review whether the handler changed or a new
  field escaped normalization before committing a replacement dataset.
- **No built console:** run `pnpm build` before staging the demo.
- **The local Worker fails before serving:** check dependency installation and local
  ignored `.wrangler` state; do not change product behavior to repair a local runtime.
- **An unexpected analytics script appears only on the public site:** inspect
  Cloudflare's zone-level injection settings separately from the bundled SPA.
