# ADR 0030: OpenRouter is the price source, and a price carries tiers and a channel multiplier

- Status: Accepted
- Date: 2026-09-28
- Extends: ADR 0003 (request-time price snapshots), which stands unchanged

## Context

Prices were synced from models.dev. Its catalogue lists every model once per
relay and aggregator that resells it, so matching needed a hand-kept table of
"first-party" provider ids per family and still priced some models at a
reseller's rate. A price was four flat rates and a multiplier: it could not say
that a prompt above 200K tokens costs twice as much, or that a model is cheaper
overnight, though the providers publish exactly that. A cache rate the catalogue
left out was stored as zero, which billed cached tokens as free.

The console also treated price as a page of its own. A request with no price
showed a dash with no way to fix it where it was seen; the page's only
guidance was a models.dev tab and a simulated budget chart.

Finally, CPA routes one model through several channels - an OAuth subscription,
the vendor's own API, a relay that resells at a discount - and a single
per-model multiplier cannot say that the same model costs 30% of list through
one of them.

## Decision

1. **OpenRouter's public model list is the only automatic source.** It lists a
   model once under its maker's namespace, carries dated canonical slugs, and
   publishes long-context and time-of-day overrides. The URL is a constant and
   needs no key. models.dev is removed; rows it priced keep their rate and
   `modelsdev` source until a sync matches them, and versions written under it
   stay priceable.
2. **A missing cache rate is the prompt rate, not zero.** An omission means no
   discount is published.
3. **A price carries tiers.** A tier applies when every condition it carries
   holds - a prompt threshold counted over the full input, a half-open UTC window
   read from the request's own timestamp - and exactly one tier governs a request:
   the highest threshold, then a windowed tier, then stored order. The tier is
   chosen inside the insertion transaction and its index stored with the cost, so
   a late-ingested request is priced by when it ran, not when it arrived.
4. **A channel multiplier is locked like a price.** Channels are the provider
   labels CPA records on a request. Multipliers are versioned append-only, the
   version in force at the request timestamp is stored beside the price version,
   and a missing or retired channel is 1×. Cost = tiered base × model multiplier ×
   channel multiplier, rounded once.
5. **Three pricing modes.** `auto` follows the automatic match, `linked` follows an
   OpenRouter model the operator chose, `custom` uses the operator's rates. A sync
   refreshes the first two and never touches the third, and never replaces a pin
   with its own match. A name that only resembles a listed model is suggested,
   never matched.
6. **Pricing happens where a cost is seen.** One editor opens in place from the
   price book, the request list, the request drawer and the dashboard's model
   ranking. A request's detail explains its stored amount from the versions it
   locked.

## Consequences

- Migration 028 rebuilds `model_prices` and `pricing_sync_state` (SQLite cannot
  relax a CHECK constraint) with the version triggers dropped, so existing rows
  are copied verbatim and nothing is repriced; `model_price_versions` is only
  extended because request snapshots reference it.
- The pricing schema gate moves to version 28.
- A request's recorded cost can now differ from `rates × tokens` of its base
  price: the breakdown names the tier and both multipliers so the difference is
  explained rather than surprising.
- Automatic prices change when OpenRouter's change, on the next sync. That is the
  point of `auto`; an operator who wants a fixed rate chooses `custom`.
- The demo no longer carries hand-written rates for synced models: it prices them
  from a trimmed copy of the real OpenRouter list with the production decoder and
  matcher.
