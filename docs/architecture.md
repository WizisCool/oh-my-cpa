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
                                        └─ pricing sync loop ──▶ models.dev

Go process ──▶ CPA management API (/v0/management) ──▶ upstream providers
Go process ──▶ CPA RESP usage channel
```

One process, one SQLite file, one Oh My CPA replica. The Go process owns the
base path contract: the SPA is served at `<base>/`, the API at `<base>/api/v1`,
media at `<base>/media`. The proxy must preserve the prefix rather than strip
it (ADR 0001).

The React bundle is built into `internal/web/dist` and embedded with
`go:embed`, so a deployment has no CDN or static-file dependency. Everything the
browser can reach is a handwritten JSON endpoint; there is no generic pass
through to CPA.

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
| `internal/security` | Redaction, keyed-HMAC fingerprints, display masks | — |
| `internal/auth` | Admin session cookie: sign, verify, rotate | — |
| `internal/usage` | Decode CPA usage/error payloads into typed events | `security` |
| `internal/usage/resp` | Minimal RESP client for CPA's subscribe/LPOP subset | — |
| `internal/pricing` | Catalog snapshot, model matching, sync service, money math | — |
| `internal/cpa/management` | Typed CPA `/v0/management` client and RESP stream wrapper | `internal/usage/resp` |
| `internal/cpa/discovery` | Normalize CPA resources into the local identity model | `management`, `crypto`, `domain`, `security` |
| `internal/cpa/configyaml` | YAML document editing that preserves comments and unknown keys | — |
| `internal/repository` | SQLite schema, migrations, queries, transactional invariants | `crypto`, `domain`, `pricing`, `security`, `usage` |
| `internal/usage/ingest` | Collector loop, decode processor, rollup and retention maintenance | `repository`, `management`, `security`, `usage` |
| `internal/quota` | Per-provider quota probes and normalization | `management` |
| `internal/api` | Routes, DTO allowlists, audited sensitive reveals, audit writes | all of the above, `internal/web` |
| `internal/web` | `go:embed` of the built SPA | — |
| `internal/app` | Wiring, background loops, graceful shutdown | all of the above |

Two rules keep the boundary meaningful:

- `internal/repository` owns transaction boundaries. Anything that must be
  atomic with a write (cost locking, inbox→event promotion, rollup checkpoints)
  is a repository method, not a sequence of calls from a service.
- `internal/api` owns the allowlist. A new response field is a deliberate DTO
  change; the allowlist tests fail otherwise.

## 3. Frontend shape

`web/src` is a single-page app on React + TypeScript + Ant Design, with TanStack
Query for server state.

| Area | Contents |
| --- | --- |
| `App.tsx` | Router, lazily loaded pages, theme and locale providers |
| `api/client.ts` | The one typed HTTP client; every endpoint is declared here |
| `types/` | Wire types, including `usageEventView.ts` (row projection and filters) |
| `hooks/` | `usePreference`, `useLastIntentQueue` (per-key last-intent serialisation), `useLogTail`, `useVisibleNow` |
| `i18n/index.tsx` | The `[zh, en]` dictionary and the `t()` context |
| `theme/` | `themeConfig.ts` (antd tokens), `cacheScale.ts` (OKLCH cache ramp) |
| `utils/` | `maskKey.ts`, `externalUrl.ts` (the http/https link rule), `modelOptions.ts` (model-input filtering), `smoothScroll.ts` (the gesture/correction scroll schedule) |
| `components/`, `pages/` | Feature UI; one page per route, no page owns another |

All page routes are `React.lazy` import boundaries so the entry chunk stays
small; the shell (`AppLayout`, `AuthGate`) is loaded eagerly because every
route needs it. Brand/provider marks are copied from the pinned
`@lobehub/icons-static-svg` package into `web/public/lobe-icons` and referenced
as SVG URLs; the React icon package is imported only for its small catalog,
because a namespace import would pull hundreds of components into the eager
bundle. `components/resources/` and `components/icons/PresetIcon.tsx`
are retained from the retired triage console and are currently unreferenced; the
backend discovery/binding model they rendered is still live behind Providers and
OAuth management.

CSS class names are kebab-case everywhere, including `*.module.css` exports,
which are consumed as `styles['kebab-case']`. That is not cosmetic: `tsc` types a
CSS module as `Record<string, string>`, so a stale class reference compiles and
fails silently at runtime. `pnpm check-css-modules` is the guard that closes
that hole.

## 4. Request and session flow

1. `POST <base>/api/auth/login` with the CPA management key. The handler
   compares it against `OMCPA_CPA_MANAGEMENT_KEY`; there is no second password.
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

The key itself is encrypted with `OMCPA_MASTER_KEY` and stored on the
`cpa_instances` row, where `bootstrapDefaultInstance` refreshes it at every
startup so a rotation needs no SQLite surgery.

## 5. Discovery and identity flow

```text
POST /api/v1/instances/default/discover
  → internal/cpa/management reads auth-files, codex/claude/gemini API keys,
    openai-compatibility entries
  → cpa/discovery derives a stable resource key and binding fingerprint
  → repository upserts discovered_resources + cpa_bindings
  → Providers / OAuth management pages read the projected rows
