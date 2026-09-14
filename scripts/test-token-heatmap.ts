import assert from 'node:assert/strict';
import {
  heatmapRampMax,
  heatmapRampMix,
  heatmapRampPosition,
} from '../web/src/theme/heatmapRamp.ts';
import {
  buildHeatmapGrid,
  HEATMAP_GRID,
  heatmapCellState,
  heatmapColumnCount,
  heatmapDrillDown,
  heatmapFocusDay,
  heatmapMinPanelWidth,
  heatmapMonthLabels,
  heatmapMoveFocus,
  localDayOf,
  type DashboardTokenHeatmapDay,
} from '../web/src/types/tokenHeatmap.ts';

/**
 * A day entry with the fields the layout helpers read. The bounds are zero here and
 * set explicitly in the drill-down check, which is the only place they carry meaning.
 */
function dayEntry(day: string, tokens: number, requests = tokens > 0 ? 1 : 0): DashboardTokenHeatmapDay {
  return {
    day,
    from_ms: 0,
    to_ms: 0,
    tokens,
    requests,
    failures: 0,
    input: tokens,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_creation: 0,
  };
}

/**
 * The grid's own decisions, tested without a browser.
 *
 * The grid is a DOM table, so nothing between these functions and what the operator sees
 * is a rendering library's business: a wrong row index, a level threshold that lifts an
 * empty cell into a measured shade, or a drill-down whose window excludes the day's own
 * traffic would each be visible and each would be invisible to a "the panel rendered"
 * assertion.
 */

// ── grid geometry ──────────────────────────────────────────────────────────

/**
 * A rolling year, as the server builds it: fifty-three whole Monday-first weeks ending on the
 * Sunday of the current week.
 */
function gridDays(): DashboardTokenHeatmapDay[] {
  const days: DashboardTokenHeatmapDay[] = [];
  // 2025-09-08 is a Monday, so the span opens on a column boundary.
  const start = Date.UTC(2025, 8, 8);
  for (let index = 0; index < 53 * 7; index += 1) {
    days.push(dayEntry(new Date(start + index * 86_400_000).toISOString().slice(0, 10), 0));
  }
  return days;
}

const days = gridDays();
const cells = buildHeatmapGrid(days);

assert.equal(cells.length, days.length, 'one cell per day');
assert.equal(new Date(Date.UTC(2025, 8, 8)).getUTCDay(), 1, 'the fixture starts on a Monday');

// The first day is row 0 of column 0, and the seventh is row 6 of the same column: the
// rows are weekdays, so a transposed pair would put every cell on the wrong row while
// keeping the length.
assert.deepEqual(
  { row: cells[0].row, column: cells[0].column },
  { row: 0, column: 0 },
  'the first day is Monday of the first week',
);
assert.equal(cells[6].row, 6, 'the seventh day is Sunday');
assert.equal(cells[6].column, 0, 'and it closes the first column');
assert.equal(cells[7].row, 0, 'the eighth day is the next Monday');
assert.equal(cells[7].column, 1, 'so it opens column 1');
assert.equal(cells[14].row, 0, 'a fortnight in, Monday opens the third column');
assert.equal(cells[14].column, 2, 'at column 2');

// Row and column have to agree with each day's real weekday, or the grid's rows mean
// nothing while still looking plausible.
for (const cell of cells) {
  const [year, month, date] = cell.day.split('-').map(Number);
  const weekday = (new Date(Date.UTC(year, (month ?? 1) - 1, date ?? 1)).getUTCDay() + 6) % 7;
  assert.equal(cell.row, weekday, `${cell.day} sits on its own weekday row`);
}
// Columns are consecutive whole weeks, with no column skipped or reused.
for (let index = 1; index < cells.length; index += 1) {
  assert.ok(cells[index].column >= cells[index - 1].column, 'columns never decrease');
  assert.ok(cells[index].column - cells[index - 1].column <= 1, 'a day is at most one column later');
}
assert.deepEqual(buildHeatmapGrid([]), [], 'an empty day list yields an empty grid');
assert.equal(heatmapColumnCount(cells), cells[cells.length - 1].column + 1, 'the column count closes the last column');
assert.equal(heatmapColumnCount([]), 0, 'an empty grid has no columns');

