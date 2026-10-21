import { ActionMenu } from '../components/common/ActionMenu';
import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Select, Tooltip } from 'antd';
import { AppstoreOutlined, HistoryOutlined, KeyOutlined, QuestionCircleOutlined, RightOutlined } from '../components/icons';
import { PageHeader } from '../components/common/PageHeader';
import { LoadingRegion, Placeholder } from '../components/common/Placeholder';
import { RefreshButton } from '../components/common/RefreshButton';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from '../utils/time';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { PRICING_QUERY_KEYS } from '../components/pricing/pricingQueries';
import { usePreference } from '../hooks/usePreference';
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport';
import { type ChartTone } from '../charts/chartTheme';
import { type DashboardTrendChartProps } from '../charts/DashboardTrendChart';
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
import type { RollingReadout } from '../types/rollingNumber';
import { successRateTone } from '../types/usageEventMetrics';
import { TimeRangeControl } from '../components/dashboard/TimeRangeControl';
import { RollingNumber } from '../components/dashboard/RollingNumber';
import { TokenHeatmap, TOKEN_HEATMAP_QUERY_KEY } from '../components/dashboard/TokenHeatmap';
import { RoutingPanel } from '../components/dashboard/routing/RoutingPanel';
import {
  CredentialQuota,
  CREDENTIAL_FILES_QUERY_KEY,
  CREDENTIAL_QUOTA_QUERY_KEY,
} from '../components/dashboard/CredentialQuota';
import { ModelTrendPanel, ModelUsagePanel, DASHBOARD_MODELS_QUERY_KEY } from '../components/dashboard/ModelUsagePanels';
import { DashboardBoard } from '../components/dashboard/DashboardBoard';
import { DashboardProviders } from '../components/dashboard/DashboardProviders';
import {
  applyTail,
  DASHBOARD_RANGE_PREFERENCE,
  dashboardRangeParams,
  DEFAULT_DASHBOARD_RANGE,
  isSlidingRange,
  requestListPreset,
  livePollInterval,
  parseDashboardRange,
  costNoteKey,
  type DashboardRange,
  type DashboardResponse,
  type DashboardSeriesPoint,
} from '../types/dashboard';
import {
  DASHBOARD_LAYOUT_PREFERENCE,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardWidgetSpec,
  parseDashboardLayout,
  sameDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetId,
} from '../types/dashboardLayout';
import { LoadFailure, useToast } from '../components/feedback';
import { EmptyState } from '../components/common/EmptyState';
import { Panel } from '../components/common/Panel';
import { ToolButton } from '../components/common/ToolButton';
import '../components/dashboard/dashboard.css';

