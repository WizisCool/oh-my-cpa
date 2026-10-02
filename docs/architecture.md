# Oh My CPA architecture

Module map, data flows, and the invariants that hold them together. Domain
vocabulary lives in `CONTEXT.md`; visual rules live in `docs/design.md`; the
decisions behind the shape below are recorded in `docs/adr/`.

## 1. Runtime shape

```text
browser ──▶ reverse proxy or Vite ──▶ Go process (one binary)
                                        ├─ chi router under the base path
                                        ├─ embedded React SPA (internal/web/dist)
                                        ├─ SQLite (WAL, one connection)
                                        ├─ usage collector  ──▶ CPA
                                        └─ pricing sync loop ──▶ openrouter.ai

Go process ──▶ CPA management API (/v8/management; CPA v8+) ──▶ upstream providers
Go process ──▶ CPA RESP usage channel
```

One process, one SQLite file, one Oh My CPA replica. The Go process owns the
base path contract: the SPA is served at `<base>/`, the API at `<base>/api/v1`,
media at `<base>/media`. The embedded bundle's hashed assets are served from
`<base>/assets/` and provider SVGs from `<base>/lobe-icons/`; unknown non-API
paths fall back to the SPA shell. The proxy must preserve the prefix rather than
strip it (ADR 0001).

The React bundle is built into `internal/web/dist` and embedded with
`go:embed`, so a deployment has no CDN or static-file dependency. Everything the
browser can reach is a handwritten JSON endpoint; there is no generic pass
through to CPA.

### Demo mode is the same process with the gateway replaced

`OMCPA_DEMO_MODE=true` runs this binary against its own fixture; see §13. The shape
above still describes it, with two edges replaced and one added:

```text
browser ──▶ Go process (one binary, demo mode)
              ├─ chi router + the demo policy (internal/api/demo_policy.go)
              ├─ embedded React SPA
              ├─ SQLite (temporary, rebuilt on every boot)
              ├─ CPA management API ──▶ internal/demo's in-process fixture (loopback)
              └─ usage collector: not started; pricing sync: not started
```

There is no arrow to openrouter.ai and none to a provider, because the demo starts
neither the pricing sync nor any capture loop, and the fixture answers the quota
reads from its own catalogue instead of forwarding them. It does listen: the console
is served on the port the platform routes to. What it never does is connect anywhere
but its own fixture.

## 2. Go package map

Dependency direction is acyclic at package level. `internal/usage` (payload
decoding) and `internal/usage/ingest` (the capture loop) are separate packages,
so `repository → usage` and `usage/ingest → repository` do not form an import
cycle even though the `internal/usage` directory appears in both directions.

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `internal/config` | Environment parsing and defaults; `.env` loading | — |
| `internal/domain` | Durable entities (`CPAInstance`, resources) | — |
| `internal/crypto` | AES-GCM envelope for secrets at rest | — |
| `internal/iconasset` | Static image validation, bounded decoding, MIME verification and XML-allowlisted SVG reconstruction | — |
| `internal/security` | Redaction, keyed-HMAC fingerprints, display masks | — |
| `internal/applog` | The OMC service log: an `slog` handler that tees every record the stderr handler accepts into a bounded, redacted in-memory ring the console reads | `security` |
| `internal/auth` | Admin session cookie: sign, verify, rotate | — |
| `internal/usage` | Decode CPA usage/error payloads into typed events | `security` |
| `internal/usage/resp` | Minimal RESP client for CPA's subscribe/LPOP subset | — |
| `internal/pricing` | OpenRouter fetch and decode, model matching, tiered quotes, sync service, modes and channel multipliers | — |
| `internal/cpa/management` | Typed CPA Management API client (`/v8/management`, behind the v8 gate; the declared `/v0/management` calls in `client_v0.go`), configuration change sets with the legacy-file backup hook, and RESP stream wrapper | `configyaml`, `internal/usage/resp` |
| `internal/cpa/gateway` | Fixed-endpoint CPA inference client for the Playground and Agent: client-key auth, model directory, bounded SSE parsing, and bounded tool-call assembly for the Agent loop | — |
| `internal/cpa/discovery` | Normalize CPA resources into the local identity model | `management`, `crypto`, `domain`, `security` |
| `internal/cpa/configyaml` | The masked configuration view and per-value secret restoration, v8 file detection, and the plugin-system settings edit | — |
| `internal/repository` | SQLite schema, migrations, queries, transactional invariants | `iconasset`, `crypto`, `domain`, `pricing`, `security`, `usage` |
| `internal/usage/ingest` | Collector loop, decode processor, rollup and retention maintenance | `repository`, `management`, `security`, `usage` |
| `internal/quota` | Per-provider quota probes and normalization | `management` |
| `internal/release` | Published-version observation: version comparison, the release feed client, and the stored index | `repository` |
| `internal/demo` | The publication fixture: an in-process CPA stand-in, the seeded history, and the capture state the console renders | `domain`, `pricing`, `quota`, `repository`, `security`, `usage`, `usage/ingest` |
| `internal/capability` | Agent capability declarations, JSON Schema validation, permission/risk rules, pending-operation store, executor audit | `repository`, `crypto` |
| `internal/operations` | Shared management operations (usage analysis, requests, providers, OAuth, quota, keys, config, pricing, system) used by both console handlers and capabilities | `capability`, `cpa/management`, `pricing`, `quota`, `repository` |
| `internal/agent` | Server-side Agent runtime: conversation persistence, the tool catalogue it declares to the model, the sectioned system prompt, display tools, budgets, model loop, resumption | `capability`, `cpa/gateway`, `repository` |
| `internal/agui` | The AG-UI 1.0 wire protocol for Agent runs: strict `RunAgentInput` decoding, the event translator and SSE framing; knows nothing of OMC | — |
| `internal/mcpbridge` | stdio MCP transport over the capability HTTP endpoints; no business logic or approval policy | `capability` |
| `internal/api` | Routes, DTO allowlists, audited sensitive reveals, audit writes, the demo policy, capability/Agent endpoints | all of the above, `internal/web` |
| `internal/web` | `go:embed` of the built SPA, with a committed placeholder entry page for a binary built without it (ADR 0033) | — |
| `internal/app` | Wiring, background loops, graceful shutdown | all of the above |

Two rules keep the boundary meaningful:

- `internal/repository` owns transaction boundaries. Anything that must be
  atomic with a write (cost locking, inbox→event promotion, rollup checkpoints)
  is a repository method, not a sequence of calls from a service.
- `internal/api` owns the allowlist. A new response field is a deliberate DTO
  change; the allowlist tests fail otherwise. Every management surface declares its own
  response shape (`ProviderItemDTO`, `QuotaItemDTO`, `PluginItemDTO`,
  `managementAuthFileResponse`, …) instead of forwarding the facade model it decoded CPA
  into, so a field added there for decoding cannot reach a caller without a decision at
  this boundary. The plugin projection is also where manifest text is bounded
  (`management_plugin_projection.go`), because that text arrives from an installed plugin
  or a store registry; it also derives each entry's repository link and whether a store
  entry is first-party, so no surface decides trust on its own.

**Plugin management** (ADR 0029, ADR 0038). `internal/api/management_plugins.go` maps
the installed list with the global switch and each plugin's declared configuration
fields, removal, the store and installation from a named registry at a named version to
CPA's plugin routes. The per-plugin switch and settings document are keys of the
configuration: the switch is written at `plugins.configs.<id>.enabled` and the settings
document (passed through unprojected because its shape is the plugin's) is read and
written at `plugins.configs.<id>` through the v8 configuration API, under the provider
write gate and the configuration mutex a configuration save holds; a write for a plugin
that is neither installed nor configured is refused as `plugin_not_found`.
CPA's plugin error codes (`plugin_not_found`, `plugin_delete_requires_restart`,
`plugin_store_rate_limited`, …) are kept rather than folded into the generic facade
error. The plugin system's own settings - `plugins.enabled`, `plugins.store-sources`
and `plugins.store-auth` - have no dedicated CPA plugin route, so
`internal/api/management_plugin_settings.go` writes them as a configuration change set
on their `plugins.*` paths (`configyaml.PluginSettingsEdit`), under the provider write
gate, the configuration mutex and the revision the page loaded, exactly like a
configuration save.


### Agent runtime, capability registry and the MCP bridge

The Agent is not a second management implementation. Every capability it can call is a
declaration in `internal/capability` whose handler calls a shared method in
`internal/operations`; the console's HTTP handlers call those same methods, so write
gates, revision checks, and CPA readback cannot drift between the two entry points.
`internal/agent` owns only the model loop: it builds the system prompt, history, and
tool schemas, streams the model reply, executes each call through
`capability.Executor`, and persists the result before continuing. It never touches the
database, configuration file, or CPA client directly, and the request it sends upstream
is assembled server-side - a client cannot inject tool results, approvals, or history.

`POST /agent/run` speaks AG-UI 1.0 (ADR 0041). `internal/agui` decodes a strict `RunAgentInput` -
one user message or a `resume` list naming the interrupts it continues from, never history, state
or tool results; the key, model, effort and the revision the page last saw as `forwardedProps`;
the console language as the one `context` entry - and `internal/api/agent_http.go` translates the
runtime's transport-independent events onto the stream. `RUN_STARTED` is sent only once the turn
is persisted, so a run refused before that emits `RUN_ERROR` alone and the console hands the
message back to the composer. Each model round is a step; a capability call is announced
(`TOOL_CALL_START`/`ARGS`/`END`) before it executes and its receipt follows as `TOOL_CALL_RESULT`;
reasoning (`reasoning_content`, or `reasoning`) streams as reasoning messages and never enters the
messages later rounds are built from. The run ends with a `STATE_SNAPSHOT` of the console-projected
conversation and `RUN_FINISHED`, whose outcome is `success` or `interrupt` with one interrupt per
waiting operation (`approval`, `question`, `secret` or `oauth`, naming the call that raised it), or
with `RUN_ERROR`; token usage rides on the last event. A resume must name exactly the waiting
operations, each already decided on the decision endpoint (`confirmation_pending` otherwise).

`internal/api/agent_projection.go` projects session reads and final snapshots into explicit console
DTOs: model history (`messages`) and queued model calls (`pending`) stay server-side. For
`database_query`, both the streamed receipt and stored trace omit raw `data` and any `view`, while
retaining status, diagnostics, arguments and timing. Projection never mutates the persisted
conversation: the model loop and display tools still resolve the full query result. Answer text
and explicitly generated display views remain visible and may include data selected by the model.

The turn records its output as ordered `parts` - reasoning, text and capability calls, in arrival
order, with a new part for each model round - plus its rounds, token usage and the
`agent.PROMPT_VERSION` it ran with. The system prompt is built from named sections (identity,
approach, data, safety, presentation, context) in `internal/agent/prompt.go`, bounded by
`agent.MAX_PROMPT_BYTES` because it is resent on every round. The display tools `render_chart` and
`render_table` (`internal/agent/display.go`, ADR 0042) are offered only when the client declares
them: the model references rows of an earlier capability result by `source {call_id, path}`, the
server resolves and checks them, freezes the dataset on the call's trace as its `view`, and returns
a small receipt instead of the rows. They never pass through the executor.

The workspace above that loop is `web/src/pages/agent`, on assistant-ui's `ExternalStore` runtime
over the shared shell in `web/src/components/workspace`. The framework-free run layer is
`web/src/agent/`: the request builder and event parser (`protocol.ts`), the chunk-safe SSE reader
(`sse.ts`), the transport (`transport.ts`), a pure reducer that folds the events into the parts the
server stores (`runReducer.ts`) and the exports (`export.ts`). `useAgentRun.ts` drives one run and
publishes its frame on a 40ms cadence; `thread.ts` converts the stored conversation and the live
frame to thread messages; `runtime.ts` is the one module that knows assistant-ui's runtime API, and
routes every framework action - send, stop, approve, answer - back into OMC's code. A message sent
during a run waits in a queue behind it. Capability calls render through a tool UI registry
(`tools/`): one row per call, grouped into a collapsible chain, with its arguments and the receipt
the model received in the side panel's details tab (`CallDetails.tsx`); display calls render as a
lazily loaded chart or a table inside the answer. A prepared operation is decided on a card under
the call that raised it (`interrupts/ApprovalCard.tsx`, ADR 0043), and an `ask_question` call is
answered in a panel that takes the composer's place (`interrupts/QuestionPanel.tsx`); deciding
either one resumes the run (ADR 0035). A conversation, or one answer, exports as Markdown, and the
conversation as JSON; a table as CSV, a chart as PNG. The presentation rules - status vocabulary,
failure copy, argument summaries, chart series, change preview - are pure functions in `state.ts`,
`thread.ts` and `web/src/agent/`, which is what lets `scripts/test-agent-workspace.ts` assert them
without a browser.

There is no consent flag: the page states where the data goes (ADR 0027). Resetting a conversation
keeps its key, model and effort. The selector itself is the `agent_target` preference, so a choice
made before anything is sent survives a reload; a conversation waiting on an approval restores its
own target instead, because only that target can resume it.

`internal/capability.Executor` is the authority gate. Reads execute immediately; a
capability marked high risk returns a server-generated pending operation with a
structured preview and target revision; approval is one allow-or-deny decision made only
in the browser and is re-validated against the capability version, the caller's authority, and the current
revision while the write gate is held. An unverified or interrupted write is reported
as `uncertain` rather than retried. Secrets and OAuth authorization never enter tool
arguments or model-visible results: the console posts them directly while approving the
operation. `ask_question`, which `internal/agent` registers, uses the same pending-operation
path with an `answer` input and is the only capability that belongs to the conversation rather
than to `internal/operations`.

`database_schema` and `database_query` read OMC's own database through a second, read-only
SQLite pool that `internal/repository` opens on first use (`mode=ro`, `query_only`, no attached
databases). The repository checks each statement's compiled `EXPLAIN` program against a table and
column classification before running it, and bounds and masks what it returns (ADR 0036,
`docs/agent-capabilities.md`).

External agents use the same registry through `oh-my-cpa mcp`, a stdio MCP server. The
subcommand is dispatched before configuration, database, and CPA client initialization,
so the bridge process opens no data directory; it forwards capability discovery and
invocation to OMC's `/api/v1/capabilities` endpoints, authenticating with the CPA
management key as a bearer token. Non-loopback URLs must be HTTPS, redirects are
refused, and responses are bounded. The bridge cannot approve operations, submit
secrets, or complete OAuth - it returns the operation id and the console link instead.

#### What the model loop spends, and where

A turn has no fixed count of model rounds or capability calls: a task takes the rounds its
work needs, and the loop checks cancellation between model calls and between calls. What is
bounded is the cost and size of what each round may assemble, because those fail differently
and an operator needs to know which one did:

| Bound | Limit | Counts |
| --- | --- | --- |
| `agent.MAX_CONTEXT_BYTES` | 128 KiB | One assembled request, including its tool declarations |
| `agent.MAX_TOOL_SCHEMA_BYTES` | 32 KiB | The catalogue's share of that request |

Three properties hold across the loop:

- **The tool catalogue is declared from the first round.** Every registered capability
  reaches the model on round one with its description and inferred schema. Discovery is not
  a step: deferring the catalogue behind a search costs a full model round trip per action,
  and it makes a request the agent cannot serve look like a capability it does not hold.
- **A fingerprint is resolved once per turn.** Resolution reads CPA's client-key list; the
  turn holds the resulting client in a per-turn map, because the conversation's target
  cannot change inside a turn. The console also caches the fingerprint-to-key join in
  memory for a short window (`agentState.catalog`), which is what keeps a `providers_list`
  call from re-reading a list CPA is concurrently mutating; the cache is dropped on the same
  lazy maintenance pass that purges expired documents.
- **History is trimmed by whole complete turns.** Only turns with status `success`
  contribute history, newest first, and tool/result pairs are never split.

The latest Agent session and pending or terminal operations live in `agent_documents`
(migration 026), encrypted with `OMCPA_MASTER_KEY`. Session content is trimmed to
older complete turns and capped; terminal operations are retained for 7 days. Purging
is lazy: it runs during Agent requests, so the server starts no additional background
loop for the Agent.

### Known coverage gaps

- The browser suite had a history of timing-sensitive flakes in the usage-events
  filter section, unrelated to the provider write path: `the list is back to the
  unfiltered page` and `the queued search still lands` each failed once in repeated
  runs before the request-view policies were lifted out of the page. They were fixed
  rather than tolerated - see §12.3 - and the diagnosis was confirmed by reproducing
  them on the unmodified baseline commit, two runs in three, under a 2-CPU
  constraint. The suite now passes eight consecutive trials in the configuration the
  baseline failed, including with the probes running concurrently.
- The lost-update regression is the Go test, not the browser check. The interleaving
  that loses a write depends on two requests overlapping at CPA, and a browser run
  cannot force that: removing the gate still produced a green browser run, because
  the first write happened to land before the second read. The browser check
  therefore asserts only the operator-visible outcome, and
  `TestConcurrentProviderTogglesDoNotLoseAWrite` (which controls the ordering at
  the fake gateway) is the check that fails when the gate is removed.
- The stale-list-read guard (a read issued before a confirmation is discarded
  rather than published over it) is reasoned and implemented but has no automated
  check: the console's list read and a toggle's internal read are the same CPA
  endpoint, so a fixture cannot delay one without delaying the other, and the
  ordering cannot be produced deterministically yet. The browser suite therefore
  covers the concurrent-toggle and rapid-burst paths, not this one.
- The `503 write_busy` refusal is covered where it is decided (the gate test in
  `internal/api`, and the retry-classification test for the controller), but not
  end to end: producing it in the browser needs the gate held open from outside
  the page, which the fixture cannot express. Its user-visible message is checked
  by `pnpm check-i18n` and type-checking only.
- `isRetryableWriteFailure` in `web/src/api/client.ts` is the classifier the
  toggle's retries depend on, and it is not directly unit-tested: the module
  imports the application's whole type graph (one of its type-only imports is
  unresolvable under the test runner's loader), so the harness cannot import it.
  Its behaviour is exercised only through the controller tests' own predicate,
  which mirrors it. Moving it to a module with no application imports would make
  it testable.

### Effect-scoped resources must survive a StrictMode remount

React runs mount, unmount, and mount again for every component under `React.StrictMode`
in a **development** build. `web/src/main.tsx` enables StrictMode, so any resource a
hook owns has to be created where the effect that owns it is created, and its
cleanup has to release the resource rather than leave a disposed one installed.

A resource created during render and disposed in an effect cleanup is disposed by
the simulated unmount and then reinstated by the remount, so consumers hold a dead
object. That failure is silent and one-sided: operations on it become no-ops, so a
control still animates while nothing is sent, and every production-bundle check
passes because StrictMode's checks do not run in a production build. It reached a
user as "the provider switch no longer toggles" on the development server while the
deterministic browser suite was green.

`web/src/hooks/disposableSlot.ts` implements the rule (setup builds and installs,
teardown disposes and releases, a replacing setup disposes what it replaces) and
`scripts/test-provider-toggle-queue.ts` exercises the mount/unmount/remount sequence
directly. When adding a hook that owns a disposable resource, use the slot rather
than a ref that is disposed in place.

### Provider configuration write gate

`internal/api` serialises every whole-list provider configuration write through
one process-wide gate (`management_provider_writes.go`): the status toggle, the
provider create/update/delete paths, and the configuration-source writer, which
replaces the same document.

This is a correctness invariant rather than a performance choice. CPA exposes no
per-entry write for a provider family, so a change means reading that family's
list, editing it, and writing the whole list back. Two such writes that overlap
read the same baseline and the later one discards the earlier, which loses a
change that both requests reported as successful. The per-provider last-intent
queue in the browser cannot close that window: it deliberately runs writes for
different providers concurrently, and those are exactly the writes that collide
over one family's list. The revision check on the configuration-source path
detects a change that already landed but not one landing between its read and its
write, which is why that path takes the same gate.

