import { useDisplayCurrency } from '../types/CurrencyDisplayContext';
import { currencyReadout, formatCurrency } from '../types/currencyDisplay';
import { ActionMenu } from '../components/common/ActionMenu';
import { DeferredPanel } from '../components/common/DeferredPanel';
import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Select } from 'antd';
import { Button } from '@/components/ui/button';
import { AppstoreOutlined, HistoryOutlined, KeyOutlined, QuestionCircleOutlined, ReceiptOutlined, RightOutlined } from '../components/icons';
import { PageHeader } from '../components/common/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from '../utils/time';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { PRICING_QUERY_KEYS } from '../components/pricing/pricingQueries';
import { usePreference } from '../hooks/usePreference';
import { useLiveRevision } from '../hooks/useLiveRevision';
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport';
import { type ChartTone } from '../charts/chartTheme';
import { type DashboardTrendChartProps } from '../charts/DashboardTrendChart';
import { LazyDashboardTrendChart } from '../charts/lazyCharts';
import { maskKeyText } from '../utils/maskKey';
import { resolveCacheRateReadout } from '../theme/cacheScale';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import {
  formatTokenRate,
  formatTokens as formatTokensStyled,
  formatTokensFull,
  resolveCountFlowReadout,
  resolveTokenFlowReadout,
  resolveTokenRateFlowReadout,
} from '../types/tokenDisplay';
import { successRateTone } from '../types/usageEventMetrics';
import { TimeRangeControl } from '../components/dashboard/TimeRangeControl';
import { RollingNumber } from '../components/dashboard/RollingNumber';
import { TokenHeatmap, TOKEN_HEATMAP_QUERY_KEY } from '../components/dashboard/TokenHeatmap';
import { RoutingPanel, ROUTING_WINDOW_CACHE_KEY } from '../components/dashboard/routing/RoutingPanel';
import {
  CredentialQuota,
  CREDENTIAL_FILES_QUERY_KEY,
  CREDENTIAL_QUOTA_QUERY_KEY,
} from '../components/dashboard/CredentialQuota';
import { ModelTrendPanel, ModelUsagePanel, ModelSeriesFocusProvider, DASHBOARD_MODELS_QUERY_KEY } from '../components/dashboard/ModelUsagePanels';
import { DashboardBoard, preloadDashboardBoardEditor } from '../components/dashboard/DashboardBoard';
import { DashboardKpiTilePlaceholder } from '../components/dashboard/DashboardSkeleton';
import { DashboardProviders } from '../components/dashboard/DashboardProviders';
import { isCalendarPreset } from '../types/calendarPresets';
import { withGroupBy } from '../types/dashboardModels';
import {
  dashboardHeatmapSwr,
  dashboardModelsSwr,
  dashboardTailSwr,
  dashboardWindowSwr,
  managementOverviewSwr,
} from '../components/dashboard/dashboardQueries';
import { invalidateSwrScopes, useSwrQuery } from '../performance/swrContract';
import { preloadRegisteredRoute, useTransitionNavigate } from '../performance/routeContract';
import {
  applyTail,
  DASHBOARD_RANGE_PREFERENCE,
  dashboardRangeParams,
  DEFAULT_DASHBOARD_RANGE,
  isSlidingRange,
  requestListWindowParams,
  livePollInterval,
  parseDashboardRange,
  costNoteKey,
  type DashboardRange,
  type DashboardWindow,
  type DashboardResponse,
  type DashboardSeriesPoint,
} from '../types/dashboard';
import {
  DASHBOARD_LAYOUT_PREFERENCE,
  DEFAULT_DASHBOARD_LAYOUT,
  parseDashboardLayout,
  sameDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from '../types/dashboardLayout';
import { LoadFailure, useToast } from '../components/feedback';
import { EmptyState } from '../components/common/EmptyState';
import { Panel } from '../components/common/Panel';
import { LoadingRegion, Placeholder } from '../components/common/Placeholder';
import { ToolButton } from '../components/common/ToolButton';
import '../components/dashboard/dashboard.css';
import { Tooltip } from '../components/common/Tooltip';

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return PLAIN_NUMBER_FORMAT.format(value);
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}%`;
}

function pickRequests(point: DashboardSeriesPoint): number { return point.v ?? 0; }
function pickTokens(point: DashboardSeriesPoint): number { return point.tokens ?? 0; }
function pickCacheReads(point: DashboardSeriesPoint): number { return point.cache_read ?? 0; }
/** The receipt reads the Insights cube and embeds fonts to export; none of it is paid for until it is opened. */
const loadReceiptShowcase = () => import('../components/dashboard/receipt/ReceiptShowcase');
const preloadReceiptShowcase = () => void loadReceiptShowcase();
const ReceiptShowcase = React.lazy(loadReceiptShowcase);

function pickCost(point: DashboardSeriesPoint): number { return (point.cost_nanos ?? 0) / 1_000_000_000; }
function formatTrendTime(timeMs: number): string { return dayjs(timeMs).format('MM-DD HH:mm'); }

const DashboardTrendChart = React.memo<DashboardTrendChartProps>((props) => (
  <React.Suspense
    fallback={<div className="chart-placeholder" style={{ height: props.height ?? 46 }} aria-hidden="true" />}
  >
    <LazyDashboardTrendChart {...props} />
  </React.Suspense>
));

const Pip: React.FC<{ tone: ChartTone }> = ({ tone }) => (
  <i className={`legend-dot ${tone}`} />
);

function rateTone(successRate: number | null | undefined): ChartTone {
  return successRateTone(successRate);
}

export const DashboardPage: React.FC = () => {
  const timeZone = useTimeZone();
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const rawNavigate = useNavigate();
  const { navigateTo } = useTransitionNavigate(rawNavigate);
  const queryClient = useQueryClient();

  const { data: pricingAttention } = useQuery({
    queryKey: PRICING_QUERY_KEYS.attention,
    queryFn: api.getPricingAttention,
    staleTime: 60_000,
  });
  const unpricedModels = pricingAttention?.unpriced?.length ?? 0;
  const { style: tokenStyle, modelView } = useTokenDisplayStyle();
  const { currency } = useDisplayCurrency();
  const formatTrendCost = React.useCallback((value: number) => formatCurrency(value, currency), [currency]);

  const { value: range, ready: rangeReady, loaded: isRangeStored, set: applyRange } = usePreference<DashboardRange>(
    DASHBOARD_RANGE_PREFERENCE,
    DEFAULT_DASHBOARD_RANGE,
    parseDashboardRange,
  );

  const toast = useToast();
  const layoutPreference = usePreference<DashboardLayout>(
    DASHBOARD_LAYOUT_PREFERENCE,
    DEFAULT_DASHBOARD_LAYOUT,
    parseDashboardLayout,
  );
  const [layoutDraft, setLayoutDraft] = React.useState<DashboardLayout | null>(null);
  const isArranging = layoutDraft !== null;
  const layout = layoutDraft ?? layoutPreference.value;
  const hasCostHidden = layout.some((item) => item.id === 'cost' && item.hidden);
  const saveLayout = React.useCallback(async () => {
    const draft = layoutDraft;
    setLayoutDraft(null);
    if (!draft || sameDashboardLayout(draft, layoutPreference.value)) return;
    const { ok } = await layoutPreference.set(draft);
    if (ok) toast.success(t('dash.layout.saved'));
  }, [layoutDraft, layoutPreference, toast, t]);

  const [selectedApiKey, setSelectedApiKey] = React.useState<string | undefined>(undefined);
  const [isReceiptOpen, setIsReceiptOpen] = React.useState(false);
  const openReceipt = React.useCallback(() => setIsReceiptOpen(true), []);

  const keysQuery = useQuery({
    queryKey: ['management-client-keys'],
    queryFn: () => api.getClientAPIKeys(),
    staleTime: 60_000,
  });

  const clientKeyOptions = React.useMemo(() => {
    return (keysQuery.data?.keys ?? [])
      .filter((k) => Boolean(k.usage_fingerprint))
      .map((k) => ({
        label: k.alias ? `${k.alias} (${maskKeyText(k.key)})` : maskKeyText(k.key),
        value: k.usage_fingerprint as string,
      }));
  }, [keysQuery.data]);

  const rangeParams = dashboardRangeParams(range);
  const query = React.useMemo(() => {
    if (!selectedApiKey) return rangeParams;
    const separator = rangeParams ? `${rangeParams}&` : '';
    return `${separator}api_key=${encodeURIComponent(selectedApiKey)}`;
  }, [rangeParams, selectedApiKey]);

  // The drill-down reads the window the server last resolved, without re-creating the handler
  // on every live tail.
  const latestWindowRef = React.useRef<DashboardWindow | undefined>(undefined);
  const handleDrillDown = React.useCallback(() => {
    const search = requestListWindowParams(range, latestWindowRef.current);
    if (selectedApiKey) {
      search.set('api_key', selectedApiKey);
    }
    navigateTo(`/usage/events?${search.toString()}`);
  }, [range, selectedApiKey, navigateTo]);

  const sliding = isSlidingRange(range);

  const { data: full, isPlaceholderData, isError, error, refetch } = useSwrQuery(
    dashboardWindowSwr,
    query,
    {
      enabled: rangeReady,
      refetchInterval: false,
      // A closed calendar unit is still the server's to move: yesterday is another day once
      // midnight passes, so it is read again on return like a sliding window.
      refetchOnWindowFocus: sliding || isCalendarPreset(range.preset),
    },
  );

  const tailEnabled = rangeReady && sliding && Boolean(full) && !isPlaceholderData;
  const tailBusyRef = React.useRef(false);
  const { revision: tailRevision, notifySettled: notifyTailSettled } = useLiveRevision({
    isEnabled: tailEnabled,
    fallbackPollMs: (full && livePollInterval(full.window.bucket_ms)) || 15_000,
    isBusyRef: tailBusyRef,
  });

  const tailQuery = useSwrQuery(dashboardTailSwr, query, {
    enabled: tailEnabled,
    refetchInterval: full ? livePollInterval(full.window.bucket_ms) : false,
    refetchOnWindowFocus: false,
  });

  const refetchTail = tailQuery.refetch;
  const lastTailRevisionRef = React.useRef(tailRevision);
  React.useEffect(() => {
    if (tailRevision === lastTailRevisionRef.current) return;
    lastTailRevisionRef.current = tailRevision;
    if (tailEnabled) void refetchTail();
  }, [tailRevision, tailEnabled, refetchTail]);

  React.useEffect(() => {
    tailBusyRef.current = tailQuery.isFetching;
    if (!tailQuery.isFetching) notifyTailSettled();
  }, [tailQuery.isFetching, notifyTailSettled]);

  const merged = React.useMemo(() => (full ? applyTail(full, tailQuery.data) : undefined), [full, tailQuery.data]);
  const data = merged?.data;
  // Written once the window commits, so a drill-down never reads one from an abandoned render.
  const committedWindow = data?.window;
  React.useLayoutEffect(() => {
    latestWindowRef.current = committedWindow;
  }, [committedWindow]);
  // A calendar day is a window only the server resolves: until it has answered for this range,
  // the request list has no bounds to open on.
  const canDrillDown = !isCalendarPreset(range.preset) || (Boolean(data) && !isPlaceholderData);

  const bucketMinutes = React.useMemo(() => {
    const ms = data?.window.bucket_ms ?? 0;
    return ms > 0 ? ms / 60_000 : 1;
  }, [data?.window.bucket_ms]);
  const pickRequestRate = React.useCallback((point: DashboardSeriesPoint) => pickRequests(point) / bucketMinutes, [bucketMinutes]);
  const pickTokenRate = React.useCallback((point: DashboardSeriesPoint) => pickTokens(point) / bucketMinutes, [bucketMinutes]);
  const formatRequests = React.useCallback((value: number) => `${formatCount(value)} ${t('dash.unit_requests')}`, [t]);
  const formatTokens = React.useCallback((value: number) => `${formatTokensStyled(value, tokenStyle)} ${t('dash.unit_tokens')}`, [t, tokenStyle]);
  const formatExactTokens = React.useCallback((value: number) => `${formatTokensFull(value)} ${t('dash.unit_tokens')}`, [t]);
  const formatRequestRate = React.useCallback((value: number) => `${value.toFixed(2)} ${t('dash.unit_requests_per_min')}`, [t]);
  const formatTokenRateLabel = React.useCallback((value: number) => `${formatTokenRate(value)} ${t('dash.unit_tokens_per_min')}`, [t]);
  const formatExactTokenRate = React.useCallback((value: number) => `${formatTokensFull(value)} ${t('dash.unit_tokens_per_min')}`, [t]);

  const overviewQuery = useSwrQuery(managementOverviewSwr, undefined, {
    refetchInterval: 30_000,
  });

  const refreshAll = React.useCallback(() => {
    void invalidateSwrScopes(queryClient, 'dashboard');
    void queryClient.invalidateQueries({ queryKey: [TOKEN_HEATMAP_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: [DASHBOARD_MODELS_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-providers'] });
    void queryClient.invalidateQueries({ queryKey: [CREDENTIAL_FILES_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: [CREDENTIAL_QUOTA_QUERY_KEY] });
    void refetch();
  }, [queryClient, refetch]);

  const healRef = React.useRef(0);
  React.useEffect(() => {
    if (!merged?.broken) return;
    const now = Date.now();
    if (now - healRef.current < 3000) return;
    healRef.current = now;
    void refetch();
  }, [merged?.broken, refetch]);

  const arrangeActions = (
    <>
      <Button onClick={() => setLayoutDraft(DEFAULT_DASHBOARD_LAYOUT)} data-testid="dashboard-layout-reset">
        {t('dash.layout.reset')}
      </Button>
      <Button onClick={() => setLayoutDraft(null)}>{t('common.cancel')}</Button>
      <Button variant="primary" onClick={() => void saveLayout()} data-testid="dashboard-layout-done">
        {t('dash.layout.done')}
      </Button>
    </>
  );

  const header = (
    <PageHeader
      title={t('nav.dashboard')}
      mobileActions={isArranging ? arrangeActions : (
        <>
          <TimeRangeControl range={range} onChange={applyRange} isDisabled={!isRangeStored} />
          <ActionMenu>
            {hasCostHidden && (
              <ToolButton
                icon={<ReceiptOutlined />}
                label={t('dash.receipt.open')}
                onClick={openReceipt}
                disabled={!data}
              />
            )}
            <ToolButton
              icon={<HistoryOutlined />}
              label={t('nav.usage_events')}
              onMouseEnter={() => preloadRegisteredRoute('/usage/events')}
              onFocus={() => preloadRegisteredRoute('/usage/events')}
              onClick={handleDrillDown}
              disabled={!canDrillDown}
            />
            <ToolButton
              icon={<AppstoreOutlined />}
              label={t('dash.layout.arrange')}
              onMouseEnter={preloadDashboardBoardEditor}
              onFocus={preloadDashboardBoardEditor}
              onClick={() => setLayoutDraft(layout)}
              disabled={!data}
            />
          </ActionMenu>
          {clientKeyOptions.length > 0 && (
            <Select
              allowClear
              className="dashboard-key-filter"
              placeholder={t('dash.filter_by_key')}
              value={selectedApiKey}
              onChange={setSelectedApiKey}
              options={clientKeyOptions}
              prefix={<KeyOutlined className="dashboard-key-filter-icon" />}
            />
          )}
        </>
      )}
      actions={isArranging ? arrangeActions : (
        <>
          <TimeRangeControl range={range} onChange={applyRange} isDisabled={!isRangeStored} />
          {clientKeyOptions.length > 0 && (
            <Select
              allowClear
              className="dashboard-key-filter"
              placeholder={t('dash.filter_by_key')}
              value={selectedApiKey}
              onChange={(val) => setSelectedApiKey(val)}
              options={clientKeyOptions}
              prefix={<KeyOutlined className="dashboard-key-filter-icon" />}
            />
          )}
          {/* With the cost tile hidden, its receipt link moves to the toolbar. */}
          {hasCostHidden && (
            <ToolButton
              icon={<ReceiptOutlined />}
              label={t('dash.receipt.open')}
              onMouseEnter={preloadReceiptShowcase}
              onFocus={preloadReceiptShowcase}
              onClick={openReceipt}
              disabled={!data}
            />
          )}
          <ToolButton
            icon={<HistoryOutlined />}
            label={t('nav.usage_events')}
            onMouseEnter={() => preloadRegisteredRoute('/usage/events')}
            onFocus={() => preloadRegisteredRoute('/usage/events')}
            onClick={handleDrillDown}
            disabled={!canDrillDown}
          />
          <ToolButton
            icon={<AppstoreOutlined />}
            label={t('dash.layout.arrange')}
            onMouseEnter={preloadDashboardBoardEditor}
            onFocus={preloadDashboardBoardEditor}
            onClick={() => setLayoutDraft(layout)}
            disabled={!data}
            data-testid="dashboard-layout-arrange"
          />
        </>
      )}
    />
  );

  if (!data && isError) {
    return (
      <div className="terminal-page dashboard-page">
        <PageHeader title={t('nav.dashboard')} />
        <LoadFailure
          title={t('dash.error_title')}
          detail={error instanceof ApiError ? error.message : t('dash.error_desc')}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const hasWarmRouting = Boolean(queryClient.getQueryData(ROUTING_WINDOW_CACHE_KEY));
  const hasWarmModels = Boolean(dashboardModelsSwr.readSnapshot(queryClient, withGroupBy(query, modelView)));
  const hasWarmHeatmap = Boolean(dashboardHeatmapSwr.readSnapshot(queryClient, timeZone));
  const hasWarmQuota = Boolean(queryClient.getQueryData([CREDENTIAL_FILES_QUERY_KEY]));
  const hasModelUsageHidden = layout.some((item) => item.id === 'model_usage' && item.hidden);

  const renderWidget = (id: DashboardWidgetId): React.ReactNode => {
    switch (id) {
      case 'requests':
        if (!data) return <DashboardKpiTilePlaceholder id="requests" index={0} />;
        return (
          <Panel className="dashboard-tile kpi-tile">
            <div className="tile-head">
              <div className="tile-label">{t('dash.total_requests')}</div>
              <Button
                variant="link"
                size="sm"
                className="tile-link"
                icon={<RightOutlined />}
                onMouseEnter={() => preloadRegisteredRoute('/usage/events')}
                onClick={handleDrillDown}
                disabled={!canDrillDown}
              >
                {t('nav.usage_events')}
              </Button>
            </div>
            <div className="tile-value">
              <RollingNumber readout={resolveCountFlowReadout(data.requests.total)} />
            </div>
            <div className="tile-caption">
              <span className="tile-rate">
                <Pip tone={rateTone(data.requests.success_rate)} />
                {t('dash.success_rate_short')} <b>{formatRate(data.requests.success_rate)}</b>
              </span>
              <span className="tile-split">
                <span>{t('dash.success_label')} <b>{formatCount(data.requests.success)}</b></span>
                <span className={data.requests.failed > 0 ? 'is-danger' : 'is-zero'}>
                  {t('dash.failure_label')} <b>{formatCount(data.requests.failed)}</b>
                </span>
              </span>
            </div>
            <DashboardTrendChart
              ariaLabel={t('dash.total_requests')}
              points={data.requests.series}
              pick={pickRequests}
              tone="accent"
              height={64}
              label={formatTrendTime}
              format={formatRequests}
            />
          </Panel>
        );
      case 'tokens':
        if (!data) return <DashboardKpiTilePlaceholder id="tokens" index={1} />;
        return (
          <Panel className="dashboard-tile kpi-tile">
            <div className="tile-label">{t('dash.total_tokens')}</div>
            <div className="tile-value" data-tip={formatTokensFull(data.tokens.total)}>
              <RollingNumber readout={resolveTokenFlowReadout(data.tokens.total, tokenStyle)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.tokens_input')} <b data-tip={formatTokensFull(data.tokens.input)}>{formatTokensStyled(data.tokens.input, tokenStyle)}</b></span>
              <span>{t('dash.tokens_output')} <b data-tip={formatTokensFull(data.tokens.output)}>{formatTokensStyled(data.tokens.output, tokenStyle)}</b></span>
              <span>{t('dash.tokens_cache_read')} <b data-tip={formatTokensFull(data.tokens.cache_read)}>{formatTokensStyled(data.tokens.cache_read, tokenStyle)}</b></span>
              {data.tokens.reasoning > 0 && (
                <span>{t('dash.tokens_reasoning')} <b data-tip={formatTokensFull(data.tokens.reasoning)}>{formatTokensStyled(data.tokens.reasoning, tokenStyle)}</b></span>
              )}
            </div>
            <DashboardTrendChart
              ariaLabel={t('dash.total_tokens')}
              points={data.tokens.series}
              pick={pickTokens}
              tone="accent"
              height={64}
              label={formatTrendTime}
              format={formatTokens}
              formatExact={formatExactTokens}
            />
          </Panel>
        );
      case 'rpm':
        if (!data) return <DashboardKpiTilePlaceholder id="rpm" index={2} />;
        return (
          <Panel className="dashboard-tile kpi-tile">
            <div className="tile-label">{t('dash.rpm')}</div>
            <div className="tile-value">
              <RollingNumber readout={resolveCountFlowReadout(data.metrics.rpm)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.total_requests')} <b>{formatCount(data.requests.total)}</b></span>
            </div>
            <DashboardTrendChart
              ariaLabel={t('dash.rpm')}
              points={data.requests.series}
              pick={pickRequestRate}
              tone="success"
              height={44}
              label={formatTrendTime}
              format={formatRequestRate}
            />
          </Panel>
        );
      case 'tpm':
        if (!data) return <DashboardKpiTilePlaceholder id="tpm" index={3} />;
        return (
          <Panel className="dashboard-tile kpi-tile">
            <div className="tile-label">{t('dash.tpm')}</div>
            <div className="tile-value" data-tip={data.metrics.tpm == null ? undefined : `${formatTokensFull(data.metrics.tpm)} ${t('dash.unit_tokens_per_min')}`}>
              <RollingNumber readout={resolveTokenRateFlowReadout(data.metrics.tpm)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.total_tokens')} <b data-tip={formatTokensFull(data.tokens.total)}>{formatTokensStyled(data.tokens.total, tokenStyle)}</b></span>
            </div>
            <DashboardTrendChart
              ariaLabel={t('dash.tpm')}
              points={data.tokens.series}
              pick={pickTokenRate}
              tone="warn"
              height={44}
              label={formatTrendTime}
              format={formatTokenRateLabel}
              formatExact={formatExactTokenRate}
            />
          </Panel>
        );
      case 'cache_rate':
        if (!data) return <DashboardKpiTilePlaceholder id="cache_rate" index={4} />;
        return (
          <Panel className="dashboard-tile kpi-tile">
            <div className="tile-label">
              {t('dash.cache_rate')}
              <Tooltip title={t('dash.cache_rate_hint')}>
                <QuestionCircleOutlined className="tile-help" />
              </Tooltip>
            </div>
            <div className="tile-value">
              <RollingNumber readout={resolveCacheRateReadout(data.metrics.cache_rate)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.tokens_cache_read')} <b data-tip={formatTokensFull(data.tokens.cache_read)}>{formatTokensStyled(data.tokens.cache_read, tokenStyle)}</b></span>
              <span>{t('dash.tokens_input')} <b data-tip={formatTokensFull(data.tokens.input)}>{formatTokensStyled(data.tokens.input, tokenStyle)}</b></span>
            </div>
            <DashboardTrendChart
              ariaLabel={t('dash.cache_rate')}
              points={data.tokens.series}
              pick={pickCacheReads}
              tone="neutral"
              height={44}
              label={formatTrendTime}
              format={formatTokens}
              formatExact={formatExactTokens}
            />
          </Panel>
        );
      case 'cost':
        if (!data) return <DashboardKpiTilePlaceholder id="cost" index={5} />;
        return (
          <Panel className="dashboard-tile kpi-tile">
            <div className="tile-head">
              <div className="tile-label">
                {t('dash.total_cost')}
                <Tooltip title={t('dash.cost_hint')}>
                  <QuestionCircleOutlined className="tile-help" />
                </Tooltip>
              </div>
              {/* The receipt is offered where the spend is read, with the same weight as the requests tile's link. */}
              <Button
                variant="link"
                size="sm"
                className="tile-link"
                icon={<ReceiptOutlined />}
                onMouseEnter={preloadReceiptShowcase}
                onFocus={preloadReceiptShowcase}
                onClick={openReceipt}
                data-testid="dashboard-receipt"
              >
                {t('dash.receipt.open')}
              </Button>
            </div>
            <div className="tile-value">
              <RollingNumber readout={currencyReadout(data.metrics.cost, currency)} />
            </div>
            <div className="tile-caption">
              <span>{costNoteKey(data.metrics.cost_source) ? t(costNoteKey(data.metrics.cost_source)!) : ''}</span>
              {unpricedModels > 0 && data.metrics.cost_source !== 'estimated' && (
                <Button
                  variant="link"
                  size="sm"
                  className="tile-caption-link"
                  onMouseEnter={() => preloadRegisteredRoute('/pricing')}
                  onClick={() => navigateTo('/pricing')}
                  data-testid="dashboard-unpriced-link"
                >
                  {t('dash.cost_unpriced_models', { n: unpricedModels })}
                </Button>
              )}
            </div>
            <DashboardTrendChart
              ariaLabel={t('dash.total_cost')}
              points={data.tokens.series}
              pick={pickCost}
              tone="neutral"
              height={44}
              label={formatTrendTime}
              format={formatTrendCost}
            />
          </Panel>
        );
      case 'routing':
        return (
          <DeferredPanel
            priority="p1"
            immediate={hasWarmRouting || isArranging}
            fallback={(
              <Panel className="dashboard-tile">
                <Placeholder width="24%" className="placeholder-line is-meta" />
                <Placeholder width="100%" height={260} className="tile-placeholder-spark" />
              </Panel>
            )}
          >
            <RoutingPanel />
          </DeferredPanel>
        );
      case 'model_trend':
        return (
          <DeferredPanel
            priority="p1"
            immediate={hasWarmModels || isArranging}
            fallback={(
              <Panel className="dashboard-tile">
                <Placeholder width="32%" className="placeholder-line is-meta" />
                <Placeholder width="100%" height={220} className="tile-placeholder-spark" />
              </Panel>
            )}
          >
            <ModelTrendPanel
              query={query}
              range={range}
              enabled={rangeReady}
              hasViewToggle={hasModelUsageHidden}
            />
          </DeferredPanel>
        );
      case 'model_usage':
        return (
          <DeferredPanel
            priority="p1"
            immediate={hasWarmModels || isArranging}
            fallback={(
              <Panel className="dashboard-tile">
                <Placeholder width="32%" className="placeholder-line is-meta" />
                <Placeholder width="100%" height={220} className="tile-placeholder-spark" />
              </Panel>
            )}
          >
            <ModelUsagePanel query={query} range={range} enabled={rangeReady} />
          </DeferredPanel>
        );
      case 'token_activity':
        return (
          <DeferredPanel
            priority="p2"
            immediate={hasWarmHeatmap || isArranging}
            fallback={(
              <Panel className="dashboard-tile heatmap-panel">
                <div className="heatmap-inner">
                  <div className="heatmap-head">
                    <span className="tile-label">{t('dash.heatmap.title')}</span>
                  </div>
                  <div className="heatmap-skeleton" aria-hidden="true" />
                </div>
              </Panel>
            )}
          >
            <TokenHeatmap />
          </DeferredPanel>
        );
      case 'credential_quota':
        return (
          <DeferredPanel
            priority="p2"
            immediate={hasWarmQuota || isArranging}
            fallback={(
              <Panel className="dashboard-tile credential-quota-panel">
                <Placeholder width="36%" className="placeholder-line is-meta" />
                <Placeholder width="100%" height={156} className="tile-placeholder-spark" />
              </Panel>
            )}
          >
            <CredentialQuota />
          </DeferredPanel>
        );
      case 'providers':
        return overviewQuery.data ? (
          <DeferredPanel priority="p2" immediate={Boolean(overviewQuery.data) || isArranging}>
            <DashboardProviders overview={overviewQuery.data} query={query} range={range} enabled={rangeReady} />
          </DeferredPanel>
        ) : null;
    }
  };

  return (
    <div className="terminal-page dashboard-page">
      {header}

      {data && data.partial_errors.length > 0 && (
        <LoadFailure
          className="dashboard-alert"
          tone="warning"
          title={t('dash.partial_title')}
          detail={data.partial_errors.join(' · ')}
          onRetry={refreshAll}
        />
      )}

      <ModelSeriesFocusProvider>
        <LoadingRegion isLoading={!data}>
          <DashboardBoard
            layout={layout}
            isEditing={isArranging}
            isPhone={isPhone}
            renderWidget={renderWidget}
            onChange={setLayoutDraft}
          />
        </LoadingRegion>
      </ModelSeriesFocusProvider>

      {data && !data.coverage.has_usage && data.partial_errors.length === 0 && (
        <div className="terminal-panel dashboard-empty">
          <EmptyState title={t('dash.empty_title')} description={t('dash.empty_desc')} />
        </div>
      )}

      {data && (
        <div className="dashboard-footnote">
          <span>{t('dash.window_minutes', { n: data.window.minutes })}</span>
        </div>
      )}

      {isReceiptOpen && (
        <React.Suspense fallback={null}>
          <ReceiptShowcase
            range={range}
            onClose={() => setIsReceiptOpen(false)}
            keyFilter={selectedApiKey
              ? { id: selectedApiKey, label: clientKeyOptions.find((option) => option.value === selectedApiKey)?.label ?? selectedApiKey }
              : undefined}
          />
        </React.Suspense>
      )}
    </div>
  );
};

export type { DashboardResponse };