const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return PLAIN_NUMBER_FORMAT.format(value);
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}%`;
}

/**
 * The spend tile's own reading: two decimals.
 *
 * `formatCost` keeps four because a list row's fraction of a cent has to stay
 * visible; a headline amount reads as money at two.
 */
function resolveTileCostReadout(cost: number): RollingReadout {
  return {
    number: cost,
    prefix: '$',
    suffix: '',
    format: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  };
}

// Parent query status changes must not turn unchanged series into G2 revisions.
function pickRequests(point: DashboardSeriesPoint): number { return point.v ?? 0; }
function pickTokens(point: DashboardSeriesPoint): number { return point.tokens ?? 0; }
function pickCacheReads(point: DashboardSeriesPoint): number { return point.cache_read ?? 0; }
function pickCost(point: DashboardSeriesPoint): number { return (point.cost_nanos ?? 0) / 1_000_000_000; }
function formatTrendTime(timeMs: number): string { return dayjs(timeMs).format('MM-DD HH:mm'); }
function formatTrendCost(value: number): string { return `$${value.toFixed(2)}`; }

const LazyDashboardTrendChart = React.lazy(() =>
  import('../charts/DashboardTrendChart').then((m) => ({ default: m.DashboardTrendChart }))
);

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

/**
 * rateTone gives the tile's only pip something to mean.
 *
 * design.md reserves green/amber/red for real state, so one pip per verdict, and the band comes
 * from `successRateTone` - the console's single published rate rule, which the dashboard's provider
 * rows read too. 80% or better is a gateway serving well enough not to need a look, 50-80% is
 * degraded, below that is broken, and a window with no traffic carries no verdict at all rather
 * than reading as a fault. See docs/design.md §Status pip semantics.
 */
function rateTone(successRate: number | null | undefined): ChartTone {
  return successRateTone(successRate);
}


export const DashboardPage: React.FC = () => {
  useTimeZone();
  const t = useT();
  const isPhone = useIsPhoneViewport();
  const navigate = useNavigate();
  // Shared with the navigation's attention mark, so the dashboard adds no request of its own.
  const { data: pricingAttention } = useQuery({
    queryKey: PRICING_QUERY_KEYS.attention,
    queryFn: api.getPricingAttention,
    staleTime: 60_000,
  });
  const unpricedModels = pricingAttention?.unpriced?.length ?? 0;
  // The console's token unit style: one setting shared with the model panels and
  // the request records, so every token readout on this page follows it.
  const { style: tokenStyle } = useTokenDisplayStyle();
  // The chosen window is the operator's working context, so it lives in the
  // database: a reload, a service restart and a container rebuild all drop
  // browser storage, and none of them should reset what they are looking at.
  // Nothing is fetched for a window that has not been read yet either: painting
  // the default and correcting it a moment later would show the wrong numbers
  // first, which is worse than a few extra milliseconds of skeleton.
  const { value: range, ready: rangeReady, set: applyRange } = usePreference<DashboardRange>(
    DASHBOARD_RANGE_PREFERENCE,
    DEFAULT_DASHBOARD_RANGE,
    parseDashboardRange,
  );

  // The board's arrangement is the operator's too, and lives beside the window for the same reason.
  // Arranging works on a draft: a half-made arrangement is never stored, and Cancel is just
  // dropping it.
  const toast = useToast();
  const layoutPreference = usePreference<DashboardLayout>(
    DASHBOARD_LAYOUT_PREFERENCE,
    DEFAULT_DASHBOARD_LAYOUT,
    parseDashboardLayout,
  );
  const [layoutDraft, setLayoutDraft] = React.useState<DashboardLayout | null>(null);
  const isArranging = layoutDraft !== null;
  const layout = layoutDraft ?? layoutPreference.value;
  const saveLayout = React.useCallback(async () => {
    const draft = layoutDraft;
    setLayoutDraft(null);
    if (!draft || sameDashboardLayout(draft, layoutPreference.value)) return;
    const { ok } = await layoutPreference.set(draft);
    if (ok) toast.success(t('dash.layout.saved'));
  }, [layoutDraft, layoutPreference, toast, t]);

  const [selectedApiKey, setSelectedApiKey] = React.useState<string | undefined>(undefined);

  const keysQuery = useQuery({
    // The masked list: this picker labels a key by its name or its mask, so it has no
    // use for the value, and it keeps the bare query key the key page deliberately does
    // not share - that page opts into the values and must not read a masked entry.
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

  const handleDrillDown = React.useCallback(() => {
    const search = new URLSearchParams();
    if (range.preset) search.set('preset', requestListPreset(range.preset));
    else if (range.from !== undefined) {
      search.set('from', String(range.from));
      if (typeof range.to === 'number') search.set('to', String(range.to));
    }
    if (selectedApiKey) {
      search.set('api_key', selectedApiKey);
    }
    navigate(`/usage/events?${search.toString()}`);
  }, [range, selectedApiKey, navigate]);

  // A relative preset and an open-ended (through-now) range both move with the
  // clock, so both are worth polling; a closed range is frozen.
  const sliding = isSlidingRange(range);

  // The full window is fetched on mount, on range change, on manual refresh and
  // whenever a tail poll finds it cannot be patched. Everything in between is
  // the tail endpoint: whole-window numbers, a few buckets of series.
  const { data: full, isFetching, isPlaceholderData, isError, error, refetch } = useQuery({
    queryKey: ['dashboard', query],
    queryFn: () => api.getDashboard(query),
    enabled: rangeReady,
    refetchInterval: false,
    refetchOnWindowFocus: sliding,
    staleTime: 10000,
    // Keep the previous window rendered while the next one loads. Without this
    // every preset change unmounts the tiles and the page flashes empty.
    placeholderData: keepPreviousData,
  });

  const { data: tail } = useQuery({
    queryKey: ['dashboard-tail', query],
    queryFn: () => api.getDashboardTail(query),
    // While a preset switch is still in flight, `full` is the *previous*
    // window held by keepPreviousData — patching a new tail onto it would mix
    // two windows on screen.
    enabled: rangeReady && sliding && Boolean(full) && !isPlaceholderData,
    // Paced to the resolution being served, and paused while the tab is hidden
    // (react-query's default). Coming back from a long sleep is handled below:
    // the splice refuses to leave a hole and asks for the full window instead.
    refetchInterval: full ? livePollInterval(full.window.bucket_ms) : false,
    refetchOnWindowFocus: false,
    meta: { silent: true },
    staleTime: 0,
  });

  const merged = React.useMemo(() => (full ? applyTail(full, tail) : undefined), [full, tail]);
  const data = merged?.data;
  // Bucket width in minutes. Rates are per minute, so this is what turns a
  // bucket's volume into the rate its tile names.
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
  // Refresh reaches the strip below as well as the tiles. The strip owns its own query
  // - its span is a fixed fifty-three weeks rather than this window - so invalidating it by
  // key prefix is what keeps one button meaning "re-read this page". Today's total in
  // particular keeps growing, so a refresh that left the one panel tracking the current
  // day stale would be lying about what it did.
  const overviewQuery = useQuery({
    queryKey: ['management-overview'],
    queryFn: api.getManagementOverview,
    refetchInterval: 30000,
    meta: { silent: true },
    staleTime: 10000,
    placeholderData: keepPreviousData,
  });

  const queryClient = useQueryClient();
  const refreshAll = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [TOKEN_HEATMAP_QUERY_KEY] });
    // The model panels own a query of their own as well, and they are ordered by the same button's
    // meaning - re-read this page. A refresh that left a ranking on screen from a minute ago would
    // be answering a question nobody asked it.
    void queryClient.invalidateQueries({ queryKey: [DASHBOARD_MODELS_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-providers'] });
    void queryClient.invalidateQueries({ queryKey: ['management-overview'] });
    void queryClient.invalidateQueries({ queryKey: [CREDENTIAL_FILES_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: [CREDENTIAL_QUOTA_QUERY_KEY] });
    void refetch();
  }, [queryClient, refetch]);

  const healRef = React.useRef(0);
  React.useEffect(() => {
    if (!merged?.broken) return;
    // Rate-limited because a refetch does not clear the stale tail that made
    // the splice refuse; without this the two would chase each other.
    const now = Date.now();
    if (now - healRef.current < 3000) return;
    healRef.current = now;
    void refetch();
  }, [merged?.broken, refetch]);

  if (!data) {
    if (isError) {
      return (
        <div className="terminal-page dashboard-page">
          <PageHeader
            title={t('nav.dashboard')}
            actions={<RefreshButton isLabelled label={t('common.retry')} onRefresh={() => void refetch()} />}
          />
          <LoadFailure
            title={t('dash.error_title')}
            detail={error instanceof ApiError ? error.message : t('dash.error_desc')}
            onRetry={() => void refetch()}
          />
        </div>
      );
    }
    // First load: keep the real page frame and draw each tile's own readouts - label, number,
    // sparkline - where they will land, in the operator's arrangement, so nothing swaps in abruptly
    // once data arrives. The panels below the tiles read on their own and are mounted with the page.
    const loadingTiles = layout.filter((item) => !item.hidden && dashboardWidgetSpec(item.id).isMetric);
    return (
      <div className="terminal-page dashboard-page">
        <PageHeader title={t('nav.dashboard')} subtitle={t('dash.loading')} />
        <LoadingRegion className="dashboard-grid">
          {loadingTiles.map((item, index) => (
            <div key={item.id} className="dashboard-cell" data-span={item.span}>
              {item.span > 1 ? (
                <Panel className="dashboard-tile">
                  <Placeholder width="28%" row={index} className="placeholder-line is-meta" />
                  <Placeholder width="42%" height={34} row={index + 1} className="tile-placeholder-hero" />
                  <Placeholder width="100%" height={44} row={index + 2} className="tile-placeholder-spark" />
                </Panel>
              ) : (
                <Panel className="dashboard-tile">
                  <Placeholder width="46%" row={index + 2} className="placeholder-line is-meta" />
                  <Placeholder width="58%" height={24} row={index + 3} className="tile-placeholder-value" />
                  <Placeholder width="72%" row={index + 4} className="placeholder-line is-meta" />
                </Panel>
              )}
            </div>
          ))}
        </LoadingRegion>
      </div>
    );
  }

  const renderWidget = (id: DashboardWidgetId): React.ReactNode => {
    switch (id) {
      case 'requests':
        return (
          <Panel className="dashboard-tile">
            <div className="tile-head">
              <div className="tile-label">{t('dash.total_requests')}</div>
              <Button
                type="link"
                size="small"
                className="tile-link"
                icon={<RightOutlined />}
                onClick={handleDrillDown}
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
        return (
          <Panel className="dashboard-tile">
            <div className="tile-label">{t('dash.total_tokens')}</div>
            <div className="tile-value" title={formatTokensFull(data.tokens.total)}>
              <RollingNumber readout={resolveTokenFlowReadout(data.tokens.total, tokenStyle)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.tokens_input')} <b title={formatTokensFull(data.tokens.input)}>{formatTokensStyled(data.tokens.input, tokenStyle)}</b></span>
              <span>{t('dash.tokens_output')} <b title={formatTokensFull(data.tokens.output)}>{formatTokensStyled(data.tokens.output, tokenStyle)}</b></span>
              <span>{t('dash.tokens_cache_read')} <b title={formatTokensFull(data.tokens.cache_read)}>{formatTokensStyled(data.tokens.cache_read, tokenStyle)}</b></span>
              {data.tokens.reasoning > 0 && (
                <span>{t('dash.tokens_reasoning')} <b title={formatTokensFull(data.tokens.reasoning)}>{formatTokensStyled(data.tokens.reasoning, tokenStyle)}</b></span>
              )}
            </div>
            <DashboardTrendChart
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
        return (
          <Panel className="dashboard-tile">
            <div className="tile-label">{t('dash.rpm')}</div>
            <div className="tile-value is-small">
              <RollingNumber readout={resolveCountFlowReadout(data.metrics.rpm)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.total_requests')} <b>{formatCount(data.requests.total)}</b></span>
            </div>
            {/* Per-minute rate, so the readout under an RPM label is an RPM and not
                a raw bucket count. The tile's own value is a rate too. */}
            <DashboardTrendChart
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
        return (
          <Panel className="dashboard-tile">
            <div className="tile-label">{t('dash.tpm')}</div>
            <div className="tile-value is-small" title={data.metrics.tpm == null ? undefined : `${formatTokensFull(data.metrics.tpm)} ${t('dash.unit_tokens_per_min')}`}>
              <RollingNumber readout={resolveTokenRateFlowReadout(data.metrics.tpm)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.total_tokens')} <b title={formatTokensFull(data.tokens.total)}>{formatTokensStyled(data.tokens.total, tokenStyle)}</b></span>
            </div>
            {/* TPM is a rate, not the token volume the tile above already plots:
                dividing by the bucket's minutes is what makes this tile a distinct
                reading rather than a restatement of Token total. */}
            <DashboardTrendChart
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
        return (
          <Panel className="dashboard-tile">
            <div className="tile-label">
              {t('dash.cache_rate')}
              <Tooltip title={t('dash.cache_rate_hint')}>
                <QuestionCircleOutlined className="tile-help" />
              </Tooltip>
            </div>
            <div className="tile-value is-small">
              <RollingNumber readout={resolveCacheRateReadout(data.metrics.cache_rate)} />
            </div>
            <div className="tile-caption">
              <span>{t('dash.tokens_cache_read')} <b title={formatTokensFull(data.tokens.cache_read)}>{formatTokensStyled(data.tokens.cache_read, tokenStyle)}</b></span>
              <span>{t('dash.tokens_input')} <b title={formatTokensFull(data.tokens.input)}>{formatTokensStyled(data.tokens.input, tokenStyle)}</b></span>
            </div>
            {/* The bar chart is the token volume behind the rate, and its hue is
                the tile's identity colour. It used to turn danger red when the
                hit rate fell under 50%, which design.md forbids: a cache miss is
                the shape of a novel prompt, not a failed execution, and the
                danger hue belongs to failed requests. The rate itself is read
                from the badge above, which owns the cache scale. */}
            {/* The mark shows the cache reads behind the rate. A rate needs both
                its terms, and this series carries only the numerator, so plotting
                the ratio itself would invent a denominator from total tokens -
                which would overstate the rate whenever output tokens were large. */}
            <DashboardTrendChart
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
        return (
          <Panel className="dashboard-tile">
            <div className="tile-label">
              {t('dash.total_cost')}
              <Tooltip title={t('dash.cost_hint')}>
                <QuestionCircleOutlined className="tile-help" />
              </Tooltip>
            </div>
            <div className="tile-value is-small">
              <RollingNumber readout={resolveTileCostReadout(data.metrics.cost)} />
            </div>
            <div className="tile-caption">
              {/* The backend distinguishes a complete total from a partial estimate and
                  from a window with nothing priced; the caption follows that, and a
                  complete total carries none. When models are unpriced right now, the
                  caption leads to the price book, where the operator can set their prices. */}
              <span>{costNoteKey(data.metrics.cost_source) ? t(costNoteKey(data.metrics.cost_source)!) : ''}</span>
              {unpricedModels > 0 && data.metrics.cost_source !== 'estimated' && (
                <Button type="link" size="small" className="tile-caption-link" onClick={() => navigate('/pricing')} data-testid="dashboard-unpriced-link">
                  {t('dash.cost_unpriced_models', { n: unpricedModels })}
                </Button>
              )}
            </div>
            {/* Priced spend per bucket. Unpriced requests contribute nothing, which
                is why the tile keeps its cost_source note rather than implying the
                spend curve is complete. */}
            <DashboardTrendChart
              points={data.tokens.series}
              pick={pickCost}
              tone="neutral"
              height={44}
              label={formatTrendTime}
              format={formatTrendCost}
            />
          </Panel>
        );
      // Live, and outside the time-range control's reach: the routing panel holds a rolling minute of
      // its own and reads whenever a request is stored, so it answers "which model is going to which
      // credential right now" whatever window the tiles show. A phone does not mount it (the board
      // leaves it out there): the map needs its three columns to say anything, and a reduced list
      // would only repeat the request list, so the phone skips its reads and live connection too.
      case 'routing':
        return <RoutingPanel />;
      // The window the tiles describe, read at model granularity - inside the window picker's reach,
      // unlike the activity grid, which owns a fixed fifty-three weeks.
      case 'model_trend':
        return (
          <ModelTrendPanel
            query={query}
            range={range}
            enabled={rangeReady}
            hasViewToggle={layout.some((item) => item.id === 'model_usage' && item.hidden)}
          />
        );
      case 'model_usage':
        return <ModelUsagePanel query={query} range={range} enabled={rangeReady} />;
      case 'token_activity':
        return <TokenHeatmap />;
      case 'credential_quota':
        return <CredentialQuota />;
      case 'providers':
        return overviewQuery.data ? (
          <DashboardProviders overview={overviewQuery.data} query={query} range={range} enabled={rangeReady} />
        ) : null;
    }
  };

  const arrangeActions = (
    <>
      <Button onClick={() => setLayoutDraft(DEFAULT_DASHBOARD_LAYOUT)} data-testid="dashboard-layout-reset">
        {t('dash.layout.reset')}
      </Button>
      <Button onClick={() => setLayoutDraft(null)}>{t('common.cancel')}</Button>
      <Button type="primary" onClick={() => void saveLayout()} data-testid="dashboard-layout-done">
        {t('dash.layout.done')}
      </Button>
    </>
  );

  return (
    <div className="terminal-page dashboard-page">
      <PageHeader
        title={t('nav.dashboard')}
        mobileActions={isArranging ? arrangeActions : (
          <>
            <TimeRangeControl range={range} onChange={applyRange} />
            <ActionMenu>
              <ToolButton icon={<HistoryOutlined />} label={t('nav.usage_events')} onClick={handleDrillDown} />
              <RefreshButton label={t('header.refresh_all')} isRefreshing={isFetching} onRefresh={refreshAll} />
              <ToolButton icon={<AppstoreOutlined />} label={t('dash.layout.arrange')} onClick={() => setLayoutDraft(layout)} />
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
            <TimeRangeControl range={range} onChange={applyRange} />
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
            <ToolButton icon={<HistoryOutlined />} label={t('nav.usage_events')} onClick={handleDrillDown} />
            <ToolButton
              icon={<AppstoreOutlined />}
              label={t('dash.layout.arrange')}
              onClick={() => setLayoutDraft(layout)}
              data-testid="dashboard-layout-arrange"
            />
            <RefreshButton label={t('header.refresh_all')} isRefreshing={isFetching} onRefresh={refreshAll} />
          </>
        )}
      />

      {data.partial_errors.length > 0 && (
        <LoadFailure
          className="dashboard-alert"
          tone="warning"
          title={t('dash.partial_title')}
          detail={data.partial_errors.join(' · ')}
          onRetry={refreshAll}
        />
      )}

      <DashboardBoard
        layout={layout}
        isEditing={isArranging}
        isPhone={isPhone}
        renderWidget={renderWidget}
        onChange={setLayoutDraft}
      />

      {/* has_usage is false when the server could not tell, too; a partial
          response must not claim the deployment has never been used. */}
      {!data.coverage.has_usage && data.partial_errors.length === 0 && (
        <div className="terminal-panel dashboard-empty">
          <EmptyState title={t('dash.empty_title')} description={t('dash.empty_desc')} />
        </div>
      )}

      <div className="dashboard-footnote">
        <span>{t('dash.window_minutes', { n: data.window.minutes })}</span>
      </div>
    </div>
  );
};

export type { DashboardResponse };

