# ADR 0005: The token heatmap is a DOM grid, and it folds days from one source

- Status: Accepted
- Date: 2026-09-14

## Context

ADR 0004 adopted `@ant-design/charts` as the visualization runtime and named "token
density heatmaps" as one of the capabilities that motivated the choice. The dashboard's next
increment is that heatmap: a field of daily token volume below the six KPI tiles.

Three questions had to be settled before building it, and two of the three have answers
that contradict the obvious reading of ADR 0004.

**How should it be drawn?** The library offers a `Heatmap` mark, which is the direct
reading of "adopt a charting runtime for heatmaps". But this panel is a grid of individually
addressable days, and its whole interaction model is "read a day, open a day". A canvas mark
gives none of that: no per-cell text, no focusable cells, no per-cell click target, no
readable structure for assistive technology.

**What should it plot?** `/management/dashboard` answers a *sliding window* - fifteen minutes to
ninety days, refetched on a tail poll as often as every five seconds. This panel covers a fixed
rolling year, because a field whose width is its own data's age is not a calendar - at the 24h
default it would be one column. Putting a year of daily history into the windowed response would
aggregate it on every tail poll, and the window's parameters are shared with the request list.

**What shape should it be?** A contribution graph is two-dimensional: seven weekday rows by
one column per week. The rows are the whole point - they make a weekly rhythm a row and a
trend a direction - and the shape and the span are one decision, since at seven rows a
quarter's worth of days would be thirteen columns rather than a field.

**How should the days be resolved?** This is the part that turned out to matter most. A
day is a local calendar day, and the obvious implementations of that are both wrong:
grouping an hourly rollup by an offset-shifted bucket start cannot split a UTC hour that
straddles a fractional-offset local midnight (India's `+05:30` puts local midnight at
18:30 UTC, inside the 18:00 hour), and any single fixed offset is wrong for every day on
the far side of a daylight-saving transition rather than only on the two transition days.

## Decision

1. **Render the grid as DOM.** One cell per day in a CSS grid, seven weekday rows by a
   column per week, each with a `title`, an `aria-label` and a roving `tabindex`. The panel
   never imports the chart runtime, so `vendor-charts` is unchanged and still reached only
   by the trend marks.

2. **Serve it from a dedicated endpoint**, `GET /management/dashboard/token-heatmap`,
   with its own query, its own refresh cadence and its own failure mode.

3. **Build the days on the server from the viewer's IANA timezone.** The client sends
   `tz`; the server resolves each day with `time.Date`/`AddDate` in that zone and returns
   every day of the span with its exact inclusive instant bounds. A local day is therefore
   23, 24 or 25 hours as the zone requires, and the bounds a cell aggregated are the same
   bounds its drill-down opens.

4. **Walk the span as civil dates, and resolve each day's bounds independently.** Chile
   springs forward *at* midnight, so `2020-09-06` has no local `00:00` and Go normalizes that
   civil date to `2020-09-05 23:00`. Walking the span with `AddDate` on a resolved instant
   therefore emits `2020-09-05` twice and never emits `2020-09-06`: the grid reports its full
   371 days while carrying 370 distinct ones, and every day after the transition shifts a
   column. Each day's key comes from the arithmetic date, and its start from the first instant
   whose local clock reads that date - which on a midnight transition is an hour later than
   midnight, making that day 23 hours long rather than 24.

5. **Fold from one source: the detail table.** No rollup-plus-tail split, and no
   rounding of the window to a bucket boundary.

6. **Clamp the final day to the read instant** rather than to the following local
   midnight, so a record timestamped in the future cannot inflate today's total.

7. **Colour is a continuous ramp of the theme accent, not a semantic or stepped one.** Brightness is
   the square root of the day's volume against the window's own busiest day, mixed in OKLCH from the
   cell's empty fill up to the accent. Stepped cutoffs quantised away the day-to-day difference the
   panel exists to show; a status hue would imply a verdict the panel has no basis for.

8. **One view.** The panel shades the day's own token volume and nothing else. Weekly and
   cumulative readings were built and then removed: they answer "how did that week go" and "how
   quickly did the span accumulate", which are different questions from the one the grid is asked,
   and a control that changes what the colours mean makes the field unreadable at a glance.

9. **The tooltip opens on click and carries the drill-down as a link.** The cell itself does not
   navigate. Every cell is interactive, including one with nothing stored: its tooltip says so and
   carries no link, because there would be nothing to open.

## Consequences

### Positive

- The panel is keyboard- and screen-reader-operable, and its cells are real elements: the
  probe asserts computed fills, attribute counts and rendered text rather than reading
  pixels out of a canvas.
- Day boundaries are exact under fractional offsets, daylight saving, and viewer zones
  that differ from the server's - the three cases a rollup-based fold gets wrong.
