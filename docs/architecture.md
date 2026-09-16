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
media at `<base>/media`. The embedded bundle's hashed assets are served from
`<base>/assets/` and provider SVGs from `<base>/lobe-icons/`; unknown non-API
paths fall back to the SPA shell. The proxy must preserve the prefix rather than
strip it (ADR 0001).

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

### Known coverage gaps

- The browser suite had a history of timing-sensitive flakes in the usage-events
  filter section, unrelated to the provider write path: `the list is back to the
  unfiltered page` and `the queued search still lands` each failed once in repeated
  runs before the request-view policies were lifted out of the page. They were fixed
  rather than tolerated - see §11.3 - and the diagnosis was confirmed by reproducing
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

## 3. Frontend shape

`web/src` is a single-page app on React + TypeScript + Ant Design, with TanStack
Query for server state.

| Area | Contents |
| --- | --- |
| `App.tsx` | Router, lazily loaded pages, theme and locale providers |
| `api/client.ts` | The one typed HTTP client; every endpoint is declared here |
| `types/` | Wire types, including `usageEventView.ts` (row projection and filters) and `usageEventViewActions.ts` (the view's URL and persistence rewrites) |
| `hooks/` | `usePreference`, `useLastIntentQueue` (React binding) over `lastIntentQueue` (the framework-free controller) and `disposableSlot` (effect-scoped resource lifetime), `useLogTail`, `useVisibleNow` |
| `i18n/index.tsx` | The `[zh, en]` dictionary and the `t()` context |
| `theme/` | `themeConfig.ts` (preset registry, antd tokens and CSS-variable projection), `ThemeContext.tsx` (single active preset), `cacheScale.ts` (OKLCH cache ramp) |
| `utils/` | `maskKey.ts`, `externalUrl.ts` (the http/https link rule), `modelOptions.ts` (model-input filtering), `smoothScroll.ts` (the gesture/correction scroll schedule) |
| `components/`, `pages/` | Feature UI; one page per route, no page owns another. `components/usage/` also carries that page's framework-free policies: `searchDebounce.ts`, `pollingPolicy.ts`, `timeRangePolicy.ts`, `syncPresentation.ts` and `chipDisplay.ts` |

All page routes are `React.lazy` import boundaries so the entry chunk stays
small; the shell (`AppLayout`, `AuthGate`) is loaded eagerly because every
route needs it. Brand/provider marks are copied from the pinned
`@lobehub/icons-static-svg` package into `web/public/lobe-icons` and referenced
as SVG URLs. The small catalog used for lookup and grouping is vendored in
`web/src/generated/lobeIconCatalog.json`; the React icon package is not a
dependency, because importing it would pull hundreds of components into the
eager bundle. Dashboard KPI cards use `@ant-design/charts` in a dedicated
`vendor-charts` chunk, lazily loaded so the entry bundle stays small.
`components/resources/` and `components/icons/PresetIcon.tsx`
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
  → repository upserts discovered_resources + cpa_bindings (served via /api/v1/resources)
```

The resource key resolution order and the ban on array position are fixed by
ADR 0002: immutable upstream id, then family-scoped `auth_index`, then a
versioned keyed HMAC of the credential material, then a fingerprint of
non-sensitive metadata, and finally an explicit `identity_collision` marker
rather than a silent merge. Secrets never enter a key, a fingerprint input that
is stored, or a response DTO. (The Providers and OAuth management pages inspect
and manage CPA runtime entries directly through `/api/v1/management/providers`
and `/api/v1/management/auth-files`, layering local preference metadata on read.)
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
    /usage/events
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
built by the handler from the viewer's IANA zone with `time.Date`/`AddDate`, and reads the
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
  defined in `web/src/types/usageEventView.ts`), `ttft_ms` is treated as a genuine
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

## 11. Test layering

The suite is split by what each layer can actually prove, not by which runner is
fashionable. The rule is **Browser Everything → Browser Only Where Browser
Matters**: an assertion moves down a layer when a lower layer can make the same
claim, and it stays in Chromium only when the claim is about the engine.

| Layer | Command | What it proves |
| --- | --- | --- |
| Pure logic | `pnpm test:logic` | Decisions about the operator's own input: URL rewrites, saved-view derivation, debounce invalidation, the poll decision, range validation, chip display mapping, refresh presentation. Runs under Node with no bundler, no HTTP server, no Go binary and no browser. |
| Mechanical repository gates | `pnpm test:docs`, `pnpm test:i18n`, `pnpm test:css-modules`, `pnpm test:dev-target`, `pnpm test:affected-checks`, `pnpm test:sync-web-dist`, `pnpm test:install-chromium`, `pnpm test:check-ui-plan` | Path references, translation keys, CSS class references, the dev proxy target, the embedded-distribution sync, the Chromium installer's decision, the fast-path planner and the UI scenario planner. |
| **UI fast path** (development only) | `pnpm check:ui` | The subset of browser claims a change can affect, against the **dev server** with mocked routes. No `pnpm build`, no Go binary, no fake CPA. This is the only layer where `React.StrictMode`'s double-invoke happens, so it is the only place a hook that disposes what it should re-create can be observed. |
| Cross-stack smoke | `pnpm verify:browser:smoke` | The thin path a pull request needs: `/omc` redirect, sign-in rejection and success, the dashboard and request list rendering their seeded rows, no console or page error. |
| Cross-stack acceptance | `pnpm verify:browser` | The whole stack against the fake CPA: auth, every route's render and secret boundary, key aliases, provider enable/disable and its concurrent path, live-tail polling, quota, OAuth. |
| Browser-only probes | `pnpm verify:probes` | The same claims as the UI fast path, but against the built SPA for release. Drawer/modal stacking and hit-testing, column geometry and truncation, the responsive alignment override, dashboard trend mark paint, refresh sequencing under a held response. |

### 11.0 The fast path is not a cheaper gate

`check:ui` and `verify:probes` run the **same scenarios** from
`scripts/acceptance/scenarios.mjs`; the difference is what they run them against, and
that difference is not a cost trade - it is a coverage difference in both directions.

`check:ui` cannot replace `verify:probes`, because the dev server and a mocked API
cannot show path resolution, minification or chunk boundaries, which is exactly the
class of bug a release artefact exposes. `verify:probes` cannot replace `check:ui`,
because a production build does not double-invoke effects, so a hook that creates a
disposable resource during render and disposes it in the first cleanup looks correct
there and is broken in development. The `search-dev-server` scenario exists because
that is not hypothetical: the debounce controller was refactored into exactly that
shape, the whole production-bundle suite stayed green, and the search box silently
stopped committing on the dev server. It was found by running the scenario against
the dev server, and it is guarded there now.

### 11.0.1 Three verification moments

Verification is organised by *when it runs*, because what a developer pays is
waiting, and a gate that costs minutes gets routed around:

| Moment | Runs | Cost |
| --- | --- | --- |
| Development iteration | `pnpm test:fast`, plus `pnpm check:ui` when the change touches interaction, layout or a browser lifecycle | 1-13s, plus 3-19s |
| One logical feature complete | `pnpm verify` | ~22s |
| Before declaring done or pushing | `pnpm verify:full`; skipped when the stage's own run already covered unchanged code and artefact | ~95s |

The rule that keeps this honest is that a *narrow* plan must never be **silent**.
`scripts/affected-checks.mjs` and `scripts/acceptance/check-ui-plan.mjs` both widen
rather than guess: the shared layer selects everything, an unrecognised frontend path
selects everything, and a change to either planner's own framework selects
everything. Both are pinned by tests that were checked against negative controls.

Two properties of this split are load bearing.

**A browser assertion is never removed without a replacement.**
`scripts/acceptance/MIGRATION.md` classifies every assertion in
`scripts/browser-acceptance.mjs` once - `PURE`, `COMPONENT`, `BROWSER` or
`CROSS-STACK` - and every assertion that left the browser names the test that
replaced it. An assertion may move; it may not disappear silently.
`scripts/browser-acceptance.mjs` is now the lifecycle/orchestration entrypoint.
Release domains live in focused modules under `scripts/acceptance/`: auth files,
key management, usage events and live-tail behavior, providers, observability,
configuration and plugins, theme and brand artwork, and OAuth flows. Each module
receives the shared browser harness it needs and owns one product surface rather
than becoming another catch-all script.

**`pnpm test:fast` never pays for the browser.** No ordinary change may build the
SPA, build a Go binary, start Vite, start Chromium or start the fake CPA. The
selection lives in `scripts/affected-checks.mjs` so it can be asserted directly,
including that negative property, and a file the rules cannot place selects the
broad gates rather than nothing.

### 11.1 Why some claims live where they do

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

### 11.2 Where the wall clock actually goes

Assertion count was not the cost, and reducing it did not by itself make the
browser suite faster. Measured per line, the acceptance run's time sits in
navigations, `waitFor` round trips and one ten-second cadence wait - which is why
the useful levers were structural rather than subtractive:

| Lever | Effect |
| --- | --- |
| Fold four standalone Chromium probes into one shared server and browser, each scenario in its own context | Four dev servers and four browsers become one each |
| Move the focused probes into `verify:full` | They were in no gate at all; a guarded invariant nobody runs is not guarded |
| Fix the suite's CPU-sensitive reads, then run the two browser phases concurrently | About 12s on a 2-CPU runner, about 14s on four cores |
| Remove the deletion window from the embedded-distribution sync | Not a speed fix: it removes a race between `pnpm build` and the Go gates, which is what made overlapping them safe to keep |

Two levers were measured and rejected.

**Clock-driven polling.** `page.clock` does make the ten-second interval fire early
(11s of app time in about 900ms), but the same mock covers `requestAnimationFrame`
and `performance.now`, which is what `smoothScroll`'s gesture schedule is built
from: with the clock installed the back-to-top gesture landed at 37px instead of
the top, with no page error, breaking the assertion the block exists for. Isolating
the interval from the frame clock is not expressible through that API, so the wait
stays.

**`tsc --incremental`.** It needs a cache that stays correct across a changing
`include` set, which is the fragile dependency graph `test:fast` exists to avoid.

### 11.3 The flakes were real, and they were in the assertions

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

### 11.4 The CI critical path is Chromium's OS dependencies

The `browser` job's preparation step was about 99s, bound by
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

Removing the apt cost then exposed what it had been hiding: the Go build is now the
floor of that step, about 60s locally with a cold build cache against 92s on the
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

## 12. Where to look next

- Domain wording: `CONTEXT.md`
- Deployment and its trade-offs: `docs/adr/0001-go-react-sqlite-modular-monolith.md`
- Identity keys and rebinding: `docs/adr/0002-cpa-binding-and-identity-hierarchy.md`
- Cost immutability: `docs/adr/0003-request-time-price-snapshots.md`
- Visual system: `docs/design.md`
- Backup, restore, and migration gates: `docs/ops/sqlite-operations.md`
- Feature parity status against CPAMC: `docs/cpamc-parity.md`
