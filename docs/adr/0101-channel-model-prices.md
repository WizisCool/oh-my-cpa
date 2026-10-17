# ADR 0101: Custom model prices are scoped by the recorded channel

- Status: Proposed
- Date: 2026-10-16
- Amends: ADR 0031's global-price-only assumption

## Context

Model Square advertises client call names, including provider prefixes and aliases.
The price catalog and request cost lock use upstream models. Forwarding a prefixed
call name into the price editor fails catalog validation. Mapping every edit to the
shared model would also prevent two channels from charging different input, output,
cache and time-of-day rates for that same model. A channel-wide multiplier cannot
express independent rates or schedules per model.

## Decision

Keep the shared price book and add custom `(channel, upstream model)` overrides.
Channel means the exact provider label recorded in usage events, matching the
existing channel-multiplier contract. It is not a configuration row id or a routing
prefix; configuration rows sharing that label share a pricing scope.

Migration 043 adds the current override table and a channel discriminator to the
existing append-only price history. Historical rows default to the shared scope.
Ingestion selects the channel override effective at request time, falling back to
the shared scope when none is available. A deletion records a channel tombstone.
The existing channel multiplier applies after either price, and recorded requests
continue to reference their original immutable price and multiplier versions.

The existing model editor endpoints take an optional channel query parameter.
Channel writes require persisted provider membership and custom mode. Shared
automatic prices, operator links and custom prices continue to work unchanged.
Model Square resolves explicit routes and offers every distinct channel/model
target. The price book shows one effective price per provider/model membership,
labels channel overrides and inherited shared prices, and keeps editing for both
scopes accessible from that row.

## Consequences

- Operators can set independent rates, cache prices, long-context and time tiers
  without introducing synthetic model identities or changing CPA configuration.
- Automatic synchronization changes shared rates without overwriting overrides.
- Restoring the shared price affects future requests; late events still resolve
  prices at their original timestamps, and no recorded cost is backfilled.
- Channel overrides are custom rates; independent per-channel automatic links
  and a finer identity than CPA's recorded provider label are outside this change.
- The existing agent pricing capabilities continue to operate on shared prices.
  Channel overrides are managed through the console and authenticated REST API.