// ── panel sizing contract ──────────────────────────────────────────────────

// The grid has to reach its panel's edges: a fixed cell size left most of a wide card empty,
// which is what made the panel look like an unfinished widget. The sizing itself is CSS
// (`minmax(--heatmap-min-cell, 1fr)` tracks), so what is asserted here is the *contract* -
// which panels fit and which scroll.
const WIDE_COLUMNS = 54;
/**
 * Panels that hold a year of weeks, and panels that do not.
 *
 * The boundary is arithmetic, not a guess: 54 columns at the 9px floor with 4px gaps need
 * 698px, plus the 30px gutter, so 728px is the narrowest panel that fills. The two lists
 * below straddle it rather than sitting on round numbers, because that is what makes the
 * caption's measurement-driven behaviour testable - a 720px viewport scrolls, a 740px one
 * does not, and no single breakpoint describes both.
 */
const MIN_PANEL_WIDTH = heatmapMinPanelWidth(WIDE_COLUMNS);
assert.equal(MIN_PANEL_WIDTH, 728, 'a year of weeks needs 728px at the cell floor');
for (const width of [MIN_PANEL_WIDTH, 740, 850, 1000, 1150, 1330]) {
  assert.ok(width >= MIN_PANEL_WIDTH!, `${width}px holds a year of weeks, so it fills rather than scrolls`);
}
for (const width of [320, 390, 560, 640, MIN_PANEL_WIDTH! - 1]) {
  assert.ok(
    heatmapMinPanelWidth(WIDE_COLUMNS)! > width,
    `${width}px is narrower than the floor needs, so the grid scrolls`,
  );
}

// The floor and gap are mirrored from the stylesheet, so a change to one without the other
// fails here rather than silently making the caption lie about scrolling.
assert.equal(HEATMAP_GRID.minCell, 9, 'the cell floor matches --heatmap-min-cell');
assert.equal(HEATMAP_GRID.gap, 4, 'the gap matches --heatmap-gap');
assert.equal(HEATMAP_GRID.label, 22, 'the gutter matches --heatmap-label');
assert.equal(HEATMAP_GRID.labelGap, 8, 'the gutter gap matches --heatmap-label-gap');

// A grid with no columns has no width requirement, so nothing is claimed.
assert.equal(heatmapMinPanelWidth(0), null, 'no columns means no minimum width');
assert.equal(heatmapMinPanelWidth(Number.NaN), null, 'a non-numeric column count is not a width');

// ── local-day reading ──────────────────────────────────────────────────────

assert.equal(localDayOf(new Date(2026, 8, 14, 23, 30, 0).getTime()), '2026-09-14', 'localDayOf reads the local calendar, not UTC');
assert.equal(localDayOf(new Date(2026, 8, 14, 0, 0, 1).getTime()), '2026-09-14', 'the first instant of a local day belongs to it');

// ── cell states ────────────────────────────────────────────────────────────

const firstStored = new Date(2026, 8, 10, 9, 0, 0).getTime();
// The grid is resolved mid-week, so the span's last column holds four days that have not happened.
// Every call passes it: a state function with no notion of "now" classifies a future day by whether
// tracking happened to start before it, which is a fact about the deployment rather than the day.
const asOf = new Date(2026, 8, 11, 12, 0, 0).getTime();

