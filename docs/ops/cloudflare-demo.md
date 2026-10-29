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

## Keep the dataset current

When a console read or response shape changes:

```bash
pnpm demo:generate
pnpm check:demo
```

Review and commit the generated diff with the code change. The owning Go export test
compares handler output with that dataset; use [Testing](../testing.md) for the
appropriate validation scope. A new supported read needs an export case and Worker
routing, not a special frontend that only works in the demo.

Exports use closed, fixed windows and pinned synthetic runtime facts. Repeated export
of unchanged code should be byte-identical. Do not commit changing wall-clock values,
heap sizes, ephemeral ports or host toolchain facts. A timestamp-only difference is
usually a determinism defect, not a reason to regenerate until CI passes.

The Worker moves real instants relative to the export reference while keeping zero
(`never`) unset and retaining durations. Local-day boundaries follow the dataset's
reported time zone; epoch-aligned buckets retain their meaning. Simulated live traffic
and the annual activity grid remain synthetic rather than evidence of a running CPA.

Agent and Playground examples are local recordings under `web/src/demo`, rendered
through the normal stream/reducer contracts. Only the offered example is replayable;
no model call is sent. Agent snapshots exclude private model history, queued calls and
raw database-query results. Reload/reset clears browser-local conversation replay.
Keep recordings covered by the demo privacy check when changing them.

## Build and verify

```bash
pnpm build
pnpm check:demo
pnpm build:demo
pnpm exec wrangler deploy --config deploy/cloudflare/wrangler.jsonc --dry-run
```

`build:demo` stages an already-built SPA; it does not build one. A fresh checkout has
no embedded production assets. Cloudflare needs Node and the committed dataset, not
Go, a browser or a database. Toolchain pins and build memory settings belong to the
repository configuration rather than duplicated Cloudflare variables.

For a deployed smoke check, use `OMCPA_DEMO_URL` with `pnpm verify:demo`. Local built
acceptance and its setup are described in [Testing](../testing.md). Check refusal,
privacy, route rendering and both conversation examples, not just an HTTP 200.

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
  Cloudflare's zone-level injection settings separately from the bundled SPA. A hosting
  feature does not justify an external asset dependency in self-hosted OMC.
