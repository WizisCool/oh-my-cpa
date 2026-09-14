import React from 'react';
import { Alert, Button, Card, Tooltip } from 'antd';
import { ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { heatmapRampMax, heatmapRampPosition } from '../../theme/heatmapRamp';
import { useT, useI18n, type Lang } from '../../i18n';
import {
  buildHeatmapGrid,
  heatmapCellState,
  heatmapColumnCount,
  heatmapDrillDown,
  heatmapFocusDay,
  heatmapMonthLabels,
  heatmapMoveFocus,
  type DashboardTokenHeatmap,
  type DashboardTokenHeatmapDay,
  type HeatmapCell,
} from '../../types/tokenHeatmap';

const FULL_NUMBER_FORMAT = new Intl.NumberFormat('en');

/**
 * The weekday labels, Monday first, matching the grid's rows.
 *
 * GitHub omits alternating labels to save width. They are all printed here because the
 * gutter is 28px and a full week of labels is what makes the rows readable without
 * counting them - which is the whole reason the grid has rows.
 */
const WEEKDAY_KEYS = [
  'dash.heatmap.dow.mon',
  'dash.heatmap.dow.tue',
  'dash.heatmap.dow.wed',
  'dash.heatmap.dow.thu',
  'dash.heatmap.dow.fri',
  'dash.heatmap.dow.sat',
  'dash.heatmap.dow.sun',
];

/**
 * The panel's own refresh cadence.
 *
 * Today's total keeps growing as the day is used, so the strip is not static between
 * visits the way a per-day figure would be. Five minutes is chosen against the cost
 * of the read - a bounded scan over the retention window - rather than against the
 * dashboard's poll cadence, which is for a windowed aggregate that changes every few
 * seconds.
 */
const HEATMAP_REFRESH_MS = 5 * 60_000;

function full(value: number): string {
  return FULL_NUMBER_FORMAT.format(value);
}

/**
 * The viewer's IANA timezone, or null when it cannot be determined.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is the zone the browser is
 * actually applying, which is what the strip's days must be built from. It is not
 * always available (a stripped-down runtime, an unusual embedder), and the caller
 * reports that rather than guessing: an offset would be wrong for every day on the
 * far side of a daylight-saving transition, not merely the two transition days.
 */
export function viewerTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && typeof zone === 'string' ? zone : null;
  } catch {
    return null;
  }
}

/**
 * formatDay renders a `YYYY-MM-DD` key as a localized date.
 *
 * The key is a calendar position, so it is read field by field rather than through
 * `new Date(key)`: the latter parses a bare date as UTC midnight, and a viewer behind
 * UTC would then be shown the previous day in every readout and axis label.
 */
function formatDay(day: string, lang: Lang, options: Intl.DateTimeFormatOptions): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', options)
    .format(new Date(year, (month ?? 1) - 1, date ?? 1));
}

/**
 * The heatmap tooltip's content: the date, the two quantities, and the link that opens the day.
 *
 * A component rather than a string because the rows are a two-column list with the values
 * right-aligned - "Requests 6" and "Tokens 6,000" only mean something read against each other.
 * The structure is semantic (`dl`/`dt`/`dd`) so the pairing survives being read aloud, which a
 * pair of styled `div`s would not.
 *
 * The drill-down is React Router's `Link`, which renders a real `<a href>`: the day's request list
 * is a place, so it has to be openable in a new tab, copyable and announced as a link. It is a
 * `Link` rather than a bare anchor because the app is served under a basename (`/omc`): an anchor
 * whose `href` is the router-internal path skips the basename and lands outside the app entirely.
 * A `Link` resolves through the router, so the rendered `href` carries the prefix.
 *
 * The cell itself never navigates - see the cell's own comment for why.
 */
