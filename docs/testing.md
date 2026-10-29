# Testing a change

Use the lowest layer that detects the real failure. Prefer extending an existing
case; a second layer needs a different claim, not another spelling of the same
assertion. Keep security, data integrity and shipped-artifact checks hard.

## Choose an entry point

| Work | Command |
| --- | --- |
| Routine edit, before pushing | `pnpm test:fast` (`--plan` explains selection; `--base <ref>` includes committed changes) |
| Frontend behavior while editing | `pnpm test:frontend`, or `pnpm exec vitest related --run --config web/vitest.config.ts <source>` |
| Layout, focus, navigation, scrolling or browser lifecycle | `pnpm check:ui` (`--plan` previews the affected scenarios) |
| Build, embedding, browser infrastructure or CI changes | `pnpm verify:full` |
| A failing CI lane | Run that lane first; do not repeat passing, unchanged checks |

`pnpm test:fast` never builds the product or launches a browser. It selects static
checks and Go packages with reverse dependants. Vitest owns frontend module
resolution and related-test discovery. CSS-only edits run the logic suite, which
owns stylesheet-derived contrast values, not jsdom layout claims. Setup, unknown assets,
dependencies, deleted files and infrastructure changes widen to the complete suite. Unknown inputs widen
rather than silently skipping verification. The planner prints its commands.

## Test ownership

| Claim | Owner | Location |
| --- | --- | --- |
| Server behavior, auth, safe DTOs, migrations, persistence, CPA writes and backups | Go | `*_test.go` beside the package |
| Complete parser/projection output | Go golden cases | `internal/<package>/testdata/golden/` |
| Pure frontend derivation, formatting, validation and state transitions | Vitest `logic`, Node environment | `scripts/test-*.ts` |
| Rendered React wiring and typed HTTP contracts | Vitest `components`, jsdom environment | `web/tests/**/*.component.test.tsx`, `web/tests/**/*.contract.test.ts` |
| Browser-engine behavior: geometry, hit testing, focus, scrolling, navigation, touch and paint | Playwright probes | `scripts/acceptance/probes/`, registered in `scripts/acceptance/scenarios.mjs` |
| Embedded SPA, Go binary, SQLite and fake CPA together | Built-artifact acceptance | `scripts/browser-acceptance.mjs` |
| Public demonstration and route refusal | Worker tests and demo acceptance | `deploy/cloudflare/*.test.mjs`, `scripts/demo-readiness.mjs` |
| Shipped repository outputs: archives, signing, deployment and asset synchronization | Node test runner | `scripts/*.test.mjs` |

`pnpm test:frontend` runs both Vitest projects. `test:logic` and `test:components`
select one project; `test:self` runs the repository and Worker suites, including
the deployment health probe, and requires a POSIX shell. Test files
remain isolated. Bound worker pools rather than multiplying workers at every
nested runner. A jsdom render and a Chromium frame measurement should not compete
with a compilation on a small machine.

For a regression, show that the relevant case fails with the fix removed, then
restore the fix and rerun that case. Preserve the failure evidence in the commit
or PR. Do not test prose, translations, CSS spellings, workflow shape, or the test
runner itself. Never repair a failure with retries, fixed sleeps, longer waits or
skip switches.

### Golden data and contracts

Use `internal/testkit` for whole-output golden comparisons. Regenerate only the
owning package with `UPDATE_GOLDEN=1 go test ./<package>` and review the diff.
Shared HTTP corpora under `scripts/acceptance/contracts/` connect handler responses
to the typed client without launching a browser. The public demo dataset is
separately generated from real handlers: run `pnpm demo:generate` when response
shapes change; `TestExportDemoDataset` owns freshness and `pnpm check:demo` owns
route coverage and privacy.

### Browser checks

`pnpm check:ui` uses the development server with mocked APIs. Its import/route
ownership planner selects scenarios; global frontend changes run the catalog.
Locale-only and component-test-only edits do not need a browser. Use `--list` to
browse scenarios and `pnpm check:ui --scenario <id>` to reproduce one.
Playwright owns workers, sharding, contexts and server readiness. `--shard i/n`
works with both `check:ui` and `verify:probes`; empty native shards need no server. Probe processes
own their server and output directories; an existing development server is not a
test fixture. Each test installs its own routes, preferences and fault ledger.

Browser failures retain diagnostics under `tmp/probe-failure/` and
`tmp/browser-acceptance-failure/`. Inspect the failing assertion, DOM/screenshot,
network and browser-fault evidence before changing a wait. Observe the state that
makes an interaction ready, not elapsed time or a text fragment from an earlier UI.

A development-server pass does not prove packaging, production chunks, root/base
path resolution, offline assets or secret safety. `pnpm verify:browser` exercises
the real built binary and fake CPA; `:smoke` is the smaller PR path.
`pnpm verify:demo` exercises the packaged public demonstration. Run the complete
`verify:full` serial variant on resource-constrained machines rather than starting
multiple full gates together.

## CI and releases

The workflows are the executable source of truth; do not duplicate their job DAG
in documentation.

- **Pull requests:** affected language lanes, repository/security checks,
  built-artifact smoke when code is affected, and affected browser probes.
- **Main, nightly, manual, or a PR labelled `full-ci`:** full static suites,
  built-artifact acceptance, demo acceptance and the complete probe catalog.
- **Weekly/manual maintenance:** race detection, bounded fuzzing, dependency
  advisories and host-native runtime checks.
- **Release:** complete verification before packaging and publication, immutable
  version identity, signed manifests, image/runtime smoke and promotion gates.
  See [Releasing](releasing.md).

Required aggregates reject failure, cancellation and an unexpectedly skipped
selected lane. Superseded PR runs may be cancelled; main revisions retain their
own results. No automatic test reruns hide failures. Go CI emits gotestsum
JUnit/test2json artifacts, and native Actions job timings include setup/cache
costs. Timings are diagnostic evidence, not a machine-load-dependent pass/fail
budget. Compare cohorts with the same event, verification scope and cache state;
one successful PR is not a new P50/P90 or a flakiness rate.

## Tooling

`package.json`, `go.mod` and `scripts/tools-versions.json` hold tool/dependency
pins. JavaScript installation uses `pnpm install --frozen-lockfile`; install the
matching Playwright Chromium with `node scripts/install-chromium.mjs` before
browser checks. `pnpm verify:toolchain:strict` checks the reproducible toolchain.

`pnpm check-docs` automatically downloads the pinned **lychee** binary for Linux,
macOS or Windows on first use, verifies its SHA-256 and caches it under `.tools/`.
No global installation or Rust toolchain is needed. The first download needs network
access; subsequent runs work offline. A preinstalled binary can be selected with
`LYCHEE_BIN`; it must match the pinned version in `scripts/tools-versions.json`.
Local checks and CI use this same entry point. Checks are offline, include local
fragments and read `lychee.toml`; GitHub image-theme selectors are the only
rendering-specific exclusion. The checker does not interpret arbitrary backticked
prose as file paths or carry a retired-document inventory.

`pnpm verify:workflow:lint` uses actionlint 1.7.12 plus the repository's small
supply-chain policy for pinned Actions, token-free checkouts and signing-key
isolation. `pnpm lint:go` uses golangci-lint v2.15.0. Secret/history scans, signature
verification and release checks remain required. CSS reference checks, i18n
checks and generated OpenUI-prompt checks catch concrete broken references;
visual intent lives in [Design](design.md) and its source tokens, not a second
catalog of CSS spellings.