- The cell and its drill-down cannot disagree: both come from the same returned interval.
- An unavailable read cannot blank the tiles above it, and a *refresh* that fails keeps
  the strip on screen.

### Trade-offs

- **`QueryDailyTokenTotals` scans the detail table over the span.** It does not consult the hourly
  rollup, which costs more rows than a rollup read would. Two things bound it: the scan is limited to
  the retention window (400 days by default, which the panel's rolling year fits inside), and the
  aggregation stays inside SQLite, so at most one row per day crosses into Go. The panel reads it once per visit on a five-minute
  interval, not on the dashboard's poll cadence.
- **The rollup split is deliberately not reused.** `QueryUsageAnalytics` divides its
  window at the hourly checkpoint and reads the two halves from different tables, which is
  correct for a *bucket* grid. It is not correct for a day: a request that arrives with an
  earlier timestamp after its hour was folded - CPA event times can arrive out of order -
  sits on the detail side of the timestamp boundary while its own hour is already inside
  the rollup, so a hybrid read counts it twice. One source has no boundary to get wrong.
  The dashboard's own path is unchanged.
- **The panel is not a chart-runtime mark**, a real divergence from ADR 0004's framing,
  confined to this panel and stated in `docs/design.md`.
- **A second endpoint on the dashboard.** The page issues three reads. The strip's is on a
  five-minute interval and a key-prefix invalidation from the refresh button, so it adds
  one request per five minutes rather than one per poll.
- **On a narrow viewport the grid scrolls, opening on today's column**, and its tap target
  grows vertically only. A year of weeks and a 44px target cannot both fit a phone, and the
  span is the panel's meaning while the target is a convenience: every cell is reachable by
  arrow key and opens its own tooltip, so nothing is unreachable. See `docs/design.md` §2 for
  the measured rule and the horizontal-overlap trap.
- **Any part of the grid older than the retention horizon reports no stored records.** At the
  default 400-day horizon the grid's 371 days all fit inside it, so this only arises when
  `OMCPA_USAGE_RETENTION_DAYS` is overridden shorter than the span. Those cells are drawn as
  unrecorded with copy that says so. Shortening the grid to follow a shorter horizon was the
  alternative and it was rejected: a quarter of a year is thirteen columns, which is not the shape
  the reading comes from.
- **The ramp is relative to the span.** Two deployments' strips are not comparable by shade
  alone; the counts in each cell's tooltip and accessible name are what make them comparable.
  A relative scale was chosen because an absolute one either saturates a busy deployment or
  flattens a quiet one, and the square root of the day's share was chosen over a linear or
  logarithmic mapping for the reasons in `docs/design.md` §2.
- **The default retention horizon was raised to 400 days for this panel**, from ninety. The window
  is a rolling year, so a ninety-day horizon would show the window's own beginning as carrying
  nothing for most of the year. The cost is linear: roughly four times the detail and rollup rows
  compared with a ninety-day horizon.
- **A day with no stored record does not mean nothing happened.** The response reports the first
  *stored* record, and a day before it is drawn as unrecorded. Whether the collector was running,
  and whether it lost anything, is not visible from the record; the copy claims only that nothing is
  stored.

## Alternatives considered

- **A `Heatmap` mark from `@ant-design/charts`.** Rejected because the panel is a calendar
  rather than a raster: per-cell text, focus and click targets are its function, not
  decoration, and a canvas would need a parallel DOM layer for all three - that is the DOM
  implementation, plus a canvas.
- **Fold the days in Go from the existing bucket path.** `QueryUsageAnalytics` reads its
  rollup whenever the requested grid is no coarser than the rollup's grain, so a daily grid
  would be served from hourly rows and inherit exactly the fractional-offset error this
  decision avoids.
- **Fold from the hourly rollup on the viewer's calendar.** Cheaper, and wrong for any
  offset that is not a whole hour, and for every day across a daylight-saving transition.
- **A single-row timeline of the last ninety days.** It fits the panel width without scrolling, and
  it was the first implementation. Rejected on reading: a row of squares is a timeline, not a
  contribution graph, and it cannot show a weekday rhythm at all.
- **A calendar-year grid** (January to December) instead of a rolling one. The shape is stable for a
  whole year, which is pleasant, but it spends every January almost empty and says nothing about last
  December - exactly the comparison a reader wants then. A rolling window always holds a year and
  always ends on today.
- **Send a UTC offset instead of a zone name.** Simpler, and wrong for every day on the
  other side of a transition. The zone database is already present in the runtime image.
- **Return only the days that carried traffic and let the client fill the gaps.** Rejected:
  the strip's shape is its span, and a client that reconstructs the gaps is a second
  implementation of the calendar that can silently disagree with the server's.
