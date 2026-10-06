# ADR 0062: Dashboard statistics are permanent usage facts; request records roll

- Status: Accepted
- Date: 2026-10-06
- Supersedes: the "one source, read the detail table" reasoning in ADR 0005 for the
  token grid's query, and the hourly/daily overview rollups. ADR 0005's DOM-grid
  decision is unchanged.

## Context

Usage is stored three times at three sizes. On a deployment with 121 302 request
records over 23.5 days, the captured payloads (`usage_inboxes`) held 82.5% of a 710 MB
database, the typed request records (`usage_events`) and their indexes about 16%, and
the hourly and daily rollups a fraction of one percent.

Retention removed all three at the same horizon. The rollups carried neither cost nor
provider nor credential, so the cost tile, the model panels, the provider list and the
token grid read request records directly. A dashboard could therefore never show more
than the retention horizon, and keeping statistics longer meant keeping the two largest
tables longer. The default horizon was 400 days only so the year-long token grid stayed
readable.

Operators want the opposite coupling: statistics for as long as the deployment exists,
and detail for as long as it is useful.

## Decision

1. **Two permanent fact tables.** `usage_facts_15m` and `usage_facts_daily` are keyed by
   bucket, client key group, model, model alias, credential, provider and auth type, and
   carry every measure a dashboard panel prints, including the request-time cost
   snapshot. They are never pruned.
2. **Fifteen minutes is the fine grain.** Every civil UTC offset in use is a multiple of
   fifteen minutes, so a local calendar day is a whole number of buckets in any time
   zone. An hourly grain cannot serve `+05:30`.
3. **One fold, one checkpoint, split by event id.** Both grains are written in one
   transaction under the `facts` checkpoint. A read takes facts for ids at or below the
   checkpoint and request records above it, in a single SQL statement. Event times
   arrive out of order, so a timestamp boundary would count a late record twice.
4. **One query layer.** `Repository.QueryUsageFacts` serves every panel; a new panel adds
   a grouping or a measure to it rather than another scan of request records.
5. **Every table declares a lifecycle.** `TABLE_LIFECYCLES` classifies each table as
   permanent, rolling, owner-bounded or replaced, with the rule that expires its rows. A
   test fails for an undeclared table, so a new feature states how its data ends when it
   is added. One engine, `RunLifecycle`, deletes in small batches, never deletes a
   request record the facts have not absorbed, and records the instant it has reached.
6. **Payloads leave first.** A payload that was decoded into a request record is kept
   seven days by default (`OMCPA_USAGE_INBOX_RETENTION_DAYS`), and is stored once: the
   ciphertext, with no second redacted copy beside it.
7. **An all-time dashboard window.** `preset=all` starts at the first recorded usage. It
   is offered by the dashboard only; the request list reads request records and keeps
   its bounded windows.
8. **Request records default to ninety days**, down from 400. The longer horizon
   existed only for the token grid, which no longer reads request records. Ninety days
   is the longest window the request list offers, so every preset it shows is fully
   backed.

## Consequences

- Dashboard reads scale with distinct dimension combinations per bucket instead of with
  requests: the grouped model read over 100 000 records fell from about 0.74 s to about
  0.02 s once folded.
- Behind the detail horizon a window is widened to whole fifteen-minute buckets and
  cannot be drawn finer. The response reports the bounds that were read.
- Statistics for requests deleted before this change are not recoverable; the facts are
  backfilled from the request records that still exist, by the ordinary fold.
- A fact row's dimensions are fixed at fold time. A new dimension needs a migration and
  can be backfilled only as far back as request records still reach.
- Deleting rows does not shrink the file. Space returns to the file system only through
  the operator-started compaction.
- Re-decoding after a decoder fix is possible only within the payload retention.
- On upgrade, a deployment that sets neither variable loses request records older than
  ninety days and decoded payloads older than seven, once the facts have absorbed
  them. Statistics are unaffected. Setting `OMCPA_USAGE_RETENTION_DAYS=400` and
  `OMCPA_USAGE_INBOX_RETENTION_DAYS=0` before upgrading keeps the previous behaviour.
