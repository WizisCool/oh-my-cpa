# CPAMC parity matrix

This document links the feature inventory of the official [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) (CPAMC) to the implementation boundary of Oh My CPA.

## Goals and Compatibility Baseline

- **Target Upstream**: `router-for-me/CLIProxyAPI` `/v0/management` API.
- **Official UI Baseline**: CPAMC README targets CLIProxyAPI `>= 7.1.0` and recommends using the latest release.
- **Recommended Co-deployment**: The full-stack compose template pins CPA `v7.3.5`. Two credential surfaces carry their own minimum: Devin OAuth needs `v7.3.1+` and Meta Muse needs `v7.3.4+`, and a gateway older than either answers a missing-capability status for just that surface.
- **Oh My CPA Principle**: CPA remains responsible for execution and protocol adaptation; Oh My CPA provides the management user experience, security boundaries around real CPA data, and a user-owned resource identity layer.
- **Credential Boundary**: The CPA Management Key is decrypted and used exclusively inside the Go process; the browser holds only an `HttpOnly` administrator session cookie. Credentials returned by CPA are displayed on-demand under protected administrative pages with masks by default.
- **Compatibility Strategy**: Endpoints are proxied through an explicit allowlist; arbitrary URL pass-through proxying is forbidden. Missing upstream capabilities surface with explicit "unsupported / upgrade required" statuses.

## Feature Matrix

Status definitions: `Covered` = Fully implemented with live endpoints and UI; `In progress` = Core contract in place, interaction or dedicated adaptation ongoing; `Planned` = Confirmed requirement, not yet implemented.