Properties to preserve when changing this code:

- The read happens inside the gate, together with the write. Acquiring only
  around the write keeps a stale snapshot and reproduces the lost update.
- The permit is a single slot, so the helper that performs the read-modify-write
  must not be called while already holding it; re-entry deadlocks against the
  caller's own acquisition and surfaces as a busy refusal.
- Acquisition is bounded and cancellable. A caller that cannot enter is answered
  `503` with `code: write_busy` and no gateway write has started, which is what
  makes the refusal safe for the client to repeat.
- The permit is released on every exit path, including a panic in the callbacks.
- The gate is process-local. It orders this console's own writes; it cannot order
  writes made to CPA by another client, and it does not make click order
  authoritative across clients.
- A provider is addressed by its position in the family, so a write carries the
  identity the operator saw (`expected_auth_index`, or `expected_name` for the
  family without an auth index) and the handler refuses the write when the entry
  at that position is no longer it. A retry repeats the position, and positions
  shift when a provider is deleted; without this check a retry would toggle a
  different provider and report success. The precondition is optional, so a
  caller with no identity to send still works, and a mismatch answers `409`
  rather than writing.
- The operator's name, website and icon for a provider are stored under the
  same positional id (`provider_names`, `provider_websites`, `provider_icons`).
  A delete therefore re-keys every later entry of that family
  (`shiftPositionalProviderIDs`), because otherwise the name given to one
  credential would relabel whichever credential took the freed index, and the
  deleted row's own brand mark would reappear on it. The icon overlay is written
  by the console through the preferences API rather than by a provider save, so
  the server both re-keys the stored document and the console replays the same
  shift into its local cache - a cache that kept the deleted key would write it
  back on the next icon change. The name and website overlays of an update are
  written by the gated write itself, after the gateway accepted the update and
  before the write permit is released. The row, the request list's provider label
  and the name resolver read these maps, so an entry recorded ahead of a refused
  write would leave the console naming a credential CPA never accepted; recording
  it after the permit would let two accepted updates invert their overlay order.
  If the local overlay write fails after CPA accepted the list, the gate answers
  `500` with `code: provider_commit_partial` instead of reporting success. The
  overlay write takes a short context detached from the client request, because a
  disconnected client must not abandon the local half of an accepted write. The
  refusal is deliberately not a retry instruction: a create may already have added
  its row, so the client must reload before deciding what to do next.
  A partial commit still notifies the pricing manager before the refusal is
  returned, because CPA's model catalogue may already have changed even though the
  console metadata transaction did not.
  Icon values are authored by the console through the preferences API; a provider
  save never sets them. A delete is the exception to that authorship split: it
  re-keys the stored icon together with the name and website maps in the same
  gated metadata transaction.

### The CPA v8 baseline

Oh My CPA requires CPA v8.0.0 or later (ADR 0034, superseding ADR 0028; the mapping and
measurements are in `docs/cpa-v8-compat.md`). The management client addresses
`/v8/management` for every operation. Whether a gateway serves it is observed, never
inferred from a version string: `Client.SupportsManagementV8` reads
`/v8/management/config/config-version` and requires the value `8`; when that route is
missing, `/v0/management/debug` tells an older gateway (`unsupported`) from one whose
Management API is disabled because it has no management secret (`disabled`). The answer
is cached per base URL (`API_SUPPORT_TTL` for v8, the shorter `API_UNSUPPORTED_TTL`
otherwise) and dropped when a v8 route answers "missing"; a probe with no answer stops
the gate re-probing for `API_UNDECIDED_TTL`. Every request passes that gate
(`requireManagementV8` in `internal/cpa/management/v8_gate.go`): against a gateway that
answered "not v8" it returns `ErrManagementV8Required` without sending anything, which
the API layer reports as `cpa_v8_required`, and against a `disabled` one
`ErrManagementDisabled` (`cpa_management_disabled`). `/api/healthz` carries the gate's
answer as `cpa_management_api`, and the console shell replaces every page with upgrade
guidance while it reads `unsupported` (`CpaUpgradeRequired`), or with the
management-secret setting while it reads `disabled` (`CpaManagementDisabled`).

`/v0/management` is addressed only through `internal/cpa/management/client_v0.go`, and
only for reads: the per-family credential lists, which alone carry each upstream key's
`auth-index`, and the configuration file as stored (`StoredConfigYAML`), which only v0
returns. Every configuration write goes through the v8 configuration API (ADR 0037,
ADR 0038).

### Configuration editing on the v8 configuration API

The configuration editors read and write the v8 layout only (ADR 0037).
`GET /management/config` returns CPA's v8 rendering (`GET /v8/management/config.yaml`)
with secrets masked (`configyaml.SanitizeSafeYAML`), its revision (the SHA-256 of that
rendering) and whether the stored file is still a pre-v8 one (`stored_layout`). The
visual editor and the Keys page diff their draft against the document they loaded
(`web/src/components/config/configPatch.ts`) and send `PATCH /management/config` with
the changed paths; the source view sends the whole rendering to
`PUT /management/config/source`. Both saves take the provider write gate and the
configuration mutex, refuse a moved revision (`409 config_conflict`), restore masked
secrets from the stored document, and answer with CPA's new rendering, which becomes the
editor's baseline. A failed success-audit write is logged but the save still returns
`200` with that baseline, because the configuration write has already landed; if the
readback fails, the response omits the baseline so the editor reloads.
`Client.ApplyConfigChanges` sends a change set as one
`PATCH /v8/management/config` merge for scalars and lists, one `PUT /config/<path>` per
map value and one `DELETE /config/<path>` per removal. CPA refuses a legacy name, an
unknown section or a mistyped value without writing that request; when no earlier
request in the change set landed, the facade reports `422 config_rejected` with CPA's
reason in `reason`. Earlier valid requests are not rolled back.

Before any v8 configuration write the client reads the stored file and, when it is not a
v8 file (`configyaml.IsV8Document`), hands it to the configured `ConfigBackup`
(`internal/cpa/management/config_backup.go`), because that write makes CPA convert the
whole file. The API layer stores it encrypted in `cpa_config_backups`
(`repository.ConfigBackupStore`, the latest `CONFIG_BACKUP_RETENTION`); a write whose
copy cannot be kept is refused before anything is sent (`503 config_backup_failed`). The
check reads the stored file before every write rather than remembering a v8 answer,
because an operator can put a legacy file back at any time; a repeated attempt on the
same legacy file keeps no second copy. The v8 writes after which CPA itself saves the file
(`InstallPlugin`, `DeletePlugin`, `PatchAuthFileStatus`) take the same copy first. A
change set CPA stops partway through is `ErrConfigPartiallyApplied`
(`502 config_partially_applied`), and CPA's reason for a refused save has the stored
document's hidden values removed (`configyaml.ScrubStoredSecrets`).
`GET /management/config/backups` lists the copies and
`GET /management/config/backups/{id}` returns one, audited as `config.reveal_backup`.

### Provider families are data, not code paths

CPA stores `claude`, `codex`, `gemini`, `meta`, `xai`, `vertex` and `interactions`
credentials as seven lists with one shared entry core and one shared write shape.
The console mirrors that: `internal/cpa/management/config_keys.go` owns the family
values (`ConfigKeyFamilies`), the endpoints and the decoding, and `internal/api/management_providers.go` holds one
declaration per family (`providerConfigFamilies`) that supplies the presentation
constants, with the list projection it feeds beside it. The writes live in
`internal/api/management_provider_crud.go`, the enable/disable toggle in
`management_provider_status.go` and the model-list pull in
`management_provider_models.go`, and all of them are written once against that
table.

Adding such a family is a constant plus a row, and the pieces that must stay in
step are the same three in both stacks: the family's credential list in CPA, its
row in that table, and its label in `PROVIDER_FAMILIES`
(`web/src/types/providerFamilies.ts`). A family that reaches the API but not the
frontend table renders as a row without a protocol label, so both the contract
test in `internal/cpa/management/config_keys_test.go` and the browser acceptance
check on the rendered provider table assert the label rather than the module.

