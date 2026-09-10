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
  type UsageEvent,
  type UsageEventPage,
  type UsageFacetValue,
  type UsageResultFilter,
} from '../types/usageEvents';
import {
  indexCredentialFiles,
  resolveCredential,
  EVENT_FILTER_KEYS,
  EVENT_PRESETS,
  eventPageMetrics,
  eventWindow,
  formatEventDuration,
  readEventQuery,
  USAGE_EVENTS_VIEW_PREFERENCE,
  DEFAULT_USAGE_EVENTS_VIEW,
  parseUsageEventsView,
  hasExplicitEventQuery,
  usageFacetLabel,
  type UsageEventsViewPreference,
  type EventGrouping,
} from '../types/usageEventView';
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

/** Text filters commit to the URL only after typing pauses: one keystroke
 *  must never fire one list request per character. Used by the request-id
 *  search and the advanced auth_type / model_alias inputs alike. */
function useDebouncedTextFilter(
  queryValue: string,
  update: (values: Record<string, string | undefined>) => void,
  key: 'request_id' | 'auth_type' | 'model_alias',
) {
  const [value, setValue] = React.useState(queryValue);
  React.useEffect(() => setValue(queryValue), [queryValue]);
  React.useEffect(() => {
    if (value.trim() === queryValue) return;
    const timer = setTimeout(() => update({ [key]: value.trim() }), 350);
    return () => clearTimeout(timer);
  }, [value, queryValue, update, key]);
  return [value, setValue] as const;
}

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
  const [autoRefreshInterval, setAutoRefreshInterval] = React.useState<number>(0);
  const activeWindow = React.useMemo(() => eventWindow(query, Date.now()), [query, refresh]);
  const scope = `${signature}:${refresh}`;
  const [pagination, setPagination] = React.useState<{ scope: string; cursors: string[] }>({
    scope,
    cursors: [],
  });
  const cursors = pagination.scope === scope ? pagination.cursors : [];
  const cursor = cursors.at(-1);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [advanced, setAdvanced] = React.useState(false);
  const [grouping, setGrouping] = React.useState<EventGrouping>('time');

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

  const handleBackToTop = React.useCallback(() => {
    listRef.current?.scrollTo({ top: 0 });
    setIsScrolledDown(false);
    setIsCollapsed(false);
  }, []);

  const handleToggleExpand = React.useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  // Reset collapse only on filter / signature changes (NOT cursor pagination)
  React.useEffect(() => {
    setIsCollapsed(false);
    setIsScrolledDown(false);
  }, [signature, refresh]);

  // One-time hydration from server preferences when entering bare route without query parameters
  React.useEffect(() => {
    if (!prefReady || hydrated) return;
    setHydrated(true);
    if (viewPref.grouping) setGrouping(viewPref.grouping);
    if (typeof viewPref.advanced === 'boolean') setAdvanced(viewPref.advanced);

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
      for (const key of EVENT_FILTER_KEYS) {
        if (viewPref[key]) nextParams.set(key, viewPref[key]!);
      }
      if (nextParams.toString()) {
        setParams(nextParams, { replace: true });
      }
    }
  }, [prefReady, hydrated, hasExplicit, viewPref, setParams]);

  // Restore grouping/advanced layout preferences even when on a drill-down link
  React.useEffect(() => {
    if (!prefReady || !hasExplicit) return;
    if (viewPref.grouping) setGrouping(viewPref.grouping);
    if (typeof viewPref.advanced === 'boolean') setAdvanced(viewPref.advanced);
  }, [prefReady, hasExplicit, viewPref.grouping, viewPref.advanced]);

  const persistView = React.useCallback(
    (overrides?: Partial<UsageEventsViewPreference>) => {
      const nextPref: UsageEventsViewPreference = {
        result: query.result,
        limit: query.limit,
        grouping,
        advanced,
        ...overrides,
      };
      if (overrides?.from !== undefined || (query.from !== undefined && overrides?.preset === undefined)) {
        nextPref.from = overrides?.from ?? query.from;
        nextPref.to = overrides?.to ?? query.to;
        delete nextPref.preset;
      } else {
        nextPref.preset = overrides?.preset ?? query.preset ?? '1h';
        delete nextPref.from;
        delete nextPref.to;
      }
      for (const key of EVENT_FILTER_KEYS) {
        const val = overrides?.[key] !== undefined ? overrides[key] : query[key];
        if (val) nextPref[key] = val;
      }
      setViewPref(nextPref);
    },
    [query, grouping, advanced, setViewPref],
  );

  const update = React.useCallback(
    (values: Record<string, string | undefined>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(values)) {
            if (!value) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
      const nextQuery: Partial<UsageEventsViewPreference> = {};
      for (const [key, value] of Object.entries(values)) {
        if (!value) {
          (nextQuery as Record<string, unknown>)[key] = undefined;
        } else if (key === 'limit') {
          nextQuery.limit = Number(value);
        } else if (key === 'result') {
          nextQuery.result = value as UsageResultFilter;
        } else if (key === 'from') {
          nextQuery.from = Number(value);
        } else if (key === 'to') {
          nextQuery.to = Number(value);
        } else {
          (nextQuery as Record<string, unknown>)[key] = value;
        }
      }
      persistView(nextQuery);
    },
    [persistView, setParams],
  );
  const [search, setSearch] = useDebouncedTextFilter(query.request_id || '', update, 'request_id');
  const [authType, setAuthType] = useDebouncedTextFilter(query.auth_type || '', update, 'auth_type');
  const [modelAlias, setModelAlias] = useDebouncedTextFilter(query.model_alias || '', update, 'model_alias');
  const isQueryEnabled = hasExplicit || prefReady;
  const facetParams = usageEventParams(activeWindow);
  const facets = useQuery({
    queryKey: ['usage-facets', facetParams, refresh],
    queryFn: () => api.getUsageFacets(facetParams),
    enabled: isQueryEnabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
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
    staleTime: 10_000,
  });

  const handlePrevPage = React.useCallback(() => {
    if (!cursors.length || result.isFetching) return;
    isNavigatingPageRef.current = true;
    setPagination({ scope, cursors: cursors.slice(0, -1) });
    listRef.current?.scrollTo({ top: 0 });
    schedulePageNavigationReset();
  }, [cursors, result.isFetching, schedulePageNavigationReset, scope]);

  const handleNextPage = React.useCallback(() => {
    if (!result.data?.has_more || !result.data?.next_cursor || result.isFetching || result.isError) return;
    isNavigatingPageRef.current = true;
    setPagination({ scope, cursors: [...cursors, result.data.next_cursor] });
    listRef.current?.scrollTo({ top: 0 });
    schedulePageNavigationReset();
  }, [cursors, result.data, result.isFetching, result.isError, schedulePageNavigationReset, scope]);

  React.useEffect(() => {
    if (!autoRefreshInterval) return;
    const intervalMs = autoRefreshInterval * 1000;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !result.isFetching) {
        setRefresh((v) => v + 1);
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [autoRefreshInterval, result.isFetching]);

  // keepPreviousData covers in-flight changes; retain the last successful page
  // after a failed query too, with an explicit stale-data label.
  const [lastPage, setLastPage] = React.useState<UsageEventPage>();
  React.useEffect(() => {
    if (result.data && !result.isPlaceholderData) setLastPage(result.data);
  }, [result.data, result.isPlaceholderData]);
  const displayedPage = result.data || (result.isError ? lastPage : undefined);
  const stale = result.isPlaceholderData || (result.isError && !!lastPage);
  const events = displayedPage?.items || [];
  const metrics = eventPageMetrics(events);

  const totalCostUSD = React.useMemo(() => {
    let sum = 0;
    let hasAny = false;
    for (const ev of events) {
      if (ev.cost_usd != null) {
        sum += ev.cost_usd;
        hasAny = true;
      }
    }
    return hasAny ? sum : null;
  }, [events]);

  const successCount = Math.max(0, metrics.count - metrics.failed);
  const successRate = metrics.count > 0 ? (successCount / metrics.count) * 100 : 100;
  const successRateStr = metrics.count > 0 ? `${successRate.toFixed(1)}%` : '—';
  const successTone = successRate < 95 ? 'danger' : successRate < 99 ? 'warn' : 'success';

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
  const activeFilters = EVENT_FILTER_KEYS.filter((key) => query[key]);
  const extraCount = activeFilters.filter((key) => !['model', 'provider', 'request_id'].includes(key)).length;

  const activeChips = React.useMemo(() => {
    const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];
    if (query.model) {
      chips.push({
        key: 'model',
        label: t('events.filter_chip_model', { val: query.model }),
        onRemove: () => update({ model: undefined }),
      });
    }
    if (query.provider) {
      chips.push({
        key: 'provider',
        label: t('events.filter_chip_provider', { val: query.provider }),
        onRemove: () => update({ provider: undefined }),
      });
    }
    if (query.source) {
      chips.push({
        key: 'source',
        label: t('events.filter_chip_source', { val: query.source }),
        onRemove: () => update({ source: undefined }),
      });
    }
    if (query.auth_index) {
      const credName = credentials.get(query.auth_index)?.name || query.auth_index;
      chips.push({
        key: 'auth_index',
        label: t('events.filter_chip_credential', { val: credName }),
        onRemove: () => update({ auth_index: undefined }),
      });
    }
    if (query.api_key) {
      chips.push({
        key: 'api_key',
        label: t('events.filter_chip_caller', { val: query.api_key }),
        onRemove: () => update({ api_key: undefined }),
      });
    }
    if (query.executor) {
      chips.push({
        key: 'executor',
        label: t('events.filter_chip_executor', { val: query.executor }),
        onRemove: () => update({ executor: undefined }),
      });
    }
    if (search) {
      chips.push({
        key: 'search',
        label: t('events.filter_chip_search', { val: search }),
        onRemove: () => setSearch(''),
      });
    }
    if (authType) {
      chips.push({
        key: 'auth_type',
        label: t('events.filter_chip_auth_type', { val: authType }),
        onRemove: () => setAuthType(''),
      });
    }
    if (modelAlias) {
      chips.push({
        key: 'model_alias',
        label: t('events.filter_chip_model_alias', { val: modelAlias }),
        onRemove: () => setModelAlias(''),
      });
    }
    return chips;
  }, [query, search, authType, modelAlias, credentials, t, update, setSearch, setAuthType, setModelAlias]);
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
  const options = (values: UsageFacetValue[] | undefined) =>
    (values || []).map((v) => ({ value: v.value, label: usageFacetLabel(v) }));
  const facet = (
    key: 'model' | 'provider' | 'source' | 'auth_index' | 'api_key' | 'executor',
    label: string,
    values?: UsageFacetValue[],
  ) => (
    <Select
      aria-label={label}
      placeholder={label}
      value={query[key]}
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      onChange={(value) => update({ [key]: value })}
      options={
        key === 'auth_index'
          ? options(values).map((option) => ({
              ...option,
              label: credentials.get(option.value)?.name
                ? `${credentials.get(option.value)!.name} · ${option.value}`
                : option.label,
            }))
          : options(values)
      }
    />
  );
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
            </p>
          </div>
          <div className="request-actions">
            <div className="req-auto-refresh-control">
              {autoRefreshInterval > 0 && (
                <span className="req-live-pulse-dot" title={t('events.auto_refreshing')} />
              )}
              <Select
                className="req-auto-refresh-select"
                aria-label={t('events.auto_refresh')}
                value={autoRefreshInterval}
                onChange={setAutoRefreshInterval}
                options={[
                  { value: 0, label: `${t('events.auto_refresh')}: ${t('events.auto_refresh_off')}` },
                  { value: 5, label: `${t('events.auto_refresh')}: ${t('events.auto_refresh_sec', { s: 5 })}` },
                  { value: 10, label: `${t('events.auto_refresh')}: ${t('events.auto_refresh_sec', { s: 10 })}` },
                  { value: 30, label: `${t('events.auto_refresh')}: ${t('events.auto_refresh_sec', { s: 30 })}` },
                ]}
              />
            </div>
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
            <Button
              aria-label={t('common.refresh')}
              icon={<ReloadOutlined spin={result.isFetching} />}
              disabled={result.isFetching}
              onClick={() => {
                setRefresh((v) => v + 1);
                void ingest.refetch();
              }}
            >
              {t('common.refresh')}
            </Button>
          </div>
        </header>
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
              aria-label={t('events.col_request_id')}
              placeholder={t('events.search_hint')}
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
            />
            <Select
              aria-label={t('events.time_range')}
              value={query.from !== undefined ? 'custom' : query.preset}
              onChange={(value) => update({ preset: value, from: undefined, to: undefined })}
              options={[
                ...(query.from !== undefined ? [{ value: 'custom', label: t('events.custom_range') }] : []),
                ...Object.keys(EVENT_PRESETS).map((value) => ({
                  value,
                  label: t('events.last_range', { range: value }),
                })),
              ]}
            />
            {facet('model', t('events.col_model'), facets.data?.facets.models)}
            {facet('provider', t('events.provider'), facets.data?.facets.providers)}
            <Button
              aria-label={t('events.more_filters')}
              icon={<FilterOutlined />}
              aria-expanded={advanced}
              onClick={() => {
                const next = !advanced;
                setAdvanced(next);
                persistView({ advanced: next });
              }}
            >
              {t('events.more_filters')}
              {extraCount > 0 ? ` (${extraCount})` : ''}
            </Button>
          </div>
          {advanced && (
            <div className="request-advanced">
              {facet('source', t('events.source'), facets.data?.facets.sources)}
              {facet('auth_index', t('events.credential_filter'), facets.data?.facets.auth_indexes)}
              {facet('api_key', t('events.caller'), facets.data?.facets.api_group_keys)}
              {facet('executor', t('events.executor'), facets.data?.facets.executors)}
              <Input
                aria-label={t('events.auth_type')}
                placeholder={t('events.auth_type')}
                value={authType}
                allowClear
                onChange={(e) => setAuthType(e.target.value)}
              />
              <Input
                aria-label={t('events.model_alias')}
                placeholder={t('events.model_alias')}
                value={modelAlias}
                allowClear
                onChange={(e) => setModelAlias(e.target.value)}
              />
              {facets.isError && <span role="status">{t('events.facets_error')}</span>}
            </div>
          )}
          <div className="request-toolbar-bottom">
            <Segmented
              aria-label={t('events.col_result')}
              value={query.result}
              onChange={(value) => update({ result: value === 'all' ? undefined : String(value) })}
              options={['all', 'success', 'failed'].map((value) => ({
                value,
                label: t(`events.filter_${value}`),
              }))}
            />
            <div className="request-actions">
              {(activeFilters.length > 0 ||
                query.result !== 'all' ||
                query.preset !== '1h' ||
                query.from !== undefined ||
                Boolean(search) ||
                Boolean(authType) ||
                Boolean(modelAlias)) && (
                <Button
                  type="text"
                  onClick={() => {
                    setSearch('');
                    setAuthType('');
                    setModelAlias('');
                    setParams({}, { replace: true });
                    setViewPref({
                      ...DEFAULT_USAGE_EVENTS_VIEW,
                      grouping,
                      advanced,
                    });
                  }}
                >
                  {t('events.reset')}
                  {activeFilters.length ? ` (${activeFilters.length})` : ''}
                </Button>
              )}
              <Select
                aria-label={t('events.group_by')}
                value={grouping}
                onChange={(value) => {
                  const next = value as EventGrouping;
                  setGrouping(next);
                  persistView({ grouping: next });
                }}
                options={['time', 'provider', 'credential'].map((value) => ({
                  value,
                  label: t(`events.group_${value}`),
                }))}
              />
            </div>
          </div>
        </section>
        {activeChips.length > 0 && (
          <div className="req-active-chips-bar" aria-label={t('events.active_filters')}>
            <span className="req-active-chips-label">{t('events.active_filters')}:</span>
            <div className="req-active-chips-list">
              {activeChips.map((chip) => (
                <span key={chip.key} className="req-filter-chip">
                  <span className="req-filter-chip-text">{chip.label}</span>
                  <button
                    type="button"
                    className="req-filter-chip-remove"
                    onClick={chip.onRemove}
                    aria-label={`${t('common.delete')}: ${chip.label}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <Button
                size="small"
                type="link"
                className="req-clear-all-chips"
                onClick={() => {
                  setSearch('');
                  setAuthType('');
                  setModelAlias('');
                  setParams({}, { replace: true });
                  setViewPref({
                    ...DEFAULT_USAGE_EVENTS_VIEW,
                    grouping,
                    advanced,
                  });
                }}
              >
                {t('events.clear_all')}
              </Button>
            </div>
          </div>
        )}
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
        <div className="request-summary">
          <div className="req-kpi-item">
            <span className="req-kpi-label">{t(stale ? 'events.previous_results' : 'events.this_page')}</span>
            <div className="req-kpi-val">
              <strong>
                {result.isLoading ? '—' : metrics.count.toLocaleString()}{' '}
                <small>{t('events.requests_unit')}</small>
              </strong>
            </div>
          </div>

          <div className="req-kpi-divider" />

          <div className="req-kpi-item">
            <span className="req-kpi-label">{t('events.success_rate')}</span>
            <div className="req-kpi-rate-content">
              <span className={`req-rate-pip is-${metrics.count === 0 ? 'neutral' : successTone}`} />
              <div className="req-kpi-val">
                <strong>{result.isLoading ? '—' : successRateStr}</strong>
              </div>
              <span className="req-kpi-sub-failed">
                ({t('events.filter_failed')}: <b>{result.isLoading ? '—' : metrics.failed}</b>)
              </span>
            </div>
          </div>

          <div className="req-kpi-divider" />

          <div className="req-kpi-item">
            <span className="req-kpi-label">{t('events.mean_latency')}</span>
            <div className="req-kpi-val">
              <strong>{result.isLoading ? '—' : formatEventDuration(metrics.latency)}</strong>
            </div>
          </div>

          <div className="req-kpi-divider" />

          <div className="req-kpi-item">
            <span className="req-kpi-label">{t('events.col_tokens')}</span>
            <div className="req-kpi-val">
              <strong>{result.isLoading ? '—' : metrics.tokens.toLocaleString()}</strong>
            </div>
          </div>

          {totalCostUSD != null && (
            <>
              <div className="req-kpi-divider" />
              <div className="req-kpi-item">
                <span className="req-kpi-label">{t('events.total_cost')}</span>
                <div className="req-kpi-val">
                  <strong>${totalCostUSD.toFixed(4)}</strong>
                </div>
              </div>
            </>
          )}

          {Object.keys(colWidths).length > 0 && (
            <Button
              size="small"
              type="dashed"
              className="req-reset-columns-btn"
              onClick={handleResetAllColumns}
            >
              {t('events.reset_columns')}
            </Button>
          )}

          <Button
            size="small"
            type="text"
            className="req-expand-toggle-btn"
            aria-label={t(isCollapsed ? 'events.collapse_view' : 'events.expand_view')}
            icon={isCollapsed ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            onClick={handleToggleExpand}
          />
        </div>
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
                key={`${scope}:${grouping}`}
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
                        activeFilters.length || query.result !== 'all'
                          ? 'events.empty_filtered'
                          : 'events.empty_hint',
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
        {isScrolledDown && (
          <button
            type="button"
            className="req-back-to-top-btn"
            onClick={handleBackToTop}
            aria-label={t('events.back_to_top')}
          >
            <VerticalAlignTopOutlined className="req-back-to-top-icon" />
            <span className="req-back-to-top-text">{t('events.back_to_top')}</span>
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
              onChange={(value) => update({ limit: String(value) })}
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