| Official Feature | CPAMC Entrypoint | CPA Management API | Oh My CPA Status | Verification Method |
| --- | --- | --- | --- | --- |
| Admin login & connection status | Login, top connection pill | Local session; server-side `/auth-files` health probe | Covered | Login, logout, invalid session, and disconnected CPA test coverage |
| Dashboard connection, version, counts, model overview | `dashboard` | `/config`, `/auth-files`, `/api-key-usage`, `/latest-version` | Covered | `GET /management/overview` aggregates three read-only endpoints, consumed by secondary dashboard sections and system pages; partial failures degrade via `partial_errors` rather than breaking the page |
| Quick start & request examples | `quick_start` | `/config`, `/api-keys`, fixed proxy endpoints | Covered | Four-step wizard, multi-client configurations, endpoints, and cURL / Python / Node.js code sample copy actions |
| Configuration read | `config_management` | `GET /config`, `GET /config.yaml` | Covered (verified against real CPA 7.2.146) | Reads and displays real JSON / YAML |
| Config visual scalar editing | `config_management` | `/debug`, `/proxy-url`, `/request-log`, `/logging-to-file`, `/usage-statistics-enabled`, `/request-retry`, `/max-retry-*`, `/ws-auth`, `/force-model-prefix`, `/routing/strategy` | Covered (verified against real CPA 7.2.146) | GET / PUT contract tests and optimistic UI interactions for each allowlisted endpoint |
| Config YAML editing & saving | `config_management` | `PUT /config.yaml` | Covered (verified against real CPA 7.2.146) | YAML error 400, config error 422, dirty state protection, Ctrl+S quick save |
| Proxy client API Keys | `key_management` (dedicated gateway page) | Config document `api-keys` field (saved via `PUT /config.yaml`); aliases via OMC's `/management/client-key-aliases` | Covered | Dedicated page `/api-keys` (under `/omc/api-keys`); additions/edits/deletions commit through visual config drafts and revision checks, sharing save transactions with the config panel. Aliases are stored in `client_key_aliases` keyed by `(instance_id, usage fingerprint)` as OMC metadata without rewriting CPA's config document; fingerprints use `usage-api-key` purpose matching `usage_events.api_group_key`; request list, drawer, facets, and chips show aliases and fall back to masks; browser acceptance asserts rendering, counts, masking, and reveal values |
| Claude / Codex / Gemini / Meta Muse API Keys | `ai_providers` | `GET/PUT/PATCH/DELETE /{provider}-api-key` | Covered (Meta Muse needs CPA `v7.3.4+`) | The four config API-key families share one credential schema, so list, create, update, delete, status toggle and model pull are implemented once against a family registry (`providerConfigFamilies`); sanitized display, per-provider toggle serialization with last-intent resolution, and website metadata (http/https only). A family the installed CPA does not have reports `capability_missing` |
| Interactions / xAI / Vertex Keys | `ai_providers` | `GET/PUT/PATCH/DELETE /{provider}-api-key` | In progress | Not console-managed families yet. `xai-api-key` credentials are counted in the dashboard and reached through xAI OAuth, but have no provider row; `interactions-api-key` and `vertex-api-key` are edited through the configuration document. Each becomes a family row (`providerConfigFamilies` plus a `PROVIDER_FAMILIES` entry) when it is picked up |
| OpenAI-compatible providers | `ai_providers` | `GET/PUT/PATCH/DELETE /openai-compatibility` | Covered | Multi-key, endpoint sanitization, model list, and enable switches; website links and instant model filtering |
| Model pulling | Provider actions, Quick Start | Bypasses CPA: connects directly to provider `Base URL` `/models` (falls back to `/v1/models`); auth-file models use `GET /auth-files/models` | Covered | `POST /management/providers/pull-models` is initiated server-side and audited; provider URLs and secrets remain in Go |
| Auth file list / filter | `auth_files` | `GET /auth-files` | Covered (verified against real CPA 7.2.146) | Field normalization, runtime-only / disabled empty states |
| Auth file upload | `auth_files` | `POST /auth-files` multipart | Covered (verified against real CPA 7.2.146) | JSON file upload and invalid file feedback |
| Auth file download / delete | Detail / batch actions | `GET /auth-files/download`, `DELETE /auth-files` | Covered (verified against real CPA 7.2.146) | Safe filenames, download payload, and batch deletion |
| Auth file enable / disable & fields | Detail / batch actions | `PATCH /auth-files/status`, `PATCH /auth-files/fields` | Covered (verified against real CPA 7.2.146) | Status toggles plus priority, weight, note, prefix, proxy URL, expiry, disable-cooling, WebSockets, using-API and excluded-model fields. Every update is verified against `GET /auth-files` before the API returns success, the fields held in the downloaded JSON are verified against a server-side safe projection of it as well, and that projection reaches the response only when it was read back |
| Auth file model list | Detail | `GET /auth-files/models` | Covered (real CPA 7.2.146 returns 200; older versions returning 404 map to 501 capability_missing) | Displays capability notice on older CPA versions |
| OAuth excluded models | `auth_files` sub-page | `/oauth-excluded-models` (in OMC handled via `excluded_models` in `PATCH /auth-files/fields`) | Covered | The credential drawer edits excluded models, normalizes whitespace/duplicates, and verifies the persisted safe projection; the write is audit logged |
| OAuth model aliases | `auth_files` sub-page | `GET /oauth-model-alias`, `PATCH /oauth-model-alias` | Covered (verified against CPA 7.3.4 source) | Provider key normalization, per-provider replacement/deletion, fork/force-mapping fields, server-side readback, and audit logging through `/management/auth-files/model-aliases` |
| OAuth login | `oauth` | `GET /{provider}-auth-url`, `GET /get-auth-status`, `DELETE /oauth-session`, `POST /oauth-callback` | Covered (Devin needs CPA `v7.3.1+`, Meta Muse `v7.3.4+`) | Built-in providers are declared once in `internal/cpa/management/oauth_providers.go` (management path, redirect vs device flow, whether CPA opens its loopback callback) and the browser renders that declaration; provider/state polling, cancellation, callback input, and no token emulation. Devin's redirect lands on a loopback callback, so a remote browser pastes the final URL and a paste bound to another attempt is refused before it reaches CPA. Meta Muse runs the device-code flow and shows the code to confirm. A cancel CPA cannot honour (`cancelled:false`, because the session already completed) is reported as such rather than as a cancelled sign-in |
| Vertex JSON / iFlow Cookie import | OAuth / auth-files | `POST /vertex/import` and provider-specific flows | Planned | Dependent on upstream version capability probes |
| Quota observation | `quota_management`, credential detail | Quota and `model_quotas` telemetry from `auth-files`; `POST /api-call` for providers that expose no quota field | Covered | Credential detail drawer display with field-level sanitization. Live refresh covers Codex, Claude, Antigravity, Kimi, xAI and Devin; Devin is read from its Connect-RPC seat-status endpoint (daily and weekly remaining shares plus the plan window) through the compile-time `AllowedURLPrefixes` allowlist. A provider with no probe reports `refresh_supported: false` instead of a failed fetch |
| Quota reset | Quota row action | `POST /reset-quota {auth_index}` | Covered | Accepts stable `auth_index`, secondary confirmation, audit logging, and frontend reset loop |
| Usage queue | Dashboard / observation | `GET /usage-queue?count=N` (equivalent to RESP subscription) | Covered (server-side collection, no direct console read) | `internal/usage/ingest` drains queue in the background; the console exposes no "read and acknowledge" action because reading is destructive and would race the collector. The request list "refresh" triggers `POST /usage/ingest/refresh` so the server drains CPA once via its collector goroutine and waits for visibility |
| Daily token heatmap | Dashboard | Bypasses CPA: aggregates Oh My CPA's own captured records | Covered | `GET /management/dashboard/token-heatmap` folds a year of local calendar weeks from the viewer's IANA zone and returns each day's exact bounds; the panel shades each day's own token volume on a continuous ramp and opens a click-triggered tooltip that prints the token volume in the console's token unit style (with the exact count kept on the value) and links to `/usage/events` for that day. See `docs/adr/0005-token-heatmap-as-a-dom-grid.md` |
| Per-model usage trend and share | Dashboard | Bypasses CPA: aggregates Oh My CPA's own captured records | Covered | `GET /management/dashboard/models` ranks the selected window's models by token volume, keeps the top five plus a folded remainder, and returns each group's own zero-filled bucket series. `group_by=call|model` chooses the grouping: by call point (the client-requested model alias, or the upstream model when unset — one call point served by several upstream variants reads as one group) or by the upstream model name. Each group also carries its priced spend (`cost_usd`, null when nothing was priced) and `priced_requests`. The trend draws one line per group and the usage ring draws their shares with a ranked list naming volumes, shares and costs; one response feeds both, so a model's colour cannot differ between them. See `docs/adr/0006-categorical-series-palette.md` |
| API Key & Provider usage | Dashboard / providers | `GET /api-key-usage`, `GET /management/dashboard/providers` | Covered | Aggregates windowed provider request traffic and bucket sparklines via `GET /management/dashboard/providers` controlled by the top range selector, displays official OAuth channel names and brand marks (including plugin OAuth like Codebuddy), aggregates configured Codex, Claude, Gemini, Meta, and OpenAI-compatible AI providers, and links rows directly to provider/OAuth management |
| Live logs & incremental fetch | `logs` | `GET /logs?after=&cursor=&limit=` | Covered (verified against real CPA 7.2.146) | Cursor prioritized with `after` fallback; `cursor-reset` buffer reconstruction; pausable 5s polling |
| Clear logs | `logs` | `DELETE /logs` | Covered | Secondary confirmation; buffer rebuilds after clearing |
| Error log files | `logs` | `/request-error-logs`, `/request-error-logs/:name` | Covered (real file list + download verification) | Filename path traversal rejected in Go, not forwarded to CPA |
| Single request log download | Log detail | `GET /request-log-by-id/:id` | Covered (`/usage/events/{id}/request-log`) | 404 treated as missing capability rather than empty file |
| Plugin list / toggle / delete / config | `plugins` | `/plugins` and `/plugins/:id/*` | Covered | Enable switch, JSON config modal editing, uninstall confirmation, and audit logging |
| Plugin store installation | `plugin_store` | `/plugin-store`, `POST /plugin-store/:id/install` | Covered | Store catalog, permission review, install confirmation, and audit logging |
| System version / update check | `system_info` | `/latest-version`, CPA response headers | Covered | Version comparison, upgrade prompts; avoids misrepresenting "check" as "upgrade complete" |
| Runtime self-check & diagnostics | `system_info` | CPA ping, management capability probes, sanitized diagnostics export | Covered | Component health topology, sanitized diagnostic package download, fail-closed audit |
| Arbitrary upstream API Call | Provider / debug actions | CPA `POST /api-call` | Partial (server-side quota observation only) | General `/api-call` remains closed to browsers; `internal/quota` uses the endpoint to observe official quotas, restricted to the compile-time `AllowedURLPrefixes` allowlist |
| Multi-CPA instances | Top connection / system info | Oh My CPA instance model | Planned | Requires instance CRUD, key rotation, and instance-scoped permissions |

