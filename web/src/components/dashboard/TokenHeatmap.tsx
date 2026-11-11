import type { MessageKey } from '../../i18n/catalog';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { TooltipPrimitive } from '@/components/ui/tooltip';
import { RightOutlined } from '../icons';
import { ApiError } from '../../api/client';
import { sharedResizeObserverHub } from '../../performance/resizeObserverHub';
import { useSwrQuery } from '../../performance/swrContract';
import {
  dashboardHeatmapSwr,
  TOKEN_HEATMAP_QUERY_KEY,
  TOKEN_HEATMAP_REFRESH_MS,
} from './dashboardQueries';
import { Link } from 'react-router-dom';
import { heatmapRampMax, heatmapRampPosition } from '../../theme/heatmapRamp';
import { languageLocale, useT, useI18n, type Lang } from '../../i18n';
import { formatTokens, formatTokensFull } from '../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import {
  buildHeatmapGrid,
  createHeatmapCellClassifier,
  fitHeatmapField,
  heatmapColumnCount,
  heatmapDrillDown,
  heatmapFocusDay,
  heatmapMonthLabels,
  heatmapMoveFocus,
  type DashboardTokenHeatmap,
  type DashboardTokenHeatmapDay,
  type HeatmapCell,
} from '../../types/tokenHeatmap';
import { LoadFailure } from '../feedback';
import { formatCalendarDay } from '../../utils/dateTimeFormat';
import { Panel } from '../common/Panel';
import './dashboard.css';

const FULL_NUMBER_FORMAT = new Intl.NumberFormat('en');

/**
 * The weekday labels, Monday first, matching the grid's rows.
 *
 * GitHub omits alternating labels to save width. They are all printed here because a full
 * week of labels is what makes the rows readable without counting them - which is the whole
 * reason the grid has rows.
 */
const WEEKDAY_KEYS: readonly MessageKey[] = [
  'dash.heatmap.dow.mon',
  'dash.heatmap.dow.tue',
  'dash.heatmap.dow.wed',
  'dash.heatmap.dow.thu',
  'dash.heatmap.dow.fri',
  'dash.heatmap.dow.sat',
  'dash.heatmap.dow.sun',
];

/**
 * A scroll offset past any width the field can have, which the browser clamps to the newest
 * column.
 *
 * It has to fit a signed 32-bit integer. WebKit converts an assigned `scrollLeft` to one, so
 * `Number.MAX_SAFE_INTEGER` wraps to -1 there and clamps to the *oldest* column: every iOS
 * browser opened the field a year in the past while Chromium opened it on today.
 */
const HEATMAP_SCROLL_END = 1_000_000;

/** Quiet-stop weights of the legend's swatches, from an empty day to the window's busiest. */
const HEATMAP_LEGEND_SHARES = ['100%', '75%', '50%', '25%', '0%'];

/**
 * The panel's own refresh cadence.
 *
 * Today's total keeps growing as the day is used, so the strip is not static between
 * visits the way a per-day figure would be. Five minutes is chosen against the cost
 * of the read - a bounded scan over the retention window - rather than against the
 * dashboard's poll cadence, which is for a windowed aggregate that changes every few
 * seconds.
 */

/**
 * Grouped digits, deliberately outside the console's token unit style.
 *
 * Two readouts still need this. A request count is not a token volume, so the token unit
 * style has nothing to say about it; and an accessible name always carries the exact count,
 * because a screen reader given "100K" hears a rounded claim with no way to ask for the
 * number it rounded. Every token volume that is *read* goes through the shared display layer
 * instead - see the tooltip below.
 */
function full(value: number): string {
  return FULL_NUMBER_FORMAT.format(value);
}

/**
 * formatDay renders a `YYYY-MM-DD` key as a localized date.
 *
 * The key is a calendar position, not a browser-local instant. An explicit UTC
 * carrier keeps labels unchanged even where a local midnight or whole day was skipped.
 */
