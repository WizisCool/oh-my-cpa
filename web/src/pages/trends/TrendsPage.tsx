import React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Select } from '@/components/ui/select';
import { api, apiErrorCode } from '../../api/client';
import { useT } from '../../i18n';
import { usePreference } from '../../hooks/usePreference';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useViewSearchParams, type ViewChangeOptions } from '../../hooks/useViewSearchParams';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { isMotionReduced } from '../../utils/motionPreference';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import dayjs from '../../utils/time';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { resolveTokenFlowReadout } from '../../types/tokenDisplay';
import { successRateTone } from '../../types/usageEventMetrics';
import { formatChange, formatLatency } from '../../types/insightsFormat';
import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_BUCKETS,
  INSIGHTS_RANGE_PREFERENCE,
  insightsPollInterval,
  parseInsightsRange,
  type InsightsBucketChoice,
  type InsightsRange,
} from '../../types/insights';
import type { TrendsSubstitutionPair, TrendsUsageGroupOption } from '../../types/trends';
import { PageHeader } from '../../components/common/PageHeader';
import { ToolButton } from '../../components/common/ToolButton';
import { StatTiles } from '../../components/common/StatTiles';
import { MetaLine } from '../../components/common/MetaLine';
import { DeferredPanel } from '../../components/common/DeferredPanel';
import { Panel } from '../../components/common/Panel';
import { TrendsSkeleton } from '../../components/common/PageLoading';
import { HistoryOutlined } from '../../components/icons';
import { LoadFailure, Notice } from '../../components/feedback';
import { RollingNumber, RollingNumberGroup } from '../../components/dashboard/RollingNumber';
import { useIsRouteActive, useIsRoutePollingActive } from '../../performance/routeContract';
import { isDemoMode } from '../../types/demoMode';
import { InsightsRangeControl } from '../insights/components/InsightsRangeControl';
import { QuotaBurnPanel } from './components/QuotaBurnPanel';
import { PerformancePanel } from './components/PerformancePanel';
import { MoversPanel } from './components/MoversPanel';
import { StabilityPanel } from './components/StabilityPanel';
import { TrendsFilterBar } from './components/TrendsFilterBar';
import {
  HOUR_LIMIT_MS,
  TRENDS_USAGE_GROUPS,
  availablePerfGroups,
  filterKeyForGroupBy,
  hasTrendsFilters,
  isRangeWithinHourLimit,
  percentReadout,
  pickForecastableQuotaWindow,
  quotaRisk,
  readTrendsView,
  relativeChange,
  stabilityFilterKeyForDim,
  substitutionEventsHref,
  successRate,
  toggleTrendsFilter,
  trendsEventsHref,
  trendsQuotaParams,
  trendsWindowParams,
  usageGroupBy,
  writeTrendsView,
  type TrendsFilterKey,
  type TrendsUsageGroup,
  type TrendsViewState,
} from './trendsLogic';
import { useTrendsIdentity } from './useTrendsIdentity';
import styles from './trends.module.css';

const QUOTA_POLL_MS = 60_000;

// The tiles read in the order the panels stand below them; each one opens its panel.
type TileKey = 'quota' | 'speed' | 'movers' | 'delivery';
const TILE_SECTIONS: Record<TileKey, string> = {
  quota: 'trends-quota',
  speed: 'trends-performance',
  movers: 'trends-movers',
  delivery: 'trends-stability',
};

function retryUnlessUncaptured(count: number, error: unknown): boolean {
  return apiErrorCode(error) !== 'demo_uncaptured' && count < 2;
}

/** A group's name as the page prints it: a key's alias over its mask, the remainder as one word. */
function groupName(item: { id: string; label: string; alias?: string; mask?: string; folded?: boolean }, folded: string): string {
  if (item.folded) return folded;
  return item.alias?.trim() || item.label || item.mask || item.id;
}

