# Pricing and usage accounting

OMC estimates request cost from a versioned price book. It does not invoice upstreams.
The price effective at the request's timestamp is locked during ingestion; later
catalog downloads, edits and credential changes must not rewrite that evidence.

## Price selection

OpenRouter's public model catalog is the only automatic source, fetched from a fixed
server-side URL. A persisted CPA catalog defines current model/provider membership;
usage history does not define what the gateway currently serves.

- **Auto** follows a safe catalog match.
- **Linked** follows the OpenRouter identity the operator selected.
- **Custom** preserves operator-entered rates and tiers across synchronization.

Suggestions are advisory, not matches. Name similarity or a reasoning-effort suffix
must not silently select a price. Ambiguous OAuth aliases remain visible without an
automatic match; explicit links and custom prices remain authoritative. Matching is
deterministic; its normalization and precedence belong to
[`internal/pricing`](../internal/pricing), not a duplicated vendor table here.

A channel-specific custom price overrides the shared model price for that channel.
Removing an override appends a tombstone so later requests use shared pricing without
changing older costs. Mode changes update the price and pin together; switching to an
automatic/linked price requires usable catalog evidence. Sync and operator writes
share a lock and reread pins after downloads, so a concurrent operator choice wins.

## Quote semantics

Rates are USD per million tokens. A quote selects one applicable tier, applies model
and channel multipliers as exact fractions, then rounds once, half-up, to USD nanos.
The implementation is [`quote.go`](../internal/pricing/quote.go); browser previews use
[`pricingDisplay.ts`](../web/src/types/pricingDisplay.ts) against the same cases.

A tier can constrain prompt size, service tier and time of day. All its conditions
must hold. Selection prefers a service-tier rule, then the highest prompt threshold,
then a windowed rule, then stored order. Tiers do not stack; priority long-context
pricing must be represented by one tier with both conditions. Omitted rates inherit
the base policy; explicit zero remains zero.

Time windows are half-open and can cross midnight. They use the request timestamp
and the tier's IANA billing zone (UTC when absent), not the browser or deployment's
display clock. A malformed or unavailable zone must not silently become UTC.

Service-tier evidence is provider-aware. For Codex, a nonempty final outbound tier
wins, followed by a nonempty client tier; explicit `auto` selects no lane and does
not fall through. Other cases use non-`auto` response evidence then request evidence.
Historical snapshots without a stored selection retain their original policy.
`fast` and `priority` are not automatically synonyms: a price lists the names it covers.
See [`service_tier.go`](../internal/pricing/service_tier.go) for the resolver.

When OpenRouter omits a cache rate, the importer uses its prompt rate, not free cache
usage. Missing values and zero have different meanings throughout pricing.

## Recorded evidence and retention

The insertion transaction stores the chosen price/channel versions, selected tier
and final amount. Versions are append-only. A missing price or unresolved accounting
produces unpriced usage, with an absent cost; totals excluding it must disclose that
they are partial. Editing a price cannot manufacture missing accounting evidence.

CPA's validated complete token-accounting breakdown partitions input into uncached,
cache-read and cache-write, and output into non-reasoning and reasoning. Count
reasoning exactly once; never add it universally to a vendor's completion total.
Absent canonical evidence uses legacy accounting. Supplied but invalid, unsupported
or unresolved evidence is preserved and stays unpriced rather than guessed.
See [`accounting.go`](../internal/usage/accounting.go).

Permanent usage facts retain aggregates after request detail expires. Cost explanations
must use the locked snapshot rather than today's price, today's provider layout or an
inferred service tier from latency. Display currency conversion is presentation only;
recorded costs remain USD. A quota-capacity estimate consumes these locked costs but
is neither a new price nor an upstream bill.

## Extending pricing

Business operations live in [`internal/operations/pricing.go`](../internal/operations/pricing.go),
versioned storage in [`internal/repository`](../internal/repository), and parsing,
matching and quoting in [`internal/pricing`](../internal/pricing). Console and Agent
use the same operations. Verify the changed accounting or matching claim in its owning
suite; do not add a browser test to re-prove arithmetic. Follow [Testing](testing.md).
