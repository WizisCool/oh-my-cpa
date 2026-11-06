# Testing a change

Use the lowest layer that detects the real failure. Prefer extending an existing
test file over creating a new suite; a higher layer requires a distinct integration
claim, not another spelling of the same assertion. Keep security, data integrity
and shipped-artifact checks strict.

## Choose an entry point

| Work | Command |
| --- | --- |
| Routine edit, fast feedback | `pnpm test:fast` (`pnpm type-check && pnpm test:logic && go test -short ./...`) |
| Frontend behavior while editing | `pnpm test:frontend`, or `pnpm exec vitest run --config web/vitest.config.ts <file>` |
| Full local static + build check | `pnpm verify` (`pnpm test:fast && pnpm test:components && pnpm verify:build`) |
| Embedded SPA + Go binary browser smoke | `pnpm verify:browser:smoke` (or `pnpm verify:browser` for the full suite) |
| Complete pre-release / CI gate | `pnpm verify:full` |
| A failing CI lane | Run that lane first; do not repeat passing, unchanged checks |

`pnpm test:fast` never builds the product or launches a browser. It runs TypeScript type checking across `web/` and `scripts/`, the Node-based Vitest `logic` suite (`~1.2s`), and `go test -short ./...`.

## Test pyramid & ownership

| Layer | Owner | Location | Scope & Rules |
| --- | --- | --- | --- |
| **1a. Backend unit & integration** | Go (`go test`) | `internal/**_test.go` | Server behavior, auth, safe DTOs, SQLite migrations/persistence, CPA writes and backups. Fresh SQLite databases use the cached post-migration bootstrap snapshot in `internal/repository` so `Open()` takes ~1.5 ms. |
| **1b. Golden output contracts** | Go (`internal/testkit`) | `internal/<pkg>/testdata/golden/` | Complete parser or projection output. Update with `UPDATE_GOLDEN=1 go test ./<pkg>` and review the diff. |
| **1c. Frontend logic & HTTP contracts** | Vitest `logic` (Node, `isolate: false`) | `web/tests/logic/*.test.ts`, `web/tests/*.contract.test.ts` | Pure frontend derivations, state machines, formatting, validation, and shared HTTP contract fixtures (`scripts/acceptance/contracts/`). Runs in ~1–2s total. |
| **2. Interactive component tests** | Vitest `components` (jsdom, `isolate: false`) | `web/tests/*.component.test.tsx` | Stateful React + Ant Design workflows (draft protection, optimistic rollback, multi-step dialogs, keyboard focus). `renderWithOmc` disables Ant Design CSS motion timers (`motion: false`) for deterministic speed. |
| **3a. Built-artifact browser acceptance** | Node + Playwright | `scripts/browser-acceptance.mjs` | Exercises the real compiled Go binary, embedded SPA, SQLite, and fake CPA (`pnpm verify:browser:smoke` on PRs; `pnpm verify:browser` on `main`/release). |
| **3b. Public demo & packaging** | Node test runner | `deploy/cloudflare/*.test.mjs`, `scripts/*.test.mjs` | Cloudflare Worker routes/filters, demo privacy/readiness (`pnpm check:demo`), release archive packaging, manifest signing, and Compose topology. |

### Anti-bloat rules

1. **No mocked dev-server browser probes**: Do not create Playwright tests against a mocked Vite dev server to test component states, CSS geometry, or static UI copy. Browser runs (`verify:browser:smoke` / `verify:browser`) exist strictly to verify that the compiled Go binary, embedded production SPA, SQLite database, and CPA integration work together.
2. **Consolidate pure logic tests**: Add cases to the existing domain test file under `web/tests/logic/*.test.ts` or `web/tests/*.contract.test.ts` instead of creating a new test file for a single helper function.
3. **Keep jsdom tests focused on stateful interaction**: Do not mount full pages or Ant Design trees in jsdom just to assert static badge labels, prop forwarding, or translation strings. Test pure view-model derivations in `logic` (Node).
4. **Shared environment discipline (`isolate: false`)**: Both Vitest projects run with `isolate: false` so modules and the jsdom window are reused across files in each worker. `web/tests/setup.ts` cleans up React trees, query clients, timers, storage, and mocked API handlers in `afterEach`. Do not mutate module-level singletons without restoring them in `afterEach`.
5. **Deterministic assertions**: For a bug fix, verify the regression test fails without the fix before restoring the fix. Never paper over timing or state leaks with retries, fixed sleeps, or longer timeouts.

## Golden data and demo dataset

- **Go golden files**: Regenerate only the owning package with `UPDATE_GOLDEN=1 go test ./<package>`.
- **Cloudflare demo dataset**: Generated from real Go handlers over the deterministic demo fixture. When console read DTOs change, run `pnpm demo:generate && pnpm check:demo`. `TestExportDemoDataset` (`internal/api/demo_export_test.go`) verifies both byte-for-byte dataset freshness and dashboard health parity in a single pass.

## Browser acceptance diagnostics

`pnpm verify:browser:smoke` and `pnpm verify:browser` compile the production SPA and Go
binary, start the server against a fake CPA instance, and run Chromium checks (`OMCPA_BROWSER_BINARY` can be set to reuse an already-compiled Go binary). Failures
retain diagnostics under `tmp/browser-acceptance-failure/`.

## CI and releases

The GitHub Actions workflows (`.github/workflows/ci.yml` and `.github/workflows/release.yml`)
are the executable source of truth:

- **Pull requests**: Path-filtered lanes (`go`, `frontend`, `static`, `browser`) run only when relevant files change, with built-artifact `browser` smoke (`pnpm verify:browser:smoke`) when application code is affected.
- **Main, nightly, manual, or `full-ci` label**: Full static and unit suites plus full built-artifact browser acceptance (`pnpm verify:browser`).
- **Weekly/manual maintenance**: Go race detector, bounded fuzzing, dependency advisories, and host-native runtime checks.
- **Release**: Complete static and browser verification before packaging, immutable tag/commit identity, Ed25519-signed manifests, container/native smoke tests, and promotion gates. See [Releasing](releasing.md).

## Tooling

`package.json`, `go.mod` and `scripts/tools-versions.json` hold tool and dependency pins:

- **Dependencies**: `pnpm install --frozen-lockfile`
- **Chromium**: `node scripts/install-chromium.mjs`
- **Docs link & fragment checker**: `pnpm check-docs` (automatically fetches and caches the pinned `lychee` binary under `.tools/` and runs offline against `*.md`, `docs/**/*.md`, and `web/src/i18n/*.md`)
- **Workflow lint**: `pnpm verify:workflow:lint` (`actionlint` + supply-chain policy)
- **Go lint**: `pnpm lint:go` (`golangci-lint`)
