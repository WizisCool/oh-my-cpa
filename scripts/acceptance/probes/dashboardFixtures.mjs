/**
 * The dashboard probes' shared fixtures: the route bodies and the series the chart,
 * heatmap and model-panel scenarios serve, plus the day grid they all agree on.
 * They live together because a scenario's route table names them by value.
 */

function heatmapDayEntry(dayOffset, tokens, requests, failures) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
  const month = `${start.getMonth() + 1}`.padStart(2, '0');
  return {
    day: `${start.getFullYear()}-${month}-${`${start.getDate()}`.padStart(2, '0')}`,
    from_ms: start.getTime(),
    to_ms: end.getTime() - 1,
    tokens,
    requests,
    failures,
    input: tokens,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_creation: 0,
  };
}


export const HEATMAP_WEEKS = 53;
export const HEATMAP_TOTAL_DAYS = HEATMAP_WEEKS * 7;
/** Days from this week's Monday to today inclusive. */
const HEATMAP_WEEKDAY_OFFSET = (() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // JavaScript's getDay() is Sunday-first; this numbers the week from Monday.
  return (today.getDay() + 6) % 7;
})();
/** The offset of the grid's first day: 52 whole weeks plus the days elapsed this week. */
const HEATMAP_FIRST_OFFSET = -((HEATMAP_WEEKS - 1) * 7 + HEATMAP_WEEKDAY_OFFSET);
/** The last day the window can carry data for: the days after it are clamped to the read instant. */
export const HEATMAP_TODAY = (() => {
  const today = new Date();
  return `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
})();

/**
 * Marked days with distinct volumes, plus one deliberately quiet day.
 *
 * Distinct volumes matter: the fill ramp is quantile-based, so a fixture whose days all carried
 * similar traffic would collapse onto one level and the assertion that the grid paints several
 * levels would pass vacuously. The offsets spread the marks across the window so they land in
 * different columns and on different weekdays.
 */
export const heatmapMarked = [
  heatmapDayEntry(0, 100_000, 120, 1),
  heatmapDayEntry(-1, 80_000, 90, 0),
  heatmapDayEntry(-3, 60_000, 70, 0),
  heatmapDayEntry(-40, 45_000, 44, 2),
  heatmapDayEntry(-100, 30_000, 30, 0),
  heatmapDayEntry(-200, 15_000, 15, 0),
  heatmapDayEntry(-320, 6_000, 6, 0),
  heatmapDayEntry(-2, 0, 0, 0),
];
const heatmapMarkedByDay = new Map(heatmapMarked.map((entry) => [entry.day, entry]));

/**
 * The whole grid, in the shape the endpoint returns it: every day of the viewer's calendar year,
 * oldest first, with the marked days carrying the fixture's volumes.
 *
 * The fixture mirrors the server's contract rather than sending only the marked days: the panel
 * reads the response's own day list, so a partial fixture would not exercise the layout, the
 * year's shape, or the row-per-weekday arithmetic. Days after today are sent the way the server
 * sends them - present, with no bounds and no traffic.
 */
export function heatmapGridDays() {
  const days = [];
  for (let offset = HEATMAP_FIRST_OFFSET; offset < HEATMAP_FIRST_OFFSET + HEATMAP_TOTAL_DAYS; offset += 1) {
    const plain = heatmapDayEntry(offset, 0, 0, 0);
    if (plain.day > HEATMAP_TODAY) {
      // The days after today in the final column: present so the column is complete, and with no
      // range because there is nothing to ask about a day that has not happened.
      days.push({ ...plain, from_ms: 0, to_ms: 0 });
      continue;
    }
    days.push(heatmapMarkedByDay.get(plain.day) ?? plain);
  }
  return days;
}

export const chartTokenHeatmap = {
  as_of_ms: Date.now(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  // Tracking started well before the grid's first day, so no cell in this fixture is
  // "unrecorded".
  first_stored_ms: Date.parse('2024-01-01T00:00:00Z'),
  days: heatmapGridDays(),
};

/**
 * The same grid as a real deployment whose retention has already trimmed the oldest weeks: the
 * marker sits partway into the span, so the cells before it are unrecorded rather than empty.
 *
 * This is the shape the panel is actually read in, and the one no other fixture covers - the main
 * fixture starts tracking before its first day so every zero cell is `empty`. That gap is why the
 * wireframe shipped: 275 outlined cells look nothing like 275 solid ones, and only this fixture
 * produces them.
 */
export const chartTokenHeatmapPruned = (() => {
  const days = heatmapGridDays();
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return {
    ...chartTokenHeatmap,
    first_stored_ms: cutoff,
    days: days.map((day) => (day.from_ms > 0 && day.from_ms < cutoff
      ? { ...day, tokens: 0, requests: 0, failures: 0, input: 0, output: 0 }
      : day)),
  };
})();

/**
 * The daily token heatmap: a contribution-graph field, one row per weekday.
 *
 * A canvas count cannot be wrong here because there is no canvas: the cells are DOM, so the
 * assertions read computed styles, grid tracks and rendered text. The field's shape is what makes
 * it recognizable, so the first thing asserted is that it is a field - seven weekday rows and a
 * year of week columns - rather than a single-row strip.
 */

const chartBuckets = 30;
const chartBucketMS = 60_000;
const chartSeries = Array.from({ length: chartBuckets }, (_, index) => ({
  t: Date.now() - (chartBuckets - 1 - index) * chartBucketMS,
  // A zero bucket is what puts the series on the plot floor, which is where the
  // baseline stroke became visible.
  v: index % 7 === 0 ? 0 : 40 + (index % 5) * 12,
  tokens: index % 7 === 0 ? 0 : 900 + (index % 4) * 250,
  // Each metric gets its own shape. If these all tracked `tokens`, four tiles
  // would paint identical marks and this scenario could not tell that the cache
  // and cost tiles had stopped plotting their own data.
  cache_read: index % 4 === 0 ? 0 : 300 + (index % 6) * 90,
  cost_nanos: index % 6 === 0 ? 0 : 120_000_000 + (index % 5) * 60_000_000,
}));

/**
 * The per-model fixture for the dashboard's two model panels.
 *
 * Deliberately larger than the model set a default run would produce, so the panels have to fold a
 * remainder rather than print every model: six named groups plus a folded one is what exercises the
 * `folded` discriminator, the legend's width at its worst, and the donut's small-slice rendering.
 *
 * Each group peaks in its own band of the window, so the trend has seven visibly different shapes.
 * That is what the paint assertions read: if every series carried the same curve, a mark wired to the
 * wrong series - or to one series repeated - would still look plausible.
 */

const MODEL_BUCKETS = 30;
const modelBucketMS = 60_000;
const modelGroups = [
  { model: 'gpt-5-codex', tokens: 480_000, peak: 2 },
  { model: 'claude-sonnet-4-5-20250929', tokens: 210_000, peak: 7 },
  { model: 'gemini-3-pro-preview', tokens: 96_000, peak: 13 },
  { model: 'deepseek-v4-pro', tokens: 44_000, peak: 18 },
  { model: 'qwen3-coder-plus', tokens: 18_000, peak: 23 },
  { model: 'glm-5.3-flash', tokens: 7_000, peak: 26 },
  { model: 'kimi-k2-thinking', tokens: 2_000, peak: 28 },
  { model: 'hy4-preview', tokens: 600, peak: 29 },
];
const modelWindowFrom = Date.now() - MODEL_BUCKETS * modelBucketMS;

/**
 * One group's series: a single peak in its own band, zero elsewhere.
 *
 * The weights are a whole unit split two ways - the earlier bucket takes the larger share and the rest
 * is the **integer remainder** - so the series always sums back to exactly `total`. An earlier revision
 * used 1 and 0.4 as fractions of the total, which made every series sum to 140% of the number reported
 * beside it: the fixture violated the one containment invariant the API guarantees, so a real
 * regression in the fold would have had a wrong baseline to be measured against.
 */
function modelSeriesFor(peak, total) {
  const head = Math.round(total * 0.7);
  const tail = total - head;
  // A peak in the final bucket has no next bucket to hold the remainder, so it takes the whole amount
  // rather than dropping it. Silently losing it is what the conservation check below caught.
  const hasTailBucket = peak + 1 < MODEL_BUCKETS;
  return Array.from({ length: MODEL_BUCKETS }, (_, index) => ({
    t: modelWindowFrom + index * modelBucketMS,
    tokens: index === peak ? (hasTailBucket ? head : total) : hasTailBucket && index === peak + 1 ? tail : 0,
  }));
}

/** The groups the response carries, named first and folded last, in the order the API promises. */
function modelFixtureGroups() {
  const named = modelGroups.slice(0, 5).map((group) => ({
    model: group.model,
    folded: false,
    tokens: group.tokens,
    requests: 10 + group.peak,
    series: modelSeriesFor(group.peak, group.tokens),
  }));
  const remainder = modelGroups.slice(5);
  const foldedTokens = remainder.reduce((sum, group) => sum + group.tokens, 0);
  // The remainder's own shape is the sum of its members' shapes, so it is built rather than sampled:
  // distributing it with a single peak would give it a shape none of its members has.
  const foldedSeries = Array.from({ length: MODEL_BUCKETS }, (_, index) => ({ t: modelWindowFrom + index * modelBucketMS, tokens: 0 }));
  for (const group of remainder) {
    for (const point of modelSeriesFor(group.peak, group.tokens)) {
      foldedSeries.find((entry) => entry.t === point.t).tokens += point.tokens;
    }
  }
  return [...named, { model: '', folded: true, tokens: foldedTokens, requests: 9, series: foldedSeries }];
}

/**
 * The fixture must satisfy the API's own containment invariant before a browser ever sees it: every
 * group's series sums to that group's total, and the groups sum to the window total. Without this the
 * probe's "the ring reports the window total" check would be comparing against a number the fixture
 * itself contradicted.
 */
const modelFixture = modelFixtureGroups();
const modelFixtureTotal = modelFixture.reduce((sum, group) => sum + group.tokens, 0);
for (const group of modelFixture) {
  const summed = group.series.reduce((sum, point) => sum + point.tokens, 0);
  if (summed !== group.tokens) {
    throw new Error(`model fixture group ${group.model || '(folded)'} sums to ${summed}, want ${group.tokens}`);
  }
}

export const chartDashboardModels = {
  window: {
    preset: '1h',
    from: modelWindowFrom,
    to: Date.now(),
    bucket_ms: modelBucketMS,
    minutes: 30,
    complete: true,
    open_end: false,
  },
  total_tokens: modelFixtureTotal,
  models: modelFixture,
  partial_errors: [],
};

/** A window in which no model carried tokens, for the panels' empty state. */
export const chartDashboardModelsEmpty = {
  window: {
    preset: '1h',
    from: modelWindowFrom,
    to: Date.now(),
    bucket_ms: modelBucketMS,
    minutes: 30,
    complete: true,
    open_end: false,
  },
  total_tokens: 0,
  models: [],
  partial_errors: [],
};

export const chartDashboardModelsWeek = {
  ...chartDashboardModels,
  window: { ...chartDashboardModels.window, preset: '7d' },
};

export const chartDashboard = {
  window: {
    preset: '1h',
    from: Date.now() - chartBuckets * chartBucketMS,
    to: Date.now(),
    bucket_ms: chartBucketMS,
    minutes: 60,
    complete: true,
    open_end: false,
  },
  requests: {
    total: chartSeries.reduce((sum, point) => sum + point.v, 0),
    success: chartSeries.reduce((sum, point) => sum + point.v, 0) - 3,
    failed: 3,
    success_rate: 98.7,
    series: chartSeries,
  },
  tokens: {
    total: chartSeries.reduce((sum, point) => sum + point.tokens, 0),
    input: 120000,
    output: 45000,
    reasoning: 5000,
    cached: 30000,
    cache_read: 30000,
    cache_creation: 2000,
    series: chartSeries,
  },
  metrics: { rpm: 12, tpm: 1234, cache_rate: 42, cost: 0, cost_source: 'none', cost_note: '', avg_latency_ms: 900, avg_ttft_ms: 200 },
  coverage: { rollup_requests: 0, detail_requests: 0, pending_inbox: 0, stored_events: 0 },
  partial_errors: [],
};

/**
 * The area marks @ant-design/charts paints into each card's .chart-slot.
 *
 * Counting canvases proves almost nothing here: an empty canvas, a mark drawn in
 * the wrong colour, and a mark collapsed onto the plot floor all satisfy it. So the
 * assertions read the painted pixels instead - several distinct tones per tile, ink
 * spanning the plot rather than a stub. That is the check an earlier revision of
 * this probe lacked, which is why it passed on a mark the design never called for.
 */
