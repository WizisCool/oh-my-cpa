import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
  Input,
  Listy,
  type ListyRef,
  Popover,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Tooltip,
} from 'antd';
import {
  FilterOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  InfoCircleOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePreference } from '../hooks/usePreference';
import { useT } from '../i18n';
import {
  usageEventParams,
  isUsageFacetsResponse,
  type UsageEvent,
  type UsageEventPage,
  type UsageFacets,
  type UsageResultFilter,
} from '../types/usageEvents';
import {
  indexCredentialFiles,
  resolveCredential,
  EVENT_AUTO_REFRESH_MS,
  EVENT_SEARCH_DEBOUNCE_MS,
  EVENT_FILTER_KEYS,
  activeFilterCount,
  eventWindow,
  filterParamsToUrl,
  queryToFilterParams,
  readEventQuery,
  readFilterParams,
  rejectedEventParams,
  USAGE_EVENTS_VIEW_PREFERENCE,
  DEFAULT_USAGE_EVENTS_VIEW,
  parseUsageEventsView,
  hasExplicitEventQuery,
  usageFacetLabel,
  mergeFacetOptions,
  type EventFilterKey,
  type UsageEventsViewPreference,
  type EventGrouping,
} from '../types/usageEventView';
import type { UsageEventsView } from '../types/usageEventFilters';
import {
  REQUEST_COLUMNS,
  COLUMN_MAP,
  USAGE_EVENTS_COLUMNS_PREFERENCE,
  type RequestColumnId,
  type RequestColumnWidths,
  parseUsageEventsColumns,
  buildGridTemplateColumns,
  computeGridMinWidth,
} from '../components/usage/requestColumns';
import {
  PROVIDER_ICONS_PREFERENCE,
  EMPTY_PROVIDER_ICONS,
  parseProviderIcons,
} from '../types/providerIcons';
import { RequestRow } from '../components/usage/RequestRow';
import { UsageEventDrawer } from '../components/usage/UsageEventDrawer';
import { RequestFilterDrawer } from '../components/usage/RequestFilterDrawer';
import { RequestFilterChips } from '../components/usage/RequestFilterChips';
import { TimeRangeControl } from '../components/usage/TimeRangeControl';
import './UsageEventsPage.css';

interface IngestStatus {
  enabled?: boolean;
  healthy?: boolean;
  collector?: {
    mode?: string;
    running?: boolean;
    captured?: number;
    coverage_gaps?: number;
    last_error?: string;
  };
  stats?: { pending?: number };
}

/**
 * Text filters commit to the URL only after typing pauses: one keystroke must
 * never fire one list request per character. Only the free-text search box uses
 * this - the drawer's fields are drafts applied on demand, which is what makes a
 * range form usable at all.
 *
 * The committed value is the source of truth in every case except one: while the
 * operator is typing. An external change (hydration from saved preferences,
 * Back/Forward, a drill-down, a removed chip) has to win over local text that was
 * typed against the old value, or the stale text would overwrite the navigation
 * once the debounce fired. A clear-all is a second case, and it cannot be detected
 * by watching the committed value at all: the search box is usually already empty
 * when the clear runs, so nothing observable changes and a queued keystroke would
 * land after it. That is what `resetToken` is for.
 */
function useDebouncedSearch(
  committed: string,
  commit: (value: string) => void,
  resetToken: number,
) {
  const [value, setValue] = React.useState(committed);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The timer calls the *latest* commit rather than the one captured when it was
  // scheduled. A commit builds its URL from the parameters of the render it was
  // created in, so a filter changed during the debounce window would otherwise be
  // erased when the queued keystroke fired against the older snapshot.
  const commitRef = React.useRef(commit);
  React.useEffect(() => {
    commitRef.current = commit;
  });
  // Read at fire time so a reset that landed while the timer was queued still
  // invalidates it. Checking only when the reset is requested would leave the
  // window between the request and its effect open.
  const resetRef = React.useRef(resetToken);
  React.useEffect(() => {
    resetRef.current = resetToken;
  });

  const cancelPending = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // The committed value is the source of truth for every change that did not come
  // from this box: hydration from saved preferences, Back/Forward, a drill-down,
  // a removed chip.
  React.useEffect(() => {
    cancelPending();
    setValue(committed);
  }, [committed, cancelPending]);

  // A clear runs while this box is usually already empty, so nothing observable
  // changes and the committed value cannot signal that queued work must be
  // dropped. That is what the token is for.
  React.useEffect(() => {
    cancelPending();
    setValue(committed);
  }, [resetToken]);

  React.useEffect(() => cancelPending, [cancelPending]);

  const change = React.useCallback(
    (next: string) => {
      setValue(next);
      cancelPending();
      if (next.trim() === committed) return;
      const scheduledUnder = resetRef.current;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (resetRef.current !== scheduledUnder) return;
        commitRef.current(next.trim());
      }, EVENT_SEARCH_DEBOUNCE_MS);
    },
    [cancelPending, committed],
  );

  return [value, change] as const;
}

/**
 * Distance from the top at which the list counts as "following the live edge".
 * A few pixels of slack avoids fighting the browser's fractional scroll offsets.
 */
const FOLLOW_TOP_PX = 4;

/**
 * Distance past which the reader counts as reading history rather than the live
 * edge. Deliberately larger than FOLLOW_TOP_PX so the state cannot flap while a
 * trackpad coasts to a stop near the top.
 */
const HOLD_FROM_PX = 60;

