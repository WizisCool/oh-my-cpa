# Testing a change

This is the working guide for writing and running tests in this repository. It says
where a new test belongs, what to run while developing, and what a change must pass
before it is pushed. `docs/architecture.md` §12 explains why the layers are split the
way they are; `docs/adr/0032-ci-owns-the-full-browser-catalog.md` records the decision
behind the verification moments.

The goal is short feedback with the same or stronger failure detection. A new test that
is slow, sleeps, or duplicates a claim another layer already makes is a cost every later
change pays. Keep to the rules below instead of inventing a new runner, a new gate or a
new registration list.

## 1. Where a new test belongs

Put each claim in the **lowest layer that can make it fail for the reason its name
gives**. Move a claim up a layer only when the lower one cannot observe it.

| The claim is about | Layer | Where | Runs in |
| --- | --- | --- | --- |
| Server behaviour: handlers, DTO allowlists, redaction, auth, repository queries, migrations, write serialisation, background loops | Go test | `*_test.go` beside the package | `go test ./...` |
| A frontend decision that is a pure function: URL/state derivation, formatting, poll and debounce policy, sorting, validation | Logic suite (`node:test`) | `scripts/test-<topic>.ts`, importing from `web/src` | `pnpm test:logic` |
| Something only a real browser engine shows: geometry, stacking, hit-testing, scroll, focus, Back, touch, paint, request ordering under a held response, StrictMode double invocation | Probe scenario | a module under `scripts/acceptance/probes/` plus an entry in `scripts/acceptance/scenarios.mjs` | `pnpm check:ui`, CI `probes` |
| The built binary, embedded SPA, fake CPA and seeded SQLite together: sign-in, route rendering, secret boundaries, cross-stack writes | Cross-stack acceptance | the domain module under `scripts/acceptance/` | `pnpm verify:browser` (P0 subset on pull requests) |
| The public demonstration | Demo acceptance | route table in `scripts/demo-readiness.mjs` | `pnpm verify:demo` |
| The Go binary's own demonstration mode: isolated settings, read-only refusals, permitted non-durable edits | Go demo smoke | `scripts/demo-smoke.mjs` | `pnpm verify:demo:go` (opt-in; not part of CI or `verify:full`) |
| A repository script or gate itself | Script self-test (`node:test`) | `scripts/<name>.test.mjs` or `deploy/cloudflare/*.test.mjs` | `pnpm test:self` |

Rules that keep the suite fast and honest:

- **Default to Go or a logic suite.** Most feature logic is a function of its inputs.
  Extract it from the component and test it directly; the browser then needs one
  representative check that the page wires it up, not one per permutation.
- **One owner per claim.** Before adding a browser check, search for an existing one
  that already asserts it. Extend that scenario instead of adding a near-duplicate.
- **No fixed waits.** Wait on something observable: a response (`page.waitForResponse`,
  a route you hold and release), an element state, `until(...)` from
  `scripts/acceptance/harness.mjs`, a Go channel, or an injected interval or clock.
  `scripts/fixed-waits.test.mjs` fails when a fixed wait is added.
- **Make time injectable in Go.** A duration a test has to wait out belongs in the
  component's config with a production default, as `ingest.Config.ReadinessGrace` is,
  so the test can set it to milliseconds.
- **Every new check must fail against a broken implementation.** Break the code on
  purpose, watch the test fail, then restore it. A check that cannot fail is removed,
  not kept for coverage.
- **Test behaviour, not spelling.** Do not assert that a source file contains a
  string. Inject the side effects and assert the decision, as
  `scripts/install-chromium.test.mjs` does.
- **Keep the fixtures hermetic.** Browser fixtures build their environment with
  `scripts/acceptance/environment.mjs`; never read the operator's `.env`, network or
  data directory. Calendar fixtures must use the console's configured timezone rather
  than the host timezone; the dashboard heatmap fixtures use the default UTC calendar,
  with a script self-test spanning hosts on opposite sides of a UTC date boundary.

## 2. Registering a new test

Discovery is automatic wherever it can be, so a test cannot be written and then never
run:

| Test | Registration |
| --- | --- |
| Go test | none |
| Logic suite `scripts/test-*.ts` | none: `scripts/test-logic.mjs` discovers the files |
| Script self-test `*.test.mjs` | none: `scripts/test-self.mjs` discovers them |
| Probe scenario | an entry in `scripts/acceptance/scenarios.mjs` (unique `id`). Optionally its measured seconds in `PROBE_WEIGHTS` in `scripts/acceptance/probe-shards.mjs`, which only affects shard balance |
| New console page | a rule in `SCENARIO_PATHS` in `scripts/acceptance/check-ui-plan.mjs` naming the scenarios that load its route, or `scenarios: []` if none does. `scripts/ui-impact.test.mjs` fails until the rule exists |
| New console read or response shape | `pnpm demo:generate` (pins `TZ=UTC` for deterministic deployment metadata), review the diff, commit the dataset (see `docs/ops/cloudflare-demo.md`) |