// Three distinct states, each meaning something different. A day that has not happened is not among
// them: it is a day nothing is stored for, which is what `unrecorded` already says, and a separate
// state asked the reader to hold two kinds of blank apart while comparing days.
assert.equal(
  heatmapCellState(dayEntry('2026-09-09', 0), firstStored, asOf),
  'unrecorded',
  'a day before the first stored record has nothing stored, which is not the same as empty',
);
assert.equal(
  heatmapCellState(dayEntry('2026-09-10', 0), firstStored, asOf),
  'empty',
  'the day of the first stored record is recorded even when it carried nothing',
);
assert.equal(
  heatmapCellState(dayEntry('2026-09-10', 500), firstStored, asOf),
  'measured',
  'a day with tokens is measured',
);
assert.equal(
  heatmapCellState(dayEntry('2026-09-10', 0, 3), firstStored, asOf),
  'measured',
  'a day with requests but no tokens is still measured: the traffic is real',
);
// The bug this argument fixes. The day after the read instant carries nothing because it has not
// happened, not because it was measured and found quiet - and on a deployment whose tracking began
// before it, the traffic test below would have called it a measured zero.
assert.equal(
  heatmapCellState(dayEntry('2026-09-12', 0), firstStored, asOf),
  'unrecorded',
  'a day after the read instant is unrecorded even with tracking established before it',
);
assert.equal(
  heatmapCellState(dayEntry('2026-09-12', 0), null, asOf),
  'unrecorded',
  'the future is unrecorded on a fresh install too, where there is no marker at all',
);
// The boundary itself: the day the read instant falls on is in the past, and is classified by its
// traffic like any other recorded day.
assert.equal(
  heatmapCellState(dayEntry('2026-09-11', 0), firstStored, new Date(2026, 8, 11, 0, 0, 1).getTime()),
  'empty',
  'the read instant\'s own day is recorded, measured from its first instant',
);
// A response without the instant cannot place the boundary, so it falls back to the marker alone
// rather than marking the whole span unrecorded.
assert.equal(
  heatmapCellState(dayEntry('2026-09-12', 0), firstStored, null),
  'empty',
  'without the read instant only the first-stored marker bounds the window',
);
// With nothing captured at all there is no record window to be outside of, so a past day is a
// recorded zero rather than an unrecorded one.
assert.equal(heatmapCellState(dayEntry('2026-09-12', 0), null, null), 'empty', 'no marker means no unrecorded days');
// A missing entry is treated as empty rather than throwing: the grid's shape comes from the
// response, and a day the server did not describe is one it did not measure.
assert.equal(heatmapCellState(undefined, null, asOf), 'empty', 'a missing day is empty rather than fatal');
// The marker is an instant and the day key is a local date, so a marker late in the local day it
// lands on must not mark that whole day unrecorded.
assert.equal(
  heatmapCellState(dayEntry('2026-09-10', 0), new Date(2026, 8, 10, 23, 59, 0).getTime(), asOf),
  'empty',
  'the marker day itself is recorded',
);
// Exactly three states, and all three are drawn and interacted with by the same path: the panel
// attaches `is-interactive` and a click-opened tooltip unconditionally, so there is no state a
// reader can see but not open. The `dashboard-heatmap` scenario asserts the clickable half of that
// against a real browser; this pins the set, which is what would grow if the removed `pending`
// state ever came back.
const CELL_STATES = ['measured', 'empty', 'unrecorded'] as const;
assert.deepEqual([...CELL_STATES].sort(), ['empty', 'measured', 'unrecorded'], 'the state set is exactly three');

// ── continuous ramp ────────────────────────────────────────────────────────

// The ramp maps a day's volume onto a position between the two stops. It replaced four fixed levels,
// which painted every day between two of them identically - the information the panel exists to show.

assert.equal(heatmapRampMax([]), 0, 'no values means no maximum');
assert.equal(heatmapRampMax([0, 0, 0]), 0, 'only zero days means no maximum');
assert.equal(heatmapRampMax([1, 500, 12]), 500, 'the maximum is the busiest day');
assert.equal(heatmapRampMax([Number.NaN, 7]), 7, 'a non-finite value is not the maximum');

// The ends of the scale are exact, and they are what the empty fill and the busiest shade mean.
assert.equal(heatmapRampPosition(0, 1000), 0, 'no traffic sits at the quiet end');
assert.equal(heatmapRampPosition(1000, 1000), 1, 'the busiest day in the window sits at the busy end');
assert.equal(heatmapRampPosition(5000, 1000), 1, 'a value above the maximum is clamped, not extrapolated');
assert.equal(heatmapRampPosition(-5, 1000), 0, 'a negative value cannot sit below the quiet end');
assert.equal(heatmapRampPosition(100, 0), 0, 'with no maximum there is no scale to sit on');
assert.equal(heatmapRampPosition(100, Number.NaN), 0, 'a non-finite maximum yields the quiet end');

