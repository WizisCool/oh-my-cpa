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

Discovery is automatic everywhere except the probe catalog: a probe is an entry in
`scripts/acceptance/scenarios.mjs`. A new console page also needs a rule in
`SCENARIO_PATHS` (`scripts/acceptance/check-ui-plan.mjs`) naming the scenarios that load
it; without one, a change to the page runs every scenario. Shared dependency, build
configuration and public-asset changes also select the whole catalog.

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

The probe harness compiles the console once before the catalog runs
(`scripts/testing/probe-warmup.ts`). The dev server transforms a route's module graph on first
request, and without that visit the first scenario of a run spent the compile inside its own
first assertion; the warm-up changes when the work happens, never an assertion's budget.

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
| `static-frontend`: type check, logic, components, antd lint | web paths changed | always |
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
- `pnpm verify:full` runs what the full CI catalog runs, locally and in order.
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
can set it to milliseconds. `scripts/fixed-waits.test.mjs` fails when a fixed wait is added.
