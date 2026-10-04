# ADR 0058: Window capacity is estimated on read from locked costs

- Status: Accepted
- Date: 2026-10-05

## Context

A subscription credential reports how much of a quota window is used as a
percentage, never as an amount. Operators want to know what a window is worth:
how many dollars of API-priced traffic, or how many tokens, 100% of it buys.
OMC already holds both halves of that answer. `internal/quota` normalizes each
window's used share, reset instant and period, and `usage_events` records every
request a credential served with a cost locked at request time.

Two existing tools derive the figure the same way, recorded usage divided by the
used share, and differ in what they guard against. One computes it in the
browser for a single provider window with no guard beyond a positive share. The
other also computes it in the browser, re-prices history at current prices, and
maintains a persisted lifecycle of window cycles (three tables and their
transitions) to know where a cycle starts and whether it was reset early.
Neither withholds an estimate at a low used share, where upstream's whole-point
rounding dominates the result.

## Decision

Estimate a window's capacity on the server, when a quota is read.

- **Arithmetic is pure and lives in `internal/quota`**; `internal/api` supplies
  its inputs from `internal/repository`. The console, the agent capabilities and
  the generated demonstration read one result.
- **The usage range ends at the observation**, `[reset − period, observed_at)`.
  The share and the usage then describe the same interval without a rule that
  rejects an estimate whenever a request is newer than the reading.
- **Cost is the sum of Request Cost Snapshots.** An estimate is not rewritten by
  a later price change, and a cycle with more than 5% of its requests unpriced
  gets a token estimate only.
- **Nothing is persisted.** The fields are joined after a snapshot is stored and
  never enter `quota_snapshots`, so usage ingested after an observation is
  counted on the next read and no migration is needed.
- **A mid-cycle reset is read from the snapshots a credential already keeps**:
  an earlier reading inside the same cycle that is higher than the current one
  withholds the estimate. No cycle lifecycle is stored.
- **An estimate is withheld below a 5% used share**, and every estimate carries
  the relative error that half a percentage point puts on it.
- **Scope is the windows every request draws on**: Codex and Claude 5-hour and
  weekly. Model- and feature-scoped windows are excluded until usage can be
  matched to their scope.

## Consequences

- The figure is honest about its precision and absent when it would mislead, at
  the cost of showing nothing early in a cycle.
- Traffic that bypassed the gateway is invisible to the numerator, so the
  estimate is a lower bound for a credential also used elsewhere. The console
  says so beside the figure.
- The quota it measures is not metered in API dollars upstream, so the estimate
  moves with the mix of models. It is a reading for the operator and must not
  feed routing or a credential's status.
- Each overview read costs one indexed aggregate per eligible window and one
  snapshot-history read per credential that has one. That is proportional to the
  number of subscription credentials, which is small.
- Without a stored lifecycle there is no previous-cycle fallback: right after a
  reset a window shows no estimate until 5% is used. A fallback derived from
  snapshot history can be added without changing this decision.
- A cycle whose reset instant is only approximate gets no estimate, because its
  start cannot be placed.