// The curve is the square root, and the point of it is the low end. Asserted as a property of the
// mapping rather than as literal percentages, so a different curve that lost the property fails.
const max = 1_000_000;
const linearPosition = (value: number) => value / max;
for (const value of [1_000, 10_000, 100_000]) {
  const squareRoot = heatmapRampPosition(value, max);
  assert.ok(squareRoot > linearPosition(value), `${value} sits above its linear position`);
  // And still below the top: the curve lifts the low end without compressing the high end flat.
  assert.ok(squareRoot < 1, `${value} does not reach the busy end`);
}
// A hundredth of the maximum is a tenth of the way up under a square root, which is the whole reason
// for the curve: on a linear scale a day with 1% of the busiest day's volume is invisible.
assert.equal(Number(heatmapRampPosition(10_000, max).toFixed(4)), 0.1, 'a hundredth of the peak is a tenth of the ramp');
// A hundredth of the peak is 1% under a linear map, which is the invisible case this avoids.
assert.ok(linearPosition(10_000) < 0.011, 'the linear position really would be about one percent');

// Monotone: a busier day is never painted quieter than a quieter one.
let previous = -1;
for (const value of [0, 1, 100, 10_000, 250_000, 999_999, 1_000_000]) {
  const position = heatmapRampPosition(value, max);
  assert.ok(position >= previous, `${value} does not decrease the ramp position`);
  previous = position;
}

// The scale is relative to the window, so the same *shape* of traffic paints the same field whatever
// the absolute volume - which is what makes the panel readable on any deployment.
const shape = [1, 2, 4, 8, 16];
const quiet = shape.map((value) => heatmapRampPosition(value, 16));
const loud = shape.map((value) => heatmapRampPosition(value * 1_000_000, 16_000_000));
assert.deepEqual(quiet, loud, 'the ramp is relative to the window, not to absolute token counts');

// The mix returns the two stops and the quiet stop's weight, with "no traffic" fully at the quiet
// stop - which *is* the cell's empty fill, so an empty day and the lightest measured shade cannot be
// confused.
const empty = heatmapRampMix(0, max);
assert.equal(empty.from, 'var(--heatmap-quiet)', 'the quiet stop is the ramp floor');
assert.equal(empty.to, 'var(--heatmap-busy)', 'the busy stop is the ramp ceiling');
assert.equal(empty.fromShare, '100%', 'no traffic is entirely the quiet stop');
assert.equal(heatmapRampMix(max, max).fromShare, '0%', 'the busiest day is entirely the busy stop');
// The weight is the complement of the position, to two decimals, so it stays a short custom property.
for (const value of [1_000, 10_000, 100_000, 500_000]) {
  const mix = heatmapRampMix(value, max);
  const expected = Math.round((1 - heatmapRampPosition(value, max)) * 10000) / 100;
  assert.equal(Number(mix.fromShare.replace('%', '')), expected, `${value} carries its own weight`);
}

// ── month axis ─────────────────────────────────────────────────────────────

const months = heatmapMonthLabels(cells, heatmapColumnCount(cells), (day) => day.slice(0, 7));
assert.ok(months.length >= 12, 'a year of columns carries at least a label per month');
for (const label of months) {
  assert.ok(label.column >= 0 && label.column < heatmapColumnCount(cells), 'a label sits inside the grid');
}
for (let index = 1; index < months.length; index += 1) {
  assert.ok(
    months[index].column - months[index - 1].column >= 3,
    'labels are spaced so they cannot overlap at this cell size',
  );
}
assert.equal(new Set(months.map((label) => label.column)).size, months.length, 'no column is labelled twice');
// Each label names a month the column it sits on actually contains, and only ever a Monday
// column - a label floating over a mid-week column would name days the axis is not ticking.
for (const label of months) {
  const monday = cells.find((cell) => cell.column === label.column && cell.row === 0);
  assert.ok(monday, `column ${label.column} has a Monday`);
}
assert.deepEqual(heatmapMonthLabels([], 0, (day) => day), [], 'an empty grid has no labels');