export const HeatmapTooltipContent: React.FC<{
  day: DashboardTokenHeatmapDay;
  lang: Lang;
  href: string;
}> = ({ day, lang, href }) => {
  const t = useT();
  const date = formatDay(day.day, lang, { year: 'numeric', month: 'long', day: 'numeric' });
  // A day with nothing recorded says so in place of the two counts. Reporting "Requests 0 / Tokens 0"
  // would be a measurement the panel cannot make - nothing is stored for that day, which is not the
  // same claim as a day that carried no traffic - and the distinction is the one thing a reader
  // comparing days needs to be able to see.
  const isRecorded = day.requests > 0 || day.tokens > 0;
  return (
    <dl className="heatmap-tip">
      <div className="heatmap-tip-day">{date}</div>
      {isRecorded ? (
        <>
          <div className="heatmap-tip-row">
            <dt>{t('dash.heatmap.tip_requests')}</dt>
            <dd>{full(day.requests)}</dd>
          </div>
          <div className="heatmap-tip-row">
            <dt>{t('dash.heatmap.tip_tokens')}</dt>
            <dd>{full(day.tokens)}</dd>
          </div>
          <Link className="heatmap-tip-link" to={href}>
            {t('dash.heatmap.open_requests')}
            <RightOutlined className="heatmap-tip-link-icon" />
          </Link>
        </>
      ) : (
        <div className="heatmap-tip-empty">{t('dash.heatmap.tip_no_requests')}</div>
      )}
    </dl>
  );
};

/**
 * The prefix every grid query shares, so the page's refresh button can invalidate it.
 *
 * A revision in the query key would be a *new* cache entry, and a refresh that failed would
 * then have no previous data to keep - it would paint the first-load error over a grid that was
 * on screen a moment ago. Invalidation re-runs the existing entry instead, so the grid stays and
 * the warning is additive. A prefix is enough because the full key also carries the viewer's
 * zone, which the page has no reason to know.
 */
export const TOKEN_HEATMAP_QUERY_KEY = 'dashboard-token-heatmap';

/**
 * TokenHeatmap is the dashboard's contribution graph of daily token volume, below the six KPI
 * tiles.
 *
 * Five decisions are worth stating, because each is a place where the obvious implementation is
 * wrong.
 *
 * **The shape is a field, not a timeline.** Seven weekday rows by a year of week columns. The
 * rows are the whole point: they make a weekly rhythm a *row* and a trend a *direction*, which a
 * single-row strip cannot show - and the shape and the span are one decision, since at seven rows
 * a quarter's worth of days would be thirteen columns rather than a field.
 *
 * **The year is drawn in full.** Days after today are simply days nothing is stored for: they are
 * not queried, so they render as `unrecorded` alongside every other day with no record. The panel
 * does not distinguish a day that has not happened from one whose records were pruned, because a
 * reader comparing days can only act on one thing - whether there is data for it.
 *
 * **The cells are DOM, not a chart mark.** `@ant-design/charts` is isolated in its own lazy chunk
 * and reaches the browser only from the trend marks above. A field of ~370 cells needs per-cell
 * text, focus and hit areas, so a canvas mark would need a parallel DOM layer for all three. See
 * docs/design.md §2 and ADR 0005.
 *
 * **Its span is a rolling fifty-three whole weeks**, ending on the week containing today. Fixed
 * rather than derived from the window picker: a field whose width is its own data's age is not a
 * calendar, and at the 24h default it would be a single column. A calendar year was the alternative
 * and it spends every January almost entirely empty while saying nothing about the December that
 * just ended - which is exactly the comparison a reader wants at that moment. The span is a whole
 * number of weeks so the current week is drawn complete, and the window picker still governs the
 * tiles above.
 *
 * **The days are the viewer's local days, built by the server in the viewer's zone.** A day is not
 * 24 hours in every zone on every date, and a single fixed offset is wrong for every day on the
 * far side of a daylight-saving transition. The response carries each day's exact bounds, and
 * those same bounds are what a click opens, so the cell and the list cannot disagree.
 *
 * Colour is a density ramp rather than a verdict - see docs/design.md §2 for the rules, which are
 * asserted from painted pixels by the browser probe.
 */
