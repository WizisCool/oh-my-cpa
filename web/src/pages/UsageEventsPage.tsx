import type { MessageKey } from '../i18n/catalog';
import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { StatusDot } from '@/components/ui/badge';
import clsx from 'clsx';
import { TablePlaceholder } from '../components/common/ContentPlaceholder';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dayjs from '../utils/time';
import { api } from '../api/client';
import { useT } from '../i18n';
import {
  usageEventParams,
  isUsageFacetsResponse,
  parseUsageRegex,
  type UsageEvent,
  type UsageEventPage,
} from '../types/usageEvents';
import {
  EVENT_FILTER_KEYS,
  eventWindow,
  eventWindowQuery,
  type EventFilterKey,
} from '../types/usageEventQuery';
import { createProviderNameResolver, credentialOptionLabel } from '../types/usageEventIdentity';
import {
  UNKNOWN_EVENT_GROUP,
  eventCredentialIdentity,
  eventProviderIdentity,
  eventUserAgentGroupKey,
  formatEventSourceGroupTitle,
  providersWithMultipleAuthSources,
} from '../types/usageEventGrouping';
import { useRequestColumnLayout } from '../components/usage/useRequestColumnLayout';
import { useUsageEventViewState } from '../components/usage/useUsageEventViewState';
import { RequestBackToTop, RequestCollapsibleHeader, RequestFoldToggle } from '../components/usage/RequestFoldControls';
import { RequestVirtualList, type RequestGroupConfig } from '../components/usage/RequestVirtualList';
import { useRequestListScroll } from '../components/usage/useRequestListScroll';
import { useUsageEventSync } from '../components/usage/useUsageEventSync';
import { isListStale, isViewChange } from '../components/usage/pollingPolicy';
import { chipDisplayValue } from '../components/usage/chipDisplay';
import { RequestRow } from '../components/usage/RequestRow';
import { RequestTooltipLayer } from '../components/usage/RequestTooltip';
import { useProviderBranding } from '../hooks/useProviderBranding';
import { UsageEventDrawer } from '../components/usage/UsageEventDrawer';
import { RequestFilterDrawer } from '../components/usage/RequestFilterDrawer';
import { RequestFilterChips } from '../components/usage/RequestFilterChips';
import { RequestPagination } from '../components/usage/RequestPagination';
import { RequestStreamHeader } from '../components/usage/RequestStreamHeader';
import { REGEX_FIELD_LABELS } from '../components/usage/RequestFilterDrawer';
import { createFacetMarkRenderer } from '../components/usage/RequestFacetMark';
import { RequestSelectionBar } from '../components/usage/RequestSelectionBar';
import { RequestExportDialog } from '../components/usage/RequestExportDialog';
import {
  loadedSelectionState,
  setLoadedSelection,
  toggleSelection,
} from '../components/usage/requestSelection';
import { RequestToolbar } from '../components/usage/RequestToolbar';
import './UsageEventsPage.css';
import { RefreshButton } from '../components/common/RefreshButton';
import { ToolButton } from '../components/common/ToolButton';
import type { SelectionAnchor } from '../types/rowSelection';
import { CheckSquareOutlined } from '../components/icons';
import { LoadFailure, Notice } from '../components/feedback';
import { EmptyState } from '../components/common/EmptyState';
import { FactList } from '../components/common/FactList';

