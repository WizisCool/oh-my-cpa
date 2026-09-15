import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Empty, Skeleton, Space, Tooltip, Typography } from 'antd';
import { HistoryOutlined, QuestionCircleOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { usePreference } from '../hooks/usePreference';
import { type ChartTone } from '../charts/chartTheme';
import { type DashboardTrendChartProps } from '../charts/DashboardTrendChart';
import { formatCacheRate } from '../theme/cacheScale';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import { formatTokens as formatTokensStyled, formatTokensFull } from '../types/tokenDisplay';
import { successRateVerdict } from '../types/usageEventView';
import { TimeRangeControl } from '../components/dashboard/TimeRangeControl';
import { TokenHeatmap, TOKEN_HEATMAP_QUERY_KEY } from '../components/dashboard/TokenHeatmap';
import { ModelUsagePanels, DASHBOARD_MODELS_QUERY_KEY } from '../components/dashboard/ModelUsagePanels';
import type { ManagementOverview, ManagementOverviewProvider } from '../types/management';
import {
  applyTail,
  DASHBOARD_RANGE_PREFERENCE,
  dashboardRangeParams,
  DEFAULT_DASHBOARD_RANGE,
  isSlidingRange,
  livePollInterval,
  parseDashboardRange,
  type DashboardRange,
  type DashboardResponse,
} from '../types/dashboard';

const { Text, Title } = Typography;

const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const PLAIN_NUMBER_FORMAT = new Intl.NumberFormat('en');

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return PLAIN_NUMBER_FORMAT.format(value);
}