export const TokenHeatmap: React.FC = () => {
  const t = useT();
  const { lang } = useI18n();

  // Read once: the zone does not change while the page is open, and reading it per
  // render would make the query key unstable and refetch the panel on every unrelated
  // state update.
  const timezone = React.useMemo(() => viewerTimezone(), []);
  const [focusDay, setFocusDay] = React.useState<string | null>(null);
  // Only the readout's day is state; the hover ring is pure CSS. A state write per
  // `pointerenter` is unavoidable while the readout names the hovered day, so the cost is
  // contained instead: the cell elements are memoized below, which makes a hover update the
  // readout's text without React reconciling 372 cells.
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const hasScrolledToToday = React.useRef(false);
  const { data, isError, error, isFetching, refetch } = useQuery({
    queryKey: [TOKEN_HEATMAP_QUERY_KEY, timezone],
    queryFn: () => api.getTokenHeatmap(timezone as string),
    enabled: timezone !== null,
    // The strip re-reads on its own cadence, on window focus, and when the page's
    // refresh button is pressed (through the key above).
    refetchInterval: HEATMAP_REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: HEATMAP_REFRESH_MS / 2,
    // A refresh that fails keeps the strip the operator is reading: replacing a month
    // of history with an error panel because one poll timed out is worse than showing
    // slightly old data with its readout still answering.
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });

  const cells = React.useMemo(() => (data ? buildHeatmapGrid(data.days) : []), [data]);
  const columns = React.useMemo(() => heatmapColumnCount(cells), [cells]);

  const entries = React.useMemo(() => {
    const map = new Map<string, DashboardTokenHeatmapDay>();
    for (const entry of data?.days ?? []) map.set(entry.day, entry);
    return map;
  }, [data]);
  // The ramp is scaled to the window's own busiest day, so the shade is relative to what this
  // deployment actually does rather than to a fixed token count. Zero means nothing in the window
  // carried traffic, which is the case the component skips the ramp for entirely.
  const rampMax = React.useMemo(
    () => heatmapRampMax((data?.days ?? []).map((entry) => entry.tokens)),
    [data],
  );
  const monthLabels = React.useMemo(
    () => heatmapMonthLabels(cells, columns, (day) => formatDay(day, lang, { month: 'short' })),
    [cells, columns, lang],
  );
  const resolvedFocus = heatmapFocusDay(cells, focusDay);
  // The tooltip's day: whatever the pointer or the keyboard is on. There is no separate
  // readout to keep in sync, so one piece of state drives both.

  // The tab stop holds real DOM focus, not just state: a roving tabindex that only moves
  // a class leaves the operator tabbing into a panel whose focus ring is painted somewhere
  // else. The effect runs after the grid has re-rendered with the new day, and only when
  // focus is already inside it, so it never steals focus from the page.
  React.useEffect(() => {
    if (focusDay === null) return;
    const host = gridRef.current;
    if (!host || !host.contains(document.activeElement)) return;
    const cell = host.querySelector<HTMLElement>(`[data-day="${focusDay}"]`);
    if (cell && document.activeElement !== cell) {
      cell.focus();
      // The panel sits below the fold on a short window, so the focused cell is brought into
      // view or an arrow key would walk the focus off the visible area with nothing to show.
      cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [focusDay]);

  /**
   * Brings today into view when the field is swipeable.
   *
   * Only a panel too narrow for the cell floor scrolls at all; everywhere else the distance is
   * zero and this is a no-op. The DOM order stays oldest-to-newest - it is what the arrow keys,
   * the month axis and a screen reader describe - so the newest column is scrolled to instead.
   * Run once per mount, so a background re-read does not yank the field back while the operator
   * is reading January.
   */
  React.useEffect(() => {
    if (hasScrolledToToday.current || cells.length === 0) return;
    const container = scrollRef.current;
    if (!container) return;
    hasScrolledToToday.current = true;
    const distance = container.scrollWidth - container.clientWidth;
    if (distance > 0) container.scrollLeft = distance;
  }, [cells.length]);

  /**
   * Focusing a cell also claims the tab stop.
   *
   * Without this the two can diverge: a click or a programmatic focus moves the browser's
   * focus without moving `resolvedFocus`, so the next arrow key or Enter acts on the day
   * the grid still thinks it is on rather than the one the operator is looking at.
   */
  // Stable across renders that do not move the tab stop, which is what lets the grid's elements be
  // reused: an inline arrow here would be a new identity every render and would invalidate the
  // `cellNodes` memo below on every one of them.
  const handleCellFocus = React.useCallback((day: string) => {
    setFocusDay((current) => (heatmapFocusDay(cells, current) === day ? current : day));
  }, [cells]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!resolvedFocus) return;
    // Every function of a cell is reachable from the keyboard: a grid that can only be explored
    // with a pointer is one an operator without one cannot use. Enter and Space activate the cell
    // the way a click does - opening its tooltip - rather than navigating, so the keyboard and the
    // pointer offer the same thing.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const cell = gridRef.current?.querySelector<HTMLElement>(`[data-day="${resolvedFocus}"]`);
      cell?.click();
      return;
    }
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const;
    const key = keys.find((candidate) => candidate === event.key);
    if (!key) return;
    // The arrow keys would otherwise scroll the grid, and the operator's keyboard focus
    // with it.
    event.preventDefault();
    const next = heatmapMoveFocus(cells, resolvedFocus, key);
    if (!next) return;
    setFocusDay(next);
  };

  /**
   * The cells grouped into their weekday rows.
   *
   * WAI-ARIA requires every `gridcell` to be owned by a `row`, and every `row` by the grid; a bare
   * grid of `gridcell`s is a violation even though it renders correctly, because assistive
   * technology has no row to announce positions against. The rows carry `display: contents`, so they
   * add the ownership the tree needs without becoming boxes: each cell keeps its own `gridColumn`
   * and `gridRow`, and the layout is exactly what it was.
   */
  const cellsByRow = React.useMemo(() => {
    const rows: HeatmapCell[][] = Array.from({ length: WEEKDAY_KEYS.length }, () => []);
    for (const cell of cells) rows[cell.row]?.push(cell);
    return rows;
  }, [cells]);

  /**
   * The cell elements, memoized so the panel's own re-renders do not rebuild them.
   *
   * There are ~370 of them and their only per-cell inputs are the day's totals, its ramp weight and
   * its place in the tab order, so a re-render driven by anything else - a refetch landing, a theme
   * or language change, the failure state clearing - can reuse the same elements instead of
   * reconciling the whole grid. The focused day is a dependency rather than a re-render input,
   * because moving the tab stop genuinely does change one cell.
   */
  const renderCell = React.useCallback((cell: HeatmapCell) => {
      const entry = entries.get(cell.day);
      const state = heatmapCellState(entry, data?.first_stored_ms ?? null, data?.as_of_ms ?? null);
      // The name follows the cell's *state*, not the response's shape. The server emits a
      // zero-valued entry for every day in the window, so keying on the entry's presence announced
      // "0 requests, 0 tokens" for a day nothing is stored for - asserting a measurement that does
      // not exist, and disagreeing with the cell's own tooltip and colour. A measured day reports
      // its counts; every other day says nothing is stored, in the words the tooltip uses.
      const label = entry
        ? t(state === 'measured' ? 'dash.heatmap.cell_label' : 'dash.heatmap.cell_label_empty', {
          day: formatDay(entry.day, lang, { year: 'numeric', month: 'short', day: 'numeric' }),
          requests: full(entry.requests),
          tokens: full(entry.tokens),
        })
        : undefined;
      // The continuous ramp: the weight of the quiet stop, as a percentage. A measured cell carries
      // it as a custom property and CSS mixes the two stops; every other state is drawn by its class
      // and gets no ramp at all, so "no traffic" can never be confused with a light measured shade.
      const quietShare = state === 'measured'
        ? `${Math.round((1 - heatmapRampPosition(entry?.tokens ?? 0, rampMax)) * 10000) / 100}%`
        : null;
      // The visual square is an inner element, and the hover scale applies to *it* rather than to
      // the cell, because the cell is what antd measures to place the tooltip: a transform on the
      // anchor is a moving target, and the box would be placed against whichever rect existed when
      // it was opened rather than the one on screen afterwards. The mark is `pointer-events: none`
      // so the hover target stays the stationary cell.
      const node = (
        <div
          key={cell.day}
          data-day={cell.day}
          role="gridcell"
          className={`heatmap-cell is-${state}${quietShare ? ' is-measured' : ''} is-interactive`}
          // The ramp weight travels as a custom property rather than an inline `background`, which
          // keeps the two stops in the stylesheet and the mixing in the browser's OKLCH.
          style={{
            gridColumn: cell.column + 1,
            gridRow: cell.row + 1,
            ...(quietShare ? { '--heatmap-quiet-share': quietShare } : {}),
          } as React.CSSProperties}
          // Only interactive cells take a tab stop. A field where every cell were focusable would
          // put ~370 stops in the tab order, and one where a dead cell were focusable would make
          // the keyboard promise an interaction that cannot happen.
          tabIndex={cell.day === resolvedFocus ? 0 : -1}
          aria-label={label}
          onFocus={() => handleCellFocus(cell.day)}
        >
          <span className="heatmap-cell-mark" aria-hidden="true" />
        </div>
      );
      // Every cell opens a tooltip, including one with nothing stored: the tooltip says so, which is
      // the answer to "what happened on this date" rather than a reason to refuse the question.
      if (!entry) return node;
      return (
        <Tooltip
          key={cell.day}
          // Click, not hover. A hover tooltip on a field this dense fires continuously as the
          // pointer crosses it, and it competes with the hover ring for the same gesture; a click
          // is deliberate, and it is the gesture that leaves the tooltip open to be read and
          // followed.
          trigger="click"
          placement="top"
          // Structure and spacing only, through antd's own semantic hooks - antd owns the popper,
          // placement, arrow and motion, so the panel contributes a class and nothing positional.
          //
          // Only the width is overridden, and the container's inset is left to antd: zeroing the
          // padding made the right-aligned values sit flush against the box's border, which reads
          // as clipped text. The wrapping was the `max-width`, which is what is lifted here.
          // The container's inset is antd's own and is left alone: zeroing its padding made the
          // right-aligned values sit flush against the box's border, which reads as clipped text.
          // Only the `max-width` is lifted, because it - not the padding - is what wrapped the rows.
          classNames={{ root: 'heatmap-tip-popper' }}
          styles={{ container: { maxWidth: 'none' } }}
          title={<HeatmapTooltipContent day={entry} lang={lang} href={heatmapDrillDown(entry)} />}
          // ~370 cells must not each hold a popper instance for a tooltip the operator may never
          // open, and a closed one leaves no node behind to be measured or clicked.
          destroyOnHidden
        >
          {node}
        </Tooltip>
      );
  }, [entries, rampMax, t, lang, resolvedFocus, data, handleCellFocus]);

  const cellRows = React.useMemo(
    () => cellsByRow.map((row, index) => (
      <div key={index} className="heatmap-row" role="row">
        {row.map(renderCell)}
      </div>
    )),
    [cellsByRow, renderCell],
  );

  // The zone is read from the browser and cannot be inferred, so a runtime without it gets
  // an explanation rather than a grid built on a guess.
  if (timezone === null) {
    return (
      <Card className="dashboard-tile is-wide heatmap-panel" styles={{ body: { padding: 20 } }}>
        <div className="tile-label">{t('dash.heatmap.title')}</div>
        <Alert className="heatmap-alert" type="warning" showIcon description={t('dash.heatmap.no_timezone')} />
      </Card>
    );
  }

  // A first load that failed has no grid to keep, so it says so and offers the retry
  // instead of leaving a skeleton up forever.
  if (isError && !data) {
    return (
      <Card className="dashboard-tile is-wide heatmap-panel" styles={{ body: { padding: 20 } }}>
        <div className="tile-label">{t('dash.heatmap.title')}</div>
        <Alert
          className="heatmap-alert"
          type="error"
          showIcon
          description={`${t('dash.heatmap.error')} — ${error instanceof ApiError ? error.message : t('dash.error_desc')}`}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>{t('common.retry')}</Button>}
        />
      </Card>
    );
  }

  return (
    <Card
      className="dashboard-tile heatmap-panel"
      styles={{ body: { padding: 20 } }}
      // The sizing travels as custom properties, not as per-cell inline styles: a style
      // attribute on each of 372 cells is 372 objects for React to diff on every render and
      // defeats the browser's style-sharing for identical elements.
    >
      <div className="heatmap-inner">
      <div className="heatmap-head">
        <span className="tile-label">{t('dash.heatmap.title')}</span>
      </div>

      {!data ? (
        <div className="heatmap-skeleton" aria-hidden="true" />
      ) : (
        <>
          {/* A refresh that failed, or one still in flight over existing data, is reported
              on its own line: the grid below stays readable, so the warning has to be
              additive rather than replacing it. */}
          {isError && (
            <Alert
              className="heatmap-alert heatmap-stale-alert"
              type="warning"
              showIcon
              description={t('dash.heatmap.stale')}
              action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>{t('common.retry')}</Button>}
            />
          )}

          {/* The week count travels as a custom property on the scroll container, so the grid, the
              weekday gutter and the month axis all build the same tracks from one value. Each of them
              deriving its own was how the axis came to size itself from its label text and drift off
              the columns it named. */}
          <div
            className="heatmap-scroll"
            ref={scrollRef}
            style={{ '--heatmap-columns': columns } as React.CSSProperties}
          >
            {/* The month axis is a grid of its own, with the weekday gutter as padding, so a
                label sits under the column it names. */}
            <div className="heatmap-months" aria-hidden="true">
              {monthLabels.map((entry) => (
                <span
                  key={entry.column}
                  className={`heatmap-month${entry.column === columns - 1 ? ' is-last' : ''}`}
                  style={{ gridColumn: entry.column + 1 }}
                >
                  {entry.label}
                </span>
              ))}
            </div>

            <div className="heatmap-body">
              {/* The weekday labels are a column of single letters (or two, in Chinese).
                  GitHub prints only alternating ones; a full week is what makes the rows
                  readable without counting them. */}
              <div className="heatmap-weekdays" aria-hidden="true">
                {WEEKDAY_KEYS.map((key, row) => (
                  <span key={key} className="heatmap-weekday" style={{ gridRow: row + 1 }}>{t(key)}</span>
                ))}
              </div>

              <div
                ref={gridRef}
                className="heatmap-grid"
                role="grid"
                aria-label={t('dash.heatmap.grid_label', { n: data.days.length })}
                aria-readonly="true"
                onKeyDown={handleKeyDown}
              >
                {cellRows}
              </div>
            </div>
          </div>

          {/* No legend. A key exists to explain what a stepped scale's bands mean, and a continuous
              ramp has none: the shade is relative to the window, so a swatch ladder would describe
              the field's own range rather than any fixed quantity. The numbers are in each cell's
              tooltip and accessible name, which is where a reader who wants them goes. */}
          {isFetching && !isError && <span className="heatmap-progress" aria-hidden="true" />}
        </>
      )}

      </div>
    </Card>
  );
};

export type { DashboardTokenHeatmap };