## Current State and Roadmap

Implemented surfaces: Dashboard, Quick Start, AI Providers, Key Management, Auth Files, OAuth, Quota, Logs, Usage Events, Pricing, Config, Plugins, Plugin Store, and System—totalling 14 live routed pages (plus a redirect fallback). No pages remain as placeholder capability mocks.

Capability probes (`GET /api/v1/management/capabilities/{key}`) are retained strictly for backwards compatibility checks with older CPA releases to distinguish "API available/missing" from "unwired UI", and are never used to fake feature completion.

Subsequent milestones:

1. **Legacy Version Compatibility**: Standardize "capability missing" notices for endpoints absent on older CPA releases (such as `/auth-files/models`), documenting minimum version requirements and graceful degradation.
2. **Multi-Instance Support**: Instance CRUD, key rotation, and instance-level permissions backed by an ADR (the database schema already models `cpa_bindings.instance_id`, while `/instances/default/*` remains single-instance).

## Oh My CPA Distinct Capabilities (No CPAMC Counterpart)

The following capabilities are unique to Oh My CPA and have no counterpart in CPAMC, but are part of this product's deliverables:

| Capability | Entrypoint | Description |
| --- | --- | --- |
| Usage Request Browser | `/usage/events`, `/usage/events/{id}`, `/usage/events/{id}/request-log`, `/usage/facets`, `/usage/ingest/refresh` | Multi-select facets (union within dimensions, intersection across dimensions), global search, range filtering, column layout and view persistence, single request detail, and raw request log downloads. The refresh action drains CPA's queue on demand until records are queryable before re-reading lists and facets. Lists are sorted by request time descending (`timestamp_ms` + `id` composite cursor), matching the displayed time column; new record counts are tracked independently against ingestion `id` |
| Request-Time Price Snapshots & Catalog | `/pricing`, `/pricing/models`, `/pricing/sync`, `/management/dashboard` | See `docs/adr/0003-request-time-price-snapshots.md` and `docs/plans/model-prices.md` |
| Quota Overview & Credential Details | `/management/quota`, `/management/quota/{authIndex}` | Normalized snapshots + cooldowns, resets, and Codex reset credits |
| Audit Logging | `/management/audit/events`, `/management/audit/export` | Append-only logging; fail-closed on sensitive exports |
| Server-Side Console Preferences | `/preferences` | Closed set of keys, surviving service and container restarts |
| Capability Probing Facade | `/management/capabilities/{key}` | Read-only, compile-time allowlist |

