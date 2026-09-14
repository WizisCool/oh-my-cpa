# CPAMC parity matrix

This document links the feature inventory of the official [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) (CPAMC) to the implementation boundary of Oh My CPA.

## Goals and Compatibility Baseline

- **Target Upstream**: `router-for-me/CLIProxyAPI` `/v0/management` API.
- **Official UI Baseline**: CPAMC README targets CLIProxyAPI `>= 7.1.0` and recommends using the latest release.
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
| Gemini / Interactions / Codex / Claude / xAI / Vertex Keys | `ai_providers` | `GET/PUT/PATCH/DELETE /{provider}-api-key` | Covered | Unified provider list, sanitized display, and status toggling; provider toggles are serialized per provider with last-intent resolution; provider website is OMC management metadata (http/https only) |
| OpenAI-compatible providers | `ai_providers` | `GET/PUT/PATCH/DELETE /openai-compatibility` | Covered | Multi-key, endpoint sanitization, model list, and enable switches; website links and instant model filtering |
| Model pulling | Provider actions, Quick Start | Bypasses CPA: connects directly to provider `Base URL` `/models` (falls back to `/v1/models`); auth-file models use `GET /auth-files/models` | Covered | `POST /management/providers/pull-models` is initiated server-side and audited; provider URLs and secrets remain in Go |
| Auth file list / filter | `auth_files` | `GET /auth-files` | Covered (verified against real CPA 7.2.146) | Field normalization, runtime-only / disabled empty states |
| Auth file upload | `auth_files` | `POST /auth-files` multipart | Covered (verified against real CPA 7.2.146) | JSON file upload and invalid file feedback |
| Auth file download / delete | Detail / batch actions | `GET /auth-files/download`, `DELETE /auth-files` | Covered (verified against real CPA 7.2.146) | Safe filenames, download payload, and batch deletion |
| Auth file enable / disable & fields | Detail / batch actions | `PATCH /auth-files/status`, `PATCH /auth-files/fields` | Covered (verified against real CPA 7.2.146) | Status toggles, priority / weight / note / proxy fields |
| Auth file model list | Detail | `GET /auth-files/models` | Covered (real CPA 7.2.146 returns 200; older versions returning 404 map to 501 capability_missing) | Displays capability notice on older CPA versions |
| OAuth excluded models | `auth_files` sub-page | `/oauth-excluded-models` (in OMC handled via `excluded_models` in `PATCH /auth-files/fields`) | Partial: API supported, not exposed in UI | Backend field allowlist accepts `excluded_models`; drawer currently exposes priority / weight / note; UI additions will need wildcard and audit tests |
| OAuth model aliases | `auth_files` sub-page | `/oauth-model-alias` | Planned | Provider key normalization and wildcard testing |
| OAuth login | `oauth` | `GET /{provider}-auth-url`, `GET /get-auth-status`, `DELETE /oauth-session`, `POST /oauth-callback` | Covered | Provider / state polling, cancellation, callback input; no token emulation |
| Vertex JSON / iFlow Cookie import | OAuth / auth-files | `POST /vertex/import` and provider-specific flows | Planned | Dependent on upstream version capability probes |
| Quota observation | `quota_management`, credential detail | Quota and `model_quotas` telemetry from `auth-files` | Covered | Credential detail drawer display with field-level sanitization |
| Quota reset | Quota row action | `POST /reset-quota {auth_index}` | Covered | Accepts stable `auth_index`, secondary confirmation, audit logging, and frontend reset loop |
| Usage queue | Dashboard / observation | `GET /usage-queue?count=N` (equivalent to RESP subscription) | Covered (server-side collection, no direct console read) | `internal/usage/ingest` drains queue in the background; the console exposes no "read and acknowledge" action because reading is destructive and would race the collector. The request list "refresh" triggers `POST /usage/ingest/refresh` so the server drains CPA once via its collector goroutine and waits for visibility |
| API Key usage buckets | Dashboard / providers | `GET /api-key-usage` | In progress | Endpoint integrated into `/management/overview`; provider-level statistics render in dashboard; 20 10-minute global `traffic` buckets not yet rendered |
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
2. **Capability Additions**: OAuth model aliases and remaining auth-file field bindings (`prefix`, `proxy_url`, `disable_cooling`, `excluded_models`, `expired`) in UI forms.
3. **Multi-Instance Support**: Instance CRUD, key rotation, and instance-level permissions backed by an ADR (the database schema already models `cpa_bindings.instance_id`, while `/instances/default/*` remains single-instance).

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
