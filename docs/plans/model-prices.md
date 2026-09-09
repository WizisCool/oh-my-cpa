# Model prices (费用与定价)

Design chosen after studying `cpa-usage-keeper` and `CPA-Manager-Plus` and
replacing the earlier heavier valuation prototype (removed before this work).

## Principles

1. Zero-config by default. The pricing service syncs from models.dev at startup
   and then daily; unique strong model matches become price rows automatically.
2. Pricing follows traffic. The sync scope is the models actually seen in usage
   events (most recent first), never the provider catalog: configured-but-unused
   models stay out of the price table so the page stays light.
3. One source. `https://models.dev/api.json` is the only pricing source.
4. Manual wins. Operator edits are saved with source `manual` and are never
   overwritten by sync; deleting a row returns the model to automatic pricing.
5. Unpriced is not zero. Events without a price row report `cost_usd` absent,
   and the dashboard marks the window `partial` instead of fabricating money.
6. Estimates stay estimates. Costs are float64, per-1M-token rates times token
   buckets times one optional multiplier (covers peak/off-peak billing).

## Components

- `migrations/015_model_prices.sql`: `model_prices` + `pricing_sync_state`.
- `migrations/016_pricing_sync_state_repair.sql`: normalises sync-state rows
  that the first revision of the upsert wrote with TEXT in an INTEGER column.
- `internal/pricing`: domain types, catalog fetch/decode, match, sync service.
  The package defines the `Store` interface; `internal/repository` implements it
  (dependency direction: repository → pricing).
- `internal/api/management_pricing.go`: `GET /v1/pricing`, `PUT /v1/pricing/models`,
  `DELETE /v1/pricing/models/{model}`, `POST /v1/pricing/sync` (409 while running).
- `web/src/pages/pricing/PricingPage.tsx`: one page, three cards (prices, sync,
  unpriced models); a modal editor for manual rows and the multiplier.
- Usage events and the dashboard join `model_prices` for the estimated cost.

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

- First sync after boot needs network access to models.dev; a failure keeps the
  last good prices and records `last_error` on the sync state.
- Cached-token prices differ per provider; a missing field in the catalog means
  that bucket is billed at zero in estimates (recorded as-is, not invented).

