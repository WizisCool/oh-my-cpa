import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
  Listy,
  Popover,
  Skeleton,
  Switch,
  Tooltip,
} from 'antd';
import {
  FullscreenExitOutlined,
  FullscreenOutlined,
  ReloadOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePreference } from '../hooks/usePreference';
import { useT } from '../i18n';
import {
  usageEventParams,
  isUsageFacetsResponse,
  type UsageEvent,
  type UsageEventPage,
} from '../types/usageEvents';
import {
  EVENT_FILTER_KEYS,
  eventWindow,
  type EventFilterKey,
} from '../types/usageEventQuery';
import { createProviderNameResolver, indexCredentialFiles } from '../types/usageEventIdentity';
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
import { useRequestListScroll } from '../components/usage/useRequestListScroll';
import { useUsageEventSync } from '../components/usage/useUsageEventSync';
import { isListStale, isViewChange } from '../components/usage/pollingPolicy';
import { chipDisplayValue } from '../components/usage/chipDisplay';
import {
  PROVIDER_ICONS_PREFERENCE,
  EMPTY_PROVIDER_ICONS,
  parseProviderIcons,
} from '../types/providerIcons';
import { RequestRow } from '../components/usage/RequestRow';
import { UsageEventDrawer } from '../components/usage/UsageEventDrawer';
import { RequestFilterDrawer } from '../components/usage/RequestFilterDrawer';
import { RequestFilterChips } from '../components/usage/RequestFilterChips';
import { RequestPagination } from '../components/usage/RequestPagination';
import { RequestStreamHeader } from '../components/usage/RequestStreamHeader';
import { RequestToolbar } from '../components/usage/RequestToolbar';
import './UsageEventsPage.css';

export const UsageEventsPage: React.FC = () => {
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
    isAutoRefresh,
    toggleAutoRefresh,
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
        <RequestToolbar
          search={search}
          onSearchChange={setSearch}
          query={query}
          onTimeWindowChange={setTimeWindow}
          onResultChange={setResult}
          committedParams={committedParams}
          onFilterChange={setFilter}
          facets={facets.data?.facets}
          facetsFailed={facets.isError}
          credentials={credentials}
          resolveProviderName={providerName}
          filterCount={filterCount}
          onOpenFilters={() => setIsFilterDrawerOpen(true)}
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
          credentialName={(authIndex) => credentials.get(authIndex)?.name ?? authIndex}
          providerName={providerName}
          onApply={(next) => {
            // Apply replaces every filter dimension, so a keystroke queued in the
            // search box must not land on top of the applied view.
            resetSearchQueue();
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
          <RequestStreamHeader
            colWidths={colWidths}
            handleResizeStart={handleResizeStart}
            handleResetColumn={handleResetColumn}
            handleResizeKeyDown={handleResizeKeyDown}
          />
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
        <RequestPagination
          stale={stale}
          isPlaceholderData={result.isPlaceholderData}
          page={cursors.length + 1}
          count={events.length}
          limit={query.limit!}
          isFetching={result.isFetching}
          isError={result.isError}
          hasMore={!!result.data?.has_more}
          hasNextCursor={!!result.data?.next_cursor}
          hasPrev={cursors.length > 0}
          onPageSizeChange={setPageSize}
          onPrev={handlePrevPage}
          onNext={handleNextPage}
        />
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