export const UsageEventsPage: React.FC = () => {
  useTimeZone();
  const t = useT();
  const {
    signature,
    query,
    committedParams,
    rejectedParams,
    committedView,
    filterCount,
    search,
    setSearch,
    grouping,
    changeGrouping,
    commit,
    setFilter,
    removeFilterValue,
    clearFilters,
    setTimeWindow,
    setResult,
    setPageSize,
    resetSearchQueue,
    isEnabled,
  } = useUsageEventViewState();

  // The records picked for export, kept as the rows themselves rather than their
  // ids: a selection outlives the page it was made on, and a poll may replace the
  // loaded rows before the image is drawn.
  const [selection, setSelection] = React.useState<ReadonlyMap<number, UsageEvent>>(() => new Map());
  // A choice is under way from the toolbar's button or the first pick until it is cleared; only then
  // does the list carry a selection column, and a plain click on a row picks it.
  const [isSelectMode, setIsSelectMode] = React.useState(false);
  const isSelecting = isSelectMode || selection.size > 0;

  const {
    colWidths,
    gridTemplate,
    gridMinWidth,
    foldedColumns,
    streamRef,
    hasCustomWidths,
    handleResizeStart,
    handleResetColumn,
    handleResetAllColumns,
    handleResizeKeyDown,
  } = useRequestColumnLayout(isSelecting);

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
    liveRevision,
    notifySettled,
    handleManualRefresh,
  } = useUsageEventSync({ query, isFetchingRef });
  // The header's estimate of the window, re-read on every live update. It is display only:
  // the reads below send the window unresolved, so the server decides what "now" is.
  const displayWindow = React.useMemo(() => eventWindow(query, Date.now()), [query, refresh]);


  // viewScope identifies the view the reader is looking at: the filters and
  // window they picked, plus which page of it. The live-refresh counter is
  // deliberately absent. It used to be part of this scope, so every refresh looked
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
    pageRef,
    scrollAreaRef,
    listRef,
    isNativeScroll,
    collapse,
    scrolledDown,
    observeLatest,
    getHeldBoundaryID,
    noteFetchedBoundaryID,
    resolveDisplayedItems,
    pendingArrivals,
    markPageNavigation,
    handleScroll,
    handleBackToTop,
    handleToggleExpand,
    scrollListToTop,
    schedulePageNavigationReset,
  } = liveEdge;
  const listHostRef = React.useRef<HTMLDivElement>(null);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = React.useState(false);
  const [isExportOpen, setIsExportOpen] = React.useState(false);
  /** The row last picked without Shift, which a Shift click runs from. */
  const selectionAnchorRef = React.useRef<SelectionAnchor<number> | null>(null);

  const isQueryEnabled = isEnabled;
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
    // Facets materialize the window once and group its dimensions. They change
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
  //
  // The window travels as the reader chose it; `eventWindowQuery` explains why a
  // bound resolved on the browser's clock must never reach the server.
  const baseEventParams = React.useMemo(
    () => ({
      ...query,
      ...eventWindowQuery(query),
      cursor,
    }),
    [cursor, query],
  );
  const queryString = React.useMemo(() => usageEventParams(baseEventParams), [baseEventParams]);
  // Only a read caused solely by a live signal is silent: a filter/page change
  // or manual sync is one the operator asked for. Keeping `refresh` out of the
  // query key lets live signals refetch the current view in place instead of
  // minting a new key with `isPlaceholderData: true` (which flashed "Updating"
  // in the pagination footer on every live tick).
  const readCauseRef = React.useRef({ queryString, refresh, liveRevision, isLiveRead: false });
  if (readCauseRef.current.queryString !== queryString || readCauseRef.current.refresh !== refresh) {
    const previous = readCauseRef.current;
    readCauseRef.current = {
      queryString,
      refresh,
      liveRevision,
      isLiveRead: previous.queryString === queryString && refresh - previous.refresh === liveRevision - previous.liveRevision,
    };
  }
  const result = useQuery({
    queryKey: ['usage-events', queryString],
    queryFn: async () => {
      const heldBoundaryID = getHeldBoundaryID();
      const params = heldBoundaryID !== undefined
        ? usageEventParams({ ...baseEventParams, since: heldBoundaryID })
        : queryString;
      const page = await api.getUsageEvents(params);
      noteFetchedBoundaryID(heldBoundaryID);
      return page;
    },
    enabled: isQueryEnabled,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
    meta: { silent: readCauseRef.current.isLiveRead },
  });
  const refetchEvents = result.refetch;
  const lastRefreshTriggerRef = React.useRef({ queryString, refresh });
  React.useEffect(() => {
    const previous = lastRefreshTriggerRef.current;
    lastRefreshTriggerRef.current = { queryString, refresh };
    if (!isQueryEnabled) return;
    if (previous.queryString !== queryString) {
      void refetchEvents({ cancelRefetch: false });
      return;
    }
    if (previous.refresh === refresh) return;
    void refetchEvents();
  }, [isQueryEnabled, queryString, refresh, refetchEvents]);

  // Assigned after the read it describes, so the poll's interval always observes
  // the latest value without naming it in its dependency list.
  isFetchingRef.current = result.isFetching;
  const wasFetchingRef = React.useRef(false);
  // A record that landed while this read was in flight was held for it; it is read now.
  React.useEffect(() => {
    if (result.isFetching) {
      wasFetchingRef.current = true;
      return;
    }
    if (wasFetchingRef.current) {
      wasFetchingRef.current = false;
      readCauseRef.current.isLiveRead = false;
    }
    notifySettled();
  }, [result.isFetching, notifySettled]);
  const isVisibleFetching = result.isFetching && !readCauseRef.current.isLiveRead;

  const handlePrevPage = React.useCallback(() => {
    if (!cursors.length || isVisibleFetching) return;
    markPageNavigation();
    setPagination({ scope: viewScope, cursors: cursors.slice(0, -1) });
    scrollListToTop();
    schedulePageNavigationReset();
  }, [cursors, isVisibleFetching, markPageNavigation, schedulePageNavigationReset, scrollListToTop, viewScope]);

  const handleNextPage = React.useCallback(() => {
    if (!result.data?.has_more || !result.data?.next_cursor || isVisibleFetching || result.isError) return;
    markPageNavigation();
    setPagination({ scope: viewScope, cursors: [...cursors, result.data.next_cursor] });
    scrollListToTop();
    schedulePageNavigationReset();
  }, [cursors, isVisibleFetching, markPageNavigation, result.data, result.isError, schedulePageNavigationReset, scrollListToTop, viewScope]);


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
  const events = resolveDisplayedItems(latestItems);

  // Read through a ref so the row's toggle keeps one identity: a new callback per
  // poll would re-render every memoized row on screen.
  const eventsRef = React.useRef(events);
  eventsRef.current = events;
  const selectionRef = React.useRef(selection);
  selectionRef.current = selection;
  const handleToggleSelect = React.useCallback((id: number, isRange: boolean) => {
    const pick = toggleSelection(selectionRef.current, eventsRef.current, id, selectionAnchorRef.current, isRange);
    selectionAnchorRef.current = pick.anchor;
    setSelection(pick.selection);
  }, []);
  const handleToggleAll = React.useCallback((isSelected: boolean) => {
    selectionAnchorRef.current = null;
    setSelection((previous) => setLoadedSelection(previous, eventsRef.current, isSelected));
  }, []);
  const clearSelectedRows = React.useCallback(() => {
    selectionAnchorRef.current = null;
    setSelection((previous) => (previous.size === 0 ? previous : new Map()));
  }, []);
  const clearSelection = React.useCallback(() => {
    clearSelectedRows();
    setIsSelectMode(false);
  }, [clearSelectedRows]);
  // A selection belongs to the view it was made in. Paging keeps it; a different
  // filter or window shows other records, and rows nobody can see must not ride
  // along into an export.
  React.useEffect(clearSelectedRows, [clearSelectedRows, signature]);
  const pendingCount = pendingArrivals(result.data?.arrived_count);

  // Safe credential metadata and historical archive come from the consolidated
  // identity directory so live and deleted credentials resolve identically.
  const {
    credentials,
    isCredentialsUnavailable,
    providerIcons,
    pluginLogos,
    multiPortalKeys,
    pluginTitles,
    configuredProviders,
    archivedProvidersByKey,
    archive,
    isProviderCatalogUnproven,
    refetchProviders,
  } = useProviderBranding();
  // Resolves CPA's stored provider key to the name the operator configured, so
  // the filter names a line the same way the providers page does.
  const providerName = React.useMemo(
    () => createProviderNameResolver(configuredProviders, pluginTitles, archivedProvidersByKey),
    [configuredProviders, pluginTitles, archivedProvidersByKey],
  );
  // Records resolve by runtime credential index, not a projected positional id.
  // A routine catalog refetch does not withdraw an identity already resolved.
  const renderFacetMark = React.useMemo(
    () => createFacetMarkRenderer({ credentials, providerIcons, configuredProviders, pluginLogos, multiPortalKeys, isProviderCatalogUnknown: isProviderCatalogUnproven, archive }),
    [credentials, providerIcons, configuredProviders, pluginLogos, multiPortalKeys, isProviderCatalogUnproven, archive],
  );

  /**
   * A chip names the dimension and the value it holds, in the operator's words.
   * The credential dimension resolves to a file name and the caller dimension to
   * its readable mask, because the stored value for both is a fingerprint that
   * nobody recognises - but the chip must still remove the value it was given,
   * not the label it displayed. The credential's file name is its display form,
   * with its account masked where the name repeats it.
   */
  const chipLabels: Record<EventFilterKey, MessageKey> = {
    model: 'events.filter_chip_model',
    model_alias: 'events.filter_chip_model_alias',
    provider: 'events.filter_chip_provider',
    auth_index: 'events.filter_chip_credential',
    auth_type: 'events.filter_chip_auth_type',
    reasoning: 'events.filter_chip_reasoning',
    service_tier: 'events.filter_chip_service_tier',
    resolved_service_tier: 'events.filter_chip_resolved_service_tier',
    source: 'events.filter_chip_source',
    api_key: 'events.filter_chip_caller',
    executor: 'events.filter_chip_executor',
    q: 'events.filter_chip_search',
    ua: 'events.filter_chip_ua',
    endpoint: 'events.filter_chip_endpoint',
    request_id: 'events.filter_chip_request_id',
    regex: 'events.filter_chip_regex',
    latency_min: 'events.filter_chip_latency_min',
    latency_max: 'events.filter_chip_latency_max',
    tokens_min: 'events.filter_chip_tokens_min',
    tokens_max: 'events.filter_chip_tokens_max',
    cost_min: 'events.filter_chip_cost_min',
    cost_max: 'events.filter_chip_cost_max',
    cost: 'events.filter_chip_cost_state',
    served: 'events.filter_chip_served_model',
    transport: 'events.filter_chip_transport',
  };

  const credentialNames = React.useMemo(
    () => new Map([...credentials].map(([index, file]) => [index, credentialOptionLabel(file)] as const)),
    [credentials],
  );

  const describeChip = React.useCallback(
    (key: EventFilterKey, values: string[]): { label: string; display?: string } => {
      if (key === 'regex') {
        const regex = parseUsageRegex(values[0]);
        return {
          label: regex
            ? t(chipLabels.regex, { field: t(REGEX_FIELD_LABELS[regex.field]), val: regex.pattern })
            : (values[0] ?? ''),
        };
      }
      // Which value to show is decided in `chipDisplay`: the stored value is a
      // fingerprint for the credential and caller dimensions and a provider key for
      // the provider dimension, and each resolves to the form the operator
      // recognises. The sentence around it stays in the dictionary.
      const shown = chipDisplayValue({
        key,
        value: values[0] ?? '',
        credentialNames,
        callerFacets: facets.data?.facets.api_group_keys,
        resolveProviderName: providerName,
        costLabels: {
          priced: t('events.cost_priced'),
          unpriced: t('events.cost_unpriced_short'),
        },
        servedLabels: {
          substituted: t('events.served_substituted'),
          matched: t('events.served_matched'),
        },
        transportLabels: {
          websocket: t('events.transport_websocket'),
          sse: t('events.transport_sse'),
          http: t('events.transport_http'),
        },
      });
      return { label: t(chipLabels[key], { val: shown }) };
    },
    [credentialNames, facets.data, t, providerName],
  );

  const activeFilters = EVENT_FILTER_KEYS.filter((key) => (committedParams[key]?.length ?? 0) > 0);
  // The result verdict is a filter too, but it is not a URL parameter, so it has
  // to be counted separately: a list narrowed to failures with the Reset button
  // hidden would be a filter the operator can only clear by guessing.
  const hasActiveFilter = activeFilters.length > 0 || query.result !== 'all';

  const openFilterDrawer = React.useCallback(() => setIsFilterDrawerOpen(true), []);
  const getEventKey = React.useCallback((event: UsageEvent) => event.id, []);
  const streamStyle = React.useMemo(
    () =>
      ({
        '--req-grid-columns': gridTemplate,
        '--req-min-width': `${gridMinWidth}px`,
      }) as React.CSSProperties,
    [gridMinWidth, gridTemplate],
  );

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

  const group = React.useMemo<RequestGroupConfig<UsageEvent> | undefined>(() => {
    if (grouping === 'time') return undefined;
    return {
      key: (event: UsageEvent) => {
        if (grouping === 'ua') return eventUserAgentGroupKey(event);
        const provider = eventProviderIdentity(event, providerName, unknownProviderLabel).key;
        const credential = eventCredentialIdentity(event, credentials, unknownCredentialLabel).key;
        return JSON.stringify([provider, credential]);
      },
      title: (_key: string, items: UsageEvent[]) => {
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
  }, [credentials, grouping, multipleAuthSources, providerName, t, unknownCredentialLabel, unknownProviderLabel]);

  const renderRequestRow = React.useCallback(
    (event: UsageEvent, position: number) => (
      <RequestRow
        event={event}
        isOddRow={position % 2 === 0}
        credentials={credentials}
        providerIcons={providerIcons}
        configuredProviders={configuredProviders}
        pluginLogos={pluginLogos}
        multiPortalKeys={multiPortalKeys}
        pluginTitles={pluginTitles}
        isProviderCatalogUnknown={isProviderCatalogUnproven}
        archive={archive}
        onOpen={setSelected}
        isSelected={selected === event.id}
        isChecked={selection.has(event.id)}
        isSelecting={isSelecting}
        onToggleSelect={handleToggleSelect}
      />
    ),
    [
      configuredProviders,
      credentials,
      handleToggleSelect,
      isProviderCatalogUnproven,
      isSelecting,
      multiPortalKeys,
      pluginLogos,
      pluginTitles,
      providerIcons,
      archive,
      selected,
      selection,
    ],
  );
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
    <div ref={pageRef} className="terminal-page usage-events-page request-events-page">
      <RequestCollapsibleHeader collapse={collapse} pageRef={pageRef}>
        <div className="request-header-content">
          <header className="terminal-page-head">
            <div className="terminal-page-heading">
              <h1 className="terminal-title">{t('events.title')}</h1>
              <p className="terminal-subtitle request-window">
                {dayjs(displayWindow.from).format('MM-DD HH:mm')} — {dayjs(displayWindow.to).format('MM-DD HH:mm')}
              </p>
            </div>
            <div className="request-actions">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button variant="ghost">
                      <StatusDot status={ingestTone} text={t(ingestLabel)} />
                    </Button>
                  }
                />
                <PopoverContent placement="bottomRight">
                  <PopoverTitle className="m-0 mb-2 text-base font-semibold text-foreground">
                    {t('events.ingest_status')}
                  </PopoverTitle>
                  <div className="request-ingest">
                    <FactList
                      emphasis="quiet"
                      facts={[
                        { key: 'mode', label: t('events.collector_mode'), value: status?.collector?.mode || '—' },
                        { key: 'captured', label: t('events.captured'), value: status?.collector?.captured ?? '—' },
                        { key: 'gaps', label: t('events.coverage_gaps'), value: status?.collector?.coverage_gaps ?? '—' },
                        { key: 'pending', label: t('events.pending'), value: status?.stats?.pending ?? '—' },
                      ]}
                    />
                    <p>{t('events.delivery_semantics_hint')}</p>
                    {status?.collector?.last_error && <p>{status.collector.last_error}</p>}
                  </div>
                </PopoverContent>
              </Popover>
              {hasCustomWidths && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="req-reset-columns-btn"
                  onClick={handleResetAllColumns}
                >
                  {t('events.reset_columns')}
                </Button>
              )}
              <ToolButton
                icon={<CheckSquareOutlined />}
                label={t('events.select_requests')}
                variant={isSelecting ? 'active' : 'secondary'}
                aria-pressed={isSelecting}
                onClick={() => (isSelecting ? clearSelection() : setIsSelectMode(true))}
              />
              <RequestFoldToggle collapse={collapse} onToggle={handleToggleExpand} />
              <RefreshButton
                isRefreshing={isSyncing || isVisibleFetching}
                disabled={isSyncing}
                onRefresh={handleManualRefresh}
              />
            </div>
          </header>
          {rejectedParams.length > 0 && (
            <Notice
              tone="warning"
              title={t('events.rejected_filters', { n: rejectedParams.length })}
              description={`${rejectedParams.join(', ')} — ${t('events.rejected_filters_hint')}`}
            />
          )}
          {result.isError && (
            <LoadFailure
              title={t('events.load_error')}
              error={result.error}
              onRetry={() => {
                readCauseRef.current.isLiveRead = false;
                void result.refetch();
              }}
            />
          )}
          <RequestToolbar
            search={search}
            onSearchChange={setSearch}
            query={query}
            onTimeWindowChange={setTimeWindow}
            onResultChange={setResult}
            committedParams={committedParams}
            renderFacetMark={renderFacetMark}
            onFilterChange={setFilter}
            facets={facets.data?.facets}
            facetsFailed={facets.isError}
            credentials={credentials}
            resolveProviderName={providerName}
            filterCount={filterCount}
            onOpenFilters={openFilterDrawer}
            hasActiveFilter={hasActiveFilter}
            activeFilterCount={activeFilters.length}
            onClearFilters={clearFilters}
            grouping={grouping}
            onGroupingChange={changeGrouping}
          />
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
            credentialName={(authIndex) => credentialOptionLabel(credentials.get(authIndex)) || authIndex}
            providerName={providerName}
            renderFacetMark={renderFacetMark}
            onApply={(next) => {
              // Apply replaces every filter dimension, so a keystroke queued in the
              // search box must not land on top of the applied view.
              resetSearchQueue();
              commit(next.params, { result: next.result });
              setIsFilterDrawerOpen(false);
            }}
          />
          {isCredentialsUnavailable && (
            <div className="request-detail-note" role="status">
              {t('events.credentials_unavailable')}
            </div>
          )}
        </div>
      </RequestCollapsibleHeader>
      <div className="request-stream-slot">
        <section
          ref={streamRef}
          className={clsx('request-stream', isSelecting && 'is-selecting')}
          data-folded-columns={foldedColumns}
          aria-label={t('events.title')}
          aria-busy={isVisibleFetching}
          style={streamStyle}
        >
          <div ref={scrollAreaRef} className="request-table-scroll-area">
            <RequestStreamHeader
              colWidths={colWidths}
              handleResizeStart={handleResizeStart}
              handleResetColumn={handleResetColumn}
              handleResizeKeyDown={handleResizeKeyDown}
              isSelecting={isSelecting}
              selectionState={loadedSelectionState(selection, events)}
              onToggleAll={handleToggleAll}
            />
            <div ref={listHostRef} className="request-list-host">
              <RequestTooltipLayer hostRef={listHostRef} />
              {!isQueryEnabled || result.isLoading ? (
                <TablePlaceholder rows={8} className="request-loading" />
              ) : events.length ? (
                <RequestVirtualList<UsageEvent>
                  ref={listRef}
                  key={`${viewScope}:${grouping}`}
                  virtual
                  overscanPx={isNativeScroll ? 640 : 432}
                  items={events}
                  getItemKey={getEventKey}
                  group={group}
                  className={clsx(isNativeScroll && 'is-native-scroll')}
                  onScroll={handleScroll}
                  renderItem={renderRequestRow}
                />
              ) : !result.isError ? (
                <EmptyState
                  title={t('events.empty_title')}
                  description={t(hasActiveFilter ? 'events.empty_filtered' : 'events.empty_hint')}
                />
              ) : (
                <div className="request-empty-error">{t('events.load_error')}</div>
              )}
            </div>
          </div>
          <RequestPagination
            collapse={collapse}
            onRestoreHeader={handleToggleExpand}
            stale={stale}
            isPlaceholderData={result.isPlaceholderData}
            page={cursors.length + 1}
            count={events.length}
            limit={query.limit!}
            isFetching={isVisibleFetching}
            isError={result.isError}
            hasMore={!!result.data?.has_more}
            hasNextCursor={!!result.data?.next_cursor}
            hasPrev={cursors.length > 0}
            onPageSizeChange={setPageSize}
            onPrev={handlePrevPage}
            onNext={handleNextPage}
            dock={isSelecting && (
              <RequestSelectionBar
                count={selection.size}
                isEveryLoadedSelected={loadedSelectionState(selection, events) === 'all'}
                onSelectLoaded={() => handleToggleAll(true)}
                onClear={clearSelection}
                onExport={() => setIsExportOpen(true)}
              />
            )}
          />
        </section>
        <RequestBackToTop scrolledDown={scrolledDown} pendingCount={pendingCount} onBackToTop={handleBackToTop} />
      </div>
      <UsageEventDrawer
        credentials={credentials}
        eventId={selected}
        onClose={() => setSelected(null)}
        events={events}
        onSelectEvent={setSelected}
        providerIcons={providerIcons}
        configuredProviders={configuredProviders}
        pluginLogos={pluginLogos}
        multiPortalKeys={multiPortalKeys}
        pluginTitles={pluginTitles}
        isProviderCatalogUnknown={isProviderCatalogUnproven}
        archive={archive}
      />
      <RequestExportDialog
        open={isExportOpen}
        onClose={() => setIsExportOpen(false)}
        selection={selection}
        colWidths={colWidths}
        credentials={credentials}
        providerIcons={providerIcons}
        configuredProviders={configuredProviders}
        pluginLogos={pluginLogos}
        multiPortalKeys={multiPortalKeys}
        pluginTitles={pluginTitles}
        isProviderUnproven={isProviderCatalogUnproven}
        onRetryProviders={() => void refetchProviders()}
        archive={archive}
      />
    </div>
  );
};