function formatDay(day: string, lang: Lang, options: Intl.DateTimeFormatOptions): string {
  return formatCalendarDay(day, languageLocale(lang), options);
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
 * `Link` rather than a bare anchor because the app can be served under a configured basename: an
 * anchor whose `href` is the router-internal path skips that basename and lands outside the app.
 * A `Link` resolves through the router, so the rendered `href` carries the prefix.
 *
 * The cell itself never navigates - see the cell's own comment for why.
 *
 * The token volume prints in the console's unit style, like every other token readout on the page.
 * The panel used to print its own exact form here, which made this one number ignore `omc_token_style`
 * while the KPI tiles directly above it obeyed it. The exact count is not lost: it is the value's own
 * `title`, the same arrangement the model panels' tooltips use, because an abbreviation is only safe
 * to print while the number it rounded stays reachable.
 */
export const HeatmapTooltipContent: React.FC<{
  day: DashboardTokenHeatmapDay;
  lang: Lang;
  href: string;
}> = ({ day, lang, href }) => {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
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
            <dd title={formatTokensFull(day.tokens)}>{formatTokens(day.tokens, tokenStyle)}</dd>
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

interface HeatmapPopupTarget {
  day: string;
  element: HTMLElement;
  timezone: string;
  isOpen: boolean;
}

/**
 * Only the selected cell needs popup machinery. A portal keeps the grid's DOM and focus
 * stable while giving antd a real, stationary anchor for placement and scroll tracking.
 */
const ActiveHeatmapTooltip: React.FC<{
  target: HeatmapPopupTarget;
  entry: DashboardTokenHeatmapDay;
  lang: Lang;
  onClose: () => void;
}> = ({ target, entry, lang, onClose }) => {
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const popupId = React.useId();
  const { element, isOpen } = target;

  React.useLayoutEffect(() => {
    if (!isOpen) return;
    element.setAttribute('aria-describedby', popupId);
    element.classList.add('omc-tooltip-open');
    return () => {
      element.removeAttribute('aria-describedby');
      element.classList.remove('omc-tooltip-open');
    };
  }, [element, isOpen, popupId, entry]);

  React.useEffect(() => {
    if (!isOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Node) || element.contains(node) || popupRef.current?.contains(node)) return;
      onClose();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (popupRef.current?.contains(document.activeElement)) element.focus({ preventScroll: true });
      onClose();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', dismissEscape);
    };
  }, [element, isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <TooltipPrimitive.Provider delay={0}>
      <TooltipPrimitive.Root open>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            anchor={element}
            side="top"
            sideOffset={6}
            className="heatmap-tip-popper z-[1070]"
          >
            <TooltipPrimitive.Popup
              ref={popupRef}
              id={popupId}
              role="tooltip"
              data-slot="tooltip"
              className="omc-float-surface min-w-[176px] max-w-none rounded-md bg-surface px-2.5 py-1.5 text-sm leading-snug text-foreground shadow-float pointer-events-auto"
            >
              <HeatmapTooltipContent day={entry} lang={lang} href={heatmapDrillDown(entry)} />
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
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
export { TOKEN_HEATMAP_QUERY_KEY };

export const TokenHeatmap: React.FC = React.memo(function TokenHeatmap() {
  const t = useT();
  const { lang } = useI18n();

  const timezone = useTimeZone();
  const [focusDay, setFocusDay] = React.useState<string | null>(null);
  const [popupTarget, setPopupTarget] = React.useState<HeatmapPopupTarget | null>(null);
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const isPinnedToNewest = React.useRef(true);
  const { data, isError, error, isFetching, refetch } = useSwrQuery(dashboardHeatmapSwr, timezone, {
    refetchInterval: TOKEN_HEATMAP_REFRESH_MS,
    refetchOnWindowFocus: true,
  });

  const cells = React.useMemo(() => (data ? buildHeatmapGrid(data.days) : []), [data]);
  const columns = React.useMemo(() => heatmapColumnCount(cells), [cells]);

  const entries = React.useMemo(() => {
    const map = new Map<string, DashboardTokenHeatmapDay>();
    for (const entry of data?.days ?? []) map.set(entry.day, entry);
    return map;
  }, [data]);
  React.useEffect(() => {
    if (popupTarget && (popupTarget.timezone !== timezone || !entries.has(popupTarget.day) || !popupTarget.element.isConnected)) {
      setPopupTarget(null);
    }
  }, [entries, popupTarget, timezone]);
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
  // The tab stop and the open tooltip are separate facts: the keyboard can walk the field without
  // opening anything, and a click opens the cell it hit whatever the tab stop was.

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
   * Sizes the cells to the panel and keeps today in view.
   *
   * The DOM order stays oldest-to-newest - it is what the arrow keys, the month axis and a screen
   * reader describe - so the newest column is scrolled to instead.
   *
   * The field stays pinned to that edge until the reader scrolls away from it: a phone rotated
   * after load, or a panel that only gets its final width a frame later, would otherwise leave
   * the newest weeks off screen again. Once the reader has chosen an older week, neither a
   * resize nor a background re-read moves the field.
   */
  React.useEffect(() => {
    if (cells.length === 0) return undefined;
    const container = scrollRef.current;
    if (!container) return undefined;
    let fittedWidth = -1;
    let fittedHeight = -1;
    let isScrollable = false;
    let newestOffset = 0;
    let pinFrame: number | undefined;
    const appliedVars = { fieldMin: '', cell: '', columnGap: '' };

    const setVar = (key: keyof typeof appliedVars, name: string, nextValue: string) => {
      if (appliedVars[key] === nextValue) return;
      appliedVars[key] = nextValue;
      if (nextValue === '') container.style.removeProperty(name);
      else container.style.setProperty(name, nextValue);
    };

    const markOlderWeeks = (hasOlderWeeks: boolean) => {
      if (container.hasAttribute('data-has-older') !== hasOlderWeeks) {
        container.toggleAttribute('data-has-older', hasOlderWeeks);
      }
    };

    const fitCells = (width: number, height: number): boolean => {
      const tokens = getComputedStyle(container);
      const readToken = (name: string) => Number.parseFloat(tokens.getPropertyValue(name)) || 0;
      const gutter = readToken('--heatmap-label') + readToken('--heatmap-label-gap');
      const gap = readToken('--heatmap-gap');
      const axis = readToken('--heatmap-axis');
      const fit = fitHeatmapField(width - gutter, height - axis, columns, readToken('--heatmap-cell-target'), gap, readToken('--heatmap-cell-max'));
      const cell = fit?.cell ?? (width - gutter - (columns - 1) * gap) / columns;
      setVar('fieldMin', '--heatmap-field-min', `${axis + 7 * cell + 6 * gap}px`);
      if (fit === null) {
        setVar('cell', '--heatmap-cell', '');
        setVar('columnGap', '--heatmap-column-gap', '');
        newestOffset = 0;
      } else {
        setVar('cell', '--heatmap-cell', `${fit.cell}px`);
        setVar('columnGap', '--heatmap-column-gap', `${fit.columnGap}px`);
        newestOffset = Math.max(0, gutter + columns * fit.cell + (columns - 1) * fit.columnGap - width);
      }
      return fit !== null;
    };

    const recordReaderPosition = () => {
      const offset = container.scrollLeft;
      isPinnedToNewest.current = offset >= newestOffset - 2;
      markOlderWeeks(offset > 1);
    };

    // Use the shared ResizeObserver hub and schedule scrollLeft pinning after browser layout rather
    // than reading/writing scrollLeft synchronously after mutating inherited CSS custom properties,
    // which previously forced 200ms+ full-document UpdateLayoutTree passes across all 371 cells.
    const unsubscribe = sharedResizeObserverHub.observe(
      container,
      ({ width, height }) => {
        const w = Math.round(width);
        const h = Math.round(height);
        if (w <= 0) return;
        if (w !== fittedWidth || Math.abs(h - fittedHeight) > 1) {
          fittedWidth = w;
          fittedHeight = h;
          isScrollable = fitCells(width, height);
        }
        if (container.hasAttribute('data-scrollable') !== isScrollable) {
          container.toggleAttribute('data-scrollable', isScrollable);
        }
        if (!isScrollable) {
          markOlderWeeks(false);
          return;
        }
        if (isPinnedToNewest.current) {
          markOlderWeeks(newestOffset > 1);
          if (pinFrame !== undefined) cancelAnimationFrame(pinFrame);
          pinFrame = requestAnimationFrame(() => {
            pinFrame = undefined;
            if (!container.isConnected || !isPinnedToNewest.current) return;
            container.scrollLeft = HEATMAP_SCROLL_END;
            markOlderWeeks(container.scrollLeft > 1);
          });
        }
      },
      { freezeOnTransition: true, epsilonPx: 1 },
    );

    container.addEventListener('scroll', recordReaderPosition, { passive: true });
    return () => {
      unsubscribe();
      if (pinFrame !== undefined) cancelAnimationFrame(pinFrame);
      container.removeEventListener('scroll', recordReaderPosition);
    };
  }, [cells.length, columns]);

  // Stable across renders that do not move the tab stop, which is what lets the grid's elements be
  // reused: an inline arrow here would be a new identity every render and would invalidate the
  // `cellRows` memo below on every one of them.
  const handleCellFocus = React.useCallback((day: string) => {
    setFocusDay((current) => (heatmapFocusDay(cells, current) === day ? current : day));
  }, [cells]);
  const handleGridFocus = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    const day = event.target.dataset.day;
    if (day) handleCellFocus(day);
  }, [handleCellFocus]);

  const closePopup = React.useCallback(() => {
    setPopupTarget((current) => current?.isOpen ? { ...current, isOpen: false } : current);
  }, []);

  const handleCellClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest<HTMLElement>('[role="gridcell"]');
    const day = element?.dataset.day;
    if (!element || !day || !gridRef.current?.contains(element) || !entries.has(day)) return;
    setPopupTarget((current) => ({ day, element, timezone, isOpen: current?.element !== element || !current.isOpen }));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!resolvedFocus) return;
    if (!(event.target instanceof Element) || !event.target.matches('[role="gridcell"]')) return;
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

  const classifyCell = React.useMemo(
    () => createHeatmapCellClassifier(data?.first_stored_ms ?? null, data?.as_of_ms ?? null),
    [data?.first_stored_ms, data?.as_of_ms, timezone],
  );

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
      const state = classifyCell(entry);
      // The name follows the cell's *state*, not the response's shape. The server emits a
      // zero-valued entry for every day in the window, so keying on the entry's presence announced
      // "0 requests, 0 tokens" for a day nothing is stored for - asserting a measurement that does
      // not exist, and disagreeing with the cell's own tooltip and colour. A measured day reports
      // its counts; every other day says nothing is stored, in the words the tooltip uses.
      const formattedDay = entry ? formatDay(entry.day, lang, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const label = entry
        ? state === 'measured'
          ? t('dash.heatmap.cell_label', {
            day: formattedDay,
            requests: full(entry.requests),
            tokens: full(entry.tokens),
          })
          : t('dash.heatmap.cell_label_empty', { day: formattedDay })
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
        >
          <span className="heatmap-cell-mark" aria-hidden="true" />
        </div>
      );
      return node;
  }, [entries, rampMax, t, lang, resolvedFocus, classifyCell]);

  const cellRows = React.useMemo(
    () => cellsByRow.map((row, index) => (
      <div key={index} className="heatmap-row" role="row">
        {row.map(renderCell)}
      </div>
    )),
    [cellsByRow, renderCell],
  );

  // A first load that failed has no grid to keep, so it says so and offers the retry
  // instead of leaving a skeleton up forever.
  if (isError && !data) {
    return (
      <Panel className="dashboard-tile heatmap-panel">
        <div className="tile-label">{t('dash.heatmap.title')}</div>
        <LoadFailure
          className="heatmap-alert"
          title={t('dash.heatmap.error')}
          detail={error instanceof ApiError ? error.message : t('dash.error_desc')}
          onRetry={() => void refetch()}
        />
      </Panel>
    );
  }

  return (
    <Panel
      className="dashboard-tile heatmap-panel"
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
            <LoadFailure
              className="heatmap-alert heatmap-stale-alert"
              tone="warning"
              title={t('dash.heatmap.stale')}
              onRetry={() => void refetch()}
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
            {/* The month axis mirrors the body below - a pinned corner, then the same tracks - so a
                label sits over the column it names at any scroll offset. */}
            <div className="heatmap-months" aria-hidden="true">
              <span className="heatmap-corner" />
              <div className="heatmap-month-track">
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
                onClick={handleCellClick}
                onFocus={handleGridFocus}
              >
                {cellRows}
              </div>
              {popupTarget && popupTarget.timezone === timezone && entries.has(popupTarget.day) && (
                <ActiveHeatmapTooltip
                  key={popupTarget.day}
                  target={popupTarget}
                  entry={entries.get(popupTarget.day)!}
                  lang={lang}
                  onClose={closePopup}
                />
              )}
            </div>
          </div>

          {/* The key names only the ramp's direction. The shade is relative to the window's own
              busiest day, so the swatches carry no quantities; those are in each cell's tooltip
              and accessible name. It closes the field from below, where it is read after the
              cells, and its line is the panel's last, level with the end of the list beside it. */}
          <div className="heatmap-legend" aria-hidden="true">
            <span>{t('dash.heatmap.legend_less')}</span>
            <span className="heatmap-legend-scale">
              {HEATMAP_LEGEND_SHARES.map((share) => (
                <i
                  key={share}
                  className="heatmap-legend-swatch"
                  style={{ '--heatmap-quiet-share': share } as React.CSSProperties}
                />
              ))}
            </span>
            <span>{t('dash.heatmap.legend_more')}</span>
          </div>
          {isFetching && !isError && <span className="heatmap-progress" aria-hidden="true" />}
        </>
      )}

      </div>
    </Panel>
  );
});

export type { DashboardTokenHeatmap };