The families differ only in the fields around that core (a Codex-style entry's
`websockets`, a Claude entry's `cloak`, `request-retry` on most of them). The
console does not model those, but every write it makes replaces a whole family, so
`ConfigAPIKey` (and `OpenAICompatibility`, its key entries and `ModelAlias`) keep
their unmodelled fields verbatim and write them back (`wire_extras.go`); an edit in
the console cannot strip a setting the operator wrote in `config.yaml`.

The file stores each family as v8 groups (`api-keys.<family>`: a name, a base URL
and shared settings over a list of keys), while the console addresses providers by
their position in CPA's flattened runtime list, the only one carrying `auth-index`
(ADR 0038, `internal/cpa/management/provider_groups.go`). A write therefore reads
both: `EditableConfigAPIKeys` matches the stored keys to the runtime entries in
order, so each editable entry holds the file's own values, its `auth-index` and the
group it came from. `UpdateConfigAPIKeys` writes the family back as groups in the
list's exact order: a key stays in its group, stating its own value where it differs
from a setting the group stores; a key its group cannot express (another base URL, a
cleared `disable-cooling` or `request-retry`) and a new provider become groups of
their own. OpenAI-compatible providers are one group per provider
(`EditableOpenAICompatibility`, `UpdateOpenAICompatibility`). The edit form shows the
runtime values, so an edit starts from the stored entry: a key's and a model's
settings the form does not show are kept (matched by API key and model name), a
base URL equal to the runtime's default for a key the file stores without one stays
unstated (`ConfigAPIKey.SubmittedBaseURL`), and a group field outside the shared
settings stays on the group. CPA's reason for refusing any v8 write is scrubbed of
the stored file's secrets and of the ones the write sent before the response or the
audit log sees it (`ApplyConfigChanges`).
Two per-family constants in the registry carry the remaining differences:
`RequiresBaseURL` (Codex and xAI, whose entries CPA drops without an error when the
base URL is empty, so the console refuses them up front) and `PullProtocol` (the
auth dialect a model-list pull uses).

A family an installed CPA does not have answers `404`; that is a missing
capability rather than an empty or broken list (`IsMissingCapability`), so a
console release that knows a newer family still works against an older gateway.

Two callers fetch an address the process did not construct: a model-list pull, whose
URL the operator typed for a provider they run, and a plugin logo, whose URL an
installed plugin's manifest declares. `internal/api/outbound_fetch.go` owns the
redirect rule both obey - a redirect that changes scheme or host is refused before
the next request leaves the process, so neither the provider key nor custom
provider headers can reach a target the operator did not enter - and the two
destination policies sit in their own callers, because the authority behind the URL
is not the same. A model pull accepts HTTP for localhost, loopback and private
literals, since a self-hosted relay on the operator's LAN is the normal case;
invalid URL policy answers `400 invalid_model_pull_url` and a refused redirect
answers `502 model_pull_redirect_refused`. A plugin logo is allowed only over
public HTTPS, or HTTP to the machine itself, and the resolved address is checked in
the dialer against everything that is not public internet space - the operator's
network, the shared-address range an overlay network hands out (`100.64.0.0/10`), the
reserved IANA blocks and a cloud metadata endpoint - so a hostname that resolves into
any of them is refused where the connection would actually be made rather than trusted
because the name looked public. A plugin is not trusted to choose what this process
connects to, which is also why this fetch connects directly instead of through an
environment proxy: through one, the dialer would be asked about the proxy's address and
the target would be unverifiable.

A plugin's logo is fetched for a different reason than a model list: not to reach
the plugin's host from the browser, but to keep the browser away from it.
`internal/api/management_plugin_logos.go` fetches the URL a plugin publishes,
requires an image media type from a bound allowlist, caps the response - for a logo
published inline as well as for one fetched - and reports it as an inline `data:`
URL on both `logo` and `metadata.logo`; a store registry's icon is inlined the same
way, on the store list. Each list shares one fetch
deadline, because what has to stay bounded is the endpoint the console polls and not
each request; the result is cached, failures included, so a plugin list that names an
unreachable host does not refetch it on every poll. An exhausted budget is the one
outcome that is not cached, since running out of time is not an answer about the
logo. A logo that cannot be inlined is reported as absent rather than as a URL, which
is what makes every provider surface fall back to the vendored catalog mark; see §3.

CPA reports a plugin's name, author, version and logo only once its host has loaded it, so
an installed plugin that is disabled or waiting for a restart arrives with its id alone.
`internal/api/management_plugin_identity.go` fills those empty fields - never a value the
plugin registered - from the store's listing of the installed plugin, before the logos are
inlined. Every store read refreshes that in-memory copy; the plugin list reads the store
itself only when a gap remains the copy cannot close, at most once per ten minutes and
within five seconds, so a plugin no registry lists costs one store read, not one per poll.

### OAuth providers are one registry

`internal/cpa/management/oauth_providers.go` is the single declaration of which
authorizations exist, the shape of each (`redirect` or `device`), and whether CPA
should open its loopback callback forwarder for it (`UsesLoopbackCallback`, sent
as `is_webui`). The facade's provider list and the client's request are both
projections of it, and the browser's card registry
(`web/src/pages/oauthProviderLogic.ts`) carries the matching presentation plus the
rules for judging a pasted redirect.

The registry is deliberately not an allowlist: CPA plugins register their own
login providers at runtime, served by the same shared v8 login endpoint
(`/v8/management/oauth/auth-url?provider=`), the console discovers them from the
plugin list, and an id the registry does not know is forwarded unchanged with no
per-provider flags. The two registries are held together by an id, so a provider
is added in both or in neither.

A provider the console's own registry names also needs a brand mark, because a
surface that cannot draw one falls back to a neutral placeholder - which reads as
"this provider has no identity" even though its artwork ships in the bundle. The
catalog marks are declared in `web/src/components/common/providerMetadata.ts` and
`web/src/types/providerIconIds.ts`; a plugin-registered provider instead brings
the logo it publishes (§3).

### OAuth management is one credential-centred workspace

`/oauth-management` is the only OAuth navigation destination. Its collection is
projected from the auth-file list, so imported, runtime-only, plugin-backed,
unknown-provider and non-login-capable entries all stay visible. Quota is joined
only when both the auth file and quota response carry one unique nonempty
`auth_index`; missing, duplicate and quota-only race states remain diagnostics on
the same surface, and no write is authorized from an ambiguous target. The pure
projection lives in `web/src/pages/oauthManagement/oauthWorkspaceLogic.ts`.

Authorization sessions live above the Connect Drawer in
`useOAuthSessions`, keyed by provider id, so minimizing or closing the task panel
does not stop polling, duplicate a checker or cancel an upstream session. A status
read that fails before CPA answers is a note on a still-waiting attempt rather than
a terminal state: the panel keeps its cancel action and the armed poll keeps running,
because only CPA's own `error` status ends an attempt. Every site that arms the poll
timer clears the previous one first, which is what holds the one-checker rule. The
drawer presents one serialized status checker per attempt. The workspace opts out of
the hook’s default completion notification and reports completion once, through its
credential-aware toast after the list refresh settles. Credential detail,
configuration and models share one guarded Drawer; provider aliases remain
provider-scoped. `CredentialQuotaBody` is the single quota renderer used by the
workspace and its detail panel. The list always renders a compact quota summary;
the Quota tab always renders the full quota body. Configuration and Models are
separate tabs with query eligibility bound to the selected tab. The configuration
form remains mounted so drafts survive tab switches; its dirty-close guard applies
to the entire Drawer. Credential identity includes the auth index when resetting
form sessions and caching models. Historical density URL values and preference
fields remain readable compatibility data, but do not change the overview layout.

A quota refresh reports its outcome once, as a toast, so it never pushes the
credential list down (ADR 0045). A run without a failing target - including one
that skipped credentials which were never eligible - is acknowledged by a toast
that closes itself. A run with a failed or unknown target raises a report toast
that lists each target's reason under its group (failed, no outcome, skipped) and
stays until it is closed; the next refresh replaces it rather than stacking. Destructive and export actions on a
credential name their target in the confirmation, not in the menu label, which
stays short for any file-name length.


The old `/oauth`, `/auth-files` and `/quota` routes are retained only as
parameter-safe replacement redirects. They preserve documented filter and
connection intent while dropping callback, state, session and code material.

### Logs and the audit trail: three records, kept apart

The Logs page (`/logs`, with `?source=service`) reads the two log records and mounts only
the one being read so the other does not poll; the audit trail is its own page (`/audit`,
`pages/AuditPage.tsx`), because it is read by filtering and counting over a long span rather
than by following a tail. An older `/logs?source=audit` link redirects there.

- **Gateway log** — CPA's own log file and request error files, proxied through the
  typed management client (`/management/logs`, `/management/logs/status`,
  `/management/request-error-logs`). The console tails it; it owns none of it.
- **Service log** — Oh My CPA's own process log. `cmd/oh-my-cpa` builds the logger as
  `applog.NewHandler(jsonStderrHandler, buffer)`, so stderr remains the durable log a
  deployment collects, and `NewHandler` in `internal/api` finds the buffer through
  `applog.BufferOf`. The buffer keeps the latest `applog.DefaultCapacity` records,
  numbers them with a sequence that only grows for the life of the process, and is
  served by `GET /api/v1/management/service-logs?after=<seq>&limit=`. A reader that fell
  more than a page behind jumps to the newest records and is told `gap: true` rather
  than replaying a backlog. Values pass through `security.RedactText`, any field whose
  name marks a credential (every `*key` name included) is replaced outright, and
  message and field sizes are bounded, so one enormous error cannot grow the ring. A
  process built without the tee answers `capturing: false`.
- **Audit trail** — `audit_events`, served by `GET /api/v1/management/audit/events`
  with `category` (action prefixes, validated identifiers), `outcome`
  (`succeeded` / `failed` / `unfinished` — an `attempt` row, which with folding on is one
  whose outcome never landed), `q` (a substring of action, target or request id),
  `since_ms`, `limit` (at most 200) and `before`, an opaque `<occurred_at_ms>_<id>`
  keyset cursor the previous page returned as `next_cursor`. `fold` (default on) hides
  an `attempt` row once an outcome exists for the same request id and action; rows
  written before request ids were stable per request are paired by action, target and
  an outcome within one minute (`auditFoldWindowMS`), and only when both rows are older
  than the moment migration 027 was applied, which is when ids became stable. `idx_audit_events_request_action`
  (migration 027) serves that lookup. `GET /api/v1/management/audit/export` takes the
  same filters, returns every row including attempts unless `fold=1`, stops at
  `repository.AuditPageMax` rows with `truncated` set, and is itself audited and
  withheld when that record cannot be written. `GET /api/v1/management/audit/summary`
  (`repository.SummarizeAuditEvents`) counts the rows the trail would show for the
  same `since_ms`, `q` and `fold` as a matrix of action prefix by outcome class; it ignores
  `category`, `outcome` and the cursor, because the page derives both facets' counts from
  that one matrix (`auditFacets`) and each facet must count under the other's selection.
  The page keeps its filters (`category` as the console's category name, `outcome`, `q`,
  `range` of `24h`/`7d`/`30d`/`all`) in its URL, so an entry's "only this target" and
  "only this request" actions, and any link, open a narrowed trail.

Every request is given one server-generated id on arrival (`assignRequestID`, which
answers it back as `X-Request-ID`). A write's attempt and outcome rows therefore share
it; before this each audit call generated its own id and no pair could be matched. A
caller's own `X-Request-ID` is never the pairing key - one value sent on two requests
would pair an attempt with another request's outcome - and is recorded on the audit
row as `client_request_id` for correlation instead.

## 3. Frontend shape

`web/src` is a single-page app on React + TypeScript + Ant Design, with TanStack
Query for server state.

| Area | Contents |
| --- | --- |
| `App.tsx` | Router, lazily loaded pages, theme and locale providers; the theme provider sits above `ConfigProvider` (Ant Design's tokens are a projection of the resolved palette) while `ThemeServerSync` sits inside `App`, because a refused save is reported through a toast (`useToast`), which needs the antd `App` context |
| `api/client.ts` | The one typed HTTP client and the shared session/error plumbing; every ordinary endpoint is declared here. The Playground's `pages/playground/api.ts` and the Agent's `agent/transport.ts` wrap `requestResponse` and `agent/sse.ts` for their SSE routes, without duplicating auth or retry policy |
| `agent/` | The Agent's framework-free run layer (ADR 0041): AG-UI request building and event parsing (`protocol.ts`), the chunk-safe SSE reader the Playground shares (`sse.ts`), the transport, the run reducer, the wire types and the browser-side exports (`export.ts`: Markdown, CSV with formula guarding, file names) |
| `types/` | Wire types, including the request-record view model split by responsibility (`usageEventQuery.ts` for the URL and filter contract, `usageEventViewPreference.ts` for the stored view, `usageEventIdentity.ts` for the credential and provider behind a row, `usageEventGrouping.ts` for how records bucket, `usageEventLabels.ts` for what a row prints, `usageEventMetrics.ts` for its numbers and `usageEventCadence.ts` for the page's timing constants), `usageEventViewActions.ts` (the view's URL and persistence rewrites), `pluginOAuthProviders.ts` (which logo an installed plugin publishes for the OAuth provider it registers, and whether a URL may be rendered as an image at all), `tokenDisplay.ts` (the one layer every user-facing token number is formatted through) and `rollingNumber.ts` (the animated shape of a reading) |
| `hooks/` | `usePreference`, `useCustomIcons` (shared revisioned custom-icon metadata), `useLastIntentQueue` (React binding) over `lastIntentQueue` (the framework-free controller) and `disposableSlot` (effect-scoped resource lifetime), `useLogTail` (CPA's gateway tail, positioned by CPA's cursor), `useServiceLogTail` (the service log, positioned by its sequence number), `useVisibleNow`, `useIsNarrowViewport` (900px, the shell), `useIsPhoneViewport` (640px, lists and control sizes), `useOverlayHistory` (React binding) over `overlayHistory` (the framework-free overlay/history policy: one sentinel per open Drawer or Modal, so the platform's Back dismisses the topmost one), `usePluginOAuthLogos` (the plugin list read once, projected to provider-key logos), `usePrefersReducedMotion` (the app-owned reduced-motion switch the canvas marks need, since neither `@antv/g2` nor `@ant-design/plots` reads the preference) |
| `i18n/` | `index.tsx` owns the base `[zh, en]` dictionary and the `t()` context; `language.ts` is the reading-language registry and locale helpers; `locales/zh-Hant.ts` and `locales/ms.ts` are the complete additional catalogs |
| `theme/` | `palette.ts` (the nine authored tokens, the seventeen-token derivation, the registered palettes and the resolution of a mode plus a selection into a palette), `themePreference.ts` (the stored preference document, its parse and its migration from the earlier bare palette id), `ThemeContext.tsx` (the preference, the system follow, the in-progress edit, and the server sync), `themeConfig.ts` (antd tokens and CSS-variable projection), `colorMath.ts` (OKLCH mixing, luminance and contrast - the one authority for every ratio in the console), `cacheScale.ts` and `heatmapRamp.ts` (the two sequential ramps' stops) |
| `utils/` | `scrollSmoothing.ts` (the console-wide wheel and keyboard glide, ADR 0046: discrete wheel notches and scrolling keys glide over the `scroll` token, virtualized lists are driven through their own wheel handling and get a glide's first step inside the input event, so the glide adds no latency to their own jump (ADR 0047), trackpads and touch are never glided; loaded on demand by `hooks/useScrollSmoothing.ts` and switched by the `omc_scroll_smoothing` preference, whose words live in `scrollSmoothingPreference.ts` so the engine stays out of the main entry), `maskKey.ts` (the console's one caller-key mask shape, kept branch for branch with the server's `security.MaskSecret`), `externalUrl.ts` (the http/https link rule), `modelOptions.ts` (model-input filtering), `smoothScroll.ts` (the gesture/correction scroll schedule), `clipboard.ts` (the one copy path, below), `download.ts` (`saveBlob`, the one download path: it attaches the anchor and releases the object URL on a delay, because revoking it in the click's own task cancels the save in Firefox and Safari), `format.ts` (`formatBytes`) |
| `components/common/` | What more than one page renders: the shell (`AppLayout`, `HeaderNav`, `AuthGate`, `PreferenceMenus`); the page chrome every route opens with - `PageHeader` (title, subtitle or live summary, right-aligned actions), `RefreshButton` (the one refresh glyph and size, spinning rather than locking while a read is in flight), `PanelTitle` (a card's glyph, title and its one control), `StatusLabel` (a state as pip + word), `FactList` (label/value rows), `StatTiles` (counted tiles that double as a list's filter), `PageLoading` and `CodeFrame` with `CopyButton` (a code block and its copy action, shared by the transcripts and the setup snippets); `SecretInput` (a secret that is not the console login, masked by style so the browser's password manager leaves it alone); and the list a surface renders at both widths - `ResponsiveList.tsx` (table on a wide viewport, rows below 640px, with loading-before-empty, blocked-is-not-empty and clamped paging decided once) over `PhoneRow.tsx` (headline, summary, labelled fields, controls) and `phoneRowFields.ts` (derives a row's fields, and one column's rendered cell, from the *table's own* column array, so a list has one description of a record at both widths and a column cannot silently disappear on a phone; see ADR 0012) |
| `components/workspace/` | The conversation workspace the Playground and the Agent share: `WorkspaceLayout` (head with title, target and actions; main column; resizable side panel that becomes a Back-aware Drawer below 900px), `useResizablePanel` (pointer and keyboard resizing that writes the width to the DOM during a drag and commits it once), `AssistantThread` (assistant-ui's thread viewport: follows the newest message while the reader is at the bottom, holds their place once they scroll away, and offers "back to latest" only then), `AssistantComposer` (assistant-ui's composer with Ant Design controls: attachments, the queue of messages sent during a run, and Enter and the send button both asking the runtime to send, because the framework's own send controls decide from state that reaches them a task after the page changed it), `ModelMarkdown` (safe `@ant-design/x-markdown` rendering with allowlisted code highlighting inside the shared `CodeFrame`), `ReasoningBlock` (a collapsible reasoning disclosure that follows its newest output while it streams and folds when the stream ends), `ReasoningEffortPicker` and `TargetPicker` (key and call point as one joined control). The side panel takes tabs, which both pages use for their directory or parameters beside the call or turn details |
| `components/feedback/` | Every notification and failure surface (ADR 0045): `useToast` (an action's outcome, including report toasts with per-target reasons), `LoadFailure` (a region's failed read, in its place, with Retry) and `Notice` (a condition, or a refusal beside its input). `toastContent.ts` holds the pure parts - `readableReason`, grouping, lifetimes. `pnpm check:feedback` keeps raw antd `Alert`, `message`, `notification` and information-only dialogs out of the rest of `web/src` |
| `components/logs/` | The Logs page's two sources: `CpaLogPanel` (the gateway tail and error files), `ServiceLogPanel` (the service log), and `LogList`, the scrolling tail both render into - it follows the newest line until the reader scrolls away and mounts only the newest chunk. Wire types and pure helpers live in `types/logs.ts` |
| `components/audit/` | The audit page's `AuditTrail`: the page head with refresh and export, the outcome tiles (`StatTiles`, each count a filter), the search, category and range filters, and the trail as one `ResponsiveList` frame per day (on a phone, one tappable row per entry: the sentence and its outcome over its time and target); `AuditEventDrawer` shows one entry in full and steps to its neighbours; `auditText.ts` turns an action and a result into the sentence and word a reader sees. Wire types, URL state and facet counting live in `types/audit.ts` |
| `components/plugins/` | The plugin management page's three tabs: `InstalledPluginsPanel` (each plugin's state in words - running, enabled but not running, disabled - its switch, settings and removal), `PluginStorePanel` (the store as cards with the registry's icon, author, tags, repository and homepage links, and the install dialog that asks a third-party install for the typed plugin id), `PluginSettingsPanel` (the plugin system switch, the third-party registries and the store authentication rules) and `PluginConfigDrawer` (a plugin's declared fields as typed controls, with the JSON view of the same document). The pure rules sit beside them: `pluginConfigForm.ts` (draft to document, per-field validation, undeclared keys carried through), `pluginConfig.ts` (JSON parsing that refuses a duplicate key) and `pluginStoreLogic.ts` (store filters and the settings draft's validation). `pages/PluginsPage.tsx` owns the tab in the URL and reads the store only once its tab is opened |
| `components/`, `pages/` | Feature UI; one page per route, no page owns another. A page composes its surface rather than carrying it: `pages/UsageEventsPage.tsx` renders `components/usage/`'s toolbar, header and rows and takes its state from that directory's hooks, `pages/ProvidersPage.tsx` renders `components/providers/`'s table and editor, and `pages/ConfigPage.tsx` renders `components/config/`'s renderers. The framework-free policies of a surface stay beside it: `components/usage/` carries `searchDebounce.ts`, `pollingPolicy.ts`, `timeRangePolicy.ts`, `syncPresentation.ts`, `chipDisplay.ts` and `requestListTouch.ts` (the request list under a finger: it follows the finger, coasts and folds the header, in place of the virtualizer's touch emulation, ADR 0048), and `components/config/` carries `payloadRules.ts`, `configDirty.ts` and `configPatch.ts` |

A failure's sentence goes through `describeError` (`api/client.ts`) rather than each
call site's own `instanceof` ladder: an `ApiError` already carries the server's message
(or the console's localized demo refusal), and a transport `Error`'s message is the useful
part - `String(error)` prefixed every one of them with `Error: `.

Every copy control goes through `utils/clipboard.ts` rather than calling the
Clipboard API itself. That API exists only in a secure context, and a plain-HTTP
origin is a supported deployment of this console (`deploy/nginx.conf` listens on
:80 without TLS, and the dev server is reachable from a LAN or Tailscale device),
where `navigator.clipboard` is `undefined` outright. The helper therefore falls
back to the selection path and returns whether the text actually reached the
clipboard, and no control may announce a copy it did not make.

That fallback carries two constraints a control inside a dialog depends on. A dialog -
antd's Drawer and Modal both - pulls focus back into its own subtree, so the scratch
element the selection path types through has to join that subtree rather than
`document.body`: attached outside it, the element never keeps the focus its selection
needs and the selection stays empty. And `execCommand('copy')` answers `true` for an
empty selection, so the helper checks that the scratch element holds focus and its own
selection before believing the result.

All page routes are `React.lazy` import boundaries so the entry chunk stays
small; the shell (`AppLayout`, `AuthGate`) is loaded eagerly because every
route needs it. Brand/provider marks are copied from the pinned
`@lobehub/icons-static-svg` package into `web/public/lobe-icons` and referenced
as SVG URLs. The small catalog used for lookup and grouping is vendored in
`web/src/generated/lobeIconCatalog.json`; the React icon package is not a
dependency, because importing it would pull hundreds of components into the
eager bundle; the OMC Settings page is lazy for the same reason, because the palette editor it carries
pulls in Ant Design's colour picker. Dashboard KPI cards use `@ant-design/charts` in a dedicated
`vendor-charts` chunk, lazily loaded so the entry bundle stays small. Their
numbers animate through `@number-flow/react`, which the dashboard page imports
directly instead of through a vendor chunk: only that route uses it, and being on
a lazy route boundary it never enters the entry's static module graph. The marks
themselves morph between revisions on the same motion token, gated by the
reduced-motion hook above. `docs/design.md`
§7 rules 5 and 8 own the motion they are allowed to run, and ADRs 0007 and 0008 own the
trade-offs.

Dashboard chart creation is paced by `utils/chartMountQueue.ts` and `charts/ChartMount.tsx`:
one queued mount commits in a task following each animation frame, leaving opportunities
for paint and input between the eight G2 initializations. The caller reserves the existing
chart geometry, queued work is canceled on unmount (including StrictMode cleanup), and
hidden tabs pause with the browser's animation frames. Once mounted, charts keep their
instances and receive data, theme, timezone, locale and unit-style updates normally; the
queue does not defer updates or change the motion specification. KPI selectors and
formatters have stable references, and memoized chart boundaries avoid reprocessing
unchanged series on query-status updates.

Icons come from `lucide-react`, through the wrapper layer in
`web/src/components/icons/index.tsx` rather than by direct import, so the console keeps the Ant
Design icon names and the `anticon` classes its CSS already selects on. Those wrappers are thin
forwarders, so the icon set is tree-shaken to the icons actually referenced; ADR 0025 records the
switch away from `@ant-design/icons` and the two stylesheet declarations the console took over so
its icons no longer depend on another package's runtime injection.

**A plugin's published logo outranks the catalog mark for the provider it
registers.** A plugin that declares `supports_oauth` may publish its own logo, and
when it publishes usable artwork that mark is the one drawn: the plugin is the only
authority on what its own provider looks like, and the vendored catalog cannot be
updated by installing a plugin, so guessing a brand from the provider key would
label the operator's own credential with somebody else's mark.
It is not loaded from the plugin's host, though - the deployment must not
depend on a CDN, and the console's CSP allows images only from itself or inline -
so the Go process inlines it (§2) and `types/pluginOAuthProviders.ts` resolves the
plugin list into provider-key logos (including a plugin whose auths are typed by
its own id rather than by `oauth_provider`). `LobeIcon.tsx`'s `ProviderBrandIcon`
renders it - one component for the provider tabs, the unified credential records,
the request records, the provider table and the dashboard's provider rows, so
those surfaces cannot disagree about the same provider. Only inline artwork is
rendered: a provider no plugin owns, a logo that could not be inlined, and a value
at a scheme the browser may not load all fall back to the catalog mark, and a
plugin-owned row shows the plugin's mark even when an operator icon override is
stored for that key, and it does not depend on the plugin being enabled — the mark
identifies the provider behind a credential or a past request, which does not stop being
true when the plugin is switched off (ADR 0014). ADR 0013 owns the trade-offs behind the
other choices here, including why a plugin-declared logo URL is held to a stricter
destination policy than an operator-typed one.
The backend discovery/binding model the retired triage console rendered is still
live behind Providers and OAuth management; the console no longer carries a
component of its own for it.

`components/icons/index.tsx` is the console's icon layer, and is referenced by every
surface that draws an icon: it wraps Lucide components in the Ant Design icon names the
rest of the codebase imports (`<ApiOutlined />`, `<SyncOutlined spin />`) instead of
letting components import an icon library directly. It keeps the `anticon` class names and
the `spin` prop, because first-party CSS and antd's own components select on them, and
`web/src/index.css` owns the two declarations that used to arrive from that library's
runtime-injected stylesheet (the base box model and the spin keyframes). ADR 0025 records
the move; the console has no direct dependency on `@ant-design/icons`, while antd keeps
its own transitive one.

CSS class names are kebab-case everywhere, including `*.module.css` exports,
which are consumed as `styles['kebab-case']`. That is not cosmetic: `tsc` types a
CSS module as `Record<string, string>`, so a stale class reference compiles and
fails silently at runtime. `pnpm check-css-modules` is the guard that closes
that hole.

The motion budget is enforced the same way. `pnpm check:motion` reads the
stylesheets and the inline `transition:` strings in components, and fails on a
duration that is not a `--motion-*` token, a transition on a layout property (or
on `all`), a keyframe animation with no `prefers-reduced-motion` counterpart, and
a hover transitioning colour outside the fast token; the disclosures that need a
layout animation are listed in its `EXCEPTIONS` table with a reason each, and a
stale entry is itself a failure. The budget it enforces is stated in
`docs/design.md` §7, and the reasoning behind the hover bound is ADR 0009.


### Route error recovery

The root data route in `web/src/App.tsx` provides `RouteErrorPage` as its
`errorElement`. Descendant render errors, rejected lazy page imports and shell
render errors bubble to this eagerly imported, full-page fallback, outside
`AppLayout` but inside the existing theme and language providers. It makes no API
reads. The authenticated `AppLayout` is loaded lazily inside the root route's
Suspense boundary, using the existing page-loading indicator while pending. Its
code is not needed for sign-in or error recovery; a rejected shell import reaches
the same eager error boundary. `web/src/utils/routeErrorDiagnostics.ts` projects
a bounded error name, message and stack plus route pathname, build version, UTC
occurrence time and HTTP status for route responses. It never serializes arbitrary thrown objects or
response bodies; only a string body or its string `message` field is projected.
Common credential forms and URL credentials/query/fragment values are removed
before rendering or copying. Redaction is best-effort rather than a guarantee
that arbitrary exception text contains no sensitive content. The existing `CopyButton` uses the
shared clipboard path and its feedback policy.
Both recovery actions replace the document: reload retries the current URL, while
the dashboard anchor includes the runtime base path. Replacing the document also
clears React's cached rejected lazy imports. Provider/bootstrap failures outside
the router, event-handler exceptions and detached asynchronous failures are not
caught by this route boundary. Unknown console paths retain their existing
dashboard redirect.

### Navigation and calendar render costs

`web/src/routePages.ts` owns the lazy page modules and their shared loaders. The navigation
menu preloads a target's code on pointer hover, keyboard focus or touch start. It does not
prefetch authenticated data, mount the target or load the configuration page's YAML editor.
The sign-in screen has no navigation menu and starts none of these speculative imports.
`web/src/utils/routeLoader.ts` shares one import across intent and navigation, reusing success
and clearing a failed speculative attempt so a later navigation can retry.
The content column records whether it has scrolled through its own scroll events.
Path navigation resets it only after actual scrolling; a column already at the top
avoids the otherwise redundant `scrollTo` call and its synchronous layout flush.
Nested scrollable widgets do not change the content column's recorded state.

The token heatmap resolves its first-stored and as-of instants to calendar days once per
observation/timezone revision, rather than once per cell. `createHeatmapCellClassifier`
retains the same per-instant dayjs timezone/DST interpretation. Localized cell names and
Agent clocks reuse the bounded formatter cache in `web/src/utils/dateTimeFormat.ts`;
civil-date keys use a UTC carrier so the browser's zone cannot shift or skip a date.
Cells are plain memoized DOM nodes. The first click creates one antd tooltip, portaled
into the selected cell through a stationary, pointer-transparent anchor; switching days
replaces that one instance without replacing cell DOM or focus. The active cell owns the
ARIA description and open ring. Outside pointer and Escape dismiss it; Escape from its
link restores cell focus. Closing keeps antd's exit motion, with popup content destroyed
when hidden. The instance and listeners are removed on navigation or calendar changes.
Initial positioning observes the first nonzero scroll-container layout and sets the scroll
position to the browser-clamped end once per mount, rather than synchronously reading the
whole dashboard's pending layout. Refreshes preserve the operator's scroll position.
See `docs/performance.md` for the measured audit and remaining bottlenecks.

Request rows generate their short label and millisecond-precision tooltip from one
zoned instant in `web/src/components/usage/requestTimestamp.ts`. The row memo retains
both strings until its timestamp or the shared display timezone changes, so selection
and unit-style changes do not repeat timezone conversion. The underlying dayjs timezone
implementation and wire timestamps remain unchanged.

Request cells carry their exact tooltip label as a data attribute instead of creating
an antd trigger tree per cell. `web/src/components/usage/RequestTooltip.tsx` delegates
pointer and focus intent within the list host to one on-demand tooltip. Its fixed,
pointer-transparent anchor is portaled to the document body so row DOM, grid layout
and focus remain unchanged. Labels update while the target stays mounted; virtual-row
removal, scrolling, resize, Escape and route cleanup release the active description
and popup. The existing 100 ms pointer intent delay and antd exit motion remain;
keyboard focus shows the price-action hint without waiting for pointer intent.

Listy's initial virtual-row estimate is aligned to the request rows' existing 68 px
minimum through its component token. Request-row CSS still owns visible padding and
geometry; the virtualizer continues measuring real item and group-header heights.


## 4. Request and session flow

1. `POST <base>/api/auth/login` with the CPA management key. The handler
   compares it against `OMCPA_CPA_MANAGEMENT_KEY`; there is no second password.
   Failed attempts are throttled by the direct peer address. Forwarding headers
   are consulted only when that peer belongs to `OMCPA_TRUSTED_PROXY_CIDRS`, and
   the rightmost untrusted address in the chain is used, so a client-supplied
   leftmost value cannot mint a fresh limiter bucket.
2. On success the session manager derives an HMAC key from the management key
   and issues an HttpOnly, SameSite=Strict cookie (`Secure` when
   `OMCPA_PUBLIC_URL` is HTTPS) with a 12-hour expiry.
3. `requireAuthentication` wraps every `/api/v1` route and rejects an absent or
   stale cookie with 401.
4. Rotating the CPA management key changes the derived signing key, so every
   existing session fails verification without any server-side session store.
5. Sensitive exports (raw auth file, request logs) write an `audit_events` row,
   and audit-write failure blocks the export (fail closed).

   **Raw config YAML is deliberately not behind a second credential.** It used to
   require a short-lived reveal grant obtained by re-entering the CPA management
   key, while `PUT /config/source` - which writes the same file - required only
   the session. Since the management key is the console's only credential, the
   grant re-checked exactly the authority the session already carried, so it added
   a step without adding a boundary. Reading the raw source still sits behind
   `requireAuthentication`, is served `no-store`, and keeps the fail-closed audit
   write. This is a deliberate removal of step-up authentication, not a
   frontend-only prompt change: the grant endpoint and its state are gone.

6. The two list endpoints that can carry plaintext credentials on request,
   `/management/api-keys?include_keys=true` and
   `/management/providers?include_keys=true`, write `api_key.reveal` or
   `provider.reveal_keys` before the response is emitted. The record identifies
   the list and carries counts rather than one event per credential. Audit-write
   failure answers `500` and no credential is returned; masked reads are not
   audited because no credential leaves the server (ADR 0018).

The key itself is encrypted with `OMCPA_MASTER_KEY` and stored on the
`cpa_instances` row, where `bootstrapDefaultInstance` refreshes it at every
startup so a rotation needs no SQLite surgery.

### Response compression

`internal/api/compression.go` negotiates gzip from `Accept-Encoding`, including quality-zero
refusals and wildcard precedence. The API middleware compresses ordinary JSON with pooled
best-speed encoders; SSE, file downloads, HEAD/range requests, already encoded bodies,
`no-transform` responses, explicit `include_keys=true` credential reveals and responses setting
cookies pass through unchanged. Streaming
flushes and `http.ResponseController` operations reach the original writer. JSON compression
removes the original content length, and both encoded and identity variants carry
`Vary: Accept-Encoding` without discarding other vary fields.

Embedded JS, CSS, SVG and JSON assets keep their immutable cache policy. Assets of at least
1 KiB are compressed on first negotiated use, only when gzip saves bytes. Their compressed
representations are reused in a process-wide cache capped at 8 MiB; larger inventories can
still be served without increasing retained bytes. Compression runs outside the cache mutex;
publication rechecks for a concurrent entry before charging the retained-byte budget.
Overlapping misses may compute the same asset, but a retained result is published and counted
only once. Fonts and other binary assets are not
compressed. GET and HEAD select the same representation and content length under both the
root mount and configured sub-path. No reverse-proxy compression setting is required.

## 5. Discovery and identity flow

```text
POST /api/v1/instances/default/discover
  → internal/cpa/management reads auth-files, the codex API-key list, and
    openai-compatibility entries
  → cpa/discovery derives a stable resource key and binding fingerprint
  → repository upserts discovered_resources + cpa_bindings (served via /api/v1/resources)
```

The resource key resolution order and the ban on array position are fixed by
ADR 0002: immutable upstream id, then family-scoped `auth_index`, then a
versioned keyed HMAC of the credential material, then a fingerprint of
non-sensitive metadata, and finally an explicit `identity_collision` marker
rather than a silent merge. Secrets never enter a key or a stored fingerprint
input, and a response DTO carries one only for the surface that edits it and only
when it asks for it (`?include_keys=true`, ADR 0015); every other response carries
a display mask. (The Providers list and the unified OAuth management workspace
inspect and manage CPA runtime entries directly through
`/api/v1/management/providers` and `/api/v1/management/auth-files`, layering
local preference metadata on read.)
Auth-file edits use CPA's field patch but do not treat its `200` as proof:
the facade reads the runtime entry and a server-side projection of the
downloaded JSON back before returning success. The projection exposes only
prefix, proxy URL, expiry, disable-cooling, WebSockets, using-API, note, priority,
weight and excluded models; tokens and other credential material stay inside
the Go process. Global OAuth model aliases are managed separately through
`/api/v1/management/auth-files/model-aliases`: the facade replaces one provider
at a time, reads CPA back before reporting success, and audit logs the write.
These writes and safe reads are audit logged.

`cpa_bindings` carries `missing_at_ms` and `ON DELETE SET NULL` so upstream
removal marks a binding missing without cascading into history.

## 6. Usage flow

```text
CPA queue / subscription
  → ingest.Runner        pop or receive, persist immediately
  → usage_inboxes        raw payload, status pending, durable before decoding
  → ingest.Processor     decode via internal/usage, one event per inbox row
  → usage_events         typed row + request-time price snapshot (one tx)
  → ingest.Maintenance   incremental rollup into hourly/daily stats,
                         retention purge
  → /management/dashboard, /management/dashboard/tail,
    /management/dashboard/token-heatmap, /management/dashboard/models,
    /management/dashboard/providers, /usage/events
```

The pipeline exists because CPA's queue is destructive and short-lived: the only
safe ordering is "persist the raw payload first, interpret it later". A failed
local write records an `ingest_gaps` row so coverage loss is visible instead of
silent, and `usage_inboxes.status` (`pending → processed | failed | discarded`)
makes a decode failure retryable without losing telemetry.

`usage_inboxes` is the only place a payload can be replayed from, so the decode
step is serialised: `ClaimUsageInboxBatch` merely selects pending rows and
`usage_events.event_key` is intentionally not unique (CPA reports retries under
one `request_id`), so two concurrent decoders would each commit their own copy of
the same payload. `ingest.Processor.drain` is that gate, which is why both the
background loop and a manual sync go through it; it is a channel rather than a
mutex so a manual sync waiting for the background loop still returns on its own
deadline.

`internal/usage/ingest.Runner` picks its transport in `auto` mode by probing
`AUTH` only — never by popping, because a probe that consumed a record would
destroy it. Subscription is preferred; repeated `SUBSCRIBE` failures degrade to
RESP `LPOP`, and an unreachable RESP endpoint degrades to the HTTP usage queue
(`/v8/management/observability/usage/queue`). Empty pulls back off through `pullPacer` (1s → 2s →
4s → 8s → 10s, then capped) while a full batch drains with no delay. A wrong
management key triggers a long cooldown instead of retrying, because CPA bans a
client IP after repeated failures.

### Manual sync versus background collection

The request list reads Oh My CPA's own database, so a manual refresh that only
re-read it could never show a request CPA accepted a moment ago. `POST
/usage/ingest/refresh` therefore drains CPA first: `ingest.Pipeline.RefreshNow`
hands a request to the collector goroutine (a second consumer would divert
records from a live subscription and race the poll loop on the same destructive
queue), waits for the pass, then runs a decode barrier until the inbox rows that
pass could have produced are no longer `pending`.

Five properties are deliberate:

- The manual pass is served by the collector's goroutine, never by the HTTP
  handler, and it persists under the collector's context while only *asking* CPA
  under the caller's: payloads already popped cannot be put back, so a caller that
  stops waiting must not abort the write, but a caller that stopped waiting also
  stops asking for more.
- A manual failure is returned to `Run` rather than swallowed, so the backoff and
  the wrong-key cooldown still govern it. An operator who clicks refresh five
  times must not spend CPA's five-strike ban budget.
- In `subscribe` mode the pass moves whatever the reader has already buffered
  into the batch, then drains the reconnect-gap residue through the same bounded
  multi-batch loop the poll path uses. A live subscription suppresses CPA's
  enqueue, so a pop alone would report "nothing new" while freshly pushed records
  waited for the next flush tick; and a single pop would report a clean sync with
  an older backlog still queued.
- The decode barrier is scoped by a watermark (`MAX(usage_inboxes.id)` taken after
  the pass). Waiting for `pending == 0` instead would only finish during a lull,
  because records keep arriving while the refresh runs.
- `synced` requires that nothing captured at or below the watermark was parked as
  undecodable. A poison payload leaves no event, so a barrier that ignored
  discards would promise records the list can never show.

The endpoint answers with `synced` plus the reason it could not sync, and an
already-running sync gets a 409 rather than queueing a second identical drain.

### Who resolves the request list's window

A sync only helps if the read that follows can see what it stored. Records carry
CPA's own `timestamp`, which shares the server's clock; the browser's clock is a
different one and can run minutes behind it. The request list and its facets
therefore send the window as the reader chose it - `preset`, or `from` plus a
`to` only for a closed range - through `eventWindowQuery` in
`web/src/types/usageEventQuery.ts`, and `dashboardWindowFromRequest` resolves
"now" on the server, the same contract the dashboard's `dashboardRangeParams`
follows. When the list sent an end resolved on the browser's clock, a browser
running behind filtered out every record newer than that clock: a request that
had just completed stayed off the list through any number of refreshes, and
appeared only once the browser's clock passed its timestamp. The header's printed
window is still estimated in the browser, because it is display only.
Its deadline is capped below the server's write timeout, so a slow sync cannot
outlive the connection carrying its answer.

Timestamps in the usage tables are epoch **milliseconds**; the older identity
tables use `unixepoch()` seconds. Rollups are gated by
`usage_aggregation_checkpoints` so aggregation is incremental rather than a
full rescan.

**A window may only be served from a rollup whose grain is no finer than the
requested bucket.** The rollups are hourly and daily; the dashboard's short presets
ask for buckets well under an hour (15m and 1h resolve to one and two minutes, 6h to
ten, 24h to thirty). An hourly row cannot be split across that grid: every rollup
timestamp is already a multiple of any bucket dividing an hour, so re-aligning maps
the whole hour onto its first bucket and reports the rest as zero. That failure is
quiet — the window total stays correct, so sum-based assertions pass while the chart
shows one spike per hour and nothing where the traffic actually was. `QueryUsageAnalytics`
therefore reads the detail rows whenever `bucketMS < grainMS`, and keeps the rollup
for hourly and coarser grids, where slicing is honest and the rollup earns its keep.
The detail path is bounded by the retention window, so it cannot grow without limit.

### Why the model breakdown reads one source, not the rollup split

The dashboard's two model panels - the per-model token trend and the model-usage ring - are served by
their own endpoint, `GET /management/dashboard/models`, with its own query, its own refresh cadence and
its own failure mode. Three properties make it the wrong thing to attach to the KPI response, and each
is the same reasoning ADR 0005 recorded for the token grid.

**It is the page's most expensive read.** `QueryUsageModelBuckets` aggregates the *detail* table by
model and bucket. `QueryUsageAnalytics` deliberately splits its window at the aggregation checkpoint
and reads the two halves from different tables - but that split is not reusable here, and reusing it
would be wrong rather than merely slower. Its boundary is a *timestamp*, while the rollup's unit of read
is a whole row whose start may precede that boundary: an event timestamped inside an already-folded
hour that arrived late (CPA event times can arrive out of order) sits on the detail side of the boundary
while its own hour is already inside the rollup, so both halves count it. In a windowed total that
artefact is a quiet double count; in a per-model *ranking* it also reorders models, which is the kind of
wrong that still looks plausible on screen. One source has no boundary to get wrong.

**It moves on its own cadence.** The KPI tiles poll through `/management/dashboard/tail` as often as
every five seconds; that poll recomputes the window's aggregates, and for grids at or above the rollup's
grain it reads them from the rollup rather than from individual events. Attaching a detail-table scan to
it would multiply the page's heaviest query by twelve to redraw a ranking that changes when a caller
switches models, which is not a second-by-second event. The panels poll on a one-minute interval for a
sliding window and not at all for a closed one.

A closed range has fixed **bounds**, not immutable contents: records are still arriving, and retention
can prune the far end. Its panels are simply not re-read on a timer, so they show what the range held
when it was last fetched - which is why the page's refresh button reaches them.

**It is allowed to fail alone.** An unavailable read leaves the six tiles and the activity grid beside
it readable, which is the same reasoning that put `partial_errors` on the overview and gave the heatmap
its own endpoint.

**The grouping is the request's, not the panel's.** The endpoint takes `group_by=call|model` (default
`model`, and an unknown value is a 400 rather than a silent fall-back, so a typo cannot quietly change
what the numbers mean). The call view partitions rows by call point - the model alias a client
requested, falling back to the upstream model name when no alias was set - so one call point served by
several upstream variants reads as one line, the way the deployment's own vocabulary names it; the
model view partitions by the upstream model name exactly as CPA recorded it. The choice rides in the
query because ranking and folding are the server's single answer for exactly one grouping - a
client-side regroup of one ranking could not also re-rank, re-fold, and re-assign colours without
duplicating the fold logic and letting it drift from the server's. The response also carries each
group's priced spend (`cost_usd`, null when nothing in the group was priced) and `priced_requests`,
summed only over rows priced at request time, so an unpriced-heavy window cannot present a partial
spend as the whole.

Two details of the fold are load-bearing. The remainder group carries a `folded` boolean rather than a
reserved display name, because the label is the frontend's to translate and a deployment may
legitimately serve a model whose name collides with whatever that label is; a name-based test would
merge real traffic into the remainder or split it in two. And the ranking is tie-broken by model name,
because equal volumes are ordinary (two aliases of one model, or a window where one request hit each)
and without a total order the order would come from map iteration, reshuffling the legend under the
operator on every poll.

`BenchmarkUsageModelBuckets` pins the cost: roughly 0.23 s over 100 000 in-window detail rows and 2.6 s
over 1 000 000 on one development machine, against a 15-second handler deadline. Retention bounds a
row's *age* rather than how many exist, so those are the numbers to re-measure if the horizon or the
traffic profile changes.

### Why the daily token grid folds its own days

The dashboard's windowed read and the year-long token grid look like the same question at
two zoom levels, and they are not - which is why
`/management/dashboard/token-heatmap` is a separate endpoint with its own query.

Three properties of the windowed read make it the wrong tool for a calendar. Its window
slides, so the same series is a different span every time it is asked. Its grid is a
*bucket* grid (`dashboardBucketWidth`), chosen so a sparkline stays near 48 points, and
`QueryUsageAnalytics` reads its hourly or daily rollup whenever the requested bucket is
*at least as coarse as* that rollup's grain, and falls back to the detail rows when the grid
is finer - a rollup row cannot be split across a finer grid, so re-aligning one would report
the whole hour in its first bucket and the rest of it as zero. And the rollup is keyed on a UTC bucket start.

A day is not a bucket. Grouping hourly rows by an offset-shifted key cannot split a UTC
hour that straddles a local midnight at a fractional offset: India is `+05:30`, so local
midnight falls at 18:30 UTC - inside the 18:00 row. The same arithmetic is wrong for
every day on the far side of a daylight-saving transition, not merely the two transition
days, because a single offset cannot describe a span that crosses one.

`Repository.QueryDailyTokenTotals` therefore takes the days as exact instant ranges,
built by the handler from the effective OMC IANA zone with `time.Date`/`AddDate`, and reads the
detail table only. It does not reuse the rollup-plus-tail split either: that split is
correct for a bucket grid because the two halves partition by *time* against the same
grid, but a day boundary and an hour checkpoint do not line up, and CPA event times can
arrive out of order - a request timestamped inside an already-folded hour lands on the
detail side of the boundary while its own hour is already in the rollup, so a hybrid read
counts it twice. One source has no boundary to get wrong.

The cost is a scan of the detail table over the span, aggregated inside SQLite so at most one row
per day crosses into Go. The window is a rolling year of weeks, and the default retention horizon
(`OMCPA_USAGE_RETENTION_DAYS`) is 400 days so the whole window stays readable — the two are one
decision, since a shorter horizon would show the window's own beginning as carrying nothing. A day
with no stored record (pruned, or later this week than today) is reported as carrying nothing and
drawn as *unrecorded*, rather than as a measured zero that would claim the gateway was idle.
The panel calls it on a five-minute interval and on an explicit page refresh, not on the tail
poll's cadence. The final day's window stops at the read instant rather than at the following
midnight, so a record timestamped in the future cannot inflate today's total.

### Why the request list is ordered by `timestamp_ms`

The list's order is the column the reader sorts by eye, so the two must agree.
`ListUsageEvents` orders by `timestamp_ms DESC, id DESC`: the newest request time
first, with the row id as a tiebreaker.

`timestamp_ms` is when the request *started*, which is what the time column
prints, and that is exactly why the visible column has to be the sort key. An
agent request can run for minutes, so ordering by anything else puts a
long-running request above requests that began after it: the reader sees
`14:53:34`, then `14:52:57`, then `14:53:36` and concludes the sort is broken.
Measured against a real instance, ordering by row id inverted **1329 of 5464**
adjacent rows — about a quarter of the list.

The `id` tiebreaker is not optional. Several records can share a start time (a
client fanning out, or a second-granularity source), and without a total order the
keyset boundary would skip or repeat rows as the reader pages. The cursor is
therefore a composite `(timestamp_ms, id)` position applied as the row comparison
`(e.timestamp_ms, e.id) < (?, ?)`, not a single-column predicate. Cursors written
before this order existed carry only an `id`; `resolveEventCursor` looks the row's
timestamp up to convert them, and a cursor naming a row that no longer exists is
rejected with `ErrUsageCursorStale` (HTTP 409) so the console restarts at page one
instead of silently serving a page from the wrong place.

This order is served by `idx_usage_events_instance_time` (migration 018),
`(instance_id, timestamp_ms DESC, id DESC)`: the keyset predicate and the
instance/time window both read from it, and the plan is a covering index seek with
no temp B-tree. Migration 021's `idx_usage_events_instance_id` no longer serves the
list order; it remains the index for `id`-keyed lookups such as the ingestion
watermark behind the console's "N records arrived" pill.

That pill is the one place the two orderings still have to be told apart, because
"new records" means newly *recorded*, not newest request time. A request that
started an hour ago and finished just now is genuinely new while sorting far below
the first page, so the console counts arrivals against an ingestion id
(`?since=<row id>`) rather than diffing the rows it has loaded — which would report
"nothing new" while records were flowing in. On a real instance **5415 of 5515**
records sort below page one, so that distinction is the normal case, not an edge
case. The arrival count is resolved before the list scan, and the list result set
is closed before the function returns. With one SQLite connection, issuing the
count after the list could otherwise keep both statements on the same WAL
snapshot, so a record committed between polls would remain invisible until a
later transaction happened to replace it. The acceptance fixture covers the same
refreshing-window path without a second process writing after the app opens the
database: it seeds one future-dated row before startup, and a later poll admits
that row once the sliding window reaches it.

Request *time* is also the windowing key (`timestamp_ms >= from AND <= to`) and the
axis of every rollup and chart, so the list, the window and the charts all agree on
what the numbers mean.

### Client key aliases: one identity, two purposes

Operator-assigned names for gateway client keys live in `client_key_aliases`
(migration 022), keyed by `(instance_id, key_fingerprint)`.

The fingerprint is `usage_events.api_group_key`, which is `security.Fingerprint`
under the purpose **`usage-api-key`** (`repository.UsageClientKeyPurpose`). The
purpose is part of the HMAC input, so the same key hashed under a different
purpose is an unrelated value - and that is exactly what the key list used to do:
it fingerprinted under `client-key`, producing an identity that matched **no**
request record. An alias written against that value could never label anything.
`ClientAPIKeyItemDTO` therefore carries both: `fingerprint` (the legacy page value,
kept for compatibility) and `usage_fingerprint` (the joinable identity).

Three consequences shape the implementation:

- **Identity is the fingerprint, never an array index or a mask.** Reordering CPA's
  `api-keys` list moves an index, and a mask keeps only a short head and tail, so
  two keys can share one. Either would put one key's name on another key's records.
- **Aliases are never pruned.** Requests keep their `api_group_key` forever, so a
  deleted key's history still needs its name; an alias belongs to the identity, not
  to the current configuration. Renaming is read-time resolution, so it changes how
  historical rows read without rewriting a single usage record.
- **Alias writes never touch CPA's configuration.** Naming a key is Oh My CPA
  metadata with its own endpoint, because routing it through `PUT /config.yaml`
  would rotate the revision for every other editor and rewrite a secret the
  operator did not touch.

Resolution is a single batched `IN` lookup per page (deduplicated, chunked at 500
parameters), not one query per row, and it is best-effort: a failure leaves
`api_key_alias` empty and the console falls back to the mask rather than failing
the list. The fingerprint remains the filter identity, so a rename cannot change
what a saved filter or a drill-down link selects.

Because neither a mask nor an index can stand in for the value, the key list is
the one reader that asks the management API for it: `/management/api-keys` sends
`ClientAPIKeyItemDTO.Key` as a display mask unless the caller opts in with
`?include_keys=true`, which is the flag the provider list already uses. The key
page opts in, joins the overlay by that value, and keeps its own query cache entry
so the dashboard's key picker — which only needs the mask — cannot be served the
values, and the key page cannot be served the masks (ADR 0015).

### Provider traffic is credited by the serving key

A provider row's traffic number answers "how much did this provider serve", and CPA's
`provider` label on a usage record cannot answer it. For an API-key request CPA writes
the credential's *family* (`codex`, `claude`, `xai`, ...) — the same word it writes for
the family's OAuth channel — so one label covers several distinct providers at once, and
the matching it invites (family, display name, or substring) credits a provider that has
served nothing with another surface's traffic. The fact that does identify the key is
already in the record: the credential's runtime `auth_index`.

`/management/dashboard/providers` therefore answers with two lists instead of one.
`internal/repository/usage_model_analytics.go` groups the window by
`(provider_key, CASE WHEN auth_type = 'apikey' THEN auth_index ELSE '' END)`;
`internal/api/management_dashboard_providers.go` folds the empty-index rows into
`providers[]` by the label CPA wrote — the OAuth channels, and records that name no
credential — and the rest into `credentials[]`, one entry per key that served traffic.
A configured provider's traffic is the sum over the indexes of its own keys, which
the provider DTO publishes as `auth_indexes` (`internal/api/management_providers.go`),
plus whatever a label attributes to it — never a general claim on indexless records, which
carry no provider identity at all. Only an `openai-compatibility` row takes a label: exactly
the `openai-compatible-<name>` label CPA derives from that provider's own name, or, when the
row is one the console presents as an OAuth channel, that channel's label as channel rows have
always been matched. A `{family}-api-key` provider takes neither — not even when its display
name spells a family — because those records were served by different credentials, and family
labels belong to the family's OAuth channel. Only a name **CPA** carries makes a row a channel:
the display name is an operator preference the browser can change, so a rename must not hand a
relay the channel whose name it borrows.

Six properties are load-bearing:

- **The join is an identity, never a heuristic.** No family match, no display-name
  match, no substring and no "the provider's only key": each of those is wrong in the
  case this rule exists for — a second provider of the same family, or a provider
  created a moment ago — and a confidently wrong number is worse than a narrow one.
- **Every configured provider is its own row.** Rows are no longer merged or skipped by
  name, so two providers left at CPA's default name, and two keys of one family, each
  report their own count instead of collapsing into one row and a dash. Only an
  `openai-compatibility` row claims the gateway's label rows for its own name, which is
  the identity its requests carry; a configured key provider whose display name spells a
  channel is a different thing and leaves that channel's row standing.
- **A provider's credential count is its own** (`key_entries`, or `auth_indexes` for a
  key CPA reports without a mask). The gateway's per-type tally counts auth files, and
  several of those type ids are shared with the API-key families, so taking the count
  from there reported credentials the provider does not hold. The converse holds for a
  channel row: CPA also lists a runtime entry (account type `api_key`) for every
  configured `{family}-api-key` key under the family's type, so the overview's
  `credentials.by_type` reports that share as `api_keys` / `api_keys_disabled`. A
  channel row counts and reads only the auth files, a configured family row reads only
  its keys, and a type holding nothing but configured keys has no channel row.
- **A record that names no index is credited to nobody.** History written before the
  index was captured, and a record whose credential CPA no longer holds — it keeps the index it
  was served under, which no configured provider publishes — count toward no configured provider.
  They stay in the totals and in the request list. The alternative is inference, and inference is
  what produced the defect this rule exists for.
- **An index two providers both publish is credited to neither.** CPA derives a credential's
  runtime index from the credential itself, so one key entered twice under one name resolves to
  a single index. Crediting whichever row the list happens to put first would print a number that
  changes with the order of the provider list.
- **A label is an identity, at CPA's precision.** `deep-seek` and `deepseek` are two labels to
  CPA and stay two rows here; the console must not fold them through a normalizer that strips
  separators to look a label up, and it must keep the label the server folded rather than
  re-deriving it from a display name.

The provider page reuses this aggregation rather than reimplementing it
(`providerTrafficById` in `web/src/components/providers/providerOverview.ts`), so the
dashboard's panel and the provider list cannot credit one request to two different
rows.

### Provider key masks: which upstream key answered

A request record names its provider, and an operator reading it needs one more
fact — which of that provider's keys the request actually went through. CPA does
not put that key in the usage payload: it publishes the credential's runtime
`auth_index` and nothing else. The keys exist only in CPA's configuration, so the
mask is resolved on the server while the request list is read, and returned on each
record as `provider_key_mask`.

`internal/api/usage_provider_key_masks.go` owns that resolution. It reads the
credential lists CPA currently reports — the config API-key families and the
`openai-compatibility` providers — and indexes each one by auth index.

**The record's own provider label chooses the list, and an unrecognized label is not
a candidate at all.** CPA labels a config API-key credential with the family name
(`codex`, `claude`, `gemini`, `meta`, `xai`, `vertex`, `interactions`) and a
compatibility credential with
`openai-compatible-<upstream name>`
(`management.OpenAICompatibilityLabelPrefix`, the same constant the dashboard's
provider grouping uses). Those two shapes are what an attributable request looks
like; anything else — an OAuth-only provider, a family the console does not manage —
reads nothing, so an index that happens to collide across lists can never be answered
by the wrong one. Within each list the match is by index alone, deliberately:
renaming a compatibility provider in CPA changes the label on later records while the
credential, and CPA's index for it, stay the same, so a name-scoped match would
orphan history that is still perfectly identifiable.

Four properties are load-bearing:

- **It resolves against the configuration as it is read, not as it was at request
  time.** A credential that has been rotated or deleted since the request stops
  being offered as that index's owner, so that record prints nothing once the cached
  read of its list expires — at once if the operator removed it through this console,
  and within the TTL if it was changed outside it. The console cannot reconstruct a
  key it can no longer read, and a plausible-looking mask would be a fabrication
  rather than a display label.

  A provider that has merely been **switched off** is deliberately not treated as a
  removal. CPA reports no auth index for a disabled compatibility provider, so such
  an entry claims nothing anyway, while filtering on the flag would additionally hide
  the key of a request served *before* the provider was switched off — the provider's
  current state is not part of the credential's identity, and that label is a true
  fact about the request rather than a wrong one. An index claimed by both a disabled
  and a live entry resolves to nothing, so the protection that matters is kept.
- **Nothing is guessed.** An index no entry claims, a key CPA reports without an
  index (the compatibility list's legacy `api-keys` array), an index two entries
  claim, a record with no index at all, and a provider that has exactly one key but
  does not claim the record's index are all left empty. The duplicate case is resolved
  to nothing even when the two masks are identical, because neither an index nor a
  mask is an identity — the same rule the resource join follows.
- **Only an API-key credential has one.** An OAuth record names the account it used
  instead, and its index lives in the same column, so an auth-type check stands in
  front of the lookup. The mask is display only, is stored on no row, is never a
  filter value, and the property is absent rather than empty when nothing was
  resolved; only `security.MaskSecret` output ever leaves the process, and a failed
  read is reported through the same public classifier every other gateway failure
  uses, because a management error body can echo the credential it rejected.
- **It is best effort and bounded.** The lists are read at most once per TTL, one
  read is shared by concurrent pages, failures are negatively cached, and the whole
  enrichment has its own short deadline. A gateway that is down, slow or missing a
  family leaves the masks empty and returns the request list unchanged, because a
  display label must not be able to fail the page whose job is to show request
  history. A write through this console drops the cached read, so an edit is
  reflected immediately; a read that was already in flight when that write landed is
  withheld as well as not stored, since the list it saw is the one being replaced.

### Streaming status and throughput (TPS) derivation

CPA usage payloads include a boolean `stream` field indicating whether the request
was executed in streaming mode. Oh My CPA records this in `usage_events.stream`
(migration 023) as a nullable integer: `1` for streaming, `0` for non-streaming,
and `NULL` for historical rows where the flag was not captured.

The flag is operational metadata, not a sufficient classifier for TTFT validity.
An upstream executor can capture a real first-token event even when the client
requested `stream: false`, while an apparently streaming request can still receive
its whole payload in one chunk. Throughput therefore keys on the observed residual
window rather than the recorded mode:

- When `latency_ms - ttft_ms >= MIN_STREAMING_GENERATION_WINDOW_MS` (50 ms,
  defined in `web/src/types/usageEventMetrics.ts`), `ttft_ms` is treated as a genuine
  generation boundary and TPS is `output_tokens * 1000 / (latency_ms - ttft_ms)`.
- When TTFT is missing or the residual window is collapsed, the response was not
  observed progressively enough to isolate generation. TPS falls back to
  `output_tokens * 1000 / latency_ms`, and presentation omits TTFT and uses a
  single total-duration bar in the drawer waterfall. This prevents timer artifacts
  such as 768,588 t/s on a 13k-token response.

The request list and detail drawer show a non-stream badge when an explicit
`stream: false` record has no measurable TTFT or when the observed residual window
collapsed. Historical records (`stream IS NULL`) use the same residual-window
heuristic, preserving genuine legacy generation rates without inferring a
first-token boundary from a completion-only measurement.

### 6.1 The request-record filter vocabulary

`UsageEventFilter` in `internal/repository/usage_events.go` is the single filter
vocabulary for the whole request-record feature set. Dimensions combine as AND;
values inside one dimension combine as OR, so an empty list means "do not narrow
this dimension" and a cleared multi-select is indistinguishable from one that was
never set.

The console sends a multi-select as a **repeated query parameter**
(`?model=a&model=b`), never as a delimited list. A comma is a legal character in
a model name, a source label and a caller mask, so splitting on one would corrupt
the exact values being filtered on. A single occurrence still parses, which keeps
drill-down links written before multi-select existed working unchanged.

| Dimension | Wire parameter | Match |
| --- | --- | --- |
| Model / alias / provider / caller key / auth index / source / auth type / executor / reasoning effort / service tier | same name, repeatable | exact, OR within the dimension |
| Identity search | `q` | literal substring across the columns in `usageEventSearchColumns` |
| Endpoint, user agent | `endpoint`, `ua` | literal substring |
| Request id | `request_id` | exact |
| Latency / tokens | `latency_min`…`tokens_max` | inclusive integer bounds |
| Cost | `cost_min`, `cost_max` | inclusive bounds in decimal USD, at most nine fractional digits |
| Price availability | `cost` | `priced` (`cost_nanos IS NOT NULL`) or `unpriced` |
| Result | `result` | `all`, `success`, `failed` |

Three properties are load-bearing rather than incidental:

- **The search is literal.** `%` and `_` are escaped with an explicit
  `ESCAPE '\'`, because SQLite's `LIKE` has no default escape character:
  untreated, searching for `50%` would match every row and `gpt_5` would also
  match `gpt-5`. The disjunction across columns is parenthesised, or its loose
  `OR`s would bind more weakly than the surrounding `AND`s and silently drop
  every other filter.
- **Bounds are pointers.** `0` is a meaningful bound (`max_cost=0` selects the
  records priced at nothing), so it cannot double as "unset". `cost_nanos` is
  compared directly, which means an unpriced row satisfies neither a lower nor an
  upper bound — it is reachable only by asking for `cost=unpriced`. Cost bounds
  arrive as decimal USD and are scaled to integer nanos in string form, so a
  bound of `0.1` cannot land below the value it was meant to include. Precision
  is **refused rather than rounded**: a bound of `0.0000000001` exceeds what the
  column stores, and rounding it to zero would answer a real constraint with "no
  cost at all". The console therefore carries cost bounds as decimal strings end
  to end — field, URL and preference document — because a nano-dollar amount does
  not survive a round trip through a double.
- **Diagnostic values are protected, not list fields.** `client_ip` and
  `x_forwarded_for` are preserved as the exact peer address and complete valid
  proxy chain for the single-record detail view, while list payloads and the
  shared search box omit both. `endpoint` is likewise available only on detail.
  `source` and `api_group_key` are fingerprinted at the persistence boundary, so
  a filter matches the stored fingerprint the facet offered, never the plaintext.
  Historical rows written under the earlier `/24` and `/64` policy remain masked;
  they are not guessed or backfilled.
- **Address projection is shape-tolerant and explicit.** `NormalizeClientIP`
  accepts IPv4, IPv6 and valid host:port forms and removes the transport port;
  `NormalizeForwardedFor` keeps every valid hop in order. An endpoint arrives as
  the request line CPA handled (`POST /v1/chat/completions`), not as a bare path,
  so `PublicEndpoint` keeps the method while stripping query, fragment and
  authority credentials. Round-trip tests run a raw payload through decode *and*
  insert, proving the protected detail value survives both boundaries without
  widening the list contract.

### 6.2 Facets

`GetUsageFacets` enumerates the values actually present in a window so a dropdown
never offers a choice that returns nothing. A single SQL statement materializes a
narrow `facet_window` CTE from the indexed instance/time window, then groups each of
the ten dimensions over that relation instead of walking the wide detail table ten
times. Each dimension still excludes only empty values, orders by count descending
and value ascending, and caps at 200. Caller-key masks retain the maximum nonempty
stored mask and normalization; empty results remain arrays. All dimensions share one
statement snapshot. Materialization uses SQLite temporary storage proportional to
the selected rows; no unbounded Go cardinality map or connection change is introduced.
`BenchmarkUsageFacets`, `BenchmarkUsageFacetsStrategies` and
`BenchmarkUsageFacetsNarrowWindow` track sparse, populated/high-cardinality and selective
windows. Endpoint and user agent are deliberately **not** facets: both are
long, high-cardinality values where a typed substring beats a capped 200-row list,
and the endpoint must never be handed to the browser at all.

Facets are read on their own window revision rather than on the list's poll
counter, and are cached with a five-minute `staleTime`. They describe which values
exist in a window, so they change only when the window is redefined (a new preset
or absolute range) or the operator refreshes explicitly — not on each list poll.
That manual refresh is the same sync described in §6: the page waits for the pull
and the decode barrier, then re-reads the list, the facets and the pipeline status.
The window is sent unresolved (see "Who resolves the request list's window"), so a
preset is the same parameters on every visit. The facet query key therefore also
carries a revision stamped when the window is defined and on each manual refresh,
and nothing else: a filter change keeps the cached entry, because the facet read
carries no filter, while a re-entered preset or a refresh is never answered from an
entry still inside its `staleTime`.
`scripts/browser-probes.mjs` asserts this directly: a manual refresh issues
a `POST` to `/usage/ingest/refresh` *and the list and facet reads wait for it*.
Request counts alone cannot establish that ordering — a page that fired all three
in parallel would still issue all three — so the probe holds the pull's response
open and requires that no list or facet read happens while it is held. Because the
response is capped at 200 values per dimension, a value that is selected but absent
from it is merged back into the options, so a filter that is still applied never
renders as a blank control.

### 6.3 Grouping the request list

The list offers three modes: chronological (`time`, the default), `source`, and
`ua`. `source` merges what used to be two separate modes, "by provider" and "by
credential": they were the same axis at two zoom levels, so one mode buckets on
provider-plus-credential and decides per provider whether the credential half is
worth printing. That decision is a property of the *page*, not of one bucket —
`providersWithMultipleAuthSources` answers it for every provider in the loaded
window — so a line served by a single credential reads as the provider alone
while a line split across two names both.

Grouping keys and labels are computed in `web/src/types/usageEventGrouping.ts` and
`web/src/types/usageEventLabels.ts`, which is what the logic test harness loads,
and are pinned there rather than by reading the DOM. Two properties matter beyond
the labels:

- **The stored preference migrates.** `parseUsageEventsView` maps the retired
  `provider` and `credential` values onto `source`, so an operator returning to a
  saved view keeps it instead of being silently moved to chronological order. An
  unreadable value falls back to `time`, which is the mode that never hides a
  record.
- **Unknown is a bucket, not a drop.** A record with no provider, no credential or
  no user agent is grouped under `unknown` and keeps its own header, because
  "nothing was recorded" is a fact about the record worth seeing.

The UA mode uses the stored `user_agent` verbatim: the value was already reduced
to a short product label on the persistence path, so grouping must not re-parse a
raw header or widen what was deliberately minimised.

## 7. Pricing flow

The catalog, the editable current price, and the immutable version history are
separate things (ADR 0003); OpenRouter is the only automatic source, and a price
carries tiers and is scaled per channel (ADR 0030). The design, matching chain
and limits are in `docs/plans/model-prices.md`.

The CPA discovery sweep returns both alias targets and non-secret provider membership. Migration 029 adds `pricing_catalog_state.providers_json`; the repository publishes that metadata in the same transaction as `pricing_model_catalog`, and pricing access requires migration 029. Empty price targets represent ambiguous aliases and are valid catalog entries but cannot auto-match. Provider metadata carries only the endpoint hostname for existing brand-icon resolution, never URL credentials, paths or query strings. The pricing response projects provider display-name/icon overlays locally; no per-model or per-credential network requests are made by the workbench. The existing `pricing_list` capability also returns membership for the models in its current page.

The price book groups by actual configured API-key/OAuth providers, orders groups by routing priority then name, and renders at most 20 model memberships per page across all groups. Provider marks appear only in group headings, with individual models rendered as text. Search and filters reset pagination on both viewport layouts. The shared `ResponsiveList` also controls and clamps desktop and phone page state consistently.


```text
CPA catalog read ──▶ pricing_model_catalog      (last complete snapshot)
                          │
openrouter.ai/api/v1/models ──▶ pricing_upstream_catalog (last complete download)
                          │
                          ▼
                   pricing.Service ──▶ model_prices ──triggers──▶ model_price_versions
                   (auto match, pins in                           (immutable, time-effective)
                    pricing_model_links;
                    custom rows win)
operator ──▶ pricing_channels ──triggers──▶ pricing_channel_versions (immutable)
```

`usage_events` stores, in the event's own insert transaction and by the request
timestamp, the price version id, the channel version id (absent means 1×), the
index of the tier the request qualified for, and integer USD nanos computed by
`pricing.Quote`. Historical totals never join the mutable tables, so a later edit
cannot rewrite an invoice. A request with no effective price version is stored
with pricing status `unpriced` (`legacy_unpriced` for rows that predate migration
019), cost absent, and is never backfilled. The request detail recomputes a
breakdown from the locked versions for display; the stored amount stays
authoritative.

A sync downloads outside the write lock, then re-reads prices and pins under it,
so an operator's pin set during the download is honoured. Catalog reconciliation
every five minutes prices a model CPA starts serving from the stored snapshot,
without reaching the network. Every surface that shows a cost opens the same
price editor in place (`web/src/components/pricing/`).

## 8. Quota flow

`internal/quota` calls CPA's `/api-call` with the credential under observation to
reach the provider's own usage endpoint. Targets are restricted to
`AllowedURLPrefixes` — a compile-time allowlist of official HTTPS endpoints — and
the resulting snapshot is normalized and stored in `quota_snapshots`. This is the
only place Oh My CPA uses CPA as a request proxy, and it is server-initiated:
there is no user-supplied URL or generic `/api-call` surface.

A provider is observed only once `internal/quota` both recognizes it
(`DetectProvider`) and implements its probe; a credential whose provider has no
probe is reported with `refresh_supported: false` rather than as a failed fetch.

Normalization never lets an exhausted window make another look exhausted. Codex
flags a whole rate limit as reached (`limit_reached` / `allowed: false`) without
saying which window tripped, while still reporting each window's own
`used_percent`. `ParseCodexUsage` therefore attributes the flag per window
(`exhaustedFlags`): a window with its own reading keeps it, a window with no
readable usage is pinned to 100%, and when every window reports usage below 100
(upstream rounds) only the most used one is pinned. The rule applies alike to the
standard, code-review and additional per-model rate limits; the domain definition
is **Quota Window** in `CONTEXT.md`.

A plan's renewal instant is carried with its provenance. Codex probes the
subscription endpoint on every refresh and records `expires_source:
live_subscription` when it answers, so an expiry the usage payload happens to
carry is still replaced by the fresher reading. When that probe fails, an expiry
the usage payload already supplied is kept without a source — it is current but
has no verified provenance — and only a plan with no expiry yet falls back to the
credential's `id_token` claim, recorded as `credential_snapshot`, because upstream
only ever moves that window forward and a token can be minted after the period it
still describes. The console renders a snapshot as a `≥` bound with an unverified
marker and never as a countdown, so a stale claim cannot read as a verified
renewal date.

Codex reset-credit redemption is offered in the credential Drawer's Quota tab and never
from a list row, because it spends an irreversible entitlement; it is offered whenever the
credential's available credit count is positive. Upstream's `applicable_available_count` is not the
gate, and the consume response is what states the outcome. The redemption POST carries the same
`Chatgpt-Account-Id` the read probes send, so the redemption is scoped to the same
account as the reading it was decided from.

## 9. Storage

| Table group | Tables | Notes |
| --- | --- | --- |
| Instances & identity | `cpa_instances`, `discovered_resources`, `resource_overrides`, `connections`, `cpa_bindings` | Encrypted management key; bindings survive upstream removal. `connections` is provisioned by migration 006 for the Connection entity but no code reads or writes it yet — treat it as reserved, not as a live table |
| Usage | `usage_inboxes`, `usage_events`, `error_events`, `ingest_gaps`, `usage_overview_hourly_stats`, `usage_overview_daily_stats`, `usage_aggregation_checkpoints` | Milliseconds; raw payloads encrypted |
| Custom icons | `custom_icons` | Migration 032 adds durable sanitized image BLOBs, stable IDs and content revisions; confirmed deletion atomically clears matching provider overrides and deletes the asset |
| Pricing | `model_prices`, `model_price_versions`, `pricing_sync_state`, `pricing_model_catalog`, `pricing_catalog_state`, `pricing_model_links`, `pricing_upstream_catalog`, `pricing_channels`, `pricing_channel_versions`, `pricing_match_reviews` | Price and channel versions are append-only via triggers; migration 028 added tiers, links, the stored OpenRouter snapshot and channels, and `usage_events.channel_version_id`/`price_tier`. Migration 029 added `pricing_catalog_state.providers_json`; the pricing repository refuses to run before migration 29. Migration 031 added `pricing_match_reviews` (the OpenRouter model last answered for a custom or linked price); match-review reads and writes refuse to run before migration 31 |
| Agent | `agent_documents` | Encrypted latest Agent session and capability operations (migration 026). Sessions are capped and trimmed by whole turns; terminal operations are retained 7 days and purged lazily during Agent requests |
| Operations | `audit_events`, `ui_preferences`, `quota_snapshots`, `schema_migrations` | Audit has no update or delete path — only `RecordAuditEvent` writes and read queries (`ListAuditEvents`, `QueryAuditEvents`) exist, and export itself is audited; the schema carries no enforcement trigger, so the guarantee lives in the repository API. Migration 027 adds `idx_audit_events_request_action`, which the trail's attempt folding looks up |
| CPA configuration | `cpa_config_backups` | Encrypted copies of pre-v8 CPA configuration files kept before the write that converts them (migration 030, ADR 0037); the latest ten are kept, and the table is hidden from `database_query` |
| Release observation | `release_index`, `release_check_state` | Migrations 024 and 025; `truncated` is added by 025, so a database that applied 024 before it existed still gains the column. `release_index` holds one row per published version (tag, name, publication time, prerelease flag) and is **replaced as a unit per product** by `PublishReleaseSnapshot`, because a feed that stops listing a withdrawn release must stop the console claiming it exists. `release_check_state` holds one row per product — the last attempt and success times, the redacted failure reason, the latest tag, the ETag and the truncation flag — and is written by `RecordReleaseCheckAttempt`/`PublishReleaseSnapshot`/`RecordReleaseCheckFailure`, read by `ListReleases` and `GetReleaseCheckState(ForRepository)`. A release's prose body is **never stored**: it lives in bounded process memory for the life of the process, so an index without notes still names the versions and links to the source (see §10) |

`GET /management/system` resolves the gateway client once and runs its reads side by side
- both products' version states, the gateway's health round trip, the credential list (read
once for both the gateway's version header and its credential count), the plugin and
provider counts, and the database, collector, record-count and admission reads - so the page
waits for its slowest read rather than for the sum of them.

The management system surface is five routes: `GET /management/system` (the page),
`GET /management/system/releases` (one product's merged change log), `POST
/management/system/check-updates` (a check, subject to the floor), `GET
/management/system/maintenance` (the running or last job) and `POST
/management/system/maintenance/{checkpoint,vacuum}`. The check answers `200` with the two
products' states and `served_from_cache`; a maintenance POST answers `202` on admission,
`409` when a job is already running, `507` when a rebuild cannot be admitted for space, and
`503` once the service is shutting down. Every one of them answers `503` when the handler was
built without the corresponding service, which is how a deployment that does not offer the
surface behaves.

Migrations are embedded from `migrations/` and applied in filename order inside
one transaction each. A migration against an existing on-disk database first
writes an AES-GCM backup plus SHA-256 sidecar, restores it as a smoke test, and
keeps the newest five. The gate that decides whether a backup is needed reads
`schema_migrations` first, and an unreadable schema state - a failed
`sqlite_master` lookup, or a table that exists but cannot be counted - is treated
as "back up first" rather than as "nothing applied yet". The smoke test likewise
refuses to pass when the sidecar digest is missing, because an unverifiable backup
is not a recoverable one. Migration 004 additionally runs a Go governance hook
inside its transaction to sanitize historical rows. Rollback is forward-only:
fix a defect with a new migration, never by editing `schema_migrations`
(`docs/ops/sqlite-operations.md`).

## 10. Background loops

| Loop | Owner | Failure behaviour |
| --- | --- | --- |
| HTTP server | `app.Run` | Fatal; shutdown drains 10s |
| Usage pipeline | `app.Run` → `ingest.Pipeline` | Fatal; a stopped collector must not serve silently stale numbers |
| Pricing sync | `app.Run` → `pricing.Service` | Best effort; prices go stale, capture continues |
| Release sweep | `app.Run` → `release.Service` | Best effort; the stored index and its timestamps go stale, and the page says so. Every six hours, first run delayed by one interval so a restart loop cannot become a request loop |
| Rollup + retention | `ingest.Maintenance` inside the pipeline | Retried on its own interval; errors surface in ingest status |
| Database maintenance | `repository.MaintenanceService`, started by an operator request | Never started automatically; a job's outcome is retained in process memory and recorded on the audit trail. The retained record is served by both reads, and the console shows only a job it observed rather than that record — see §11 |

A demo deployment starts only the HTTP server: its history is the fixture, so there
is no collector to lose and no sync loop to let prices go stale. §13 and
`internal/demo` explain what replaces them.

The release sweep is the only loop that talks to a host outside the deployment's own
gateway, and it is the one loop whose absence is invisible rather than harmful:
without it the page shows the last known index. It can be switched off with
`OMCPA_UPDATE_CHECK_ENABLED=false`, which stops the sweep while leaving the page's own
check and the manual button working — those are an operator asking a question rather
than the process deciding to reach the internet.

`OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false` is separate because it answers a separate question: may
opening a page spend a request from a budget shared per address? A self-hosted deployment wants
that enabled — the page exists to answer "is there a newer version" — while an air-gapped install
or a test suite wants it off, since a page visit there is not a reader asking anything. The manual
button is unaffected by either switch. The acceptance harness sets both, and the reason is worth
recording: disabling the sweep alone does not stop the traffic, because the sweep's first run is a
full interval away and the suite visits the page that checks on open.

### What a stored failure may contain

A failed check records a redacted reason: one `security.RedactText` copy serves the stored
`last_error`, the `CheckError` the page renders, and every log line, because all three can leak and
a raw form kept for one of them defeats the other two. The reason is a remote response, and a feed or
a proxy can echo back a token it was sent.

The redactor's vendor-prefix rule had a gap worth recording: it matched only a hyphenated separator,
so `ghp_...` - the shape a GitHub API error actually carries, and this feature reads GitHub - passed
through untouched. It now accepts the separators the real prefixes use, and it has positive and
negative controls; it had no test before, which is why the gap survived.

### Why a check has a floor

`CheckFloor` is fifteen minutes, and every path that reads the feed passes it. The feed is
one shared per-address budget — sixty requests an hour for the unauthenticated GitHub API —
while the page is loaded far more often than a release is published. A check costs one
request per product and a second only when a feed's first page is full, so an unthrottled
page-load check spends up to four requests per view: fifteen views exhaust the allowance for
every client behind that address. That is what happened, and it is how the floor was
calibrated.

Inside the floor a check is answered from the stored index and reports `served_from_cache`,
so the button says the result was cached rather than claiming a check it did not perform. The
floor is measured from the last attempt rather than the last success, because a failing feed
is when an operator reloads most and re-learning the same error would spend the budget twice.
The six-hour sweep is exempt by construction: it is far outside any floor.

### The release check does not store release notes

A release's Markdown body is held in process memory and nowhere else. The index —
tags, names, publication times, prerelease flags — is stored, because that is what
answers "is there a newer version" after a restart or while offline. The notes are
not, and the page states which of the two it has: an index with no notes still names
the versions and links to the source, while an empty log would claim nothing changed.

Two details follow from that split. A `304` from a conditional request is only
trusted while the process still holds the body the validator describes, so stored
ETags are cleared at start-up and the first check after a restart is unconditional.
And a failed check never clears the stored index or the last-success time: the page
keeps the previous answer and reports the failure with its reason and the time of the
attempt, rather than going blank or presenting stale data as current. The routine
"last checked" readout was deliberately dropped from the cards - it was the same
timestamp on every one of them - so staleness is now something the page states when a
check fails rather than a number a reader has to interpret.

## 11. Database maintenance and the write gate

### A retained job status is not the reader's result

The maintenance service keeps the last job's status in process memory for the life of the
process, and **both** reads answer with it: `GET /management/system` and `GET
/management/system/maintenance` describe one server holding one job. That retention is what
lets a reload after a rebuild still show its numbers, but it is not a result the reader
asked for, and presenting it directly has a defect the retention cannot fix — the panel
then belongs to a job from an earlier session, and reloading re-reads it, so the reader can
never put it away.

The console therefore separates the server's **retained status** from the page's own
**displayed outcome**. The running banner is drawn from live server status and is always
shown, including for a job that was already running when the page opened: it is the only
evidence that a Maintenance Action holds the write gate, and it must not be dismissible. The
completed panel is instead drawn from a local snapshot, set only when a job this page
observed reaches its terminal state. A job is observed when the page starts it, or when a
server snapshot reports it running and the page adopts it — so a second tab or another
client's job is still followed to its outcome. Adoption looks at **every** snapshot rather
than only the first one, because a job admitted elsewhere after the page was opened is
invisible until a refetch reports it; skipping the job already being observed is what keeps
a repeated refetch from restarting a poll that is already following it. A terminal status is
accepted only for the job being observed, or for a job that superseded it, recognised by the
server's `job_id` — the reservation the job was admitted under, which is monotonic within the
process. That id is what the page compares rather than the start time, because the start time
is the wall clock: two jobs can share a millisecond, and a synchronised clock can step
backwards, either of which would make a later job look like one already handled and drop its
result. A job that **started later** than the observed one is accepted as well, and becomes the
observed job: a fast job can finish and be replaced inside a single poll interval, so the first
sign of its replacement is that replacement's own terminal record. Without that rule the page
would drop the newer result and keep polling for a job the server had already moved past —
verified in the browser, where the exact-match guard reported `0` outcome panels across `23`
polls. "Admitted later" is the accurate phrase here, not "started later": the ids are handed out
at reservation, which precedes the launch.

Adopting a running job also **seeds the poll's cache** with that job before polling is
enabled, because while polling is enabled the card reads that cache rather than the page's own
snapshot. A cache still holding an earlier job's terminal record otherwise hid live work: no
in-progress banner, and maintenance actions that looked available while a job held the write
gate. The browser probes hold the first poll open for ten seconds and assert the banner and the
disabled actions inside that window, since after the poll answers the record is correct
either way.

Dismissing the outcome clears only that local snapshot, and both the close control and the
page's Refresh button clear it. Since the snapshot is local, neither the server's retained
record nor a later refetch can resurrect a result the reader has put away, while the next
real job still produces a new one.

The terminal status is handled **once per job**, and the guard sits before the outcome is set
rather than after it. That ordering is the whole of the guarantee: the effect names the
translation function among its dependencies, so changing the interface language re-runs it
while the terminal record is still cached, and a guard placed after the outcome was set would
put back a result the reader had already dismissed. The job is recognised by the server's
`job_id` and not by its finish time, which the backend assigns from the wall clock and does
not promise to be unique.

Because the ids come from a counter that begins again with each process, the page also records
which process those ids describe (`runtime.started_at_ms`) and clears its observed and reported
job when that changes. A restart can otherwise mint an id the page has already handled, and the
new process's job would look like one already dealt with — its result never shown. The probe
asserts this **without reloading**, since a reload resets the page's own state and would hide
the confusion being tested.

Two operator-issued actions rewrite the database: `PRAGMA wal_checkpoint(TRUNCATE)`
and `VACUUM`. Both are offered from the System Information page and both are
guarded by a write gate, because the failure mode without one is not a slow request:
`internal/usage/ingest`'s flush records an ingest gap and returns an error, and
`app.Run` treats a stopped pipeline as fatal on purpose, so a writer that lost a
race against a rebuild would take the process down with it.

SQLite's own locking cannot express the boundary. Under WAL a reader never blocks a
writer and a writer never blocks a reader, and `busy_timeout` makes a blocked call
retry rather than stopping a writer from starting. So `internal/repository` wraps
its driver: a statement that is not provably a read passes a gate that maintenance
holds exclusively, writers wait rather than fail, and a queued writer can abandon its
wait when its own context ends.

The classification is deliberately asymmetric and deliberately narrow — only `SELECT`,
`VALUES` and `EXPLAIN` count as reads. `PRAGMA` is gated whatever its argument, because
the family mixes reads and writes. `WITH` is gated even when the statement selects,
because a common table expression can introduce an `UPDATE`, `DELETE` or `INSERT` and
its first keyword does not say which. A string containing a second statement is gated
however it starts, because a first-keyword classifier cannot see past the first
statement at all. Each of those refusals costs one wait during a rebuild; the direction
that would be cheap is the direction that can terminate the process.

Seven properties of the arrangement are load-bearing:

- Maintenance runs on a context marked as the holder's own (`withMaintenanceContext`),
  because a maintenance statement that passed the gate again would queue behind the
  exclusivity it already holds.
- Maintenance uses its own database connection rather than the pool's. A writer takes
  the gate inside its driver call, by which point `database/sql` has already handed it a
  connection, so a waiting writer *holds* a connection while it waits; with one pooled
  connection, maintenance needing that connection would wait for a writer that is
  waiting for the job. This was observed as a real deadlock, and
  `TestMaintenanceDoesNotDeadlockAgainstAWriterHoldingAConnection` reproduces it.
- A write transaction holds the gate until it ends, not per statement: SQLite's write
  lock outlives the statements inside a transaction. The `driver.TxOptions.ReadOnly`
  hint does not exempt a transaction, because modernc.org/sqlite only uses it to pick
  the `BEGIN` mode string — such a transaction can still write.
- No request performs database work after admitting a job. The handler records
  *admission* and returns the status the start returned; the job records its own
  completion through an observer once it has released exclusivity. A request that wrote
  anything afterwards would hold a connection while the job held the gate, so its `202`
  would not arrive until the rebuild finished.
- The gate's row wrappers forward the driver's optional column-metadata interfaces and
  assert that at compile time, because a wrapper satisfying only `driver.Rows` compiles
  while silently discarding what the driver reports about each column's type.
- The gate belongs to one `repository.DB` rather than to the process, so a rebuild in one
  database cannot stall writes to another. Every pool derived from that same `DB` shares its
  gate — which is what the maintenance service relies on — while two separate `Open` calls over
  the same file keep separate gates and are therefore not mutually exclusive. That is the
  contract the code implements, and a deployment runs one `Open`.
- Job status lives in memory (`MaintenanceService`), not in a table. A status endpoint
  that read the database could not answer while a job held the connection — which is
  exactly when an operator asks. The service owns a context derived from the
  application's, so a job cannot outlive the process, and `Close` cancels and joins it
  before releasing the connection.

`VACUUM` is run as a plain `VACUUM` rather than `VACUUM INTO` plus a file swap. The
pool holds an open handle, so replacing the file underneath it would need every
connection closed and the pool rebuilt while other goroutines still hold references
to it. A plain `VACUUM` copies into a temporary file and overwrites the original
inside an ordinary transaction, so an interrupted rebuild leaves the original intact;
`TestInterruptedVacuumLeavesTheDatabaseUsable` cancels one and then checks both the
surviving rows and `PRAGMA integrity_check`. Its documented requirement — up to twice
the database file in free space — is measured and shown in the confirmation before the
action runs, as a pre-check rather than a guarantee. A checkpoint that SQLite reports
as blocked is surfaced as an incomplete result, not as a success: `wal_checkpoint`
returns its outcome in a row of three integers and does not raise an error when it
cannot proceed, and a rebuild that is itself fine but cannot truncate the log reports
that partial outcome rather than either success or failure.

## 12. Test layering

The suite is split by what each layer can actually prove, not by which runner is
fashionable. `docs/testing.md` is the working guide (where a new test goes, how it is
registered, what to run when); this section records why. The rule is **Browser Everything → Browser Only Where Browser
Matters**: an assertion moves down a layer when a lower layer can make the same
claim, and it stays in Chromium only when the claim is about the engine.

| Layer | Command | What it proves |
| --- | --- | --- |
| Pure logic | `pnpm test:logic` | Decisions about the operator's own input: URL rewrites, saved-view derivation, debounce invalidation, the poll decision, range validation, chip display mapping, refresh presentation. Runs under Node with no bundler, no HTTP server, no Go binary and no browser. Every `scripts/test-*.ts` is discovered; there is no suite list to register in. |
| Mechanical repository gates | `pnpm test:self` | Every `*.test.mjs` under `scripts/` and `deploy/cloudflare/`, discovered: path references, translation keys, CSS class references, the dev proxy target, the embedded-distribution sync, the Chromium installer's decision, both planners, the probe shards, the workflow structure and the fixed-wait ratchet. |
| **UI fast path** (development only) | `pnpm check:ui` | The subset of browser claims a change can affect, against the **dev server** with mocked routes. No `pnpm build`, no Go binary, no fake CPA. Like the full probe catalog, this runs `React.StrictMode` double-invocation checks that a production build cannot expose. |
| Cross-stack smoke | `pnpm verify:browser:smoke` | A local quick check of the thin path: `/omc` redirect, sign-in rejection and success, the dashboard and request list rendering their seeded rows, no console or page error. |
| Cross-stack P0 gates | `pnpm verify:browser:p0` | The pull-request gate: the smoke path and its checks, then the request-record/live-tail suite and the OAuth management scheduling-field suite, using the same built binary and deterministic fixture. |
| Cross-stack acceptance | `pnpm verify:browser` | The whole stack against the fake CPA: auth, every route's render and secret boundary, key aliases, provider enable/disable and its concurrent path, live-tail polling, and the unified OAuth management workspace. |
| Browser-only probes | `pnpm verify:probes` | The full scenario catalog on the Vite dev server with mocked routes; this is not built-artifact coverage. CI runs it as three weight-balanced shards (`--shard i/3`) on every pull request and master push. Drawer/modal stacking and hit-testing, column geometry and truncation, the responsive alignment override, dashboard trend mark paint, refresh sequencing under a held response, the platform's Back dismissing each overlay class, the phone rendering of each list surface against its table, and the touch rules on a deliberately coarse-and-hoverless context. |
| Demo acceptance | `pnpm verify:demo` | The staged production console and the real Worker handler served in-process, or an explicit deployment URL. Every route must complete its initial reads and render its page heading and content, with no API, transport or script errors. |
| Go demo smoke | `pnpm verify:demo:go` | Separate coverage of the binary's demo mode: isolated settings, read-only refusals and permitted non-durable edits. This opt-in command is not part of `verify:full`. |

Pull requests run the P0 gates, which contain the smoke path; master runs the whole
cross-stack acceptance. Both then run the demo acceptance. The probe catalog is its
own sharded job on both events, behind one aggregate `probes` check (ADR 0032).

### 12.0 Development and built-artifact coverage

`check:ui` and `verify:probes` run the **same scenarios** from
`scripts/acceptance/scenarios.mjs`, ordered under `scripts/acceptance/probes/`.
Both call the Vite dev-server harness in `scripts/acceptance/probe.mjs` with
mocked endpoints. The difference is selection: `check:ui` selects affected scenarios
(or an explicit scenario), while `verify:probes` runs the complete catalog.

Neither substitutes for built-artifact acceptance. Production path resolution,
minification, chunk loading and the embedded Go surface are exercised by
`verify:browser`; `verify:demo` also drives the production console. Conversely,
production builds cannot expose `React.StrictMode` double invocation. The
`search-dev-server` scenario guards a real controller-cleanup regression that
left production checks green but stopped search commits on the dev server.
Moving the full probe catalog to production artifacts would require retaining
explicit development coverage; it is not how the harness currently runs.

### 12.0.1 Three verification moments

Verification is organised by *when it runs*, because what a developer pays is
waiting, and a gate that costs minutes gets routed around:

| Moment | Runs | Cost guidance |
| --- | --- | --- |
| Development iteration | `pnpm test:fast`, plus `pnpm check:ui` when the change touches interaction, layout or a browser lifecycle | Scope-dependent; use printed check and scenario timings |
| Feature complete, and before declaring done or pushing | `pnpm verify` and `pnpm check:ui` | Tens of seconds of static gates plus the scenarios the change reaches |
| Pull request | CI: static gates, P0 acceptance, the full probe catalog in shards, demo | Runs beside the author; its checks gate the merge |

`pnpm verify:full` runs everything CI runs, locally. It is for changes to the build,
the embedded distribution, the browser harness or the workflow, and for reproducing a
CI failure. ADR 0032 records why the full catalog moved from a local pre-push duty to
a required CI check: it used to be enforced only by local discipline and by master CI
after merge, while every developer paid for it serially before each push.

The rule that keeps this honest is that a *narrow* plan must never be **silent**.
`scripts/affected-checks.mjs` and `scripts/acceptance/check-ui-plan.mjs` both widen
rather than guess, and every rule that narrows has a negative case in its self-test.
The UI planner narrows on evidence only:

- **Runtime imports.** `scripts/acceptance/ui-impact.mjs` builds the reverse import
  graph of `web/src` from TypeScript's `transpileModule` output, so imports used only
  as types are not edges. A file's scenarios are those of every mapped module on the
  chains that import it. A chain that reaches the shared layer, or a routed page
  without a rule, selects everything; so does any unresolved local import, an asset
  the graph cannot see (a CSS `url()`, `web/index.html`), a dependency or Vite change.
  `scripts/ui-impact.test.mjs` requires every routed page to have a rule and the real
  tree to resolve completely.
- **Translation additions.** A catalog edit whose every pre-existing entry and every
  line outside the catalog objects is unchanged selects nothing: a new entry is only
  rendered by code that references it, which the planner places separately.
- **Probe code.** `scripts/acceptance/probe-impact.mjs` attributes a probe module or
  registry edit to the scenarios that use it. The runner (`probe.mjs` and the two entry
  scripts) still selects everything; the planners select nothing, because they decide
  which scenarios run, not what a scenario observes, and are pinned by self-tests.
- **Manifests.** A `package.json` edit confined to `scripts` is not a runtime input.

`test:fast` compares against `HEAD` by default. `--base <ref>` includes committed
differences as well as staged, unstaged and untracked files; renames retain both
source and destination paths. `--plan` only prints the selection. Each file contributes
a conservative set of checks and the final plan is their union: a migration plus
a Markdown edit must still run Go tests. Dependency inputs widen both the static
and UI planners; TS/TSX references also select the CSS-module checker; a Go test edit
also runs the self-tests, which include the fixed-wait ratchet. The frontend type
check is incremental in `test:fast` only (build info under `tmp/tsc/`); `verify` and
CI always run a fresh `tsc`.

`scripts/fixed-waits.test.mjs` is a one-way ratchet on fixed sleeps in browser
tests and Go tests: adding one fails, and removing one fails until its recorded count
is lowered, so an improvement cannot be quietly undone.

`test:self` discovers the Node test files in `scripts/` and `deploy/cloudflare/`,
uses one Node invocation with test-file process isolation and concurrency two, and
runs demo freshness checking alongside it. This removes repeated package-manager
startup without reducing the test set. Shared fixtures must not write to the same
paths across files; isolated temporary directories remain the convention.

Two properties of this split are load bearing.

**A browser assertion is never removed without a replacement.**
`scripts/acceptance/MIGRATION.md` classifies every assertion in
`scripts/browser-acceptance.mjs` once - `PURE`, `COMPONENT`, `BROWSER` or
`CROSS-STACK` - and every assertion that left the browser names the test that
replaced it. An assertion may move; it may not disappear silently.
`scripts/browser-acceptance.mjs` is now the lifecycle/orchestration entrypoint.
Release domains live in focused modules under `scripts/acceptance/`: OAuth
management, key management, usage events and live-tail behavior, providers,
observability, configuration and plugins, and theme and brand artwork. Each module
receives the shared browser harness it needs and owns one product surface rather
than becoming another catch-all script.

**`pnpm test:fast` never pays for the browser.** No ordinary change may build the
SPA, build a Go binary, start Vite, start Chromium or start the fake CPA. The
selection lives in `scripts/affected-checks.mjs` so it can be asserted directly,
including that negative property, and a file the rules cannot place selects the
broad gates rather than nothing.

### 12.1 Why some claims live where they do

- **Request ordering belongs to Go.** `TestListUsageEventsOrdersByRequestTime` in
  `internal/repository` inserts a request that was recorded last but started
  earliest, so a regression to recording order inverts the assertion. A JavaScript
  re-check would read whatever the server already ordered and could not fail for
  the reason its name gives.
- **Pagination and scroll stay in the browser.** A virtualized list holding a
  bounded DOM, a poll leaving the reader's scroll offset and row identity untouched,
  and a back-to-top gesture landing exactly on the top are rendering behaviours.
  The scroll *schedule* is a pure function and is tested as one
  (`scripts/test-scroll-intent.ts`); its effect on a real list is not.
- **Some browser waits are irreducible, and one was investigated rather than
  assumed.** The live-tail block waits out the app's ten-second auto-refresh
  cadence. Driving it with `page.clock` works - the interval fires early, 11s of app
  time in about 900ms - but the same mock covers `requestAnimationFrame` and
  `performance.now`, which is what `smoothScroll`'s gesture schedule is built from:
  with the clock installed the back-to-top gesture landed at 37px instead of the
  top, with no page error, breaking the assertion the block exists for. Isolating
  the interval from the frame clock is not expressible through that API, so the
  wait stays and the rationale is recorded at the call site.
- **The debounce is split rather than moved.** `createSearchDebounce` carries the
  policy and is tested directly. The one claim that stays in the browser is that a
  real pending timer survives a real clear-all, because it depends on a React state
  update and a URL write happening between the two.
- **Refresh sequencing cannot be replaced by a poll-decision test.** A
  `shouldPoll()` unit test says nothing about whether the page serialises the pull
  before the reads, so the probe holds the response and observes the ordering.
- **The copy path is split between a unit test and the browser.** Which route a copy
  takes - the async Clipboard API, or the selection path a plain-HTTP origin needs -
  is a decision over stubbed globals (`scripts/test-clipboard.ts`), including where a
  dialog's focus trap requires the scratch element to be attached. Whether that
  selection path puts the text on the clipboard is not: it needs a real document, so
  the acceptance pastes the value back out of the browser's own paste pipeline from
  inside a dialog and from a drawer, which are the containers that trap focus. That
  context is granted no clipboard permission on purpose - granting it would stop the
  acceptance from exercising the fallback at all.

### 12.2 Where the wall clock actually goes

Earlier profiling established that assertion count was not the cost, and reducing it did not by itself make the
browser suite faster. Measured per line, the acceptance run's time sits in
navigations, `waitFor` round trips and one ten-second cadence wait - which is why
the useful levers were structural rather than subtractive:

| Lever | Effect |
| --- | --- |
| Fold four standalone Chromium probes into one shared server and browser, each scenario in its own context | Four dev servers and four browsers become one each |
| Move the focused probes into `verify:full` | They were in no gate at all; a guarded invariant nobody runs is not guarded |
| Fix the suite's CPU-sensitive reads, then run the two browser phases concurrently | About 12s on a 2-CPU runner, about 14s on four cores |
| Remove the deletion window from the embedded-distribution sync | Not a speed fix: it removes a race between `pnpm build` and the Go gates, which is what made overlapping them safe to keep |

Current wait removal is narrower than changing browser clocks. Demo navigation waits
for successful, completed initial reads and visible page content, with explicit
per-route timeouts; it never waits for global network silence while polling continues.
The system-information stale-cache probe holds its first response until the in-flight
assertions finish, then releases it in `finally` instead of sleeping ten seconds.
Every probe now prints its own elapsed duration, including failed scenarios.

The numerical observations in this section describe earlier profiling, not current
runtime guarantees. Re-profile the current catalog before setting a speed budget.
Two other levers were previously evaluated:

**Clock-driven polling.** `page.clock` does make the ten-second interval fire early
(11s of app time in about 900ms), but the same mock covers `requestAnimationFrame`
and `performance.now`, which is what `smoothScroll`'s gesture schedule is built
from: with the clock installed the back-to-top gesture landed at 37px instead of
the top, with no page error, breaking the assertion the block exists for. Isolating
the interval from the frame clock is not expressible through that API, so the wait
stays.

**`tsc --incremental`.** Adopted for `test:fast` only. The build info records a
hash of every program file and the compiler options, so a changed file, a deleted
file or an edited `tsconfig` invalidates what it must; a fresh `tsc` in `verify` and
CI remains the backstop for any cache defect. Measured on a 4-CPU machine: about 16s
cold, 6s with nothing changed, 9s after editing a widely imported utility.

### 12.3 The flakes were real, and they were in the assertions

The suite carried a recorded history of intermittent failures in the filter
section. Running the same suite under a 2-CPU constraint on the **unmodified
baseline commit** reproduced them two runs in three, which settled the question of
whether they were caused by the refactor: they were not.

The shared shape is a read taken immediately after a state change, with no wait for
the event that makes the read meaningful:

- **A footer read racing the refetch.** `the list is back to the unfiltered page`
  read the pagination footer immediately after a URL write. A filterless URL and a
  list that has re-issued its request are different states, and the read could see
  the previous filter's page size.
- **A poll wait with three intervals of headroom.** The live-tail block waited 30s
  for a 10s cadence. That is not three intervals of margin under contention; it is
  three intervals before giving up, and it expired on a page that was merely slow.
  It is now derived from `EVENT_AUTO_REFRESH_MS` with six intervals, and a longer
  bound costs nothing on a healthy machine because the wait returns as soon as the
  pill appears.
- **A row count read before the rows could arrive.** `the list still runs on the
  usable filters` read the row count one render after the notice.

A negative claim still cannot be waited on: `a clean URL shows no notice` stays a
plain `check`, because waiting for the absence of a notice would pass on the first
poll whether or not the page had rendered. What makes it meaningful is the await
before it - the rows being visible is the evidence that the page rendered, and it
rendered without a notice.

After the fixes, the suite passes eight consecutive trials under the strictest
configuration available here (2 CPUs, with the probes running concurrently), which
is the configuration the baseline failed.

### 12.4 CI preparation and fail-early artifact gates

An earlier profile of the `browser` job's preparation step was about 99s, bound by
`playwright-core install --with-deps chromium`: almost all of it apt installing the
shared libraries Chromium links against. The SPA build (29.5s) and the Go binaries
(1.3s) run concurrently with that work and are entirely hidden behind it, which is
why overlapping more with the step cannot shorten it.

The apt cost is real but it is not always necessary. `scripts/install-chromium.mjs`
downloads the browser without `--with-deps`, probes a real launch, and installs the
dependencies only when that launch fails. A runner image that already carries the
libraries therefore skips the ~100s, and one that does not gets exactly the command
the workflow used to run unconditionally, so the worst case is the previous cost
rather than a new failure mode. A second launch failure is reported instead of
ignored, because the alternative is a browser job with no browser, which surfaces
as a test failure rather than an environment one.

The probe, not the download's exit status, is what decides. A download that reports
success while the binary cannot start is precisely the state `--with-deps` exists to
repair, so trusting the exit status would reintroduce the bug the flag prevents.
`scripts/install-chromium.test.mjs` asserts both halves.

Removing the apt cost then exposed what it had been hiding: the Go build became the
floor of that measured step, about 60s locally with a cold build cache against 92s on the
runner. Two ideas for it were measured and rejected rather than left looking open:
warming the non-embedding packages concurrently with the SPA build is *slower*
(48s against 46s), because the warm-up competes for the same cores the build is
using; and starting the seeder beside the SPA build is also slower (34s for two
concurrent `go build` calls against 23s plus about 5s serially), because both share
one module and build cache and contend on its lock.

Two constraints keep the preparation step's shape:

- **The application binary must be compiled after the SPA build**, because it embeds
  `internal/web/dist`. Building it alongside `pnpm build` can embed a half-written
  bundle, so the sequencing is a correctness requirement rather than a preference.
  Only the seeder, which embeds nothing, runs in parallel.
- **A cache hit on `~/.cache/ms-playwright` proves the browser files are present and
  says nothing about the shared libraries.** That is why the OS dependencies are
  still guaranteed on every run, just by probe rather than unconditionally.

`pnpm check:bundle` owns the complete chunk and aggregate budget policy. CI runs
it immediately after `pnpm build`, before compiling the embedded app, and rejects
a dirty generated worktree before launching browser suites. Final clean-tree and
secret checks still run. The local build, E2E and full-gate commands call the same
checker; standalone browser acceptance does not carry a second entry-only policy.
Workflow self-tests exercise missing, misordered and non-enforcing gate cases, and
the probe jobs' structure: shards `1..n` matching the `--shard` denominator, no
event filter, no fail-fast, retained diagnostics, and an aggregate that fails unless
every shard succeeded.

Probe shards need no build and no Go: each installs dependencies and Chromium and
runs its part of the catalog on its own runner, so the scenarios' timing-sensitive
checks see no contention from a sibling browser. A failed check writes the same
screenshot, DOM, URL and page-error evidence as a thrown error, and each run clears
earlier evidence first.

The application processes spawned by cross-stack acceptance and Go demo smoke use
`scripts/acceptance/environment.mjs`: inherited `OMCPA_*`, `PORT` and transport proxy
variables are removed, fixture overrides are explicit, and `OMCPA_ENV_FILE` points
to the platform's empty device. Startup must not log a loaded dotenv file. This
prevents a developer's working-directory `.env` or operator settings from silently
changing the fixture. Explicit live-system smoke remains separate.

## 13. Demo mode

A public demonstration has to show the product without a gateway behind it, without
any credential, and without becoming a second frontend to maintain. Demo mode is
that, expressed as a thin layer over the ordinary process: `OMCPA_DEMO_MODE=true`
changes where the data comes from and refuses what must not happen, and nothing
declares itself a demo at compile time.

It is off unless it is asked for, and everything it changes is scoped to it, so the
self-hosted path is byte-for-byte the same code (ADR 0016 records the decision and
the alternatives).

| Concern | Self-hosted | Demo |
| --- | --- | --- |
| Upstream | The configured CPA instance | `internal/demo`'s fixture, over a loopback socket, with a key minted per process |
| Management key | `OMCPA_CPA_MANAGEMENT_KEY` | The fixture's own key; an inherited one is discarded, never encrypted into the instance row |
| Database | `oh-my-cpa.db` under `OMCPA_DATA_DIR` | `oh-my-cpa-demo.db`, deleted and rebuilt on every boot |
| Capture and sync | Collector and pricing loop run | Neither starts; the fixture is the history and the price list |
| Sign-in | The CPA management key | A session on first sight, so a link can be opened by anyone |
| Dangerous routes | Served | Refused by `internal/api/demo_policy.go` |

### Why the upstream is a fixture rather than a separate adapter

The console reads the gateway through `internal/cpa/management` in about twenty
handlers. The cheapest way to keep all of them working - including the DTO
allowlists, the credential projection and the model catalog resolution - is to keep
the client and replace what is on the other end of it, so `internal/demo` serves the
management API on a loopback port and the application is pointed at it exactly as it
would be pointed at a real gateway. An adapter at the handler layer would have had
to reproduce every response shape from Go structs and would have grown a branch in
every handler that reads one.

The fixture never dials the URL it is handed: it resolves the requested provider
endpoint against its own catalogue and refuses anything else, which is what makes
"the demonstration contacts no provider" a property of the code rather than a promise
about the environment. That property holds in both deployments - the Go demo mode and
the Worker behind the public page - and neither forwards a request anywhere. The public
page does carry an analytics beacon, which the hosting platform injects into HTML rather
than anything this repository emits; ADR 0021 records that as an accepted property of the
host. The URLs it answers are pinned to
`internal/quota`'s allowlist by a test, so the duplication cannot drift into
answering a request the console would never make.

### The boundary is a classification, not a list of disabled buttons

The server classifies every route it serves. `internal/api/demo_policy.go` holds one
table of `method + chi pattern + verdict`, first match wins, and the test suite walks
the **real** routing table asserting that every registered route is classified: an
endpoint added without a verdict fails the suite rather than inheriting one. At
runtime an unclassified route is refused, so the failure mode of a gap is a blocked
feature.

The table is ordered from the specific to the general, and the trailing wildcard
that serves the SPA comes last. That ordering is load-bearing: while the wildcard
sat first, it classified every `GET` in the application as public - including the
credential download and the request log - and both were allowed.

Last is not enough on its own, though. A wildcard that resolves before the refusal
for an unclassified API path makes the coverage test unfalsifiable for reads: an
unlisted `GET` matches the wildcard and looks classified. The fallback and the
console are therefore separate lists, and the coverage test refuses a fallback match
as a verdict - so a read endpoint added without one fails the suite, and is refused
at runtime while it does.

Refusals answer `403` with `{"error": ..., "code": "demo_operation_refused"}` - the
code the facade's other failures already carry - plus `X-OMCPA-Demo-Blocked` for a
caller that never parses a body. Reads are marked with `X-OMCPA-Demo: active`, and a
write carries `X-OMCPA-Demo-Persistence: none`, which is how a response can say its
result is not durable without the page having to know.

The classification resolves in three passes - the endpoint verdicts, then the
fallbacks, then the console itself - and the third exists because a trailing wildcard
matches every path below it. That ordering is what keeps the SPA fallback from
answering for an API path: `/api/v1/...` is refused by the fallback, while `/api-keys`
is a page and stays public. Writing the coverage test against that arrangement found
two reads - the gateway key list and the error-log file list - that had been matching
the SPA wildcard, which is to say they were being served without anyone having decided
they should be.

What the demo refuses is whatever moves credential material, starts a real sign-in,
executes a plugin, writes the gateway configuration, spends a quota entitlement,
hands back a raw request or error log, or would leave the process - provider model
reads, the pricing catalogue sync, the diagnostic bundle. What it performs instead
are writes that stay inside this instance: credential metadata and the enabled state
in the fixture, and client-key names, preferences, price rows, resource overrides and
a discovery sweep in the database. A credential status edit and a preference edit are
therefore stored in different places, and both are gone when the instance is replaced.

### The fixture is seeded through the real write path

`internal/demo` builds the history a deployment would have accumulated - about
fourteen thousand requests over 371 days, rising towards the present, across fourteen
traffic models and eight providers, with cached and reasoning tokens, latency and
TTFT, a failure share, named caller keys and a price list - and writes it through
`repository.InsertUsageEvents`, the same call the capture path uses. That is what keeps the fixture subject to the request-time price
lock, the display-mask rules and the schema instead of drifting from them.

The consequence is that the fabricated history needs the price version it is
pretending existed: the price lock resolves a version by the request's own
timestamp, and the trigger that shadows every price write stamps the moment of the
write. `Repository.SeedModelPriceHistoryBackfill` and its channel counterpart are the
only callers that write a version at an explicit time, and they exist so the fixture
can stay under the real lock rather than writing a cost column directly.

The price list is seeded with the catalogue the pricing page resolves against,
because a real deployment fills that catalogue from the gateway's own model list
during a sync and the demo deliberately runs none. Without it the page would
intersect its stored prices with an empty catalogue and render nothing. The prices
themselves come from a trimmed copy of OpenRouter's real list
(`internal/demo/openrouter_snapshot.json`), decoded and matched by the production
code, beside one pinned model, hand-set rates for the relay models, one channel
multiplier and one catalogue model left unpriced in the grouped price book.
`Repository.SeedChannelHistoryBackfill` does for the channel multiplier what the
price backfill does for prices.

Seeding is also why the demo database is rebuilt on every boot. A platform that
scales to zero brings the process back hours later; a database left behind would end
its history hours ago, and the fifteen-minute and one-hour windows - the panels that
make the console look alive - would be empty.

### The capture state is reported, not faked

The request list prints the capture state in its own header, and a demo has no
collector to report on. Rather than render "capture disabled" over a page full of
requests, the demo answers with the deployment its fixture describes - a
subscribe-mode collector that last captured seconds ago - while every number that
describes stored data is read from the database. A manual sync is answered the same
way: it reports a pass that found an empty queue, which is what a real deployment
answers when nothing arrived in between.

### Where the public demonstration is deployed

The public demonstration runs as a Cloudflare Worker: the same console as static
assets, with its API answered from a dataset generated out of the real handlers. It is
not a second frontend - the bundle is the one this binary embeds - and the reason it
is generated rather than hand-written is that every served response has then been
through the same DTO projection a self-hosted install produces.

`deploy/cloudflare/` holds it: `worker.mjs` answers and refuses, `routes.mjs` maps a
request to a captured response, `time.mjs` re-bases the captured history onto the
viewer's clock, and `data/responses.json` is the dataset. `internal/api/demo_export_test.go`
is the generator, and `scripts/generate-demo-data.mjs` is the command that runs it.

Two properties are load-bearing rather than incidental. Every response is re-based by
one delta before it is served, because the console asks for a window by name and a
frozen capture would be visibly empty within a day. A calendar cell in the
token-activity grid moves as one unit under that delta - its `day` key, its start and
its end by the same whole-day offset - because the key is what a cell is matched,
labelled and linked by, while the two instants beside it are the day's own bounds: moved
by different amounts they describe different days. The grid itself is captured on the
seeded history's calendar rather than on the export machine's, since it is the one read
whose window is derived from a clock rather than taken from the request. And the dataset's coverage is a
gate rather than an instruction: `scripts/check-demo.mjs` fails when a console route
has no captured reads, when a source it derives from has changed, or when it carries a
value that must not be public. That last check matters because the dataset is
downloadable by anyone.

A refusal is reported once. The server answers it with English prose meant for a log
("demo mode - uploading a credential is disabled"), and the console raises its own
localized notice for the refusal; echoing the server's sentence as well put two messages
on screen for one action, in two languages, reading as two different failures. The API
layer substitutes the console's sentence for a refused call, so whichever caller reports
it reports the same one.

The demonstration does not run the product: no gateway, no database, no capture
pipeline and no authentication are behind it, which
[ADR 0021](adr/0021-the-public-demonstration-is-generated-data-behind-the-real-console.md)
records as a deliberate trade. `docs/ops/cloudflare-demo.md` is the runbook, including
the account steps no command can perform and the failure modes that look like something
else.

## Browser-managed run lifetime

`internal/api/browser_runs.go` wraps console Agent and Playground POSTs carrying
`X-OMC-Run-ID` with a per-workspace, notification-driven replay journal. The existing handlers
still own validation, inference and capabilities; the wrapper owns detached lifetime, same-id
admission, replay and explicit cancellation. `GET /{workspace}/runs/active`,
`GET /{workspace}/runs/{id}` and `POST /{workspace}/runs/{id}/cancel` are console-authenticated
(`workspace` is `agent` or `playground`). Socket loss never cancels managed execution.
`internal/app/app.go` joins these tasks before closing dependencies. The journal is bounded to
4 MiB plus a terminal overflow error, retains the latest completed run for 15 minutes, and has
15-second socket heartbeats. Its 30-minute run deadline does not override Playground's existing
10-minute deadline. Replaced/expired ids have a 24-hour, 1,024-entry tombstone admission bound.
Before buffering a managed request body, the wrapper rejects a different id while its workspace
is active and refuses admission after shutdown. A shared four-permit gate bounds concurrent body
reads, validation and handoff, including uploads with the same id; saturation returns HTTP 429
with the workspace's busy code. Permits are released before streaming a subscription. Admission
is checked again after reading because another request can start a run or shutdown can begin
while an upload is in progress.

`web/src/agent/runConnection.ts` is the injectable transport state machine; `reconnect.ts` binds
it to the authenticated, subpath-aware API client. It retries GET subscriptions with 500ms-to-8s
backoff, waits for online events and reconnects 45-second stalled reads. Full replay first resets
the transient frame. It never repeats an initial generation POST automatically. Cleanup aborts
subscriptions, while Stop sends the idempotent server cancel command. Agent's persisted session
includes `active_run_id` when a managed task is running; reading a live stored turn does not mark
it interrupted. Restarted runtimes still expose stored running turns as interrupted.

`internal/api/playground_run_state.go` builds the bounded recovery turn from the actual request
and redacts large inline images. The existing frontend preference writer alone persists recovered
Playground results. `last_run_id` acknowledges completed journals, including after clearing turns,
so a retained journal cannot recreate a cleared conversation. Retry/edit descriptors identify the
turn they replace. These are process-local recovery guarantees, not durable execution; a result
not recovered before journal expiry may never enter the Playground preference. ADR 0044 records
this boundary and its shutdown behaviour.

## 14. Model playground

The lazy `web/src/pages/playground/PlaygroundPage.tsx` route is composed on the shared
conversation frame (`web/src/components/workspace`), so its transcript, composer, reasoning
disclosure, code blocks and side panel are the Agent's. The page itself owns the request: the
streaming loop (`usePlaygroundRun.ts`, which publishes the live turn on a 40ms cadence and keeps
every settled turn's object identity so the memoised transcript re-parses only the answer that
changed), the image attachment adapter the composer's picker and paste feed (`attachments.ts`),
the parameters panel and the turn inspector. `runtime.ts` is its `ExternalStore` adapter: sending,
regenerating the last answer and editing the last message all land in `usePlaygroundRun`, which
keeps its one-request-at-a-time rule and its OpenAI-shaped protocol. Pure request rules - building
the request, reading the custom body, the stored session's shape, the turn an edit produces - live
in `state.ts`. The conversation exports as Markdown with the model and parameters each answer ran
with.

The single latest session is persisted server-side in `ui_preferences` as `playground_session`,
allowing operators to resume the target, parameters and conversation across devices and reloads.
It is written when a turn settles and after parameter edits pause, never while a turn streams.
Starting a new conversation discards stored turns. Large image payloads are redacted before
persistence to conserve storage budget. Neither conversation nor prompts enter client-side
`localStorage` or `sessionStorage`. Markdown rendering uses `@ant-design/x-markdown` with raw HTML
escaped and external images suppressed.

`internal/api/playground.go` adds session-authenticated `GET /playground/models` and
`POST /playground/chat` beneath the configured API base. The former resolves a
`client_key_fingerprint` query against the current CPA client-key list using the
`usage-api-key` fingerprint purpose. The latter accepts the same identity, a model,
optional system prompt, typed messages, and optional temperature, top_p, max_tokens and reasoning_effort.
Unknown input fields are refused. System messages are built from the separate prompt;
user and assistant messages carry only text and inline image content blocks.

`internal/cpa/gateway` is the inference client, separate from the management client. It
supports only the configured origin's `/v1/models` and `/v1/chat/completions`, sets the
resolved client key server-side, and refuses redirects. Model IDs come from the live
client directory, not pricing or historical traffic. Each entry carries the OpenAI
`id` plus an explicit `call_point` (the same client-visible identifier CPA returns);
the selector uses that call point. Vision capability is unknown.
The facade emits `meta`, `request`, `delta`, `thought`, `usage`, `done` and `error` SSE events.
`request` carries CPA's `request_id` for the call, read from the `X-CPA-TRACE-ID` response header
CPA stamps once it has picked a credential (`<selection time>-<auth index>-<request id>`, parsed by
`gateway.RequestIDFromTrace`); it is the same id CPA publishes on the request's usage record, and an
`error` for a request CPA rejected after that point carries it too. Errors contain
safe codes, upstream HTTP status and allowlisted parameter names rather than upstream
bodies. Missing usage stays missing. CPA ingestion remains unchanged.

Admission is process-wide and non-queueing: four calls include request validation and
credential resolution. JSON bodies are limited to 32 MiB including history; each user
message has at most four PNG/JPEG/WebP images, each at most 5 MiB and 40 megapixels.
Only Base64 data URLs are accepted. Image headers are decoded without allocating pixels.
Messages are limited to 256 including the optional system message. Responses are bounded
to 8 MiB, individual SSE lines to 1 MiB. The browser retains at most 500 diagnostic events
or 1 MiB while continuing to render the answer. No automatic paid-request retry exists.

This route overrides the server's ordinary 30-second write deadline per flush, retaining
a 30-second slow-reader budget. Upstream first-response and idle budgets are 120 seconds,
total lifetime is ten minutes, and downstream heartbeats run every 15 seconds. Cancel or
unmount aborts the fetch and upstream context. The heartbeat writer is joined before
returning the handler. Existing management routes retain their original deadlines.

The upstream body is composed once (`gateway.BuildPayload`) and then validated as the body it
will be (`gateway.ValidatePayload`): the console's own `model`/`messages`/`stream` defaults
first, the turn's parameter fields next, and `custom_body` last so an operator's override wins
every collision. Validating the composed body rather than the typed request is what stops an
override from replacing `messages` with content the image checks never approved; parameters the
console does not model pass through untouched. `user_agent` is a transport header rather than a
body field, so it is resolved here (the operator's value, else `Oh-My-CPA/<build version>`) and
refused when it is not a header value; a non-streaming body is refused by name, because this
route projects allowlisted SSE events. TPS in the turn footer comes from the same
`eventTokensPerSecond` helper the request records use, so the two cannot disagree.

Request inspection substitutes image summaries at any depth (a valid custom body may replace
`messages` with the string-content form) and omits `user_agent` from the body preview, since it
travels as a header; cURL uses environment placeholders, sets that header explicitly, and
requires local image substitution. The model named by the turn label and the diagnostics heading
is the effective one, so a turn is never labelled with a model it did not call. A turn's request
link (`usageLink`) filters the request records by its `request_id`.
CPA numbers requests with a counter that restarts with CPA, so the same id recurs across
restarts; the link therefore also keeps an absolute window of the turn's own span, anchored on
the server's `started_at_ms` (browser time for a turn restored without it) and widened by five
minutes either side to absorb clock skew between OMC, CPA and the browser. A turn with no known
end, and a link opened within a minute of its window closing, stay open-ended, so the list keeps
polling until ingest delivers the record. A turn that never learned its id (CPA refused it before
choosing a credential, or it was stored before the id existed) has no link: the button is
disabled with the reason rather than falling back to matching by key, model and time, which
listed neighbouring requests as if they were this one. ADR
0022 records the entitlement and privacy boundary; ADR 0023 recorded the selection-only preference
and is superseded by ADR 0024, which records the single latest session that replaced it. Gateway unit tests, facade tests,
`scripts/test-playground.ts`, and desktop/phone probes cover this flow. Public-demo
model reads are generated through the real facade; inference is explicitly refused.

## 15. Where to look next

- Domain wording: `CONTEXT.md`
- Deployment and its trade-offs: `docs/adr/0001-go-react-sqlite-modular-monolith.md`
- Identity keys and rebinding: `docs/adr/0002-cpa-binding-and-identity-hierarchy.md`
- Cost immutability: `docs/adr/0003-request-time-price-snapshots.md`
- Visual system: `docs/design.md`
- Backup, restore, and migration gates: `docs/ops/sqlite-operations.md`
- Feature parity status against CPAMC: `docs/cpamc-parity.md`
- CPA v8 baseline, relocation table and measurements: `docs/cpa-v8-compat.md`

## Deployment-wide calendar time

`internal/timezone` resolves the deployment calendar from `TZ`, the system zone name or the local zone file, and embeds Go's IANA data for offline named-zone loading. `Repository` owns an atomic runtime location and serializes timezone preference commits before publishing the new location. Startup loads `omc_timezone` from the existing preference table; no migration or timestamp rewrite is needed. Invalid overrides fail validation rather than replacing a working calendar. The preference API remains allowlisted: `PUT /preferences/omc_timezone` accepts an IANA name or an empty string, and `GET /preferences` includes `time_zone` metadata (`timezone`, `server_timezone`, `effective_timezone`).

The application wraps its log handler with a per-record location resolver, so successful timezone writes affect new OMC log timestamps without changing process-global `time.Local`. Retention, authentication expiry, collector watermarks and stored timestamps continue to use absolute instants. The built-in Agent's system context names the effective calendar; `timezone_get` and `timezone_set` use the same repository validation through `internal/operations`.

`web/src/utils/time.ts` owns timezone-aware date construction, gateway timestamp conversion and picker wall-clock resolution. `TimeZoneProvider` hydrates the deployment setting inside the authenticated shell; subscribed readers update on preference changes and failed-write rollback. Memoized chart configuration and audit grouping include the zone as a dependency. Day keys use that calendar; DatePicker edits resolve wall-clock fields again so an offset retained from a different date cannot move a DST selection. The heatmap accepts an optional explicit `tz` for API consumers and defaults to the effective server-side OMC zone; the console sends its shared effective zone.

`web/src/components/common/TimeZoneSelect.tsx` is a controlled, reusable picker independent of preference persistence. It accepts `value`, `onChange`, optional `serverTimezone`, `isDisabled`, `id` and an accessible label. The server zone is pinned first and annotated; the caller decides whether choosing it clears an override. Options and minute-keyed offsets are cached, and fixed-height virtual rows bound the rendered list while preserving search and keyboard navigation.

## Custom icon library

`internal/iconasset` validates static PNG/JPEG/WebP and reconstructs SVG from an XML element/attribute allowlist. Imports accept standard padded or unpadded Base64 and Base64 image Data URLs. Client MIME is not trusted; a declared Data URL MIME must match the decoded image. Decoded and reconstructed artwork is bounded to 512 KiB, raster dimensions to 1024 pixels per axis, and HTTP JSON bodies to 1 MiB. Animated PNG/WebP, scripts, events, XML directives, foreign objects, external resources and SVG style attributes are refused. Only validated artwork is previewed in the browser.

`web/src/types/customIcons.ts` owns custom reference parsing, library filtering and plugin-safe artwork resolution; `web/src/hooks/useCustomIcons.ts` shares revisioned metadata with all rendered provider surfaces.

Migration 032 creates `custom_icons`: stable random `id`, `name`, `mime_type`, image `content`, monotonic `revision`, and millisecond creation/update timestamps. The deployment holds at most 100 icons, with trimmed names of at most 80 Unicode characters. Artwork is stored separately from `ui_preferences`; `provider_icons` preserves existing catalog IDs and adds `custom:<id>` references. Preferences validate references inside their write transaction, while deletion removes every matching stored mapping, including legacy name keys, inside the same transaction as the asset deletion. Removing overrides, rather than writing a fixed catalog ID, preserves each surface's default/placeholder resolution and plugin branding authority. A single SQLite connection serializes these operations, preventing assignment/deletion races. Artwork is hidden from the free-form database capability.

The session-authenticated routes are `GET`/`POST /custom-icons`, `POST /custom-icons/preview`, `PATCH`/`DELETE /custom-icons/{id}`, and `GET`/`HEAD /custom-icons/{id}/content`, under the configured API base. Create accepts `{name,data}`; update accepts optional `name` and `data`; preview accepts `{data}`. List returns `{icons}` containing metadata/reference counts, not bytes. Content responses use validated MIME, nosniff, a sandbox CSP and private revalidation with a revision ETag. Preview is non-persistent and no-store. Invalid imports return 400, oversize imports 413, missing icons 404 and library exhaustion 409, using stable error codes. Console errors never quote image input.

Operations registers the same repository-backed CRUD for Agent/MCP. Lists are bounded to twenty metadata records per page; capability uploads remain subject to the existing 32 KiB tool envelope. Deletion requires confirmation tied to the icon's content revision, with a reference-count/default-reset preview. Its transaction rechecks the revision and removes all current matching overrides. Audit entries omit arguments/results. The shared frontend icon renderer resolves custom artwork using one metadata query and authenticated same-origin image URLs, with safe placeholders on failed reads. Mutation invalidation updates all mounted references. Plugin logos keep precedence; a plugin-owned provider never falls back to operator-uploaded artwork.