```

The resource key resolution order and the ban on array position are fixed by
ADR 0002: immutable upstream id, then family-scoped `auth_index`, then a
versioned keyed HMAC of the credential material, then a fingerprint of
non-sensitive metadata, and finally an explicit `identity_collision` marker
rather than a silent merge. Secrets never enter a key, a fingerprint input that
is stored, or a response DTO.

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
  → /management/dashboard, /management/dashboard/tail, /usage/events
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
RESP `LPOP`, and an unreachable RESP endpoint degrades to HTTP
`/v0/management/usage-queue`. Empty pulls back off through `pullPacer` (1s → 2s →
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
Its deadline is capped below the server's write timeout, so a slow sync cannot
outlive the connection carrying its answer.

Timestamps in the usage tables are epoch **milliseconds**; the older identity
tables use `unixepoch()` seconds. Rollups are gated by
`usage_aggregation_checkpoints` so aggregation is incremental rather than a
full rescan.

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
case.

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
- **Private values are filtered, never projected.** `endpoint` narrows the list
  without the endpoint ever appearing in a list payload, and the shared search box
  deliberately excludes `client_ip`, `x_forwarded_for` and `endpoint`. `source`
  and `api_group_key` are fingerprinted at the persistence boundary, so a filter
  matches the stored fingerprint the facet offered, never the plaintext.
- **Anonymising projections are idempotent and shape-tolerant.** A record is
  masked twice — once by `internal/usage`, again by the persistence boundary — so
  `security.MaskIP`/`MaskForwardedFor` accept their own output (an IPv4 `/24` or
  an IPv6 `/64`) and re-mask it, and a narrower prefix such as `/32` is reduced to
  the coarse network rather than passed through as already anonymised. An
  endpoint arrives as the request line CPA handled (`POST /v1/chat/completions`),
  not as a bare path, so `PublicEndpoint` keeps the method while still stripping
  query, fragment and authority credentials. Both are pinned by tests that run a
  raw payload through decode *and* insert: a unit test on either half alone cannot
  see a second pass that destroys the first one's output.

### 6.2 Facets

`GetUsageFacets` enumerates the values actually present in a window so a dropdown
never offers a choice that returns nothing. Each dimension costs one grouped scan
of the window, and it is the *count* of those scans — not the size of any one —
that makes facets the expensive part of opening the page; `BenchmarkUsageFacets`
pins the budget. Endpoint and user agent are deliberately **not** facets: both are
long, high-cardinality values where a typed substring beats a capped 200-row list,
and the endpoint must never be handed to the browser at all.

Facets are read on their own window revision rather than on the list's poll
counter, and are cached with a five-minute `staleTime`. They describe which values
exist in a window, so they change only when the window is redefined (a new preset
or absolute range) or the operator refreshes explicitly — not on each list poll.
That manual refresh is the same sync described in §6: the page waits for the pull
and the decode barrier, then re-reads the list, the facets and the pipeline status.
The revision is part of the facet query key, not only of the window it computes,
because an absolute range resolves to the same two timestamps on every render and
a naive revision would leave the cached entry inside its `staleTime`.
`scripts/browser-usage-events.mjs` asserts this directly: a manual refresh issues
a `POST` to `/usage/ingest/refresh` before the list and facet reads, and the
fixed-window case re-reads facets too. Because the response is
capped at 200 values per dimension, a value that is selected but absent from it is
merged back into the options, so a filter that is still applied never renders as a
blank control.

### 6.3 Grouping the request list

The list offers three modes: chronological (`time`, the default), `source`, and
`ua`. `source` merges what used to be two separate modes, "by provider" and "by
credential": they were the same axis at two zoom levels, so one mode buckets on
provider-plus-credential and decides per provider whether the credential half is
worth printing. That decision is a property of the *page*, not of one bucket —
`providersWithMultipleAuthSources` answers it for every provider in the loaded
window — so a line served by a single credential reads as the provider alone
while a line split across two names both.

Grouping keys and labels are computed in `web/src/types/usageEventView.ts`, which
is what the logic test harness loads, and are pinned there rather than by reading
the DOM. Two properties matter beyond the labels:

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
three separate things (ADR 0003):

```text
CPA catalog read ──▶ pricing_model_catalog   (last complete snapshot)
                          │