export const UsageEventsPage: React.FC = () => {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const signature = params.toString();
  const query = React.useMemo(() => readEventQuery(new URLSearchParams(signature)), [signature]);

  const { value: viewPref, ready: prefReady, set: setViewPref } = usePreference<UsageEventsViewPreference>(
    USAGE_EVENTS_VIEW_PREFERENCE,
    DEFAULT_USAGE_EVENTS_VIEW,
    parseUsageEventsView,
  );

  const {
    value: columnWidthsPref,
    ready: columnWidthsReady,
    set: setColumnWidthsPref,
  } = usePreference<RequestColumnWidths>(
    USAGE_EVENTS_COLUMNS_PREFERENCE,
    {},
    parseUsageEventsColumns,
  );

  const [colWidths, setColWidths] = React.useState<RequestColumnWidths>({});

  React.useEffect(() => {
    if (columnWidthsReady) {
      setColWidths(columnWidthsPref);
    }
  }, [columnWidthsReady, columnWidthsPref]);

  const gridTemplate = React.useMemo(
    () => buildGridTemplateColumns(colWidths),
    [colWidths],
  );
  const gridMinWidth = React.useMemo(() => computeGridMinWidth(colWidths), [colWidths]);

  // The row list scrolls vertically and therefore loses a scrollbar's worth of
  // inner width that the header never loses. Measuring the real gutter (rather
  // than assuming a platform width) lets the header pad exactly that much, so
  // column boundaries line up on Windows, macOS overlay scrollbars and touch.
  const [scrollbarGutter, setScrollbarGutter] = React.useState(0);
  React.useEffect(() => {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;top:-9999px;left:-9999px;width:64px;height:64px;overflow:scroll;';
    document.body.appendChild(probe);
    setScrollbarGutter(Math.max(0, probe.offsetWidth - probe.clientWidth));
    probe.remove();
  }, []);

  const handleResizeStart = React.useCallback(
    (colId: RequestColumnId, e: React.PointerEvent<HTMLSpanElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const colDef = COLUMN_MAP.get(colId)!;
      const thElement = target.parentElement as HTMLElement;
      const startWidth = thElement
        ? thElement.getBoundingClientRect().width
        : (colWidths[colId] || colDef.defaultWidth);
      const startX = e.clientX;

      let latestWidth = startWidth;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        latestWidth = Math.round(
          Math.min(colDef.maxWidth, Math.max(colDef.minWidth, startWidth + delta)),
        );
        setColWidths((prev) => ({
          ...prev,
          [colId]: latestWidth,
        }));
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        try {
          target.releasePointerCapture(upEvent.pointerId);
        } catch {}
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onPointerUp);
        target.removeEventListener('pointercancel', onPointerUp);

        setColWidths((prev) => {
          const next = { ...prev, [colId]: latestWidth };
          setColumnWidthsPref(next);
          return next;
        });
      };

      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('pointercancel', onPointerUp);
    },
    [colWidths, setColumnWidthsPref],
  );

  const handleResetColumn = React.useCallback(
    (colId: RequestColumnId) => {
      setColWidths((prev) => {
        const next = { ...prev };
        delete next[colId];
        setColumnWidthsPref(next);
        return next;
      });
    },
    [setColumnWidthsPref],
  );

  const handleResetAllColumns = React.useCallback(() => {
    setColWidths({});
    setColumnWidthsPref({});
  }, [setColumnWidthsPref]);

  const handleResizeKeyDown = React.useCallback(
    (colId: RequestColumnId, e: React.KeyboardEvent) => {
      const colDef = COLUMN_MAP.get(colId)!;
      const currentWidth = colWidths[colId] ?? colDef.defaultWidth;
      let nextWidth: number | null = null;
      if (e.key === 'ArrowLeft') {
        nextWidth = Math.max(colDef.minWidth, currentWidth - 10);
      } else if (e.key === 'ArrowRight') {
        nextWidth = Math.min(colDef.maxWidth, currentWidth + 10);
      } else if (e.key === 'Enter' || e.key === 'Escape') {
        handleResetColumn(colId);
        return;
      }
      if (nextWidth !== null) {
        e.preventDefault();
        const finalWidth = nextWidth;
        setColWidths((prev) => {
          const next = { ...prev, [colId]: finalWidth };
          setColumnWidthsPref(next);
          return next;
        });
      }
    },
    [colWidths, handleResetColumn, setColumnWidthsPref],
  );

  // Initial URL check: did the user enter with explicit query params (e.g. from dashboard drill-down)?
  const initialParamsRef = React.useRef(params);
  const hasExplicit = React.useMemo(() => hasExplicitEventQuery(initialParamsRef.current), []);
  const [hydrated, setHydrated] = React.useState(hasExplicit);

  const [refresh, setRefresh] = React.useState(0);
  const [isAutoRefresh, setIsAutoRefresh] = React.useState(false);
  const activeWindow = React.useMemo(() => eventWindow(query, Date.now()), [query, refresh]);

  /**
   * Facets are read on their own window, not on the list's poll counter.
   *
   * `activeWindow` advances on every poll, so keying the facet query on it made
   * each ten-second tick re-issue ten grouped scans - the most expensive query
   * on the page - to answer a question whose answer barely moves. Facets describe
   * which values exist in a window, so they only need re-reading when the window
   * is *redefined* (a new preset or absolute range) or the operator asks for a
   * refresh. `facetWindowRevision` is exactly those two events, and the resolved
   * timestamps still live in the query key, so a genuinely new window is a
   * genuinely new cache entry.
   */
  const [facetWindowRevision, setFacetWindowRevision] = React.useState(0);
  const facetWindow = React.useMemo(
    () => eventWindow(query, Date.now()),
    [query, facetWindowRevision],
  );

  // viewScope identifies the view the reader is looking at: the filters and
  // window they picked, plus which page of it. The auto-refresh counter is
  // deliberately absent. It used to be part of this scope, so every poll looked
  // like a brand-new view: pagination fell back to page one and the list was
  // remounted by its key, which threw a reader who was halfway down the list
  // back to the top every few seconds.
  const viewScope = signature;
  const [pagination, setPagination] = React.useState<{ scope: string; cursors: string[] }>({
    scope: viewScope,
    cursors: [],
  });
  const cursors = pagination.scope === viewScope ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = React.useState(false);
  // Bumped whenever filters are discarded on the operator's behalf, so a text
  // filter with a queued keystroke cannot commit after the discard.
  const [searchResetToken, setSearchResetToken] = React.useState(0);
  const [grouping, setGrouping] = React.useState<EventGrouping>('time');

  // The flat committed filter map, derived from the URL through the same
  // normalisation the request itself uses. Chips and persistence both read it,
  // so a chip can never describe a filter the query did not apply.
  const committedParams = React.useMemo(() => readFilterParams(params), [signature]);
  const rejectedParams = React.useMemo(() => rejectedEventParams(params), [signature]);
  const committedView = React.useMemo<UsageEventsView>(
    () => ({ result: query.result ?? 'all', params: committedParams }),
    [query.result, committedParams],
  );
  const filterCount = activeFilterCount(committedParams);

  /**
   * Every local URL write records its signature first, so the effect below can tell
   * a change this page made from one that arrived from outside it. Without that
   * distinction a keystroke queued behind the debounce would survive a Back or a
   * drill-down and be written onto the view the operator navigated to.
   */
  const selfWrittenSignatureRef = React.useRef<string | null>(null);
  const writeParams = React.useCallback(
    (next: URLSearchParams) => {
      selfWrittenSignatureRef.current = next.toString();
      setParams(next, { replace: true });
    },
    [setParams],
  );

  React.useEffect(() => {
    if (selfWrittenSignatureRef.current === signature) return;
    // A URL this page did not write: history navigation, a drill-down link, or a
    // pasted address. A pending keystroke belongs to the view that was just left.
    setSearchResetToken((value) => value + 1);
  }, [signature]);

  // Full-height scroll-down expansion & top-bounce expand mode & back-to-top
  const listRef = React.useRef<ListyRef>(null);
  const [isCollapsed, setIsCollapsed] = React.useState(false);
  const [isScrolledDown, setIsScrolledDown] = React.useState(false);
  const lastScrollTopRef = React.useRef(0);
  const isNavigatingPageRef = React.useRef(false);
  const justCollapsedFromTopRef = React.useRef(false);
  const pageNavigationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePageNavigationReset = React.useCallback(() => {
    if (pageNavigationTimerRef.current) clearTimeout(pageNavigationTimerRef.current);
    pageNavigationTimerRef.current = setTimeout(() => {
      isNavigatingPageRef.current = false;
      lastScrollTopRef.current = 0;
      setIsScrolledDown(false);
      pageNavigationTimerRef.current = null;
    }, 300);
  }, []);

  React.useEffect(
    () => () => {
      if (pageNavigationTimerRef.current) clearTimeout(pageNavigationTimerRef.current);
    },
    [],
  );

  const handleScroll = React.useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      const { scrollTop } = e.currentTarget;
      lastScrollTopRef.current = scrollTop;

      // Show back-to-top button when scrolled down
      setIsScrolledDown(scrollTop > 60);

      // Following vs. holding. The top of the list is the live edge: at the top
      // the list follows new records, and scrolling away freezes the rows on
      // screen so the reader keeps their place.
      if (scrollTop <= FOLLOW_TOP_PX) {
        if (heldItemsRef.current) setHeldItems(null);
      } else if (scrollTop > HOLD_FROM_PX && !heldItemsRef.current && latestItemsRef.current.length > 0) {
        setHeldItems(latestItemsRef.current);
      }

      // Programmatic scroll-to-top during page change must not cancel collapse
      if (isNavigatingPageRef.current) {
        return;
      }

      // If we just collapsed into full-screen mode from the very top,
      // keep the list pinned at row 1 (scrollTop = 0) so the first record is never skipped
      if (justCollapsedFromTopRef.current) {
        justCollapsedFromTopRef.current = false;
        if (scrollTop > 0) {
          listRef.current?.scrollTo({ top: 0 });
          lastScrollTopRef.current = 0;
        }
        return;
      }

      // Scrolling down collapses header into full-screen mode
      if (scrollTop > 50) {
        if (!isCollapsed) setIsCollapsed(true);
      }
    },
    [isCollapsed],
  );

  // Wheel handling:
  // 1. When at top edge and wheeling down in normal mode: collapse header and keep row 1 visible.
  // 2. When at top edge and wheeling up in collapsed mode: intentional top-bounce overscroll expands header.
  const handleWheel = React.useCallback(
    (e: React.WheelEvent<HTMLElement>) => {
      if (isNavigatingPageRef.current) return;

      if (!isCollapsed && e.deltaY > 10 && lastScrollTopRef.current <= 5) {
        // First wheel down from top: enter full-screen mode, but freeze scroll at top
        // so row 1 stays visible in full screen mode!
        justCollapsedFromTopRef.current = true;
        setIsCollapsed(true);
        listRef.current?.scrollTo({ top: 0 });
        if (e.cancelable) {
          e.preventDefault();
        }
        return;
      }

      if (isCollapsed && e.deltaY < -15 && lastScrollTopRef.current <= 2) {
        // Intentional top-bounce when already at the very top: unfold header
        setIsCollapsed(false);
      }
    },
    [isCollapsed],
  );

  /**
   * Scrolling a virtualized list to row one takes two passes. The first pass
   * lands against the content height the list is holding; committing the new
   * rows then makes it re-measure, and it re-applies the offset it was holding,
   * which leaves a residual scroll of roughly one row's top margin. The second
   * pass lands after that commit.
   */
  const scrollListToTop = React.useCallback(() => {
    listRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0 }));
  }, []);

  const handleBackToTop = React.useCallback(() => {
    scrollListToTop();
    setIsScrolledDown(false);
    setIsCollapsed(false);
    // Resuming is explicit here: the scroll event that follows will also clear
    // it, but the reader clicked "apply", so do not depend on event timing.
    setHeldItems(null);
  }, [scrollListToTop]);

  const handleToggleExpand = React.useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  // Reset collapse only on filter / window changes (NOT cursor pagination, and
  // not on a poll: a refresh must never expand or collapse the reader's view).
  React.useEffect(() => {
    setIsCollapsed(false);
    setIsScrolledDown(false);
  }, [viewScope]);

  // One-time hydration from server preferences when entering bare route without query parameters
  React.useEffect(() => {
    if (!prefReady || hydrated) return;
    setHydrated(true);
    if (viewPref.grouping) setGrouping(viewPref.grouping);
    if (typeof viewPref.autoRefresh === 'boolean') setIsAutoRefresh(viewPref.autoRefresh);

    if (!hasExplicit) {
      const nextParams = new URLSearchParams();
      if (viewPref.from !== undefined) {
        nextParams.set('from', String(viewPref.from));
        if (viewPref.to !== undefined) nextParams.set('to', String(viewPref.to));
      } else if (viewPref.preset && viewPref.preset !== '1h') {
        nextParams.set('preset', viewPref.preset);
      }
      if (viewPref.result && viewPref.result !== 'all') {
        nextParams.set('result', viewPref.result);
      }
      if (viewPref.limit && viewPref.limit !== 100) {
        nextParams.set('limit', String(viewPref.limit));
      }
      if (viewPref.cost && viewPref.cost !== 'all') {
        nextParams.set('cost', viewPref.cost);
      }
      // `cost` is a top-level query field, not a repeated filter dimension, so it
      // travels as its own parameter. It must not also be replayed from the stored
      // filter map, or the URL would carry it twice.
      const storedFilters = filterParamsToUrl({
        ...(viewPref.filterValues ?? {}),
        cost: undefined,
      });
      storedFilters.forEach((value, key) => nextParams.append(key, value));
      if (nextParams.toString()) {
        writeParams(nextParams);
      }
    }
  }, [prefReady, hydrated, hasExplicit, viewPref, writeParams]);

  // Restore the layout preferences even when arriving on a drill-down link.
  React.useEffect(() => {
    if (!prefReady || !hasExplicit) return;
    if (viewPref.grouping) setGrouping(viewPref.grouping);
    if (typeof viewPref.autoRefresh === 'boolean') setIsAutoRefresh(viewPref.autoRefresh);
  }, [prefReady, hasExplicit, viewPref.grouping, viewPref.autoRefresh]);

  /**
   * persistView writes the saved view for the *complete* next state.
   *
   * It used to take partial overrides and fall back to the previous query for
   * anything not mentioned. That is what made a cleared filter come back: the
   * override said `{ model: undefined }`, the fallback then read the model out of
   * the still-old `query`, and the removed value was written straight back into
   * storage. Deriving every field from one normalised state removes the class of
   * bug rather than the instance.
   */
  const persistView = React.useCallback(
    (nextParams: URLSearchParams, overrides?: { grouping?: EventGrouping; autoRefresh?: boolean }) => {
      const nextQuery = readEventQuery(nextParams);
      const nextPref: UsageEventsViewPreference = {
        result: nextQuery.result,
        limit: nextQuery.limit,
        grouping: overrides?.grouping ?? grouping,
        autoRefresh: overrides?.autoRefresh ?? isAutoRefresh,
      };
      if (nextQuery.cost === 'priced' || nextQuery.cost === 'unpriced') nextPref.cost = nextQuery.cost;
      if (nextQuery.from !== undefined) {
        nextPref.from = nextQuery.from;
        if (nextQuery.to !== undefined) nextPref.to = nextQuery.to;
      } else {
        nextPref.preset = nextQuery.preset ?? '1h';
      }
      // The stored filter map excludes `cost` because it is persisted as its own
      // field. Keeping both was a second source of truth that hydration wrote back
      // into the URL a second time.
      const filterValues = queryToFilterParams(nextQuery);
      delete filterValues.cost;
      if (Object.keys(filterValues).length) nextPref.filterValues = filterValues;
      setViewPref(nextPref);
    },
    [grouping, isAutoRefresh, setViewPref],
  );

  /**
   * commit applies a filter change. `values` is the complete next filter map, so
   * a removal is expressed by the key being absent rather than by a sentinel.
   * The change is written to the URL and to the saved view together, which is
   * what keeps a reload equivalent to not having reloaded.
   */
  /**
   * Every local URL write records its signature first, so the effect above can tell
   * a change this page made from one that arrived from outside it.
   */
  const commit = React.useCallback(
    (values: Partial<Record<EventFilterKey, string[]>>, options?: { result?: UsageResultFilter; keepWindow?: boolean }) => {
      const nextParams = new URLSearchParams(params);
      for (const key of EVENT_FILTER_KEYS) nextParams.delete(key);
      filterParamsToUrl(values).forEach((value, key) => nextParams.append(key, value));
      if (options?.result !== undefined) {
        if (options.result === 'all') nextParams.delete('result');
        else nextParams.set('result', options.result);
      }
      writeParams(nextParams);
      persistView(nextParams, { grouping });
    },
    [grouping, params, persistView, writeParams],
  );

  /** setFilter replaces one dimension wholesale. An empty list clears it. */
  const setFilter = React.useCallback(
    (key: EventFilterKey, values: string[]) => {
      const next = { ...committedParams };
      if (values.length) next[key] = values;
      else delete next[key];
      commit(next);
    },
    [commit, committedParams],
  );

  const removeFilterValue = React.useCallback(
    (key: EventFilterKey, value?: string) => {
      const current = committedParams[key] ?? [];
      // Removing the search chip removes the whole filter, so a keystroke still
      // queued behind the debounce must be dropped with it.
      if (key === 'q') setSearchResetToken((token) => token + 1);
      setFilter(key, value === undefined ? [] : current.filter((entry) => entry !== value));
    },
    [committedParams, setFilter],
  );

  const clearFilters = React.useCallback(() => {
    const windowOnly = new URLSearchParams(params);
    for (const key of EVENT_FILTER_KEYS) windowOnly.delete(key);
    windowOnly.delete('result');
    writeParams(windowOnly);
    // Cancels any queued keystroke. The search box's committed value is already
    // empty during a clear, so nothing else would signal that its pending timer
    // must not fire.
    setSearchResetToken((value) => value + 1);
    // Persisted from the URL that is actually being navigated to. Saving the
    // defaults here instead is what reset the operator's window and page size in
    // storage while the URL kept them, so a later reload silently moved them.
    persistView(windowOnly, { grouping });
  }, [grouping, params, persistView, writeParams]);

  const setTimeWindow = React.useCallback(
    (window: { preset?: string; from?: number; to?: number }) => {
      const nextParams = new URLSearchParams(params);
      nextParams.delete('preset');
      nextParams.delete('from');
      nextParams.delete('to');
      if (window.from !== undefined) {
        nextParams.set('from', String(window.from));
        if (window.to !== undefined) nextParams.set('to', String(window.to));
      } else if (window.preset) {
        nextParams.set('preset', window.preset);
      }
      writeParams(nextParams);
      persistView(nextParams, { grouping });
    },
    [grouping, params, persistView, writeParams],
  );

  const [search, setSearch] = useDebouncedSearch(
    committedParams.q?.[0] ?? '',
    (value) => {
      setFilter('q', value ? [value] : []);
    },
    searchResetToken,
  );  const isQueryEnabled = hasExplicit || prefReady;
  const facetParams = usageEventParams(facetWindow);
  const facets = useQuery({
    queryKey: ['usage-facets', facetParams],
    queryFn: async () => {
      const response = await api.getUsageFacets(facetParams);
      // A response missing a facet is treated as a failed load, not as an empty
      // window: an empty dropdown for a dimension that certainly has values is
      // the one way this control can lie about the data.
      if (!isUsageFacetsResponse(response)) {
        throw new Error('usage facets response is incomplete');
      }
      return response;
    },
    enabled: isQueryEnabled,
    placeholderData: keepPreviousData,
    // Facets are the expensive part of the page: one grouped scan per dimension,
    // ten in all. They describe which values exist in a window, so they change
    // only when the window moves - not on every poll - and the cache keeps the
    // dropdowns populated while a poll is in flight.
    staleTime: 5 * 60_000,
  });
  const ingest = useQuery({
    queryKey: ['usage-ingest-status'],
    queryFn: api.getUsageIngestStatus,
    refetchInterval: 15_000,
  });
  const status = ingest.data as IngestStatus | undefined;
  const queryString = usageEventParams({ ...query, ...activeWindow, cursor });
  const result = useQuery({
    queryKey: ['usage-events', queryString, refresh],
    queryFn: () => api.getUsageEvents(queryString),
    enabled: isQueryEnabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });

  const handlePrevPage = React.useCallback(() => {
    if (!cursors.length || result.isFetching) return;
    isNavigatingPageRef.current = true;
    setPagination({ scope: viewScope, cursors: cursors.slice(0, -1) });
    scrollListToTop();
    schedulePageNavigationReset();
  }, [cursors, result.isFetching, schedulePageNavigationReset, scrollListToTop, viewScope]);

  const handleNextPage = React.useCallback(() => {
    if (!result.data?.has_more || !result.data?.next_cursor || result.isFetching || result.isError) return;
    isNavigatingPageRef.current = true;
    setPagination({ scope: viewScope, cursors: [...cursors, result.data.next_cursor] });
    scrollListToTop();
    schedulePageNavigationReset();
  }, [cursors, result.data, result.isFetching, result.isError, schedulePageNavigationReset, scrollListToTop, viewScope]);

  // The poll reads the in-flight state through a ref rather than closing over it.
  // Naming `result.isFetching` in the dependency list rebuilt the timer on every
  // fetch, which reset the interval each time and turned a 10-second poll into
  // "10 seconds after the last response finished" - the cadence the operator
  // asked for is wall-clock, not round-trip dependent.
  const isFetchingRef = React.useRef(false);
  isFetchingRef.current = result.isFetching;
  React.useEffect(() => {
    if (!isAutoRefresh) return;
    const timer = setInterval(() => {
      // A hidden tab is a reader who is not watching, so the poll is skipped
      // instead of spending the gateway's query budget on an unseen list.
      if (document.visibilityState !== 'visible') return;
      // Skipping rather than queueing means a slow query cannot stack up a
      // backlog of polls that all fire the moment it resolves.
      if (isFetchingRef.current) return;
      setRefresh((value) => value + 1);
    }, EVENT_AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isAutoRefresh]);

  const toggleAutoRefresh = React.useCallback(
    (next: boolean) => {
      setIsAutoRefresh(next);
      persistView(params, { grouping, autoRefresh: next });
    },
    [grouping, params, persistView],
  );

  // keepPreviousData covers in-flight changes; retain the last successful page
  // after a failed query too, with an explicit stale-data label.
  const [lastPage, setLastPage] = React.useState<UsageEventPage>();
  React.useEffect(() => {
    if (result.data && !result.isPlaceholderData) setLastPage(result.data);
  }, [result.data, result.isPlaceholderData]);
  const displayedPage = result.data || (result.isError ? lastPage : undefined);

  // A poll is not a view change. `stale` used to flip on every poll, because the
  // sliding window advances each time and that reads as placeholder data; the
  // label and the "updating" note then blinked every few seconds. Compare the
  // identity the reader chose instead - filters plus page - and let the resolved
  // window move underneath it.
  const queryIdentity = `${signature}:${cursor ?? ''}`;
  const [fetchedIdentity, setFetchedIdentity] = React.useState(queryIdentity);
  React.useEffect(() => {
    if (result.data && !result.isPlaceholderData) setFetchedIdentity(queryIdentity);
  }, [result.data, result.isPlaceholderData, queryIdentity]);
  const isViewChange = fetchedIdentity !== queryIdentity;
  const stale = isViewChange || (result.isError && !!lastPage);

  const latestItems = displayedPage?.items;

  // ---- live tail ----
  // While the reader is at the top the list follows the newest records. Once
  // they scroll away it holds the rows they are reading and reports how many
  // have arrived since, the way log viewers do it: applying the update would
  // move text out from under the cursor, and jumping to the top is the worst
  // version of that. Scrolling back to the top resumes and applies the backlog.
  const [heldItems, setHeldItems] = React.useState<UsageEvent[] | null>(null);
  const latestItemsRef = React.useRef<UsageEvent[]>([]);
  latestItemsRef.current = latestItems ?? [];
  const heldItemsRef = React.useRef<UsageEvent[] | null>(null);
  heldItemsRef.current = heldItems;

  // A different view, or a different page, starts following again.
  React.useEffect(() => {
    setHeldItems(null);
  }, [viewScope, cursor]);

  const events = heldItems ?? latestItems ?? [];
  const pendingCount = React.useMemo(() => {
    if (!heldItems || !latestItems) return 0;
    const shown = new Set(heldItems.map((event) => event.id));
    return latestItems.reduce((count, event) => (shown.has(event.id) ? count : count + 1), 0);
  }, [heldItems, latestItems]);

  // Safe file metadata only: never download credential contents for the stream.
  const authFiles = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    staleTime: 60_000,
  });
  const credentials = React.useMemo(
    () => indexCredentialFiles(authFiles.data?.files || []),
    [authFiles.data],
  );
  const { value: providerIcons } = usePreference<Record<string, string>>(
    PROVIDER_ICONS_PREFERENCE,
    EMPTY_PROVIDER_ICONS,
    parseProviderIcons,
  );
  const providersQuery = useQuery({
    // Distinct cache key: this page must never read (or populate) the cache
    // entry that carries plaintext key material for the providers page.
    queryKey: ['management-providers-sanitized'],
    queryFn: () => api.getManagementProviders(false),
    staleTime: 60_000,
  });
  const configuredProviders = providersQuery.data?.providers;

  /**
   * A chip names the dimension and the value it holds, in the operator's words.
   * The credential dimension resolves to a file name and the caller dimension to
   * its readable mask, because the stored value for both is a fingerprint that
   * nobody recognises - but the chip must still remove the value it was given,
   * not the label it displayed.
   */
  const chipLabels: Record<EventFilterKey, string> = {
    model: 'events.filter_chip_model',
    model_alias: 'events.filter_chip_model_alias',
    provider: 'events.filter_chip_provider',
    auth_index: 'events.filter_chip_credential',
    auth_type: 'events.filter_chip_auth_type',
    reasoning: 'events.filter_chip_reasoning',
    service_tier: 'events.filter_chip_service_tier',
    source: 'events.filter_chip_source',
    api_key: 'events.filter_chip_caller',
    executor: 'events.filter_chip_executor',
    q: 'events.filter_chip_search',
    ua: 'events.filter_chip_ua',
    endpoint: 'events.filter_chip_endpoint',
    request_id: 'events.filter_chip_request_id',
    latency_min: 'events.filter_chip_latency_min',
    latency_max: 'events.filter_chip_latency_max',
    tokens_min: 'events.filter_chip_tokens_min',
    tokens_max: 'events.filter_chip_tokens_max',
    cost_min: 'events.filter_chip_cost_min',
    cost_max: 'events.filter_chip_cost_max',
    cost: 'events.filter_chip_cost_state',
  };

  const describeChip = React.useCallback(
    (key: EventFilterKey, values: string[]): { label: string; display?: string } => {
      const raw = values[0] ?? '';
      let shown = raw;
      if (key === 'auth_index') shown = credentials.get(raw)?.name || raw;
      // The caller dimension is stored as a fingerprint, so the chip has to speak
      // the readable mask the facet offered; showing the fingerprint would name
      // the filter in a form the operator never chose and cannot recognise.
      if (key === 'api_key') {
        const facet = facets.data?.facets.api_group_keys.find((entry) => entry.value === raw);
        shown = facet?.mask?.trim() || raw;
      }
      if (key === 'cost') {
        shown = t(raw === 'priced' ? 'events.cost_priced' : 'events.cost_unpriced_short');
      }
      if (key.endsWith('_min') || key.endsWith('_max')) {
        const range = key.replace(/_(min|max)$/, '') as 'latency' | 'tokens' | 'cost';
        shown = range === 'cost' ? `$${raw}` : raw;
      }
      return { label: t(chipLabels[key], { val: shown }) };
    },
    [credentials, facets.data, t],
  );

  const activeFilters = EVENT_FILTER_KEYS.filter((key) => (committedParams[key]?.length ?? 0) > 0);
  // The result verdict is a filter too, but it is not a URL parameter, so it has
  // to be counted separately: a list narrowed to failures with the Reset button
  // hidden would be a filter the operator can only clear by guessing.
  const hasActiveFilter = activeFilters.length > 0 || query.result !== 'all';

  const listHost = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState(480);
  React.useLayoutEffect(() => {
    const host = listHost.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.max(240, Math.floor(entry.contentRect.height))),
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /**
   * Facet options carry the window's request count; `expandProps` was dropped
   * because the count in the label is what makes the option worth reading.
   * A selected value missing from a capped response is re-added, so the control
   * can never render blank while its filter is still applied.
   */
  const facetMulti = (
    key: EventFilterKey,
    labelKey: string,
    values: UsageFacets[keyof UsageFacets] | undefined,
  ) => {
    const selected = committedParams[key] ?? [];
    return (
      <Select
        className="req-facet-select"
        mode="multiple"
        aria-label={t(labelKey)}
        placeholder={t(labelKey)}
        value={selected}
        allowClear
        maxTagCount="responsive"
        showSearch={{ optionFilterProp: 'label' }}
        onChange={(next) => setFilter(key, next as string[])}
        options={mergeFacetOptions(values, selected, usageFacetLabel, (value) =>
          key === 'auth_index' ? `${credentials.get(value)?.name || value} · ${value}` : value,
        )}
        notFoundContent={facets.isError ? t('events.facets_error') : undefined}
      />
    );
  };

  /**
   * Clear-all is offered in two places (the bar and the chip strip) and must
   * mean the same thing in both: filters and result go, the time window and the
   * layout choices stay. Resetting the window too would move the reader to a
   * different hour without saying so.
   */
  const group =
    grouping === 'time'
      ? undefined
      : {
          key: (event: UsageEvent) =>
            grouping === 'provider'
              ? event.provider || t('events.unknown_provider')
              : JSON.stringify([
                  event.provider,
                  event.auth_index || event.source || event.resource_id || 'unknown',
                ]),
          title: (key: React.Key, items: UsageEvent[]) => (
            <div className="request-group-title">
              <strong>
                {grouping === 'provider'
                  ? String(key)
                  : `${items[0].provider || t('events.unknown_provider')} / ${resolveCredential(items[0], credentials).name || t('events.unknown_credential')}`}
              </strong>
              <span>{t('events.record_count', { n: items.length })}</span>
            </div>
          ),
        };
  const ingestTone =
    !status || ingest.isError
      ? 'default'
      : status.enabled === false
        ? 'default'
        : status.healthy === true && !status.collector?.coverage_gaps
          ? 'success'
          : 'warning';
  const ingestLabel =
    !status || ingest.isError
      ? 'events.ingest_unknown'
      : status.enabled === false
        ? 'events.ingest_disabled'
        : ingestTone === 'success'
          ? 'events.ingest_healthy'
          : 'events.ingest_attention';

  return (
    <div className="terminal-page usage-events-page request-events-page">
      <div className={`request-collapsible-header ${isCollapsed ? 'is-collapsed' : ''}`}>
        <header className="terminal-page-head">
          <div>
            <h1 className="terminal-title">{t('events.title')}</h1>
            <p className="request-window">
              {dayjs(activeWindow.from).format('MM-DD HH:mm')} — {dayjs(activeWindow.to).format('MM-DD HH:mm')}
              <Tooltip title={t('events.order_recorded_hint')}>
                <span className="request-order-hint">{t('events.order_recorded')}</span>
              </Tooltip>
            </p>
          </div>
          <div className="request-actions">
            <label className="req-auto-refresh-control" htmlFor="req-auto-refresh">
              {/* The pulse only appears while the poll is actually running, so it
                  means "this list is moving" rather than "this page has a
                  setting". */}
              {isAutoRefresh && <span className="req-live-pulse-dot" aria-hidden="true" />}
              <span className="req-auto-refresh-label">{t('events.auto_refresh')}</span>
              <Switch
                id="req-auto-refresh"
                size="small"
                checked={isAutoRefresh}
                onChange={toggleAutoRefresh}
                aria-label={t('events.auto_refresh')}
              />
              {isAutoRefresh && (
                <span className="req-auto-refresh-cadence">
                  {t('events.auto_refresh_sec', { s: EVENT_AUTO_REFRESH_MS / 1000 })}
                </span>
              )}
            </label>
            <Popover
              trigger="click"
              title={t('events.ingest_status')}
              content={
                <div className="request-ingest">
                  <Descriptions
                    size="small"
                    column={1}
                    items={[
                      {
                        key: 'mode',
                        label: t('events.collector_mode'),
                        children: status?.collector?.mode || '—',
                      },
                      {
                        key: 'captured',
                        label: t('events.captured'),
                        children: status?.collector?.captured ?? '—',
                      },
                      {
                        key: 'gaps',
                        label: t('events.coverage_gaps'),
                        children: status?.collector?.coverage_gaps ?? '—',
                      },
                      { key: 'pending', label: t('events.pending'), children: status?.stats?.pending ?? '—' },
                    ]}
                  />
                  <p>{t('events.delivery_semantics_hint')}</p>
                  {status?.collector?.last_error && <p>{status.collector.last_error}</p>}
                </div>
              }
            >
              <Button type="text" icon={<InfoCircleOutlined />}>
                <Badge status={ingestTone} text={t(ingestLabel)} />
              </Button>
            </Popover>
            {Object.keys(colWidths).length > 0 && (
              <Button
                size="small"
                type="text"
                className="req-reset-columns-btn"
                onClick={handleResetAllColumns}
              >
                {t('events.reset_columns')}
              </Button>
            )}
            <Tooltip title={t(isCollapsed ? 'events.collapse_view' : 'events.expand_view')}>
              <Button
                size="small"
                type="text"
                className="req-expand-toggle-btn"
                aria-label={t(isCollapsed ? 'events.collapse_view' : 'events.expand_view')}
                icon={isCollapsed ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={handleToggleExpand}
              />
            </Tooltip>
            <Button
              aria-label={t('common.refresh')}
              icon={<ReloadOutlined spin={result.isFetching} />}
              disabled={result.isFetching}
              onClick={() => {
                setRefresh((v) => v + 1);
                // A manual refresh re-reads the facet window too: the operator
                // asked to see current data, and stale dropdown counts are part of
                // what is on screen.
                setFacetWindowRevision((v) => v + 1);
                void ingest.refetch();
              }}
            >
              {t('common.refresh')}
            </Button>
          </div>
        </header>
        {rejectedParams.length > 0 && (
          <Alert
            type="warning"
            showIcon
            title={t('events.rejected_filters', { n: rejectedParams.length })}
            description={`${rejectedParams.join(', ')} — ${t('events.rejected_filters_hint')}`}
          />
        )}
        {result.isError && (
          <Alert
            type="error"
            showIcon
            title={t('events.load_error')}
            description={result.error instanceof Error ? result.error.message : undefined}
            action={<Button onClick={() => void result.refetch()}>{t('common.retry')}</Button>}
          />
        )}
        <section className="request-toolbar" aria-label={t('events.filters')}>
          <div className="request-filters">
            <Input
              className="request-search"
              aria-label={t('events.search_hint')}
              placeholder={t('events.search_placeholder')}
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
            />
            <TimeRangeControl
              preset={query.preset}
              from={query.from}
              to={query.to}
              onChange={setTimeWindow}
            />
            <Segmented
              className="req-result-segmented"
              aria-label={t('events.col_result')}
              value={query.result}
              onChange={(value) => {
                const next = value as UsageResultFilter;
                commit(committedParams, { result: next });
              }}
              options={['all', 'success', 'failed'].map((value) => ({
                value,
                label: t(`events.filter_${value}`),
              }))}
            />
            {facetMulti('model', 'events.col_model', facets.data?.facets.models)}
            {facetMulti('provider', 'events.provider', facets.data?.facets.providers)}
            <Button
              className="req-more-filters"
              aria-label={t('events.more_filters')}
              icon={<FilterOutlined />}
              onClick={() => setIsFilterDrawerOpen(true)}
            >
              {t('events.more_filters')}
              {filterCount > 0 ? <span className="req-more-filters-count">{filterCount}</span> : null}
            </Button>
          </div>
          <div className="request-toolbar-bottom">
            {facets.isError && (
              <span className="req-facets-note" role="status">
                {t('events.facets_error')}
              </span>
            )}
            <div className="request-actions">
              {hasActiveFilter && (
                <Button type="text" className="req-reset-filters" onClick={clearFilters}>
                  {t('events.reset')}
                  <span className="req-reset-count">{activeFilters.length || 1}</span>
                </Button>
              )}
              <Select
                aria-label={t('events.group_by')}
                value={grouping}
                onChange={(value) => {
                  const next = value as EventGrouping;
                  setGrouping(next);
                  persistView(params, { grouping: next });
                }}
                options={['time', 'provider', 'credential'].map((value) => ({
                  value,
                  label: t(`events.group_${value}`),
                }))}
              />
            </div>
          </div>
        </section>
        <RequestFilterChips
          committed={committedParams}
          describe={describeChip}
          onRemove={removeFilterValue}
          onClearAll={clearFilters}
        />
        <RequestFilterDrawer
          open={isFilterDrawerOpen}
          onClose={() => setIsFilterDrawerOpen(false)}
          committed={committedView}
          facets={facets.data?.facets}
          facetsFailed={facets.isError}
          credentialName={(authIndex) => credentials.get(authIndex)?.name ?? authIndex}
          onApply={(next) => {
            // Apply replaces every filter dimension, so a keystroke queued in the
            // search box must not land on top of the applied view.
            setSearchResetToken((token) => token + 1);
            commit(next.params, { result: next.result });
            setIsFilterDrawerOpen(false);
          }}
        />
        {authFiles.isError && (
          <div className="request-detail-note" role="status">
            {t('events.credentials_unavailable')}
          </div>
        )}
      </div>
      <section
        className="request-stream"
        aria-label={t('events.title')}
        aria-busy={result.isFetching}
        style={
          {
            '--req-grid-columns': gridTemplate,
            '--req-min-width': `${gridMinWidth}px`,
            '--req-gutter': `${scrollbarGutter}px`,
          } as React.CSSProperties
        }
      >
        <div className="request-table-scroll-area" onWheel={handleWheel}>
          <div className="request-table-header">
            {REQUEST_COLUMNS.map((col) => (
              <div key={col.id} className={`req-th req-th-${col.id}`}>
                <span className="req-th-label">{t(col.labelKey)}</span>
                {col.resizable && (
                  <span
                    className="req-col-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('events.col_resizer')}
                    aria-valuenow={colWidths[col.id] ?? col.defaultWidth}
                    aria-valuemin={col.minWidth}
                    aria-valuemax={col.maxWidth}
                    tabIndex={0}
                    onPointerDown={(e) => handleResizeStart(col.id, e)}
                    onDoubleClick={() => handleResetColumn(col.id)}
                    onKeyDown={(e) => handleResizeKeyDown(col.id, e)}
                  />
                )}
              </div>
            ))}
            <span className="req-th req-th-chevron" />
          </div>
          <div ref={listHost} className="request-list-host">
            {!isQueryEnabled || result.isLoading ? (
              <div className="request-loading">
                <Skeleton active={false} paragraph={{ rows: 8 }} title={false} />
              </div>
            ) : events.length ? (
              <Listy<UsageEvent>
                ref={listRef}
                key={`${viewScope}:${grouping}`}
                virtual
                height={height}
                items={events}
                rowKey="id"
                group={group}
                sticky
                className="request-list"
                onScroll={handleScroll}
                itemRender={(event) => (
                  <RequestRow
                    event={event}
                    credentials={credentials}
                    providerIcons={providerIcons}
                    configuredProviders={configuredProviders}
                    onOpen={setSelected}
                    isSelected={selected === event.id}
                  />
                )}
              />
            ) : !result.isError ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <>
                    <strong>{t('events.empty_title')}</strong>
                    <p>
                      {t(
                        hasActiveFilter ? 'events.empty_filtered' : 'events.empty_hint',
                      )}
                    </p>
                  </>
                }
              />
            ) : (
              <div className="request-empty-error">{t('events.load_error')}</div>
            )}
          </div>
        </div>
        {(isScrolledDown || pendingCount > 0) && (
          <button
            type="button"
            className={`req-back-to-top-btn${pendingCount > 0 ? ' is-live' : ''}`}
            onClick={handleBackToTop}
            aria-label={
              pendingCount > 0 ? t('events.new_records', { n: pendingCount }) : t('events.back_to_top')
            }
          >
            <VerticalAlignTopOutlined className="req-back-to-top-icon" />
            <span className="req-back-to-top-text">
              {pendingCount > 0 ? t('events.new_records', { n: pendingCount }) : t('events.back_to_top')}
            </span>
          </button>
        )}
        <footer className="request-pagination">
          <span aria-live="polite">
            {stale
              ? t('events.previous_results')
              : t('events.page_loaded', { page: cursors.length + 1, n: events.length })}
            {result.isPlaceholderData && ` · ${t('events.updating')}`}
          </span>
          <div className="request-actions">
            <Select
              aria-label={t('events.page_size')}
              value={query.limit}
              onChange={(value) => {
                const nextParams = new URLSearchParams(params);
                if (value === 100) nextParams.delete('limit');
                else nextParams.set('limit', String(value));
                writeParams(nextParams);
                persistView(nextParams, { grouping });
              }}
              options={Array.from(new Set([100, 250, 500, query.limit!]))
                .sort((a, b) => a - b)
                .map((value) => ({ value, label: t('events.per_page', { n: value }) }))}
            />
            <Tooltip title={t('events.prev_page')}>
              <Button
                aria-label={t('events.prev_page')}
                icon={<LeftOutlined />}
                disabled={!cursors.length || result.isFetching}
                onClick={handlePrevPage}
              />
            </Tooltip>
            <Tooltip title={t('events.next_page')}>
              <Button
                aria-label={t('events.next_page')}
                icon={<RightOutlined />}
                disabled={!result.data?.has_more || !result.data?.next_cursor || result.isFetching || result.isError}
                onClick={handleNextPage}
              />
            </Tooltip>
          </div>
        </footer>
      </section>
      <UsageEventDrawer
        credentials={credentials}
        eventId={selected}
        onClose={() => setSelected(null)}
        events={events}
        onSelectEvent={setSelected}
      />
    </div>
  );
};
