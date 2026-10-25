# Testing a change

The rules for what to test are in `AGENTS.md` §5. This document says where each kind of
test lives, how to add one, what CI runs when, and how to reproduce a failure.

## Layers

Put a claim in the lowest layer that can fail for the reason the test's name gives. One
claim has one owner; a second test of the same claim in another layer is a cost every later
change pays.

| The claim is about | Layer | Where | Runs with |
| --- | --- | --- | --- |
| Server behaviour: handlers, DTO allowlists, redaction, auth, repository queries, migrations, write serialisation, background loops | Go test | `*_test.go` beside the package | `go test ./...` |
| What a parser or projection produces from an upstream payload | Go golden cases | `internal/<pkg>/testdata/golden/<name>/` | `go test ./...` |
| A pure frontend function: URL/state derivation, formatting, sorting, validation | Logic suite | `scripts/test-<topic>.ts`, importing from `web/src` | `pnpm test:logic` |
| Rendered React wiring and the typed API client | Component and contract tests (Vitest + jsdom) | `web/tests/**/*.component.test.tsx`, `web/tests/**/*.contract.test.ts` | `pnpm test:components` |
| What only a browser engine shows: geometry, stacking, hit-testing, scroll, focus, Back, touch, paint | Probe scenario | a module under `scripts/acceptance/probes/`, registered in `scripts/acceptance/scenarios.mjs` | `pnpm check:ui`, CI |
| The built binary, embedded SPA, fake CPA and seeded SQLite together | Built-artifact acceptance | `scripts/browser-acceptance.mjs` and the steps it runs from `scripts/acceptance/` | `pnpm verify:browser` (`:smoke` on pull requests) |
| The public demonstration | Demo acceptance | `scripts/demo-readiness.mjs` | `pnpm verify:demo` |
| A repository script whose output ships: release planning, signing, the Worker, the embedded distribution | Script test | `scripts/*.test.mjs`, `deploy/cloudflare/*.test.mjs` | `pnpm test:self` |

Discovery is automatic except the probe catalog itself. A new scenario belongs in
`scripts/acceptance/scenarios.mjs`; no second path-prefix list or shard-weight registration is
needed. `scripts/affected-files.mjs` follows TypeScript-parsed imports (including literal dynamic
imports and URL assets). The UI planner reads route declarations and each probe's imports and
navigation literals, so shared components reach their actual pages. Unresolved ownership widens
the selection and prints why. Shared common-component changes run recovery, settings and phone representatives;
global runtime, API-client and authentication changes keep the complete catalog;
the full catalog remains mandatory on `main`, nightly, manual and `full-ci` runs. Locale data
and rendered-test changes alone select no browser: types/i18n and their owning test layer check
them. An unfamiliar frontend path selects every scenario rather than silently selecting none.

`pnpm test:fast --plan` lists actual suite commands. Local frontend changes select only logic
and rendered suites that import them; test setup changes reach all rendered suites. Go source
changes select their package and reverse dependants through `go list`, while a Go test change
selects its own package. Global inputs or an unresolved package graph retain the full static
fallback. `pnpm test:frontend:affected` is the frontend-only CI entrypoint (its `BASE` environment
variable names the comparison revision); Go and repository checks remain separate required jobs.
It uses the same affected plan for ordinary pull requests; full runs retain
complete discovery. Do not copy the full gate into an iteration loop.

## OpenUI generation and streaming

`pnpm check:openui-prompt` compares the embedded Agent instructions with the official
library's generated prompt and OMC's capability catalogue. It runs in the repository
static lane and in affected checks for prompt sources, generated files and dependency
changes. After changing those inputs, run `pnpm openui:prompt` and review the generated
diff. Air watches `internal/agent/openui/openui.json` because the backend embeds it at
build time; restart `pnpm dev` after changing Air's watcher configuration.

The `agent-stream` probe holds the OpenUI tool's argument stream open and checks that
content appears before the argument JSON is complete, then fills the same interface
with a table and chart. This verifies browser streaming, not model generation quality.
A real-inference check must also establish that the model receives the generated
instructions and emits a renderable program progressively.

## Asking the operator

Two probes cover the two ways a turn can wait for the operator. `agent-ask` drives
`ask_question`: the panel takes the composer's place, a digit key picks a single choice and moves
on, every question has its own tab plus a review tab, and one decision carries each answer back.
`agent-question` drives `prompt_openui`: the drawn form appears inside the answer, its submit
decides once with the official action, and the submitted answer is drawn as the operator's own
message under the form.

