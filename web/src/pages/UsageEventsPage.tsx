import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
  Input,
  Listy,
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
  EVENT_FILTER_KEYS,
  activeFilterCount,
  eventWindow,
  filterParamsToUrl,
  hasExplicitEventQuery,
  mergeFacetOptions,
  readEventQuery,
  readFilterParams,
  rejectedEventParams,
  type EventFilterKey,
} from '../types/usageEventQuery';
import {
  DEFAULT_USAGE_EVENTS_VIEW,
  EVENT_GROUPING_VALUES,
  USAGE_EVENTS_VIEW_PREFERENCE,
  parseUsageEventsView,
  type EventGrouping,
  type UsageEventsViewPreference,
} from '../types/usageEventViewPreference';
import { createProviderNameResolver, indexCredentialFiles } from '../types/usageEventIdentity';
import { providerFacetLabel, usageFacetLabel } from '../types/usageEventLabels';
import {
  UNKNOWN_EVENT_GROUP,
  eventCredentialIdentity,
  eventProviderIdentity,
  eventUserAgentGroupKey,
  formatEventSourceGroupTitle,
  providersWithMultipleAuthSources,
} from '../types/usageEventGrouping';
import type { UsageEventsView } from '../types/usageEventFilters';
import {
  applyTimeWindow,
  clearAllFilters,
  mergeFilters,
  replaceFilters,
  viewPreferenceFromUrl,
} from '../types/usageEventViewActions';
import { useDebouncedSearch } from '../components/usage/useDebouncedSearch';
import { useRequestColumnLayout } from '../components/usage/useRequestColumnLayout';
import { useRequestListScroll } from '../components/usage/useRequestListScroll';
import { useUsageEventSync } from '../components/usage/useUsageEventSync';
import { isListStale, isViewChange } from '../components/usage/pollingPolicy';
import { chipDisplayValue } from '../components/usage/chipDisplay';
import {
  REQUEST_COLUMNS,
  requestColumnAlignClass,
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
import { ResultMarker } from '../components/usage/ResultMarker';
import { TimeRangeControl } from '../components/usage/TimeRangeControl';
import './UsageEventsPage.css';

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
    colWidths,
    gridTemplate,
    gridMinWidth,
    scrollbarGutter,
    hasCustomWidths,
    handleResizeStart,
    handleResetColumn,
    handleResetAllColumns,
    handleResizeKeyDown,
  } = useRequestColumnLayout();

  // Initial URL check: did the user enter with explicit query params (e.g. from dashboard drill-down)?
  const initialParamsRef = React.useRef(params);
  const hasExplicit = React.useMemo(() => hasExplicitEventQuery(initialParamsRef.current), []);
  const [hydrated, setHydrated] = React.useState(hasExplicit);

  const [isAutoRefresh, setIsAutoRefresh] = React.useState(false);
  // The sync hook's poll reads the list's in-flight state through this ref rather
  // than closing over it; the interval it installs explains why the dependency
  // list cannot name the flag.
  const isFetchingRef = React.useRef(false);
  const {
    ingest,
    status,
    isSyncing,
    facetWindow,
    facetRevision,
    refresh,
    handleManualRefresh,
  } = useUsageEventSync({ query, isAutoRefresh, isFetchingRef });
  const activeWindow = React.useMemo(() => eventWindow(query, Date.now()), [query, refresh]);


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
  const liveEdge = useRequestListScroll({ viewScope, cursor });
  const {
    listRef,
    isCollapsed,
    isScrolledDown,
    observeLatest,
    pendingArrivals,
    markPageNavigation,
    handleScroll,
    handleWheel,
    handleBackToTop,
    handleToggleExpand,
    scrollListToTop,
    schedulePageNavigationReset,
  } = liveEdge;
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
      // The saved view is derived from the URL that is actually being navigated to.
      // Deriving every field from one normalised state - rather than merging the
      // changed fields into the previous query - is what stops a cleared filter from
      // being read back out of the query it was removed from and reappearing on the
      // next visit. See `viewPreferenceFromUrl`.
      setViewPref(
        viewPreferenceFromUrl(nextParams, {
          grouping: overrides?.grouping ?? grouping,
          autoRefresh: overrides?.autoRefresh ?? isAutoRefresh,
        }),
      );
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
      // The rewrite is defined in `usageEventViewActions`: every filter dimension is
      // replaced wholesale so a removal is expressible, while the window, page size
      // and cursor are left alone.
      const nextParams = replaceFilters(params, values, { result: options?.result });
      writeParams(nextParams);
      persistView(nextParams, { grouping });
    },
    [grouping, params, persistView, writeParams],
  );

  /** setFilter replaces one dimension wholesale. An empty list clears it. */
  const setFilter = React.useCallback(
    (key: EventFilterKey, values: string[]) => {
      commit(mergeFilters(committedParams, key, values));
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
    // Filters and the verdict go; the window, page size and cursor stay. Reset the
    // window too and the reader is silently moved to a different hour.
    const windowOnly = clearAllFilters(params);
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
      const nextParams = applyTimeWindow(params, window);
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
    queryKey: ['usage-facets', facetParams, facetRevision],
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
  // While the reader is holding rows, ask the server how much has been recorded
  // since the newest row id they are holding. The anchor is an id rather than a
  // timestamp because the list is sorted by request time: the records ingested
  // most recently are not the ones at the top, so "new" has to be asked as
  // "recorded after what I can see". The count is scoped to the same filters and
  // window as the list, and only adds `arrived_count` to the response - it never
  // changes which rows come back, so the reader's place is untouched.
  //
  // A held page always contains the rows the reader was looking at, so the
  // boundary is derivable on any page, not just the first.
  const queryString = usageEventParams({ ...query, ...activeWindow, cursor, since: liveEdge.heldBoundaryID });
  const result = useQuery({
    queryKey: ['usage-events', queryString, refresh],
    queryFn: () => api.getUsageEvents(queryString),
    enabled: isQueryEnabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  // Assigned after the read it describes, so the poll's interval always observes
  // the latest value without naming it in its dependency list.
  isFetchingRef.current = result.isFetching;

  const handlePrevPage = React.useCallback(() => {
    if (!cursors.length || result.isFetching) return;
    markPageNavigation();
    setPagination({ scope: viewScope, cursors: cursors.slice(0, -1) });
    scrollListToTop();
    schedulePageNavigationReset();
  }, [cursors, markPageNavigation, result.isFetching, schedulePageNavigationReset, scrollListToTop, viewScope]);

  const handleNextPage = React.useCallback(() => {
    if (!result.data?.has_more || !result.data?.next_cursor || result.isFetching || result.isError) return;
    markPageNavigation();
    setPagination({ scope: viewScope, cursors: [...cursors, result.data.next_cursor] });
    scrollListToTop();
    schedulePageNavigationReset();
  }, [cursors, markPageNavigation, result.data, result.isFetching, result.isError, schedulePageNavigationReset, scrollListToTop, viewScope]);

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
  const stale = isListStale({
    isViewChange: isViewChange(fetchedIdentity, queryIdentity),
    isError: result.isError,
    hasLastPage: !!lastPage,
  });

  const latestItems = displayedPage?.items;
  observeLatest(latestItems);
  const events = liveEdge.heldItems ?? latestItems ?? [];
  const pendingCount = pendingArrivals(result.data?.arrived_count);

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
  // Resolves CPA's stored provider key to the name the operator configured, so
  // the filter names a line the same way the providers page does.
  const providerName = React.useMemo(
    () => createProviderNameResolver(configuredProviders),
    [configuredProviders],
  );

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
      // Which value to show is decided in `chipDisplay`: the stored value is a
      // fingerprint for the credential and caller dimensions and a provider key for
      // the provider dimension, and each resolves to the form the operator
      // recognises. The sentence around it stays in the dictionary.
      const shown = chipDisplayValue({
        key,
        value: values[0] ?? '',
        credentialNames: new Map(
          [...credentials].map(([index, file]) => [index, file?.name] as const),
        ),
        callerFacets: facets.data?.facets.api_group_keys,
        resolveProviderName: providerName,
        costLabels: {
          priced: t('events.cost_priced'),
          unpriced: t('events.cost_unpriced_short'),
        },
      });
      return { label: t(chipLabels[key], { val: shown }) };
    },
    [credentials, facets.data, t, providerName],
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
        options={mergeFacetOptions(
          values,
          selected,
          // The provider dimension is stored as CPA's key, so it is labelled with
          // the operator's own name for that line; the value stays the key.
          key === 'provider'
            ? (entry) => providerFacetLabel(providerName(entry.value), entry.requests)
            : usageFacetLabel,
          (value) =>
            key === 'provider'
              ? providerName(value)
              : key === 'auth_index'
                ? `${credentials.get(value)?.name || value} · ${value}`
                : value,
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
  /**
   * One source grouping replaces what used to be two.
   *
   * "By provider" and "by auth source" were the same axis read at two zoom
   * levels, so the merged mode buckets on provider plus credential and then
   * decides per provider whether the credential half is worth printing: a line
   * that served every request through one credential gains nothing from
   * repeating it, while a line split across two must name them or both buckets
   * read as the same source.
   */
  const unknownProviderLabel = t('events.unknown_provider');
  const unknownCredentialLabel = t('events.unknown_credential');
  const multipleAuthSources = React.useMemo(
    () => providersWithMultipleAuthSources(events, credentials, providerName, unknownProviderLabel),
    [credentials, events, providerName, unknownProviderLabel],
  );

  const group =
    grouping === 'time'
      ? undefined
      : {
          key: (event: UsageEvent) => {
            if (grouping === 'ua') return eventUserAgentGroupKey(event);
            const provider = eventProviderIdentity(event, providerName, unknownProviderLabel).key;
            const credential = eventCredentialIdentity(event, credentials, unknownCredentialLabel).key;
            return JSON.stringify([provider, credential]);
          },
          title: (_key: React.Key, items: UsageEvent[]) => {
            if (grouping === 'ua') {
              const label = eventUserAgentGroupKey(items[0]);
              return (
                <div className="request-group-title">
                  <strong>
                    {label === UNKNOWN_EVENT_GROUP ? t('events.unknown_ua') : items[0].user_agent?.trim()}
                  </strong>
                  <span>{t('events.record_count', { n: items.length })}</span>
                </div>
              );
            }
            const provider = eventProviderIdentity(items[0], providerName, unknownProviderLabel);
            const credential = eventCredentialIdentity(items[0], credentials, unknownCredentialLabel);
            return (
              <div className="request-group-title">
                <strong>
                  {formatEventSourceGroupTitle(
                    provider.label,
                    credential.label,
                    multipleAuthSources.has(provider.key),
                  )}
                </strong>
                <span>{t('events.record_count', { n: items.length })}</span>
              </div>
            );
          },
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
              <Button type="text">
                <Badge status={ingestTone} text={t(ingestLabel)} />
              </Button>
            </Popover>
            {hasCustomWidths && (
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
              icon={<ReloadOutlined spin={isSyncing || result.isFetching} />}
              disabled={isSyncing}
              onClick={handleManualRefresh}
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
              options={(['all', 'success', 'failed'] as const).map((value) => ({
                value,
                // The marker reuses the Result column's own vocabulary, so
                // "success" and "failed" mean the same thing in the filter and
                // in the list it filters. 'all' gets none: it is the absence of
                // a verdict, and two bullets would read as a third outcome.
                label: (
                  <span className="req-result-option">
                    {value !== 'all' && <ResultMarker kind={value} />}
                    {t(`events.filter_${value}`)}
                  </span>
                ),
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
                options={EVENT_GROUPING_VALUES.map((value) => ({
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
          providerName={providerName}
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
              <div
                key={col.id}
                className={`req-th req-th-${col.id} ${requestColumnAlignClass(col.id)}`}
              >
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
