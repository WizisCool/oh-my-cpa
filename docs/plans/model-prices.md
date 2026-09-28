# Model prices

The price book: how every request the gateway serves is given a cost, which
rates that cost is locked against, and how an operator changes them. The
decision record is ADR 0030; the request-time lock it extends is ADR 0003.

## Principles

1. **Zero-config by default.** The pricing service downloads OpenRouter's public
   model list (`https://openrouter.ai/api/v1/models`, no key) at startup and then
   on a server-side interval that defaults to daily; the operator can change it
   (off / 1h / 6h / 12h / 24h) without a restart. Every current CPA model that
   matches an OpenRouter model is priced automatically, and a model CPA starts
   serving is priced within the five-minute catalog reconciliation from the
   stored snapshot, without waiting for the next download.
2. **One source.** OpenRouter is the only automatic source. The URL is a
   compile-time constant; no operator-supplied URL is ever fetched.
3. **Pricing follows the current CPA catalog.** A complete catalog snapshot is
   persisted separately from usage history; removed models leave the book while
   their immutable request snapshots remain queryable.
4. **Three modes, and the operator's always wins.** A model is priced
   automatically (`auto`), follows an OpenRouter model the operator chose
   (`linked`), or uses the operator's own rates (`custom`). Syncs refresh auto
   and linked rows and never touch custom ones; a sync never replaces a pinned
   model with its own match.
5. **Unpriced is not zero.** A request with no price version reports `cost_usd`
   absent, and every total that excludes it says it is partial.
6. **Request costs are locked once.** The insertion transaction selects the price
   version and the channel version effective at the request timestamp, applies
   the tier the request qualifies for, and stores USD nanos, the tier index and
   both version ids. Later edits cannot rewrite history.

## Price structure

A price is four rates per 1M tokens (prompt, completion, cache read, cache
write), a model multiplier, and an optional list of **tiers**:

- a **long-context tier** (`min_prompt_tokens`) applies when the request's full
  input, cached tokens included, reaches the threshold;
- a **time-of-day tier** (`utc_start`/`utc_end`, HHMM) applies when the
  request's own timestamp falls in the UTC window `[start, end)`, which wraps
  past midnight when the end is not after the start;
- a tier carrying both applies only when both hold.

Exactly one tier governs a request: the highest applicable threshold, then a
windowed tier over an unwindowed one, then stored order. Rates a tier leaves
out inherit the base price. `pricing.Quote` is the single implementation; the
console's editor preview mirrors it in `web/src/types/pricingDisplay.ts` and
the logic suite pins the two against the same cases.

A **channel multiplier** scales every request one CPA provider answered
(`usage_events.provider`, e.g. `codex`, `openai-compatible-deepseek`). The
request cost is:

```
tiered base cost × model multiplier × channel multiplier
```

Both multipliers are applied as exact fractions before a single half-up
rounding to nanos, so a request with no tiers and a 1× channel costs exactly
what the pre-tier formula charged (`FuzzQuoteLegacyParity`).

## Decoding OpenRouter

`internal/pricing/openrouter.go` reduces the envelope to list prices:

- per-token decimal strings are scaled to per-1M exactly;
- variants (`:free`, `:batch`, every `:` flavour), OpenRouter's own routers and
  any entry whose price is negative or missing are skipped;
- `~vendor/…-latest` aliases are kept but only ever match as a last resort;
- overrides with `min_prompt_tokens` or `utc_start`/`utc_end` become tiers; any
  other override is dropped;
- **a cache rate OpenRouter omits resolves to the prompt rate**, never to zero:
  the omission means no cache discount is published, and zero would bill cached
  tokens as free. A tier inherits its own prompt rate the same way when the base
  inherited one.

Tiers are stored in one canonical spelling (`pricing.EncodeTiers`), because the
version trigger compares the stored text and two spellings of the same tiers
would mint a version on every sync.

## Matching rule

`Catalog.MatchModel` ranks candidates by match precision, then first-party
author, then slug length, then id — a total order, so the winner is stable
across syncs:

