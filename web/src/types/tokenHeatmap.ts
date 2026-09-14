/**
 * Response and strip shapes for the dashboard's daily token heatmap.
 *
 * The strip is built here rather than derived from the response's day list, because
 * the two halves come from different sources: the server decides which days carried
 * traffic, and the client decides what the strip looks like - one cell per day of
 * the span, the axis labels, and the fill level of a cell. Pure helpers, so the
 * layout and the ramp thresholds can be tested without a browser: the rendering is
 * a DOM strip, not a canvas, so there is no library between these decisions and the
 * assertions.
 */

export interface DashboardTokenHeatmapDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /**
   * The exact inclusive instant range this day covers on the viewer's calendar.
   * These are the same bounds the drill-down opens, so the day a cell aggregates and
   * the day it navigates to are one interval rather than two derivations.
   */
  from_ms: number;
  to_ms: number;
  tokens: number;
  requests: number;
  failures: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_creation: number;
}

export interface DashboardTokenHeatmap {
  /**
   * The instant the grid was resolved against, on the viewer's calendar.
   *
   * The client needs it to tell a day that has not happened from one whose records were pruned.
   * Both carry nothing, but only the latter is a fact the server could have observed, and the
   * difference decides which of the two zero states a cell takes.
   */
  as_of_ms: number;
  /** The IANA zone the days were built in, echoed by the server. */
  timezone: string;
  /**
   * The earliest *stored* request record, or null when none has been captured.
   *
   * This is a statement about the record, not about the collector: a request is only
   * here once it has been captured and decoded. A day earlier than this marker is
   * `unrecorded` rather than `empty`, because nothing was stored for it - the copy says
   * which. Whether the records were pruned or never existed is not a distinction the
   * client can make, and not one a reader comparing days can act on.
   */
  first_stored_ms: number | null;
  /** Every day of the span, oldest first, including the ones that carried nothing. */
  days: DashboardTokenHeatmapDay[];
}

/** One cell of the grid, with the day it stands for and where it sits. */
export interface HeatmapCell {
  day: string;
  /** Column, oldest week first. */
  column: number;
  /** Row, 0 = Monday through 6 = Sunday, matching the row labels. */
  row: number;
}

/**
 * A cell is one of three things, and the grid draws all three differently.
 *
 * `unrecorded` is a day nothing is stored for - which includes a day that has not happened yet,
 * because that is exactly what it is and it is the only thing a reader comparing days can act on.
 * A separate "pending" state described the calendar rather than the record and asked the reader to
 * hold two kinds of blank apart. `empty` is a recorded day with no traffic; `measured` is a day
 * with traffic.
 */
export type HeatmapCellState = 'unrecorded' | 'empty' | 'measured';

/**
 * heatmapCellState classifies one cell against the observation window.
 *
 * The order of the tests is the order of the questions. Both bounds come first, because each is a
 * statement about storage rather than about traffic: a day before the first stored record is
 * older than anything captured, and a day after the read instant has not happened at all. Only
 * once a day is known to lie inside the observed range does its traffic decide the state.
 */
export function heatmapCellState(
  day: DashboardTokenHeatmapDay | undefined,
  firstStoredMS: number | null,
  asOfMS: number | null,
): HeatmapCellState {
  if (!day) return 'empty';
  // The marker is an instant and the day key is a local calendar date, so the marker is
  // flattened onto the viewer's calendar before the two are ordered. Both are then fixed-width
  // `YYYY-MM-DD` strings, which compare correctly as strings.
  if (firstStoredMS !== null && day.day < localDayOf(firstStoredMS)) return 'unrecorded';
  // The tail of the current week has not happened yet, so nothing is stored for it either - the
  // server does not even query those days. They are bracketed by the same marker as a pruned day
  // rather than left to fall through to the traffic test below, which would classify them by
  // whether tracking happened to start before them: a day that has not occurred would read as a
  // *measured* zero on an established deployment and as an unrecorded one on a fresh install.
  if (asOfMS !== null && day.day > localDayOf(asOfMS)) return 'unrecorded';
  // Requests without tokens still count as traffic: a request that produced no completion is a
  // real request, and painting it as an empty day would hide it.
  return day.tokens > 0 || day.requests > 0 ? 'measured' : 'empty';
}