/**
 * Trends: where the deployment is heading, beside Insights' cross-section of where it stands.
 *
 * Three reads, each a server-side aggregate: the OAuth windows' cycle burn and forecast, the
 * window's net-token trajectory with its shares and movers, and the window's speed, latency and
 * failures. The window is the stored analytical window Insights also reads; what the reader
 * narrowed and how each panel is cut is in the URL, so a view is a link.
 */
export const TrendsPage: React.FC = () => {
  useTimeZone();
  const t = useT();
  const navigate = useNavigate();
  const isPhone = useIsPhoneViewport();
  const isRouteActive = useIsRouteActive();
  const isPollingActive = useIsRoutePollingActive();
  const isDemo = isDemoMode();
  const { modelView, style } = useTokenDisplayStyle();

  const visibleNow = useVisibleNow();
  const [search, setSearch] = useViewSearchParams();
  const view = React.useMemo(() => readTrendsView(search), [search]);
  const setView = React.useCallback((patch: Partial<TrendsViewState>, options?: ViewChangeOptions) => {
    setSearch((current) => writeTrendsView({ ...readTrendsView(current), ...patch }), options);
  }, [setSearch]);

  const { value: range, ready: isRangeReady, loaded: isRangeStored, set: setRange } = usePreference<InsightsRange>(
    INSIGHTS_RANGE_PREFERENCE, DEFAULT_INSIGHTS_RANGE, parseInsightsRange,
  );

  const usageGroup = usageGroupBy(view.usageGroup, modelView);
  const perfGroup = usageGroupBy(view.perfGroup, modelView);
  const effectiveBucket: InsightsBucketChoice = view.bucket === 'hour' && !isRangeWithinHourLimit(range, visibleNow)
    ? 'auto'
    : view.bucket;
  const usageQueryString = trendsWindowParams(range, effectiveBucket, usageGroup, view.filters);
  const telemetryQueryString = trendsWindowParams(range, effectiveBucket, perfGroup, view.filters);
  const quotaQueryString = trendsQuotaParams(view.filters);

  const usageQuery = useQuery({
    queryKey: ['trends-usage', usageQueryString],
    queryFn: ({ signal }) => api.getTrendsUsage(usageQueryString, signal),
    enabled: isRangeReady,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
    retry: retryUnlessUncaptured,
    // The page states a failure in place, and an uncaptured demonstration window as a notice.
    meta: { silent: true },
  });
  const telemetryQuery = useQuery({
    queryKey: ['trends-telemetry', telemetryQueryString],
    queryFn: ({ signal }) => api.getTrendsTelemetry(telemetryQueryString, signal),
    enabled: isRangeReady,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
    retry: retryUnlessUncaptured,
    meta: { silent: true },
  });
  const quotaQuery = useQuery({
    queryKey: ['trends-quota', quotaQueryString],
    queryFn: ({ signal }) => api.getTrendsQuota(quotaQueryString, signal),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: isPollingActive ? QUOTA_POLL_MS : false,
    retry: retryUnlessUncaptured,
    meta: { silent: true },
  });

  const telemetryItemFilterKey = filterKeyForGroupBy(telemetryQuery.data?.group_by ?? perfGroup);
  const selectedPerfItem = React.useMemo(() => {
    const telemetry = telemetryQuery.data;
    if (!telemetry || (view.perfMode !== 'ttft' && view.perfMode !== 'latency') || !view.perfItem) return undefined;
    const listed = availablePerfGroups(telemetry, !isDemo);
    return listed.some((item) => item.id === view.perfItem) ? view.perfItem : undefined;
  }, [isDemo, telemetryQuery.data, view.perfItem, view.perfMode]);
  const needsTelemetryItemQuery = Boolean(
    !isDemo &&
    selectedPerfItem &&
    telemetryItemFilterKey &&
    telemetryQuery.data &&
    !telemetryQuery.data.series.some((item) => item.id === selectedPerfItem),
  );
  const telemetryItemFilters = React.useMemo(
    () => (selectedPerfItem && telemetryItemFilterKey ? { ...view.filters, [telemetryItemFilterKey]: [selectedPerfItem] } : view.filters),
    [selectedPerfItem, telemetryItemFilterKey, view.filters],
  );
  const telemetryItemQueryString = trendsWindowParams(range, effectiveBucket, perfGroup, telemetryItemFilters);
  const telemetryItemQuery = useQuery({
    queryKey: ['trends-telemetry', telemetryItemQueryString],
    queryFn: ({ signal }) => api.getTrendsTelemetry(telemetryItemQueryString, signal),
    enabled: isRangeReady && needsTelemetryItemQuery,
    staleTime: 15_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
    retry: retryUnlessUncaptured,
    meta: { silent: true },
  });

  // A cached slot coming back on screen revalidates what went stale while it was parked, since
  // focus refetches were off while the route was hidden.
  const wasRouteActiveRef = React.useRef(isRouteActive);
  React.useEffect(() => {
    const becameActive = isRouteActive && !wasRouteActiveRef.current;
    wasRouteActiveRef.current = isRouteActive;
    if (!becameActive) return;
    for (const query of [usageQuery, telemetryQuery, quotaQuery, ...(needsTelemetryItemQuery ? [telemetryItemQuery] : [])]) {
      if (query.isStale && !query.isFetching && query.fetchStatus !== 'paused') void query.refetch();
    }
  }, [isRouteActive, needsTelemetryItemQuery, quotaQuery, telemetryItemQuery, telemetryQuery, usageQuery]);

  const usage = usageQuery.isPlaceholderData && usageQuery.isError ? undefined : usageQuery.data;
  const telemetry = telemetryQuery.isPlaceholderData && telemetryQuery.isError ? undefined : telemetryQuery.data;
  const quota = quotaQuery.data;
  const quotaFetchedAtMs = quotaQuery.dataUpdatedAt;
  const quotaElapsedMs = quota && quotaFetchedAtMs > 0 ? Math.max(0, visibleNow - quotaFetchedAtMs) : 0;
  const quotaNowMs = quota ? quota.as_of_ms + quotaElapsedMs : visibleNow;
  const resolveQuotaNowMs = React.useCallback(
    () => (quota && quotaFetchedAtMs > 0 ? quota.as_of_ms + Math.max(0, Date.now() - quotaFetchedAtMs) : Date.now()),
    [quota, quotaFetchedAtMs],
  );
  const currentUsage = usage && !usageQuery.isPlaceholderData ? usage : undefined;
  const currentTelemetry = telemetry && !telemetryQuery.isPlaceholderData ? telemetry : undefined;
  const shownWindow = currentUsage?.window ?? currentTelemetry?.window;

  React.useEffect(() => {
    if (!isRangeReady || view.bucket !== 'hour') return;
    const isHourLimitError =
      apiErrorCode(usageQuery.error) === 'insights_bucket_hour_limit' ||
      apiErrorCode(telemetryQuery.error) === 'insights_bucket_hour_limit' ||
      apiErrorCode(telemetryItemQuery.error) === 'insights_bucket_hour_limit';
    if (
      isHourLimitError ||
      !isRangeWithinHourLimit(range, visibleNow) ||
      (shownWindow && shownWindow.to - shownWindow.from > HOUR_LIMIT_MS)
    ) {
      setView({ bucket: 'auto' }, { replace: true });
    }
  }, [isRangeReady, range, setView, shownWindow, telemetryItemQuery.error, telemetryQuery.error, usageQuery.error, view.bucket, visibleNow]);

  const isUsageUncaptured = apiErrorCode(usageQuery.error) === 'demo_uncaptured';
  const isTelemetryUncaptured = apiErrorCode(telemetryQuery.error) === 'demo_uncaptured';
  const isQuotaUncaptured = apiErrorCode(quotaQuery.error) === 'demo_uncaptured';
  const isUncaptured = isUsageUncaptured || isTelemetryUncaptured || isQuotaUncaptured;
  const hasActiveRangeOverride = view.bucket !== 'auto' || range.preset !== DEFAULT_INSIGHTS_RANGE.preset || range.from !== undefined;
  const canRestoreCapturedView = hasActiveRangeOverride || hasTrendsFilters(view.filters);

  // The names the reads gave each group, so a filter chip keeps reading as a name after the group
  // has scrolled out of the current view.
  const namesRef = React.useRef(new Map<string, string>());
  const folded = t('trends.folded');
  const nameGroups = React.useCallback((groupBy: string, items: ReadonlyArray<{ id: string; label: string; alias?: string; mask?: string; folded?: boolean }>) => {
    const key = filterKeyForGroupBy(groupBy);
    if (!key) return;
    for (const item of items) if (!item.folded) namesRef.current.set(`${key}\u0000${item.id}`, groupName(item, folded));
  }, [folded]);
  if (usage) {
    nameGroups(usage.group_by, usage.series);
    if (usage.groups) nameGroups(usage.group_by, usage.groups);
    nameGroups(usage.group_by, [...usage.movers.risers, ...usage.movers.fallers]);
  }
  if (telemetry) {
    nameGroups(telemetry.group_by, telemetry.series);
    if (telemetry.groups) nameGroups(telemetry.group_by, telemetry.groups);
  }
  const identity = useTrendsIdentity();
  const perfDimension = telemetry?.group_by ?? perfGroup;
  const seriesLabel = React.useCallback(
    (item: { id: string; label: string; alias?: string; mask?: string; folded?: boolean }) => (item.folded ? folded : identity.label(perfDimension, item)),
    [folded, identity, perfDimension],
  );

  const fallbackName = React.useCallback(
    (key: TrendsFilterKey, id: string) => namesRef.current.get(`${key}\u0000${id}`),
    [],
  );
  const primeName = React.useCallback(
    (key: TrendsFilterKey, option: TrendsUsageGroupOption) => {
      namesRef.current.set(`${key}\u0000${option.id}`, groupName(option, folded));
    },
    [folded],
  );
  const toggleFilter = React.useCallback((key: TrendsFilterKey, value: string) => {
    setView({ filters: toggleTrendsFilter(view.filters, key, value) });
  }, [setView, view.filters]);
  const clearFilters = React.useCallback(() => setView({ filters: {} }), [setView]);

  const changeRange = React.useCallback((next: InsightsRange) => {
    if (view.bucket === 'hour' && !isRangeWithinHourLimit(next, visibleNow)) {
      setView({ bucket: 'auto' }, { replace: true });
    }
    void setRange(next);
  }, [setRange, setView, view.bucket, visibleNow]);

  const eventsHref = shownWindow ? trendsEventsHref(shownWindow, view.filters, {}, { isDemo }) : null;
  const moverFilterKey = usage ? filterKeyForGroupBy(usage.group_by) : null;

  const [focusedTile, setFocusedTile] = React.useState<TileKey | null>(null);
  const selectTile = (key: TileKey) => {
    setFocusedTile(key);
    // The quota tile counts active forecastable credentials; opening it targets the most pressing one.
    const pressingPair = key === 'quota' && quota ? pickForecastableQuotaWindow(quota.items, quotaNowMs) : null;
    if (pressingPair) setView({ quotaCredential: pressingPair.credential.auth_index, quotaWindow: pressingPair.window.window_id, quotaView: 'burn' });
    document.getElementById(TILE_SECTIONS[key])?.scrollIntoView?.({
      block: 'start',
      behavior: isMotionReduced() ? 'instant' : 'smooth',
    });
  };

  const isHourAllowed = !shownWindow || shownWindow.to - shownWindow.from <= HOUR_LIMIT_MS;
  const bucketControl = (
    <Select
      size="small"
      variant={isPhone ? 'borderless' : undefined}
      value={view.bucket}
      aria-label={t('insights.bucket_label')}
      popupMatchSelectWidth={false}
      options={INSIGHTS_BUCKETS.map((bucket) => ({
        value: bucket,
        label: bucket === 'auto' && shownWindow
          ? t('insights.bucket.auto_resolved', { bucket: t(`insights.bucket.${shownWindow.bucket}`) })
          : t(`insights.bucket.${bucket}`),
        disabled: bucket === 'hour' && !isHourAllowed,
        title: bucket === 'hour' && !isHourAllowed ? t('insights.bucket.hour_limit') : undefined,
      }))}
      onChange={(next: InsightsBucketChoice) => setView({ bucket: next })}
    />
  );
  const usageGroupControl = (
    <Select
      size="small"
      variant={isPhone ? 'borderless' : undefined}
      value={view.usageGroup}
      aria-label={t('trends.group_label')}
      popupMatchSelectWidth={false}
      options={TRENDS_USAGE_GROUPS.map((value) => ({ value, label: t(`trends.group.${value}`) }))}
      onChange={(next: TrendsUsageGroup) => setView({ usageGroup: next })}
      data-testid="trends-movers-group"
    />
  );

  const eventsButton = (
    <ToolButton
      icon={<HistoryOutlined />}
      label={t('trends.view_requests')}
      disabled={!eventsHref}
      onClick={() => eventsHref && navigate(eventsHref)}
      data-testid="trends-events"
    />
  );
  const rangeControl = <InsightsRangeControl range={range} onChange={changeRange} isDisabled={!isRangeStored} />;
  const subtitle = shownWindow ? (
    <span className={styles['window-span']}>
      {`${dayjs(shownWindow.from).format('MM-DD HH:mm')} – ${shownWindow.open_end ? t('dash.range.until_now') : dayjs(shownWindow.to).format('MM-DD HH:mm')}`}
    </span>
  ) : t('dash.loading');
  const header = (
    <PageHeader
      title={t('nav.trends')}
      subtitle={subtitle}
      actions={<>{rangeControl}{eventsButton}</>}
      mobileActions={<>{rangeControl}{eventsButton}</>}
    />
  );

  const failure = usageQuery.error ?? telemetryQuery.error ?? quotaQuery.error;
  if (!usage && !telemetry && !quota) {
    if (failure && !isUncaptured) {
      return (
        <div className={`terminal-page ${styles.page}`}>
          {header}
          <LoadFailure
            title={t('trends.error_title')}
            error={failure}
            onRetry={() => {
              if (usageQuery.isError) void usageQuery.refetch();
              if (telemetryQuery.isError) void telemetryQuery.refetch();
              if (quotaQuery.isError) void quotaQuery.refetch();
            }}
          />
        </div>
      );
    }
    if (!isUncaptured) {
      return (
        <div className={`terminal-page ${styles.page}`}>
          {header}
          <TrendsSkeleton hasHeader={false} />
        </div>
      );
    }
  }

  const totals = usage?.totals;
  const compare = usage?.compare_totals;
  // `compare_totals` describes the previous period: its own total and its robust, progress-scaled baseline.
  const change = totals && compare ? relativeChange(totals.net_tokens, compare.baseline_net_tokens) : null;
  const changeText = formatChange(change);
  const summary = telemetry?.summary;
  const rate = summary ? successRate(summary) : null;
  const ttftP95 = summary?.ttft_p95_ms ?? null;

  // Each tile answers one question a reader brings to the page, with its figure and a concise
  // supporting fact: whether any subscription runs out, how fast answers stream, how the token
  // volume compares, and how many requests failed.
  const isQuotaMembershipUnknown = Boolean(quota?.summary.is_membership_unknown);
  const risk = quota ? quotaRisk(quota.items, quotaNowMs) : null;
  const rateTone = rate === null ? 'neutral' : successRateTone(rate * 100);

  const tiles = [
    {
      key: 'quota' as const,
      label: t('trends.tile.quota'),
      value: risk
        ? (isQuotaMembershipUnknown ? '—' : <RollingNumber readout={{ number: risk.forecastable, suffix: '', format: { maximumFractionDigits: 0 } }} />)
        : undefined,
      foot: risk && !isQuotaMembershipUnknown ? (
        <MetaLine className={styles['tile-foot']}>
          {risk.limited > 0 && <span className={styles['tone-danger']}>{t('trends.tile.quota_limit', { n: risk.limited })}</span>}
          {risk.projected > 0 && <span className={styles['tone-warn']}>{t('trends.tile.quota_projected', { n: risk.projected })}</span>}
          {risk.forecastable > 0 && risk.limited === 0 && risk.projected === 0 && <span>{t('trends.tile.quota_clear')}</span>}
        </MetaLine>
      ) : null,
    },
    {
      key: 'speed' as const,
      label: t('trends.tile.speed'),
      value: summary ? (
        summary.tps_p50 === null ? '—' : (
          // How the rate is measured qualifies the figure, so it rides on the figure rather than the foot.
          <span data-tip={t(`trends.tps_mode.${telemetry!.tps_mode}`)}>
            <RollingNumber readout={{ number: Number(summary.tps_p50.toFixed(1)), suffix: ' TPS', format: { maximumFractionDigits: 1 } }} />
          </span>
        )
      ) : undefined,
      foot: summary ? (
        <MetaLine className={styles['tile-foot']}>
          <span>{t('trends.tile.ttft_p95', { value: ttftP95 === null ? '—' : formatLatency(ttftP95) })}</span>
        </MetaLine>
      ) : null,
    },
    {
      key: 'movers' as const,
      label: t('trends.tile.movers'),
      value: totals ? (
        <span data-tip={totals.net_tokens.toLocaleString('en')}>
          <RollingNumber readout={resolveTokenFlowReadout(totals.net_tokens, style)} />
        </span>
      ) : undefined,
      foot: usage ? (
        <MetaLine className={styles['tile-foot']}>
          {changeText !== null && (
            <span data-trend={change! > 0 ? 'up' : change! < 0 ? 'down' : undefined}>{t('trends.tile.vs_baseline', { value: changeText })}</span>
          )}
        </MetaLine>
      ) : null,
    },
    {
      key: 'delivery' as const,
      label: t('trends.tile.delivery'),
      value: summary ? (
        <span className={rateTone === 'warn' || rateTone === 'danger' ? styles[`tone-${rateTone}`] : undefined}>
          <RollingNumber readout={percentReadout(rate === null ? null : rate * 100)} />
        </span>
      ) : undefined,
      foot: summary ? (
        <MetaLine className={styles['tile-foot']}>
          {summary.failed_requests > 0
            ? <span className={styles['tone-danger']}>{t('trends.tile.errors', { n: summary.failed_requests })}</span>
            : <span>{t('trends.tile.requests', { n: summary.total_requests })}</span>}
        </MetaLine>
      ) : null,
    },
  ];

  return (
    <div className={`terminal-page ${styles.page}`} data-testid="trends-page">
      {header}
      <TrendsFilterBar
        filters={view.filters}
        range={range}
        bucket={effectiveBucket}
        modelView={modelView}
        usage={currentUsage}
        telemetry={currentTelemetry}
        isRangeReady={isRangeReady}
        isDemo={isDemo}
        isPollingActive={isPollingActive}
        fallbackName={fallbackName}
        onPrimeName={primeName}
        identity={identity}
        eventsHref={eventsHref}
        onToggle={toggleFilter}
        onClear={clearFilters}
        onNavigate={navigate}
      />
      {isUncaptured && (
        <Notice
          tone="info"
          data-testid="trends-uncaptured"
          description={t('trends.uncaptured')}
          action={canRestoreCapturedView ? (
            <button
              type="button"
              className="underline font-medium"
              onClick={() => {
                setView({ bucket: 'auto', filters: {} });
                if (range.preset !== DEFAULT_INSIGHTS_RANGE.preset || range.from !== undefined) {
                  void setRange(DEFAULT_INSIGHTS_RANGE);
                }
              }}
            >
              {t('trends.window.demo_reset')}
            </button>
          ) : undefined}
        />
      )}
      <RollingNumberGroup>
        <StatTiles
          tiles={tiles}
          selected={focusedTile}
          onSelect={selectTile}
          ariaLabel={t('trends.tile_switch')}
          phoneLayout="grid"
          className={styles['trends-tiles']}
          testId="trends-tiles"
          tileTestIdPrefix="trends-tile"
        />
      </RollingNumberGroup>
      <QuotaBurnPanel
        data={quota}
        isLoading={quotaQuery.isFetching}
        error={isQuotaUncaptured ? null : quotaQuery.error}
        onRetry={() => void quotaQuery.refetch()}
        credentialId={view.quotaCredential}
        windowId={view.quotaWindow}
        view={view.quotaView}
        onChange={(patch) => setView(patch)}
        onNavigate={navigate}
        nowMs={quotaNowMs}
        resolveNowMs={resolveQuotaNowMs}
      />
      {!isUsageUncaptured && usageQuery.isError && (
        <LoadFailure tone="warning" title={t('trends.error_title')} error={usageQuery.error} onRetry={() => void usageQuery.refetch()} />
      )}
      {!isTelemetryUncaptured && telemetryQuery.isError && (
        <LoadFailure tone="warning" title={t('trends.error_title')} error={telemetryQuery.error} onRetry={() => void telemetryQuery.refetch()} />
      )}
      <DeferredPanel priority="p1" fallback={<Panel><div className="chart-placeholder" style={{ height: 320 }} aria-hidden="true" /></Panel>}>
        <PerformancePanel
          data={telemetry}
          itemData={needsTelemetryItemQuery ? telemetryItemQuery.data : undefined}
          isItemLoading={needsTelemetryItemQuery && telemetryItemQuery.isFetching}
          itemError={needsTelemetryItemQuery && telemetryItemQuery.isError ? telemetryItemQuery.error : null}
          onRetryItem={needsTelemetryItemQuery ? () => void telemetryItemQuery.refetch() : undefined}
          includeAllGroups={!isDemo}
          mode={view.perfMode}
          group={view.perfGroup}
          selectedItem={selectedPerfItem}
          isPhone={isPhone}
          seriesLabel={seriesLabel}
          identity={identity}
          onModeChange={(perfMode) => setView({ perfMode })}
          onGroupChange={(perfGroup) => setView({ perfGroup, perfItem: undefined })}
          onItemChange={(perfItem) => setView({ perfItem })}
          isUnavailable={isTelemetryUncaptured}
          bucketControl={bucketControl}
        />
      </DeferredPanel>
      <DeferredPanel priority="p2" fallback={<><Panel /><Panel /></>}>
        <>
          <MoversPanel
            data={usage}
            groupControl={usageGroupControl}
            isSelected={(id) => Boolean(moverFilterKey && view.filters[moverFilterKey]?.includes(id))}
            identity={identity}
            onSelect={(id) => moverFilterKey && toggleFilter(moverFilterKey, id)}
            eventsHref={(id) => (currentUsage?.window && moverFilterKey ? trendsEventsHref(currentUsage.window, { ...view.filters, [moverFilterKey]: [id] }, {}, { isDemo }) : null)}
            onNavigate={navigate}
            isUnavailable={isUsageUncaptured}
          />
          <StabilityPanel
            identity={identity}
            data={telemetry}
            filters={view.filters}
            isDemo={isDemo}
            canFilterTrends={!isDemo}
            isPollingActive={isPollingActive}
            isStale={telemetry !== undefined && !currentTelemetry}
            pairHref={(pair: TrendsSubstitutionPair) => (currentTelemetry?.window ? substitutionEventsHref(currentTelemetry.window, view.filters, pair, { isDemo }) : null)}
            isEntityFiltered={(dimension, id) => Boolean(view.filters[stabilityFilterKeyForDim(dimension)]?.includes(id))}
            onToggleFilter={(dimension, id) => {
              if (!isDemo) toggleFilter(stabilityFilterKeyForDim(dimension), id);
            }}
            onNavigate={navigate}
            isUnavailable={isTelemetryUncaptured}
          />
        </>
      </DeferredPanel>
      {usage?.window.widened && (
        <div className={styles.footnote}><span>{t('insights.widened')}</span></div>
      )}
    </div>
  );
};

export default TrendsPage;
