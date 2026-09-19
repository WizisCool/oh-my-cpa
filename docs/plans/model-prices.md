# Model prices

Design chosen after studying `cpa-usage-keeper` and `CPA-Manager-Plus` and
replacing the earlier heavier valuation prototype (removed before this work).

## Principles

1. Zero-config by default. The pricing service syncs from models.dev at startup
   and then on a server-side interval that defaults to daily; the operator can
   change it (off / 1h / 6h / 12h / 24h) without a restart. Deterministic
   candidate ranking selects winning price rows automatically per the ranking chain.
2. Pricing follows the current CPA catalog. A complete catalog snapshot is
   persisted separately from usage history; removed models leave the maintenance
   list while their immutable request snapshots remain queryable.
3. One source. `https://models.dev/api.json` is the only pricing source.
4. Manual wins. Operator edits are saved with source `manual` and are never
   overwritten by sync; deleting a row creates a retired tombstone version so
   future requests stay unpriced until the catalog re-syncs or a manual price is
   re-added.
5. Unpriced is not zero. Events without a price row report `cost_usd` absent,
   and the dashboard marks the window `partial` instead of fabricating money.
6. Request costs are locked once. The insertion transaction selects the price
   version effective at the request timestamp and stores USD nanos, so later
   edits cannot rewrite history. Existing rows from before this migration stay
   usage-only because their original rate is unknowable.

## Components

- `migrations/015_model_prices.sql`: `model_prices` + `pricing_sync_state`.
- `migrations/019_request_price_snapshots.sql`: immutable price versions and
  request-time cost/status snapshots.
- `migrations/020_pricing_model_catalog.sql`: current CPA catalog projection.
- `migrations/016_pricing_sync_state_repair.sql`: normalises sync-state rows
  that the first revision of the upsert wrote with TEXT in an INTEGER column.
- `migrations/017_pricing_auto_sync.sql`: adds `auto_sync_interval_hours` to
  `pricing_sync_state` (0 = disabled, default 24).
- `internal/pricing`: domain types, catalog fetch/decode, match, sync service.
  The package defines the `Store` interface; `internal/repository` implements it
  (dependency direction: repository → pricing).
- `internal/api/management_pricing.go`: `GET /v1/pricing`, `PUT /v1/pricing/models`,
  `DELETE /v1/pricing/models/{model}`, `POST /v1/pricing/sync` (409 while running),
  `PUT /v1/pricing/sync-schedule`.
- `web/src/pages/pricing/PricingPage.tsx`: one page — a sync telemetry bar with the
  interval selector, an unpriced-model ribbon, and a workbench whose filter tabs
  are all / models.dev / manual / unpriced, over a modal editor for the four
  rates and the multiplier.
- Usage events and the dashboard read the stored request-cost snapshot; they do
  not join mutable `model_prices` when calculating historical totals.

## Matching rule

`Catalog.MatchModel` ranks candidates instead of refusing them. Exact id,
name and normalized identities all enter the candidate set; the winner is
decided by the chain `plan-zero last → first-party provider (family list) →
match precision → longest true id match → fewest namespaces → not deprecated →
most recently updated → provider/model id`. The family lists mirror
cpa-usage-keeper and are verified against the live catalog (glm → zai/zhipuai,
qwen → alibaba-cn/alibaba, mimo → xiaomi, ...), which is what fixed the old
"only GPT models get priced" behavior. Entries without explicit input/output
rates are never selected — a missing rate must not become zero. A model with
no catalog identity at all stays unpriced for manual setup (the manual editor
pre-fills nothing and never guesses).

## Manual edit bookkeeping

A manual price is written as a new immutable version whose `effective_from_ms`
the database trigger stamps from the server clock. `updated_at_ms` on
`model_prices` — the value the pricing table and editor render as "when this rate
last changed" — is stamped by `UpsertModelPrices` from the same server clock and
is never taken from the request payload. The browser used to send `Date.now()`,
which let a skewed client clock misdate the change relative to the version that
actually governed billing.

Manual edits take effect immediately: `SaveManualPrices` writes the version in
the same transaction, so subsequent requests are priced without a metadata sync.
Requests stamped before the version's effective time stay `unpriced` even when
they are ingested later, because selection uses the request timestamp.

## Sync-state write rule

SQLite column types are advisory, so a mistyped value is stored happily and only
explodes on read. `SavePricingSyncState` therefore keeps every `DO UPDATE SET`
term on `excluded.` or the target row: the first revision bound a seventh
placeholder inside the UPDATE clause and passed the source name for it, which
wrote `modelsdev` into `last_success_at_ms` on every repeat sync and made
`GET /v1/pricing` fail. The read guards the column with `typeof()` so one dirty
bookkeeping field can never blank the page, and migration 016 heals stored rows.
`GET /v1/pricing` also degrades instead of failing: an unreadable sync state
returns `sync.known = false` with the reason in `sync.state.last_error`, while
the price table and unpriced models still load.

## Known limits

- First sync after boot needs a complete CPA catalog and network access to
  models.dev; a failure keeps the last complete catalog and good prices. The read
  is refused whole rather than partially published — publishing only the providers
  that answered would prune the rates of the ones that failed — and the aggregate
  keeps each source's error type, so a gateway that lacks an endpoint stays
  classifiable (`IsMissingCapability`) apart from one that failed to answer.
- Cached-token prices differ per provider; a missing field in the catalog means
  that bucket is billed at zero in estimates (recorded as-is, not invented).