`agent-followups` covers the third case, where nothing waits: on a phone-sized viewport, reading
away from the newest end and then clicking a suggestion returns the transcript to its newest end,
because the answer to what was just sent appears below. It fails without the scroll-on-send effect
in `components/workspace/AssistantThread.tsx`.

## Rendered tests and the in-memory OMC

A component test renders the real component over the real typed client, and
`web/tests/support/omcApi.ts` answers its requests from one in-memory state:
preferences, providers, plugins, auth files and the health document are stateful, so a
write is what the next read and the next mount see. A test seeds state, adds the
endpoints its surface needs with `on`, serves a contract fixture from
`scripts/acceptance/` with `serve`, holds a response with `hold`, and asserts on
`requests`, `writes()` or the state itself. `renderWithOmc` (`web/tests/support/render.tsx`)
mounts under the console's providers.

```tsx
const api = installOmcApi({ providers: [PROVIDER] });
renderWithOmc(<Editor />);
fireEvent.click(screen.getByRole('button', { name: 'Save' }));
await waitFor(() => expect(api.writes('/management/providers/openai-compat-0')).toHaveLength(1));
```

A request no route answers, or one sent without the session cookie, fails the test after
it ends, so a component cannot pass by swallowing a rejected query. Files run in
parallel, each in its own environment. The contract tests (`*.contract.test.ts`) stub
`fetch` directly, because what they pin is the request the client forms.

## Golden cases

A golden case is two files: `<case>.input.json`, holding why the case exists, the instant
it is evaluated at and the body the code reads, and `<case>.golden.json`, the whole
encoded output.

```json
{ "why": "A free plan's primary window is monthly ...", "now_ms": 1735689600000, "body": { ... } }
```

`testkit.Cases(t, "testdata/golden/<name>", run)` runs `run` for every input and compares
its result with the golden file. To add a case, add an input file and generate its output:

```
UPDATE_GOLDEN=1 go test ./internal/quota
git diff internal/quota/testdata   # the review: is this the output the case should have?
```

A golden test that reads the clock or the zone calls `testkit.PinUTC(t)` first, so the
file is the same on every machine. `internal/quota/golden_test.go` is the reference use.

`internal/usage/golden_test.go` decodes CPA usage and error records the same way. Its
case body is `{ "record": ..., "fingerprinted": bool, "secrets": [...] }`: the output
leaves out zero fields so a golden file shows only what the record set, and the test
fails when any listed secret survives anywhere in the decoded row, so a redaction case
states its claim in the input rather than in a reviewer's reading of the output.