## Known Limitations

- The CPA Management API is an evolving, versioned external contract; the console must treat 404 and 405 as missing capabilities rather than empty data.
- **CPA logs `/v0/management/*` calls into its log file.** If the console polls every 5 seconds, it will pollute the log with its own management traffic; "Hide management traffic" is therefore enabled by default (CPAMC hid the entire log page to work around this).
- When file logging is disabled, CPA returns **400 `logging to file disabled`** for `GET /logs`. Oh My CPA translates this into 409 `file_logging_disabled`, allowing the UI to explain the cause and direct users to the toggle, rather than reporting an unexpected failure.
- `/usage-queue` destructively consumes queue records and must never be invoked during ordinary UI polling; the console does not expose this endpoint, leaving the background collector as the sole consumer.
- `POST /api-call` allows CPA to make arbitrary upstream requests on behalf of credentials, introducing SSRF and exfiltration risks. General browser access remains disabled; the server uses it exclusively in `internal/quota`, restricted to verified HTTPS endpoints in `AllowedURLPrefixes`.
- Replacing CPAMC does not mean copying its browser `localStorage` secret storage; Oh My CPA maintains strict server-side secret boundaries.

## Scheduler Semantics (CPA v7.3.5)

Priority and weight are routing fields, not presentation metadata. The console
validates and writes them against the current CPA contract; the runtime semantics
are owned by CPA's scheduler:

| Field | CPA semantics | OMC treatment |
| --- | --- | --- |
| `priority` | Missing or `0` is the default tier; higher integer values are selected before lower values. A credential in a lower tier is used only after the higher tier has no ready credential. | The drawer accepts a safe integer without inventing a `0..100` range, and readback verifies the runtime value. |
| `weight` | Missing defaults to `1`; `1..1_000_000` are allowed; non-positive values normalize to `0`, which excludes the credential from `weighted-round-robin`. Weight does not cross priority tiers. | The drawer accepts up to `1_000_000`, preserves the CPA normalization, and verifies persisted/runtime readback. |
| `fill-first` | Chooses the first ready credential in the highest available priority tier and ignores weight. | The field remains editable but the UI must not imply that weight affects this strategy. |
| `round-robin` | Rotates credentials within the highest available priority tier and ignores weight. | Same as above. |
| Session affinity | An existing session may remain bound to its credential; priority and weight apply when no affinity binding can be reused. | The routing help calls this out instead of presenting priority as an unconditional override. |

This matrix is based on the official CPA scheduler behavior at v7.3.5:
`authPriority` defaults missing/invalid values to `0`; priority buckets are sorted
descending; `credentialweight.Default` is `1` and `Max` is `1_000_000`;
`pickWeighted` skips non-positive weights; and `pickReadyLocked` selects only from
the highest ready priority bucket before applying the configured strategy.
The external contract was exercised directly against the official CPA v7.3.5
source with `go test ./sdk/cliproxy/auth -run TestSchedulerPick`, including
`TestSchedulerPick_RoundRobinHighestPriority`,
`TestSchedulerPick_WeightedRoundRobin`,
`TestSchedulerPick_WeightedRoundRobinSkipsNonPositiveWeightPriorityTier`, and
`TestSchedulerPick_FillFirstSticksToFirstReady`. Those tests assert the selected
credential IDs and weighted pick counts, not merely decoded JSON: the highest
ready priority tier excludes lower tiers, a non-positive weight is skipped in
favour of a ready lower-priority credential, and fill-first keeps the same ready
credential. Additional CPA tests cover persisted metadata weight, cooldown
recovery, token-expiry demotion, and session-affinity lookup. Oh My CPA's
ingest-to-persistence round trip separately asserts that the emitted
`auth_index`/`auth_type` reach both list and detail projections unchanged.
