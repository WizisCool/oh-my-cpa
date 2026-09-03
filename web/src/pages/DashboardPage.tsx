import React from 'react';
import { Alert, Button, Card, Empty, Skeleton, Space, Tooltip, Typography } from 'antd';
import { QuestionCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { Tiny } from '@ant-design/charts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useThemeMode } from '../theme/ThemeContext';
import { usePreference } from '../hooks/usePreference';
import { lineOptions, sparkDomain, sparkOptions, type ChartTone } from '../charts/chartTheme';
import { TimeRangeControl } from '../components/dashboard/TimeRangeControl';
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
  type DashboardSeriesPoint,
} from '../types/dashboard';

const { Text, Title } = Typography;

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const standard = new Intl.NumberFormat('en');

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return standard.format(value);
}

function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return compact.format(value);
}

function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(2)}%`;
}

/** Sparkline data: an index channel keeps buckets evenly spaced on the axis. */
function seriesData(points: DashboardSeriesPoint[], pick: (point: DashboardSeriesPoint) => number) {
  return points.map((point, index) => ({ x: index, y: pick(point) }));
}

interface TrendProps {
  points: DashboardSeriesPoint[];
  pick: (point: DashboardSeriesPoint) => number;
  tone?: ChartTone;
  height?: number;
  /** area keeps a flat tint under the line; line is a bare hairline. */
  variant?: 'area' | 'line';
  /** Formats the bucket start for the tooltip title. */
  label?: (timeMs: number) => string;
  /** Formats the value shown in the tooltip. */
  format?: (value: number) => string;
}

/**
 * Trend renders one sparkline with Ant Design Charts' Tiny.Area.
 *
 * It is a thin data adapter over the library component, not a chart of our own:
 * every visual decision comes from chartTheme so the line follows the active
 * palette.
 */
const Trend: React.FC<TrendProps> = ({
  points,
  pick,
  tone = 'accent',
  height = 46,
  variant = 'area',
  label,
  format,
}) => {
  const { themeMode } = useThemeMode();
  const t = useT();
  const data = React.useMemo(() => seriesData(points, pick), [points, pick]);
  const options = React.useMemo(() => {
    const domain = sparkDomain(data.map((row) => row.y));
    const tooltip = label
      ? {
          title: (datum: { x: number }) => label(points[datum.x]?.t ?? 0),
          items: [
            (datum: { y: number }) => ({
              name: t('dash.tooltip_bucket'),
              value: format ? format(datum.y) : formatCount(datum.y),
            }),
          ],
        }
      : false;
    const base = variant === 'area'
      ? sparkOptions(themeMode, tone, { domain, tooltip })
      : lineOptions(themeMode, tone, { domain, tooltip });
    return base;
  }, [data, domainKey(data), format, label, points, t, themeMode, tone, variant]);

  if (data.length < 2) {
    return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
  }
  const Chart = variant === 'area' ? Tiny.Area : Tiny.Line;
  return (
    <div className="chart-slot" style={{ height }}>
      <Chart data={data} xField="x" yField="y" height={height} {...options} />
    </div>
  );
};

/** domainKey memoises the sparkline domain without re-scanning on every render. */
function domainKey(rows: Array<{ y: number }>): number {
  let sum = 0;
  for (const row of rows) sum += row.y;
  return sum;
}

const Pip: React.FC<{ tone: ChartTone }> = ({ tone }) => (
  <i className={`legend-dot ${tone}`} />
);

/**
 * rateTone gives the tile's only pip something to mean.
 *
 * design.md reserves green/amber/red for real state, so one pip per verdict:
 * a clean window is green, a degraded one amber, a bad one red, and "no
 * traffic yet" is deliberately grey rather than dressed up as success.
 */
function rateTone(rate: number | null): ChartTone {
  if (rate === null) return 'neutral';
  if (rate >= 100) return 'success';
  if (rate >= 95) return 'warn';
  return 'danger';
}


export const DashboardPage: React.FC = () => {
  const t = useT();
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
  // A relative preset and an open-ended "至今" range both move with the clock,
  // so both are worth polling; a closed range is frozen.
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
          message={t('dash.error_title')}
          description={error instanceof ApiError ? error.message : t('dash.error_desc')}
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
          <Tooltip title={t('header.refresh_all')}>
            <Button size="small" icon={<ReloadOutlined />} loading={isFetching} onClick={() => refetch()} />
          </Tooltip>
        </Space>
      </div>

      {data.partial_errors.length > 0 && (
        <Alert className="dashboard-alert" type="warning" showIcon message={t('dash.partial_title')} description={data.partial_errors.join(' · ')} />
      )}

      <div className="dashboard-grid">
        <Card className="dashboard-tile is-wide" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">{t('dash.total_requests')}</div>
          <div className="tile-value">{formatCount(data.requests.total)}</div>
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
          <Trend
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
          <div className="tile-value">{formatCompact(data.tokens.total)}</div>
          <div className="tile-caption">
            <span>{t('dash.tokens_input')} <b>{formatCompact(data.tokens.input)}</b></span>
            <span>{t('dash.tokens_output')} <b>{formatCompact(data.tokens.output)}</b></span>
            <span>{t('dash.tokens_cache_read')} <b>{formatCompact(data.tokens.cache_read)}</b></span>
            {data.tokens.reasoning > 0 && (
              <span>{t('dash.tokens_reasoning')} <b>{formatCompact(data.tokens.reasoning)}</b></span>
            )}
          </div>
          <Trend
            points={data.tokens.series}
            pick={(point) => point.tokens ?? 0}
            tone="accent"
            height={64}
            label={(timeMs) => dayjs(timeMs).format('MM-DD HH:mm')}
            format={(value) => `${formatCompact(value)} ${t('dash.unit_tokens')}`}
          />
        </Card>

        <Card className="dashboard-tile" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">{t('dash.rpm')}</div>
          <div className="tile-value is-small">{formatCount(data.metrics.rpm ?? null)}</div>
          <div className="tile-caption">
            <span>{t('dash.total_requests')} <b>{formatCount(data.requests.total)}</b></span>
          </div>
          <Trend points={data.requests.series} pick={(point) => point.v ?? 0} tone="success" height={44} variant="line" />
        </Card>

        <Card className="dashboard-tile" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">{t('dash.tpm')}</div>
          <div className="tile-value is-small">{formatCompact(data.metrics.tpm ?? null)}</div>
          <div className="tile-caption">
            <span>{t('dash.total_tokens')} <b>{formatCompact(data.tokens.total)}</b></span>
          </div>
          <Trend points={data.tokens.series} pick={(point) => point.tokens ?? 0} tone="warn" height={44} variant="line" />
        </Card>

        <Card className="dashboard-tile" styles={{ body: { padding: 20 } }}>
          <div className="tile-label">
            {t('dash.cache_rate')}
            <Tooltip title={t('dash.cache_rate_hint')}>
              <QuestionCircleOutlined className="tile-help" />
            </Tooltip>
          </div>
          <div className="tile-value is-small">{formatRate(data.metrics.cache_rate)}</div>
          <div className="tile-caption">
            <span>{t('dash.tokens_cache_read')} <b>{formatCompact(data.tokens.cache_read)}</b></span>
            <span>{t('dash.tokens_input')} <b>{formatCompact(data.tokens.input)}</b></span>
          </div>
          <Trend
            points={data.tokens.series}
            pick={(point) => point.tokens ?? 0}
            tone={data.metrics.cache_rate !== null && data.metrics.cache_rate < 50 ? 'danger' : 'success'}
            height={44}
            variant="line"
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
            <span>{t('dash.cost_placeholder_note')}</span>
          </div>
          <Trend points={data.tokens.series} pick={(point) => point.tokens ?? 0} tone="neutral" height={44} variant="line" />
        </Card>
      </div>

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