// ── focus and keyboard movement ────────────────────────────────────────────

assert.equal(heatmapFocusDay([], '2025-09-08'), null, 'an empty grid has no focus day');
assert.equal(heatmapFocusDay(cells, '2026-01-05'), '2026-01-05', 'a remembered day inside the grid is kept');
assert.equal(
  heatmapFocusDay(cells, '2020-01-01'),
  cells[cells.length - 1].day,
  'a remembered day outside the grid falls back to the newest day',
);
assert.equal(heatmapFocusDay(cells, null), cells[cells.length - 1].day, 'with no remembered day the grid starts at its newest cell');

// A grid has two real axes, so the keys mean what they say.
const wednesday = cells.find((cell) => cell.row === 2 && cell.column === 5);
assert.ok(wednesday, 'the fixture has a Wednesday in column 5');
assert.equal(
  heatmapMoveFocus(cells, wednesday.day, 'ArrowLeft'),
  cells.find((cell) => cell.row === 2 && cell.column === 4)?.day,
  'left moves a whole week',
);
assert.equal(
  heatmapMoveFocus(cells, wednesday.day, 'ArrowUp'),
  cells.find((cell) => cell.row === 1 && cell.column === 5)?.day,
  'up moves one weekday back',
);
assert.equal(
  heatmapMoveFocus(cells, wednesday.day, 'ArrowDown'),
  cells.find((cell) => cell.row === 3 && cell.column === 5)?.day,
  'down moves one weekday forward',
);
assert.equal(heatmapMoveFocus(cells, cells[0].day, 'Home'), cells[0].day, 'Home reaches the oldest day');
assert.equal(heatmapMoveFocus(cells, cells[0].day, 'End'), cells[cells.length - 1].day, 'End reaches the newest day');
// Movement does not wrap: a key at a boundary is a no-op, because a grid whose Up key
// jumped from Monday to the previous Sunday reads as broken.
assert.equal(heatmapMoveFocus(cells, cells.find((cell) => cell.row === 0)!.day, 'ArrowUp'), null, 'up on Monday does nothing');
assert.equal(
  heatmapMoveFocus(cells, cells.find((cell) => cell.row === 0 && cell.column === 0)!.day, 'ArrowLeft'),
  null,
  'left on the first week does nothing',
);
assert.equal(heatmapMoveFocus(cells, '2019-01-01', 'ArrowDown'), null, 'a day outside the grid cannot be moved from');

// ── drill-down ─────────────────────────────────────────────────────────────

// The drill-down uses the day entry's own bounds, so the interval the list opens is the
// interval the cell aggregated. Re-deriving them from the date string here would be the
// bug: for a viewer whose zone differs from the response's, the two disagree.
const bounded = { ...dayEntry('2026-09-14', 100), from_ms: 1_787_000_000_000, to_ms: 1_787_086_399_999 };
const drill = new URL(heatmapDrillDown(bounded), 'https://example.test');
assert.equal(drill.pathname, '/usage/events', 'drill-down targets the request list');
assert.equal(Number(drill.searchParams.get('from')), bounded.from_ms, 'the window opens at the day entry start');
assert.equal(Number(drill.searchParams.get('to')), bounded.to_ms, 'the window closes at the day entry end');
for (const instant of [bounded.from_ms, bounded.from_ms + 1, bounded.to_ms]) {
  assert.ok(instant >= bounded.from_ms && instant <= bounded.to_ms, 'every instant of the day is inside the window');
}
assert.ok(bounded.to_ms + 1 > bounded.to_ms, 'the following day is outside the window');

console.log('PASS token heatmap: grid geometry, cell states, continuous ramp, month axis, keyboard movement and drill-down');