1. `exact` — the OpenRouter id without its author namespace;
2. `canonical` — the dated canonical slug (`claude-opus-5.5-20260921`);
3. `normalized` — case and separator normalization (`GLM-5.3 Flash` = `glm-5.3-flash`), preserving numeric component boundaries so `5.1` never equals `51`;
4. `date_stripped` — after removing one release date (`-YYYYMMDD`,
   `-YYYY-MM-DD`, `-MM-YYYY`, or `-MMDD` when it reads as a real month and day, so
   Qwen's YYMM `2507` survives);
5. `alias` — a floating `~…-latest` alias.

The first-party author table maps a model family to OpenRouter namespaces
(`gpt` → `openai`, `glm` → `z-ai`, `kimi` → `moonshotai`, …). A CPA name is
split with `StripProviderPrefix`; an OpenRouter id is split at its first `/`
and its `:` variant is never treated as a model.

A name that only resembles a listed model — typically a reasoning-effort
decoration such as `gpt-5.4-mini-high` — is not matched. `Catalog.Suggest`
offers it instead, restricted to the family's first-party authors. A recognized trailing effort or thinking control is removed for suggestion ranking only; a resolved base identity (including canonical or dated names) ranks first. The console lets the operator adopt a suggestion in one click (a link).

A CPA alias with conflicting targets is persisted with an empty `price_model`. It stays visible but does not auto-match; other models continue syncing. A newly ambiguous alias retires its previous automatic price, while custom prices and operator links remain authoritative. Invalid model identities still reject the entire snapshot.

## Components

- `migrations/028_openrouter_pricing.sql`: rebuilds `model_prices` (tiers, upstream
  id, match kind, the `openrouter` source) and `pricing_sync_state` (source
  `openrouter`, the schedule carried over), extends `model_price_versions`, and adds
  `pricing_model_links`, `pricing_upstream_catalog`, `pricing_channels`,
  `pricing_channel_versions` and `usage_events.channel_version_id`/`price_tier`.
  Existing rows are copied with the version triggers dropped, so the upgrade mints
  no version and reprices nothing.
- `migrations/019_request_price_snapshots.sql` and
  `migrations/020_pricing_model_catalog.sql`: the append-only versions, the request
  snapshot columns and the CPA catalog projection this builds on.
- `internal/pricing`: `openrouter.go` (fetch and decode), `match.go` (index,
  ranking, suggestions), `quote.go` (tier selection, `Quote`, tier encoding),
  `service.go` (sync, modes, channels), `types.go`. The package defines the
  `Store` interface; `internal/repository` implements it.
- `internal/repository/usage_pricing.go`: the request lock (`lockUsagePrice`), the
  read-time breakdown (`GetUsageEventCostBreakdown`) and price history;
  `pricing_channels.go`, `pricing_upstream.go`, `pricing_usage.go` (30-day traffic
  per model and channel, and the median token profile).
- `internal/api/management_pricing.go`: `GET /v1/pricing`,
  `GET /v1/pricing/attention`, `GET /v1/pricing/catalog`,
  `GET|PUT|DELETE /v1/pricing/models/{model}`,
  `PUT|DELETE /v1/pricing/channels/{channel}`, `POST /v1/pricing/sync` (409 while
  running), `PUT /v1/pricing/sync-schedule`. Path parameters are decoded, so a
  model named `openai/gpt-5` works. The request detail response carries
  `cost_breakdown`.
- `internal/operations/pricing.go`: the agent capabilities `pricing_list`,
  `pricing_set` (mode, link, rates, tiers), `pricing_delete`, `pricing_sync`,
  `pricing_channel_set`, `pricing_channel_delete`.
- `web/src/components/pricing/`: the console-wide editor (`PricingEditorProvider`,
  `PriceEditorDrawer`), the request cost breakdown, and shared parts.
- `web/src/pages/pricing/`: the price book — coverage and sync status in the head,
  the provider-grouped model list, and the channel multiplier tab.

## Where a price is set

The editor opens in place from every surface that shows a cost:

- the price book's rows (where "Adopt" links a suggestion without opening the editor);
- an unpriced row of the request list, without opening the record;
- the request drawer's cost breakdown;
- an unpriced or partially priced group of the dashboard's model ranking, in the
  model view only — a call point may be an alias priced under the model it
  resolved to.

The dashboard's cost tile links to the book when its total is partial. The editor
previews the change on the model's median request of the last seven days, and
on its largest recent prompt when that reaches a long-context tier.

## Provider-grouped workbench

Model membership is collected during the same complete CPA catalog sweep as alias targets, then persisted atomically in `pricing_catalog_state.providers_json` (migration 029). The price book reads this snapshot locally: opening the page never fans out across credentials. API-key providers retain their provider-page ids; OAuth credentials are combined by provider, using the highest active credential priority. Disabled credentials do not contribute membership. A failed sweep preserves the entire previous snapshot. Deleting a positional API-key provider re-keys stored membership in the same transaction as its display-name, website and icon overlays.

`GET /v1/pricing` includes `providers`, with id, family, display name, channel, priority, OAuth marker, model membership, an optional icon override and a hostname-only endpoint hint for the existing provider icon resolver. URL userinfo, paths and query parameters are excluded. The facade resolves current provider name/icon preferences at read time; the frontend uses the same default provider marks and plugin-owned logos as provider management. Individual model names are text-only; `pricingModelIdentity` is the metadata extension point.

Groups sort by descending routing priority, then natural provider name and stable id. Models sort naturally by name, case-insensitively first and uppercase first for case-only ties. Membership uses exact model identities: two names differing only in case remain distinct. A model served by multiple providers appears in each relevant group, but all entries edit the same global price. Models without recorded membership appear in an explicit unconfirmed group rather than a guessed maker group.

Search, price-mode filters and a provider selector operate on the grouped book. One global page renders at most 20 membership rows across all groups on desktop and phones. Unpriced models occupy their normal sorted position and show any suggested link beside their name. The OpenRouter picker searches ids, canonical slugs and display names with separator-tolerant search; it paginates all matches in groups of 12 instead of truncating the catalog. Channel multipliers use 20-row pages and reuse known provider aliases/icons; a channel shared by several configured providers names those providers together.

## Mode changes

A mode change is one write (`Repository.ApplyModelPrice`) that replaces the row,
custom included, and sets or clears the pin in the same transaction, so it mints
exactly one version and never a tombstone in between. A switch to `auto` or
`linked` is refused when the stored snapshot has nothing to price it with,
rather than leaving the model unpriced. Removing a price retires it and its pin;
the next reconciliation may price the model automatically again.

Sync and operator writes share one lock. The download happens outside it, and
prices and pins are re-read under it before writing, so a pin set during a slow
download is honoured; the upsert guard refuses to replace a pinned row with a
different upstream model as a second line.

## Bookkeeping

`updated_at_ms` is stamped by the server when a row is written; a browser clock
never dates a price change. SQLite column types are advisory, so
`SavePricingSyncState` keeps every `DO UPDATE SET` term on `excluded.` or the
target row, the read guards `last_success_at_ms` with `typeof()`, and
`GET /v1/pricing` degrades to `sync.known = false` with the reason in
`sync.state.last_error` rather than failing. Traffic columns degrade the same
way: a failed usage read leaves them empty and the response names it in
`partial`.

A request breakdown preserves its stored status and amount when its locked tier
snapshot is unreadable, reports `invalid_reason`, and withholds a recomputed quote.
Price history rejects corrupt tier snapshots rather than presenting them as base-only rates.

## Known limits

- The first download after boot needs network access to openrouter.ai; a failure
  keeps the last complete snapshot and good prices, and reconciliation keeps
  pricing new models from the stored snapshot. Local reconciliation preserves the
  previous refresh error and schedule; only a successful price refresh clears it.
- A model OpenRouter does not list stays unpriced until an operator links or
  prices it; suggestions only help when the name resembles a listed model.
- Rows priced from models.dev before the switch keep their `modelsdev` source
  until a sync matches them, and stay priced meanwhile; the book labels them as
  legacy. A version written under that source still prices late-arriving
  requests stamped inside its period.
- A request's cost breakdown is recomputed from the versions it locked. The stored
  amount is authoritative; `recomputed_matches` flags any disagreement.
- **Demo mode runs no sync.** The OpenRouter snapshot, the prices, one pin, one
  channel multiplier and the sync bookkeeping are fixture data seeded by
  `internal/demo`; the snapshot is a trimmed copy of the real list
  (`internal/demo/openrouter_snapshot.json`) priced by the same decoder and
  matcher. The fixture writes the price and channel versions its fabricated
  history is priced against (`Repository.SeedModelPriceHistoryBackfill`,
  `Repository.SeedChannelHistoryBackfill`). See `docs/architecture.md` §13.