models.dev api.json ──▶ pricing.Service ──▶ model_prices      (current projection)
                          │                      │ triggers
                          │                      ▼
                          │              model_price_versions (immutable, time-effective)
                          ▼
                    manual rows win; a delete writes an unavailable tombstone
```

`usage_events` stores the price version id and integer USD nanos chosen in the
event's own insert transaction, using the request timestamp. Historical totals
never join the mutable `model_prices` table, so a later edit cannot rewrite an
invoice. A request with no effective version is stored with pricing status
`unpriced` (`legacy_unpriced` for rows that predate migration 019), cost absent,
and is never backfilled.

Matching (`internal/pricing/match.go`) ranks catalog candidates with a fixed
tie-break chain instead of refusing ambiguous ones; an entry without explicit
input/output rates is never selected, because a missing rate must not become
zero.

## 8. Quota flow

`internal/quota` calls CPA's `/api-call` with the credential under observation to
reach the provider's own usage endpoint. Targets are restricted to
`AllowedURLPrefixes` — a compile-time allowlist of official HTTPS endpoints — and
the resulting snapshot is normalized and stored in `quota_snapshots`. This is the
only place Oh My CPA uses CPA as a request proxy, and it is server-initiated:
there is no user-supplied URL or generic `/api-call` surface.

## 9. Storage

| Table group | Tables | Notes |
| --- | --- | --- |
| Instances & identity | `cpa_instances`, `discovered_resources`, `resource_overrides`, `connections`, `cpa_bindings` | Encrypted management key; bindings survive upstream removal. `connections` is provisioned by migration 006 for the Connection entity but no code reads or writes it yet — treat it as reserved, not as a live table |
| Usage | `usage_inboxes`, `usage_events`, `error_events`, `ingest_gaps`, `usage_overview_hourly_stats`, `usage_overview_daily_stats`, `usage_aggregation_checkpoints` | Milliseconds; raw payloads encrypted |
| Pricing | `model_prices`, `model_price_versions`, `pricing_sync_state`, `pricing_model_catalog`, `pricing_catalog_state` | Versions are append-only via triggers |
| Operations | `audit_events`, `ui_preferences`, `quota_snapshots`, `schema_migrations` | Audit has no update or delete path — only `RecordAuditEvent` writes and read queries exist, and export itself is audited; the schema carries no enforcement trigger, so the guarantee lives in the repository API |

Migrations are embedded from `migrations/` and applied in filename order inside
one transaction each. A migration against an existing on-disk database first
writes an AES-GCM backup plus SHA-256 sidecar, restores it as a smoke test, and
keeps the newest five. Migration 004 additionally runs a Go governance hook
inside its transaction to sanitize historical rows. Rollback is forward-only:
fix a defect with a new migration, never by editing `schema_migrations`
(`docs/ops/sqlite-operations.md`).

## 10. Background loops

| Loop | Owner | Failure behaviour |
| --- | --- | --- |
| HTTP server | `app.Run` | Fatal; shutdown drains 10s |
| Usage pipeline | `app.Run` → `ingest.Pipeline` | Fatal; a stopped collector must not serve silently stale numbers |
| Pricing sync | `app.Run` → `pricing.Service` | Best effort; prices go stale, capture continues |
| Rollup + retention | `ingest.Maintenance` inside the pipeline | Retried on its own interval; errors surface in ingest status |

## 11. Where to look next

- Domain wording: `CONTEXT.md`
- Deployment and its trade-offs: `docs/adr/0001-go-react-sqlite-modular-monolith.md`
- Identity keys and rebinding: `docs/adr/0002-cpa-binding-and-identity-hierarchy.md`
- Cost immutability: `docs/adr/0003-request-time-price-snapshots.md`
- Visual system: `docs/design.md`
- Backup, restore, and migration gates: `docs/ops/sqlite-operations.md`
- Feature parity status against CPAMC: `docs/cpamc-parity.md`