/**
 * localDayOf renders an instant as the `YYYY-MM-DD` the viewer's own clock shows.
 *
 * Read through the local accessors rather than by adding a UTC offset: an offset
 * is only constant where there is no daylight saving, and an event that happened
 * on a 23-hour or 25-hour day would otherwise land on the wrong calendar date.
 * This is the function that decides whether a day is "already before the first
 * recorded request", so it has to agree with the operator's wall clock exactly.
 */
export function localDayOf(ms: number): string {
  const value = new Date(ms);
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const date = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${date}`;
}

/**
 * buildHeatmapGrid places the days into the contribution-graph shape: one row per
 * weekday, one column per week.
 *
 * The layout comes from the response's own day list rather than from a span count. The
 * server resolved each day's exact local-calendar bounds, so re-deriving the dates here
 * would be a second chance to disagree with them - the grid's left edge would move by a
 * day for a viewer whose zone offset puts local midnight in the middle of the server's
 * UTC day.
 *
 * Row and column come from each day's own weekday, read in UTC on the date key: the key
 * is a calendar position, and its weekday is a property of the calendar rather than of
 * the viewer's clock. `Date.UTC` on a bare `YYYY-MM-DD` gives exactly that.
 */
export function buildHeatmapGrid(days: DashboardTokenHeatmapDay[]): HeatmapCell[] {
  if (days.length === 0) return [];
  // The row is each day's own weekday, and the column is the whole-week offset from the span's
  // first Monday. Reading the row from the weekday rather than from the day's position in the list
  // is what keeps the rows aligned: the positions only map to weekdays when a span happens to begin
  // on the week's first day, and a span that did not would put every cell one row out for its whole
  // length - which a calendar-year grid did.
  const [firstYear, firstMonth, firstDate] = days[0].day.split('-').map(Number);
  const first = Date.UTC(firstYear, (firstMonth ?? 1) - 1, firstDate ?? 1);
  // The Monday of the span's first week, as a UTC-midnight instant. The span begins on a Monday, so
  // this is the first day itself; the subtraction is what keeps the function correct if a caller
  // ever hands it a span that does not.
  const firstWeekStart = first - (((new Date(first).getUTCDay() + 6) % 7) * 86_400_000);
  return days.map((entry) => {
    const [year, month, date] = entry.day.split('-').map(Number);
    const at = Date.UTC(year, (month ?? 1) - 1, date ?? 1);
    // `getUTCDay()` is Sunday-first; this numbers the week from Monday to match the row labels.
    const row = (new Date(at).getUTCDay() + 6) % 7;
    // Floor, not round: dividing the day offset by seven *rounds* a Thursday or later up into the
    // next column, which split every week across two of them. The row is subtracted rather than the
    // remainder being taken, because a negative offset would floor the wrong way for a span that
    // began mid-week.
    const column = Math.floor((at - row * 86_400_000 - firstWeekStart) / (7 * 86_400_000));
    return { day: entry.day, column, row };
  });
}

/**
 * The grid's sizing contract, mirrored from the stylesheet.
 *
 * The *implementation* is CSS: the grid's tracks are
 * `repeat(columns, minmax(var(--heatmap-min-cell), 1fr))`, which makes a year of weeks span
 * its panel exactly at any width. That is deliberate rather than incidental - an integer
 * cell size computed in JavaScript cannot divide an arbitrary panel width evenly, and the
 * remainder shows up as a gutter at the field's edge, which is what made the panel look like
 * an unfinished widget.
 *
 * These constants exist so the contract can be asserted without a browser: which panels fill
 * their grid and which scroll instead. They must match the custom properties on `:root` in
 * `web/src/index.css`, and the test fails if the two drift.
 */
export const HEATMAP_GRID = {
  /** The cell floor: below this a square stops reading as a measured value. */
  minCell: 9,
  /** Space between cells, and between the gutter and the grid. */
  gap: 4,
  /** The weekday gutter's width. */
  label: 22,
  /** Space between the gutter and the grid. */
  labelGap: 8,
} as const;

/**
 * The smallest panel that holds `columns` columns at the cell floor, or `null` when the
 * arguments describe no grid at all.
 *
 * This is a property of the grid and the floor, not of the panel: every panel narrower than
 * the returned width scrolls, and every panel at least that wide fills. A caller compares its
 * own measured width against it, which is why the function does not take one.
 */
export function heatmapMinPanelWidth(columns: number): number | null {
  if (!Number.isFinite(columns) || columns <= 0) return null;
  const grid = columns * HEATMAP_GRID.minCell + (columns - 1) * HEATMAP_GRID.gap;
  return grid + HEATMAP_GRID.label + HEATMAP_GRID.labelGap;
}

/** The number of columns a grid's cells occupy. */
export function heatmapColumnCount(cells: HeatmapCell[]): number {
  return cells.length === 0 ? 0 : cells[cells.length - 1].column + 1;
}

/**
 * heatmapMonthLabels names the month each column starts, for the axis above the grid.
 *
 * A label is emitted for the first column whose week contains the first of a month, and
 * only when it does not crowd the previous one - two labels within two columns would
 * overlap at the cell size the grid uses. The final column is not force-labelled: unlike a
 * date axis's right edge, "this month" is already known from the panel's range caption.
 */
export function heatmapMonthLabels(
  cells: HeatmapCell[],
  columns: number,
  format: (day: string) => string,
): Array<{ column: number; label: string }> {
  const labels: Array<{ column: number; label: string }> = [];
  let lastMonth = '';
  let lastColumn = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    if (cell.row !== 0) continue;
    const month = cell.day.slice(0, 7);
    if (month === lastMonth) continue;
    lastMonth = month;
    if (cell.column - lastColumn < 3) continue;
    lastColumn = cell.column;
    labels.push({ column: cell.column, label: format(cell.day) });
  }
  if (columns > 0 && labels.length > 0 && labels[labels.length - 1].column >= columns) {
    labels.pop();
  }
  return labels;
}

/**
 * heatmapFocusDay decides which day owns the grid's single tab stop.
 *
 * Three hundred and seventy cells should not be that many tab stops. One cell is
 * reachable by Tab and the rest by the arrow keys, and the day it lands on is remembered
 * so that returning to the panel does not send the operator back a year. A remembered day
 * that has fallen outside the grid - it slides with the clock, so this happens daily -
 * falls back to the last cell, which is today and the position the operator was reading.
 */
export function heatmapFocusDay(cells: HeatmapCell[], remembered: string | null): string | null {
  if (cells.length === 0) return null;
  if (remembered && cells.some((cell) => cell.day === remembered)) return remembered;
  return cells[cells.length - 1].day;
}

/**
 * heatmapMoveFocus resolves an arrow key against the grid.
 *
 * The grid has two real axes, so the keys mean what they say: left and right move a week
 * (one column), up and down move a weekday (one row). Treating up/down as aliases for
 * left/right - which is right for a single-row strip - would make the vertical keys walk
 * along the week instead of across weekdays, which is the opposite of what a grid's shape
 * promises.
 *
 * `Home`/`End` jump to the ends of the whole span, the way they do in any sequential
 * widget. Movement does not wrap: a key at a boundary is a no-op, because a grid whose Up
 * key jumped from Monday to the previous Sunday reads as broken rather than as a boundary.
 */
export function heatmapMoveFocus(
  cells: HeatmapCell[],
  current: string,
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
): string | null {
  const index = cells.findIndex((cell) => cell.day === current);
  if (index < 0) return null;
  if (key === 'Home') return cells[0].day;
  if (key === 'End') return cells[cells.length - 1].day;
  const cell = cells[index];
  let targetRow = cell.row;
  let targetColumn = cell.column;
  if (key === 'ArrowUp') targetRow -= 1;
  if (key === 'ArrowDown') targetRow += 1;
  if (key === 'ArrowLeft') targetColumn -= 1;
  if (key === 'ArrowRight') targetColumn += 1;
  if (targetRow < 0 || targetRow > 6 || targetColumn < 0) return null;
  return cells.find((candidate) => candidate.row === targetRow && candidate.column === targetColumn)?.day ?? null;
}

/**
 * heatmapDrillDown is the request-list URL for one day.
 *
 * The bounds come from the day entry itself rather than being re-derived from the
 * date string. The server resolved them from the zone's own rules, so using them is
 * what makes the cell's total and the list it opens describe the same interval; a
 * second derivation from the browser's clock would disagree for a viewer in a zone
 * whose offset differs from the one the response was built with, which is exactly the
 * case a shared link produces.
 */
export function heatmapDrillDown(day: DashboardTokenHeatmapDay): string {
  const query = new URLSearchParams({ from: String(day.from_ms), to: String(day.to_ms) });
  return `/usage/events?${query.toString()}`;
}