## 3. What to run, and when

| Moment | Command | What it does |
| --- | --- | --- |
| While editing | `pnpm test:fast` | Only the static checks the changed files need; the frontend type check is incremental. `--plan` prints the selection, `--base <ref>` includes committed changes |
| While editing UI | `pnpm check:ui` | Only the probe scenarios the change can reach, on the dev server. `--plan` explains the selection; `--scenario <id>` runs one |
| A feature is complete, and before pushing | `pnpm verify` and `pnpm check:ui` | The full static gates, the worktree secret scan and the affected browser scenarios |
| Pull request (CI) | automatic | Static gates, secret scans, build and bundle budgets, the P0 cross-stack acceptance, the **whole** probe catalog in three shards, and the demo acceptance |
| Optional locally | `pnpm verify:full` | Everything CI runs, in one local command. Use it for changes to the build, the browser harness or the workflow, or to reproduce a CI failure |
| Opt-in | `pnpm verify:demo:go` | The Go binary's own demo mode: a browser against a locally started binary with its own route assertions. It generates the dataset, so it is not part of CI |

How `check:ui` chooses scenarios (`scripts/acceptance/check-ui-plan.mjs`):

- A path rule names the scenarios for a page or component directory.
- Any other `web/src` file is followed through the **runtime** import graph
  (`scripts/acceptance/ui-impact.mjs`) to the pages that import it. Imports used only
  as types are not edges, so a pure type change selects nothing and is covered by the
  type check.
- Reaching the shared layer (`web/index.html`, `App.tsx`'s shell, `components/common/`,
  the theme, the API client, the global stylesheet) selects every scenario, as does a
  routed page with no rule, an unresolved import, a dependency or Vite change, or an
  asset the graph cannot see.
- A translation catalog edit that only adds entries selects nothing; changing or
  removing existing copy selects every scenario.
- A probe module or registry edit selects the scenarios that use it
  (`scripts/acceptance/probe-impact.mjs`); an edit to the probe runner selects all.

Never add a skip switch or narrow a planner rule to make a slow run go away. If the
selection is wider than the change warrants, add a path rule or a scenario mapping,
with a test in `scripts/ui-impact.test.mjs` or `scripts/check-ui-plan.test.mjs`.

Agent/Playground recovery assertions belong at the lowest boundary that owns the behaviour:
channel-driven facade tests for execution lifetime and replay, injectable transport logic tests
for connection failures, and the existing `agent-live` / `playground` probes for actual browser
reload and rendering. Live elapsed labels are independent external-store consumers: their clock
and hidden-tab suspension are logic tests, while the Agent probe checks visible tenths and the
light Stop border. Stream-coalescing probes exclude only elapsed-label mutations, not answer
mutations, because the clock does not publish through the transcript's run hook.

### Feedback regressions

- `scripts/check-feedback.test.mjs` checks Ant Design modal bindings and aliases, scope shadowing,
  false positives in comments and strings, legal confirmations, diagnostic locations and the
  feedback module exemption. It is automatically discovered by the repository self-test runner.
- The `oauth-management` browser scenario checks that ordinary copy acknowledgements cannot evict
  a persistent quota report, another refresh replaces it, and its close action removes it. It also
  checks one credential-aware authorization toast for a unique new credential, an ambiguous result
  and a failed credential-list refresh, including the action that reveals the provider collection.
  Cross-stack OAuth acceptance dismisses the completion toast before exercising drawer reopening,
  so the notification cannot cover the close action or consume the bounded success-state window.
- The `agent-failure` scenario retries a failed capability-directory read without losing the
  composer draft, then checks the refused-message retry and the accepted-run failure surfaces.

## 4. When CI fails

- Probe shards upload `tmp/probe-failure/`: for every failed scenario, whether a check
  failed or it threw, a screenshot, the DOM, the URL, page errors, and the page's console
  warnings and navigations. A scenario that threw also prints the last of those in the job
  log. Reproduce with `pnpm check:ui --scenario <id>`.
- Cross-stack acceptance uploads `tmp/browser-acceptance-failure/`. Reproduce with
  `pnpm build` and `pnpm verify:browser` (or `verify:browser:p0`).
- Rerun only the failed command. A failure that passes on rerun is a flake to fix at
  its assertion, never a reason to add a retry or lengthen a wait.