`internal/cpa/management/golden_test.go` covers how a key family's v8 groups are read and
written back. A case holds the stored groups, the runtime list and the console's edits by
position (merged into the entry's wire form, `null` clearing a field); the golden file is
the editable list and the whole set of groups the write sent, so a write that touched
anything the operator did not change appears in its diff.

## The demonstration dataset

`deploy/cloudflare/data/responses.json` is generated by the real handlers.
`TestExportDemoDataset` regenerates it in memory and fails when the committed copy
differs; `pnpm demo:generate` writes it, and its diff is reviewed like a golden file. The
comparison seeds a year of history (about fifteen seconds), so it is skipped under
`-short` (which `pnpm test:fast` uses) and runs in CI.

## What CI runs

`scripts/ci-scope.mjs` reads the changed paths and decides the lanes.

| Lane | Pull request against `main` | Push to `main`, nightly, manual run, label `full-ci` |
| --- | --- | --- |
| `static-repository`: docs, i18n, CSS modules, design gates, script tests, workflow lint, secrets | always | always |
| `static-go`: `go test ./...`, golangci-lint (`.golangci.yml`) | Go paths changed | always |
| `static-frontend`: type check, logic, components, antd lint | affected suites when web paths changed | complete discovery |
| `browser`: build, bundle boundaries, built-artifact acceptance | smoke, when Go or web paths changed | full, plus demo acceptance |
| `probes` | the scenarios the frontend change selects | the whole catalog in three shards |

A change to a shared input (`package.json`, the lockfile, `ci.yml`, `ci-scope.mjs`) or a
path the scope script does not recognise runs every lane. Branch protection requires
`static`, `browser` and `probes`; a lane skipped by scope reports success.

Weekly maintenance (`.github/workflows/maintenance.yml`) runs the race detector, fuzzing
and the advisory scan.

## Built-artifact acceptance

`pnpm verify:browser` is a handful of paths through the shipped binary, not a second copy
of the suites below it: sign-in; the secret sweep, which renders every console route and
requires that no DOM, browser storage or response carries the management key or OAuth
material; the request list over the seeded database; an external agent over MCP; adding a
provider through to the gateway; copying without the Clipboard API; the production YAML
worker; and the trusted plugin host. `:smoke` stops before the last four. A claim about how a page behaves belongs in a
component test or a probe; a step here earns its place by needing the built binary.

## When CI fails

- Probe jobs upload `tmp/probe-failure/`, with separate directories per port and phase
  so the exclusive run retains shared-run failures: the screenshot, DOM, URL, page errors and console
  of each failed scenario. Reproduce with `pnpm check:ui --scenario <id>`.
- Built-artifact acceptance uploads `tmp/browser-acceptance-failure/`. Reproduce with
  `pnpm build && pnpm verify:browser`.
- `pnpm verify:full` runs the full static, build, browser and demonstration catalog locally. CI additionally runs its workflow lint, golangci-lint and publication-specific gates.
- Rerun only the failed command. A failure that passes on rerun is a flake to fix at its
  assertion, never a reason to add a retry or lengthen a wait.

## Firefox plugin-page regression

The existing `plugin-management` probe waits for actual plugin content, checks live theme
propagation without losing an unsaved draft, reload, scrolling, opening a new tab, and
recovering from a shell response that lacks the plugin frame.
Run it in Firefox as well as the default Chromium when changing plugin-page hosting:

```sh
pnpm exec playwright install firefox
OMC_PROBE_IDS='["plugin-management"]' pnpm exec playwright test --config scripts/testing/probe-config.ts --browser firefox --workers 1
```

The pre-fix `srcdoc` host fails this probe because Firefox blocks the nested plugin frame
under the console's `frame-src 'self' blob:` policy. Built-artifact acceptance additionally
exercises the hashed shell asset through the embedded Go server and its MIME type.

## Waiting in tests

Wait on something observable: a response, an element state, `until(...)` from
`scripts/acceptance/harness.mjs`, a Go channel, or an injected clock. A duration a Go test
has to wait out belongs in the component's config with a production default, so the test
can set it to milliseconds. Do not maintain source-text wait counts: they conflate polling and rejecting deadlines with sleeps. Keep readiness observable and investigate real execution-cost growth.

## Verification cost and admission

Before adding a test, identify a failure mode not already owned by a cheaper test. Extend
that owner, or replace redundant checks. New features need observable behaviour and important
contracts; internal refactors need no new test by default. A browser scenario must require an
engine, not just a server response or React state. The PR template asks for that claim and net
cost; review, rather than a file-count quota, decides whether it earns its place.

`parallel-checks.mjs` retains per-check timings in `tmp/check-timings/`. Successful fast,
UI and full invocations also record wall time under `tmp/verification-cost/`, separated by
lane, OS, architecture, available CPU count and check ids with coarse suite-count buckets (small ≤2, medium ≤8, large or full), or exact
scenario ids for UI. Adding cases retains its workload identity; unrelated one-suite edits
share a useful baseline without mixing them with full catalogs. New suites also remain in
the fixed CI-wide cost envelope. The first three successes establish a local
median. The baseline freezes; one slow observation warns, and three successive observations
above **1.5 × baseline + 10 seconds** fail with the slow-lane diagnosis. Failed tests do not
become timing samples. Inactive local cost histories expire after 30 days. A new host starts its own baseline; cold-start observations are retained,
not presented as warm-cache speedups. Explicit scenario runs, different affected plans and full catalogs are distinct
workloads; reproduce a cost regression with comparable scope before changing its baseline.

The required CI aggregate reads GitHub's native job timestamps, reports runner-seconds and
execution critical path (setup plus the slowest parallel lane, excluding queue time), and
checks the current run plus two preceding successful runs of the same event. Historical PR runs established a
506-second execution baseline (448/506/513 seconds across three runs); full runs established
282 seconds (262/282/370). Runner-time medians were 857 and 1,167 seconds respectively. CI allows **50% + 30 seconds** for
runner/cache variation and rejects three successive significant overruns in either execution critical path or total runner-time. A lone cold runner
warns. Missing GitHub timing telemetry warns explicitly and cannot erase or fail a product-test
verdict. No extra monitoring service, retries, permanent governance suite or test-count quota is
needed. API outages still leave native job durations available in Actions.

On a sustained overrun, inspect the individual command/scenario timings, remove duplicate work,
and compare three equivalent successful runs. If new product risk genuinely needs the cost,
include those measurements, the owned failure mode and consolidation considered in the PR;
update the CI baseline in `scripts/parallel-checks.mjs` and this section together. A same-host
local baseline may be reset only with equivalent evidence. Never skip cases, loosen assertions,
or simply rerun a failing cost gate until it goes green.

## October 2026 verification audit

Measurements on a four-CPU Linux ARM64 host used Node 22.23.4 and pnpm 11.19.0.
The frontend-plan comparison ran the fast plan for the same `HeaderAction.tsx` change
before and after selection changed. Both exclude production build and browser work; the
old plan selected whole frontend suites and the new one selects their affected owners.

| Workload | Before | After |
| --- | --- | --- |
| Equivalent local frontend fast plan, three successful runs | 99.07 / 99.36 / 98.27 s | 18.40 / 14.81 / 14.73 s |
| Rendered suites selected for that component | all 30, plus all 89 logic suites | one rendered suite; unrelated logic omitted |
| Authenticated Agent dev mount, module requests | 2,480 total; 2,239 optimized | 815 total; 572 optimized |

The fast-plan median fell from 99.07 to 14.81 seconds (85%). The old Agent mount took
9.70 seconds without the browser guard; three new mounts took 5.10 / 4.99 / 4.61 seconds
with the guard, so request counts are the stronger comparison than those unequal timing
conditions. Vite now leaves the ESM dynamic icon import map unoptimized; icons stay lazy
instead of becoming thousands of eager shared chunks. Production bundle acceptance and
browser fault/network guards retain their existing responsibilities.

The PR execution baselines above come from runs 40223084404, 40224797884 and 40226144832;
the full-run samples are 40217897363, 40222722525 and 40226823544. In the affected PR lane,
probes alone took 405–461 seconds while build/smoke took 177–188 seconds: whole-catalog
selection on shared paths, not just build time, dominated feedback. An initial local full
run at `38bbfe9c` took 1,204.53 seconds and failed workspace bootstrap; that failed,
colder run is diagnostic evidence, not a successful speedup denominator. The final
pinned-Go full run passed in 1,016.72 seconds: build 81.88, static 134.48, packaged
browser 48.75, all 76 probes 679.31, and all 19 demo routes 59.98 seconds (the remainder
is toolchain, secret and bundle gates). It establishes the first successful local full
sample, not a three-run stable baseline. Full-catalog cost remains substantial; the daily
loop avoids paying it rather than hiding or weakening those checks.

From the PR #166 merge to `15952aa3`, product source grew from 154,006 to 190,044 lines
(23%), and tests from 90,623 to 104,309 (15%). Test volume did not outgrow product source
in that interval. The actionable causes were selection fanout, duplicated certification,
module startup and CPU scheduling rather than an unsupported claim about test counts.

Six script suites were removed: five certified fixture implementations or synthetic data
rather than product behaviour; the sixth counted source-text waits. Preference, updater
and warmup wire claims remain owned by Go handler certification and the typed-client
contract suites under `web/tests/`. Heatmap calendar behaviour remains in the API and
logic tests. Four rendered cases and source-CSS assertions that pinned presentation were
also removed; interaction, accessibility, lifecycle and real colour-contrast claims stay.
No security, migration, CPA-write, updater or embedded-distribution test was removed.
Across changed test files, the net reduction is 566 lines. The changed selector and
orchestration files (including the two new entry/helpers) shrink from 1,123 to 995 lines,
a net reduction of 128 despite the cost reporting and cancellation handling.

Temporary development experiments verified ordinary page and shared-component selection,
new-suite discovery, locale-only changes, shared test setup, global inputs and unknown-path
fallback. Synthetic cost samples verified that one slow run warns, normal observations
break the overrun streak, and three successive overruns fail. Admission exercises rejected another CSS-pin suite with no new failure mode and an E2E
proposal for an already-owned pure mapping, while permitting a genuinely new engine-only
claim. Semantic duplication and whether an E2E claim truly needs an engine remain review judgments;
the fixed full-CI envelope catches sustained cost growth, not every redundant assertion.
