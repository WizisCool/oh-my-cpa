# ADR 0003: Lock request costs to request-time price versions

## Status

Accepted

## Context

The old cost query joined every usage event to the mutable `model_prices` row.
Changing a price therefore changed historical invoices and dashboard totals.
The old sync scope also used historical traffic, which made removed models stay
in the maintenance list indefinitely.

## Decision

Maintain a durable snapshot of the current CPA model catalog separately from
usage history. A complete CPA catalog refresh atomically replaces that snapshot;
partial or failed discovery leaves the last complete snapshot intact. A model
alias stores its canonical pricing identity, so aliases do not need separate
manual maintenance when CPA changes their target.

Keep `model_prices` as the current editable projection and append immutable rows
to `model_price_versions` whenever a price is created, changed, or retired.
When a usage event is inserted, select the latest version effective at the
event's request timestamp and store its version id plus an integer USD-nanos
cost in the same transaction. A missing or invalid price is stored as usage
with status `unpriced`/`invalid_price`, never as zero and never as a future
backfill. Rows that predate this migration are `legacy_unpriced` because their
original price cannot be reconstructed.

Manual edits are restricted to the current CPA catalog and are protected both
in the service and in the SQL upsert. Removing a manual price retires its
current version; the next catalog refresh can recreate an automatic price for
future requests without changing existing snapshots.

## Consequences

- Historical costs remain stable across price changes, model removal, delayed
  queue delivery, and retries.
- The pricing page only asks users to maintain currently configured CPA models.
- Existing databases lose no usage telemetry, but old rows cannot be assigned
  an invented historical cost.
- A catalog refresh requires a successful CPA management read and can wait for
  the configured metadata source to identify a new model's rates.