function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return COMPACT_NUMBER_FORMAT.format(value);
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}%`;
}

const LazyDashboardTrendChart = React.lazy(() =>
  import('../charts/DashboardTrendChart').then((m) => ({ default: m.DashboardTrendChart }))
);

const DashboardTrendChart: React.FC<DashboardTrendChartProps> = (props) => (
  <React.Suspense
    fallback={<div className="chart-placeholder" style={{ height: props.height ?? 46 }} aria-hidden="true" />}
  >
    <LazyDashboardTrendChart {...props} />
  </React.Suspense>
);

const Pip: React.FC<{ tone: ChartTone }> = ({ tone }) => (
  <i className={`legend-dot ${tone}`} />
);

/**
 * rateTone gives the tile's only pip something to mean.
 *
 * design.md reserves green/amber/red for real state, so one pip per verdict. The
 * bands come from `successRateVerdict` so the dashboard and the request list can
 * never disagree about the same window, and they are wide on purpose: a gateway
 * fanning out to several upstreams always carries some 429/timeout noise, and
 * painting that amber is how an indicator trains its reader to ignore it.
 */
function rateTone(total: number, failed: number): ChartTone {
  return successRateVerdict(total, failed);
}


export const DashboardPage: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
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

  const query = dashboardRangeParams(range);
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
  // Refresh reaches the strip below as well as the tiles. The strip owns its own query
  // - its span is a fixed fifty-three weeks rather than this window - so invalidating it by
  // key prefix is what keeps one button meaning "re-read this page". Today's total in
  // particular keeps growing, so a refresh that left the one panel tracking the current
  // day stale would be lying about what it did.
  const queryClient = useQueryClient();
  const refreshAll = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [TOKEN_HEATMAP_QUERY_KEY] });
    // The model panels own a query of their own as well, and they are ordered by the same button's
    // meaning - re-read this page. A refresh that left a ranking on screen from a minute ago would
    // be answering a question nobody asked it.
    void queryClient.invalidateQueries({ queryKey: [DASHBOARD_MODELS_QUERY_KEY] });
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
      <div className="terminal-page">
        <div className="terminal-page-head">
          <div>
            <Title level={2} className="terminal-title">{t('nav.dashboard')}</Title>
          </div>
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>{t('common.retry')}</Button>
        </div>
        <Alert
          type="error"
          showIcon
          description={`${t('dash.error_title')} — ${error instanceof ApiError ? error.message : t('dash.error_desc')}`}
        />
      </div>
    );
    }
    // First load: keep the real page frame and fill the tiles with a shimmer,
    // so nothing swaps in abruptly once data arrives.
    return (
      <div className="terminal-page dashboard-page">
        <div className="terminal-page-head">
          <div>
            <Title level={2} className="terminal-title">{t('nav.dashboard')}</Title>
            <Text type="secondary" className="terminal-subtitle">{t('dash.loading')}</Text>
          </div>
        </div>
        <div className="dashboard-grid">
          {[0, 1].map((index) => (
            <Card key={`wide-${index}`} className="dashboard-tile is-wide" styles={{ body: { padding: 20 } }}>
              <Skeleton title={{ width: '40%' }} paragraph={{ rows: 1, width: ['70%'] }} />
              <div className="tile-skeleton" style={{ marginTop: 12 }}>
                <Skeleton title={false} paragraph={{ rows: 2, width: ['70%', '55%'] }} />
              </div>
            </Card>
          ))}
          {[0, 1, 2, 3].map((index) => (
            <Card key={`small-${index}`} className="dashboard-tile" styles={{ body: { padding: 20 } }}>
              <Skeleton title={false} paragraph={{ rows: 3, width: ['50%', '70%', '60%'] }} />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-page dashboard-page">
      <div className="terminal-page-head">
        <div>
          <Title level={2} className="terminal-title">{t('nav.dashboard')}</Title>
        </div>
        <Space size={8}>
          <TimeRangeControl range={range} onChange={applyRange} />
          <Button
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => navigate('/usage/events')}
          >
            {t('nav.usage_events')}
          </Button>
          <Tooltip title={t('header.refresh_all')}>
            <Button size="small" icon={<ReloadOutlined />} loading={isFetching} onClick={refreshAll} />
          </Tooltip>
        </Space>
      </div>

      {data.partial_errors.length > 0 && (
        <Alert className="dashboard-alert" type="warning" showIcon description={`${t('dash.partial_title')} — ${data.partial_errors.join(' · ')}`} />
      )}

      <div className="dashboard-grid">
        <Card className="dashboard-tile is-wide" styles={{ body: { padding: 20 } }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="tile-label">{t('dash.total_requests')}</div>
            <Button
              type="link"
              size="small"
              icon={<RightOutlined />}
              onClick={() => navigate('/usage/events')}
              style={{ padding: 0, height: 'auto', fontSize: 12 }}
            >
              {t('nav.usage_events')}
            </Button>
          </div>
          <div className="tile-value">{formatCount(data.requests.total)}</div>
          <div className="tile-caption">
            <span className="tile-rate">
              <Pip tone={rateTone(data.requests.total, data.requests.failed)} />
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
            pick={(point) => point.v ?? 0}
            tone="accent"
            height={64}
            label={(timeMs) => dayjs(timeMs).format('MM-DD HH:mm')}
            format={(value) => `${formatCount(value)} ${t('dash.unit_requests')}`}
          />
        </Card>

        <Card className="dashboard-tile is-wide" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">{t('dash.total_tokens')}</div>
          <div className="tile-value" title={formatTokensFull(data.tokens.total)}>{formatTokensStyled(data.tokens.total, tokenStyle)}</div>
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
            pick={(point) => point.tokens ?? 0}
            tone="accent"
            height={64}
            label={(timeMs) => dayjs(timeMs).format('MM-DD HH:mm')}
            format={(value) => `${formatTokensStyled(value, tokenStyle)} ${t('dash.unit_tokens')}`}
            formatExact={(value) => `${formatTokensFull(value)} ${t('dash.unit_tokens')}`}
          />
        </Card>

        <Card className="dashboard-tile" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">{t('dash.rpm')}</div>
          <div className="tile-value is-small">{formatCount(data.metrics.rpm ?? null)}</div>
          <div className="tile-caption">
            <span>{t('dash.total_requests')} <b>{formatCount(data.requests.total)}</b></span>
          </div>
          {/* Per-minute rate, so the readout under an RPM label is an RPM and not
              a raw bucket count. The tile's own value is a rate too. */}
          <DashboardTrendChart
            points={data.requests.series}
            pick={(point) => (point.v ?? 0) / bucketMinutes}
            tone="success"
            height={44}
            label={(timeMs) => dayjs(timeMs).format('MM-DD HH:mm')}
            format={(value) => `${value.toFixed(2)} ${t('dash.unit_requests_per_min')}`}
          />
        </Card>

        <Card className="dashboard-tile" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">{t('dash.tpm')}</div>
          <div className="tile-value is-small" title={data.metrics.tpm == null ? undefined : `${formatTokensFull(data.metrics.tpm)} ${t('dash.unit_tokens_per_min')}`}>{formatCompact(data.metrics.tpm ?? null)}</div>
          <div className="tile-caption">
            <span>{t('dash.total_tokens')} <b title={formatTokensFull(data.tokens.total)}>{formatTokensStyled(data.tokens.total, tokenStyle)}</b></span>
          </div>
          {/* TPM is a rate, not the token volume the tile above already plots:
              dividing by the bucket's minutes is what makes this tile a distinct
              reading rather than a restatement of Token total. */}
          <DashboardTrendChart
            points={data.tokens.series}
            pick={(point) => (point.tokens ?? 0) / bucketMinutes}
            tone="warn"
            height={44}
            label={(timeMs) => dayjs(timeMs).format('MM-DD HH:mm')}
            format={(value) => `${formatCompact(value)} ${t('dash.unit_tokens_per_min')}`}
            formatExact={(value) => `${formatTokensFull(value)} ${t('dash.unit_tokens_per_min')}`}
          />
        </Card>

        <Card className="dashboard-tile" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">
            {t('dash.cache_rate')}
            <Tooltip title={t('dash.cache_rate_hint')}>
              <QuestionCircleOutlined className="tile-help" />
            </Tooltip>
          </div>
          <div className="tile-value is-small">{formatCacheRate(data.metrics.cache_rate)}</div>
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
            pick={(point) => point.cache_read ?? 0}
            tone="neutral"
            height={44}
            label={(timeMs) => dayjs(timeMs).format('MM-DD HH:mm')}
            format={(value) => `${formatTokensStyled(value, tokenStyle)} ${t('dash.unit_tokens')}`}
            formatExact={(value) => `${formatTokensFull(value)} ${t('dash.unit_tokens')}`}
          />
        </Card>

        <Card className="dashboard-tile" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">
            {t('dash.total_cost')}
            <Tooltip title={t('dash.cost_hint')}>
              <QuestionCircleOutlined className="tile-help" />
            </Tooltip>
          </div>
          <div className="tile-value is-small">${data.metrics.cost.toFixed(2)}</div>
          <div className="tile-caption">
            {/* The backend distinguishes a true placeholder from a partial
                estimate; keep both visible so an unpriced model never reads as
                fully priced. */}
            <span>
              {data.metrics.cost_source === 'partial'
                ? t('dash.cost_partial_note')
                : t('dash.cost_placeholder_note')}
            </span>
          </div>
          {/* Priced spend per bucket. Unpriced requests contribute nothing, which
              is why the tile keeps its cost_source note rather than implying the
              spend curve is complete. */}
          <DashboardTrendChart
            points={data.tokens.series}
            pick={(point) => (point.cost_nanos ?? 0) / 1_000_000_000}
            tone="neutral"
            height={44}
            label={(timeMs) => dayjs(timeMs).format('MM-DD HH:mm')}
            format={(value) => `$${value.toFixed(2)}`}
          />
        </Card>
      </div>

      {/* Between the six KPI tiles and the activity grid: the same window the tiles describe, read at
          model granularity. Inside the window picker's reach on purpose - unlike the grid below, which
          owns a fixed year - and therefore above it in the reading order, since it answers "how is this
          window going, and to which models" before the grid answers "how has the year gone". */}
      <ModelUsagePanels query={query} range={range} enabled={rangeReady} />

      {/* Under the six tiles, and outside the time-range control's reach: the strip has
          its own fixed fifty-three-week span, so it keeps its own query and its own failure -
          an unavailable read leaves the tiles above it readable. It is still reached by
          the page's refresh button, through a key-prefix invalidation rather than a
          prop. */}
      <TokenHeatmap />

      <OverviewSecondary />

      {data.coverage.stored_events === 0 && (
        <div className="terminal-panel dashboard-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                {t('dash.empty_title')}
                <br />
                <Text type="secondary">{t('dash.empty_desc')}</Text>
              </span>
            }
          />
        </div>
      )}

      <div className="dashboard-footnote">
        <span>{t('dash.source_note')}</span>
        <span>{t('dash.window_minutes', { n: data.window.minutes })}</span>
      </div>
    </div>
  );
};

/**
 * OverviewSecondary keeps the CPA-level facts that the six traffic tiles do not
 * carry: which instance answered, provider fleet totals, credential health and
 * runtime versions. It reads the overview endpoint, not the request store.
 */
const OverviewSecondary: React.FC = () => {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['management-overview'],
    queryFn: api.getManagementOverview,
    refetchInterval: 30000,
    meta: { silent: true },
    staleTime: 10000,
    placeholderData: keepPreviousData,
  });
  if (!data) return null;
  const overview: ManagementOverview = data;
  const credentials = overview.credentials;

  return (
    <div className="dashboard-secondary">
      <section className="dashboard-section">
        <div className="section-heading">
          <h2>{t('dash.providers')}</h2>
          <Text type="secondary">{t('dash.providers_hint')}</Text>
        </div>
        <div className="terminal-panel provider-list">
          {overview.providers.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dash.empty_providers')} />
          ) : (
            overview.providers.map((provider: ManagementOverviewProvider) => (
              <div className="provider-row" key={provider.id}>
                <div className="provider-name"><span className="status-pip" />{provider.id}</div>
                <span className="provider-credentials">{t('dash.credentials_n', { n: provider.credentials })}</span>
                <span className="provider-total">{formatCount(provider.total)}</span>
                <span className="provider-rate">{formatRate(provider.success_rate)}</span>
                <div className="dashboard-meter">
                  <span style={{ width: `${Math.max(0, Math.min(100, provider.success_rate ?? 0))}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="dashboard-lower">
        <div className="terminal-panel dashboard-card">
          <div className="section-heading"><h2>{t('dash.health')}</h2></div>
          {credentials && credentials.total > 0 ? (
            <>
              <div className="health-meter">
                <span className="health-active" style={{ flexGrow: credentials.active }} />
                <span className="health-unavailable" style={{ flexGrow: credentials.unavailable }} />
                <span className="health-disabled" style={{ flexGrow: credentials.disabled }} />
              </div>
              <div className="health-legend">
                <span><i className="legend-dot success" />{t('dash.legend_active')} <b>{credentials.active}</b></span>
                <span><i className="legend-dot warning" />{t('dash.legend_unavailable')} <b>{credentials.unavailable}</b></span>
                <span><i className="legend-dot failure" />{t('dash.legend_disabled')} <b>{credentials.disabled}</b></span>
              </div>
              <div className="type-list">
                {credentials.by_type.map((entry) => <span key={entry.type}>{entry.type} <b>{entry.count}</b></span>)}
              </div>
            </>
          ) : (
            <p className="empty-copy">{t('dash.health_empty')}</p>
          )}
        </div>

        <div className="terminal-panel dashboard-card">
          <div className="section-heading"><h2>{t('dash.runtime')}</h2></div>
          <dl className="runtime-list">
            <div><dt>{t('dash.runtime_instance')}</dt><dd>{overview.cpa_instance_name || '—'}</dd></div>
            <div><dt>{t('dash.runtime_version')}</dt><dd>{overview.cpa_version || '—'}</dd></div>
            <div><dt>{t('dash.runtime_omc')}</dt><dd>{overview.omc_version || '—'}</dd></div>
            <div><dt>{t('dash.runtime_baseurl')}</dt><dd>{overview.cpa_base_url || '—'}</dd></div>
          </dl>
        </div>
      </div>
    </div>
  );
};

export type { DashboardResponse };

