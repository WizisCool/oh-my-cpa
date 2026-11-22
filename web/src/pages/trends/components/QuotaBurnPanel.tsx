import React from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Segmented } from '@/components/ui/segmented';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { ToolButton } from '../../../components/common/ToolButton';
import { EmptyState } from '../../../components/common/EmptyState';
import { tipCard } from '../../../components/common/tipCard';
import { AttentionDot } from '../../../components/common/AttentionDot';
import { ChartLinesPlaceholder } from '../../../components/common/PageLoading';
import { LoadFailure } from '../../../components/feedback';
import { CredentialMark } from '../../../components/LobeIcon';
import { HistoryOutlined, LoginOutlined, ReloadOutlined, SyncOutlined } from '../../../components/icons';
import { usePluginMultiPortalKeys, usePluginOAuthLogos } from '../../../hooks/usePluginOAuthLogos';
import { credentialBrandIdentity } from '../../../types/credentialIdentity';
import { useT } from '../../../i18n';
import dayjs from '../../../utils/time';
import { useTimeZone } from '../../../utils/TimeZoneProvider';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatTokens } from '../../../types/tokenDisplay';
import type { TrendsQuotaCredential, TrendsQuotaResponse } from '../../../types/trends';
import { LazyQuotaBurnChart as QuotaBurnChart, LazyQuotaCyclesChart as QuotaCyclesChart } from '../../../charts/lazyCharts';
import {
  QUOTA_VIEWS,
  buildQuotaBurnSeries,
  canRefreshTrendsQuotaCredential,
  chartableWindows,
  countdownParts,
  formatPercent,
  pickQuotaWindow,
  quotaCycleBars,
  quotaDivider,
  quotaEventsHref,
  quotaNoticeState,
  quotaCredentialName as credentialName,
  quotaWindowName,
  quotaWindowNames,
  quotaCredentialAttention,
  quotaWindowAttention,
  type QuotaView,
} from '../trendsLogic';
import { Notice } from '../../../components/feedback';
import { TrendsValue } from '../useTrendsIdentity';
import styles from '../trends.module.css';

export interface QuotaBurnPanelProps {
  data: TrendsQuotaResponse | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onRefreshQuota?: (credential: TrendsQuotaCredential) => void;
  refreshingQuotaIndexes?: ReadonlySet<string>;
  credentialId?: string;
  windowId?: string;
  view: QuotaView;
  onChange: (patch: { quotaCredential?: string; quotaWindow?: string; quotaView?: QuotaView }) => void;
  onNavigate: (href: string) => void;
  nowMs: number;
  resolveNowMs?: () => number;
}

/**
 * The page's opening card: one OAuth window's cycle as cumulative burn against its limit, the
 * measured part in the healthy ink and the projection to the reset hatched in amber. The head
 * reads the window now - how much is used, when it resets, how fast it burns and where it lands.
 */
export const QuotaBurnPanel: React.FC<QuotaBurnPanelProps> = ({
  data, isLoading, error, onRetry, onRefreshQuota, refreshingQuotaIndexes, credentialId, windowId, view, onChange, onNavigate, nowMs, resolveNowMs,
}) => {
  useTimeZone();
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const pluginLogos = usePluginOAuthLogos();
  const multiPortalKeys = usePluginMultiPortalKeys();
  const [cycleMeasure, setCycleMeasure] = React.useState<'net_tokens' | 'requests'>('net_tokens');

  const picked = React.useMemo(() => (data ? pickQuotaWindow(data.items, credentialId, windowId) : null), [credentialId, data, windowId]);
  const credentials = React.useMemo(() => (data?.items ?? []).filter((item) => chartableWindows(item).length > 0), [data]);
  const windowLabels = React.useMemo(
    () => (picked ? quotaWindowNames(chartableWindows(picked.credential), t) : new Map<string, string>()),
    [picked, t],
  );
  const points = React.useMemo(() => (picked ? buildQuotaBurnSeries(picked.window) : []), [picked]);
  const cycles = React.useMemo(() => (picked ? quotaCycleBars(picked.window, cycleMeasure) : []), [cycleMeasure, picked]);
  const drawingKey = picked ? `${picked.credential.auth_index}:${picked.window.window_id}` : '';

  const countdown = (ms: number) => {
    const parts = countdownParts(ms);
    if (parts.days > 0) return t('trends.quota.countdown_days', { d: parts.days, h: parts.hours });
    if (parts.hours > 0) return t('trends.quota.countdown_hours', { h: parts.hours, m: parts.minutes });
    return t('trends.quota.countdown_minutes', { m: parts.minutes });
  };
  const instant = (ms: number) => dayjs(ms).format(dayjs(ms).isSame(dayjs(nowMs), 'day') ? 'HH:mm' : 'MM-DD HH:mm');

  const viewSwitch = (
    <Segmented
      size="sm"
      value={view}
      onChange={(next) => onChange({ quotaView: next as QuotaView })}
      aria-label={t('trends.quota.view_label')}
      data-testid="trends-quota-view"
      options={QUOTA_VIEWS.map((value) => ({ value, label: t(`trends.quota.view.${value}`) }))}
    />
  );

  const attentionLabel = (tone: 'warn' | 'danger') => t(tone === 'danger' ? 'trends.quota.fact.exhausted' : 'trends.quota.fact.exhaust');

  // The picker names each credential beside its brand. Only the open list flags the ones heading
  // for a limit, after the name: the closed control's own state is already read by the figures below.
  const credentialOption = (authIndex: string, label: React.ReactNode, isInList: boolean) => {
    const item = credentials.find((entry) => entry.auth_index === authIndex);
    if (!item) return label;
    const brand = credentialBrandIdentity(item.provider, { oauth_provider: item.oauth_provider }, multiPortalKeys);
    const value = (
      <TrendsValue
        mark={<CredentialMark credential={brand} pluginLogos={pluginLogos} size={15} />}
        name={credentialName(item)}
        isTipOnOverflow={false}
      />
    );
    const attention = isInList ? quotaCredentialAttention(item) : null;
    return attention ? <span className={styles['flagged-label']}>{value}<AttentionDot tone={attention} label={attentionLabel(attention)} /></span> : value;
  };

  const body = (() => {
    if (!data) {
      if (error) return <LoadFailure title={t('trends.quota.error_title')} error={error} onRetry={onRetry} />;
      return <div className="chart-placeholder" style={{ height: 300 }} aria-hidden="true"><ChartLinesPlaceholder height={300} kind="trend" /></div>;
    }
    const isMembershipUnknown = Boolean(data.summary.is_membership_unknown);
    if (!picked) {
      if (isMembershipUnknown) {
        return (
          <Notice
            tone="warning"
            data-testid="trends-quota-stale-notice"
            description={t('trends.quota.cpa_unreachable_empty_notice')}
            action={(
              <Button
                size="sm"
                icon={<ReloadOutlined />}
                loading={isLoading}
                onClick={onRetry}
                data-testid="trends-quota-notice-retry"
              >
                {t('common.retry')}
              </Button>
            )}
          />
        );
      }
      return <EmptyState size="compact" title={t('trends.quota.empty')} description={t('trends.quota.empty_hint')} />;
    }
    const { credential, window } = picked;
    const windows = chartableWindows(credential);
    const isPhysicalUnavailable = Boolean(window.is_physical_unavailable);
    const eventsHref = isPhysicalUnavailable ? null : quotaEventsHref(credential.auth_index, window, nowMs);
    const notice = quotaNoticeState(credential, window, isMembershipUnknown, nowMs);
    const canRefreshCredential = canRefreshTrendsQuotaCredential(credential, isMembershipUnknown);
    const isRefreshingCredential = Boolean(refreshingQuotaIndexes?.has(credential.auth_index.trim()));
    const isExhausted = window.exhausted_at_ms !== undefined;
    // A projection past the reset is no exhaustion this cycle.
    const projectedExhaustAt = !isExhausted && window.projected_exhaust_at_ms !== undefined && window.projected_exhaust_at_ms < window.cycle_reset_ms
      ? window.projected_exhaust_at_ms
      : undefined;
    const activeWindowLabel = windowLabels.get(window.window_id) ?? quotaWindowName(window, t, windows);
    const showCycleMeasure = view === 'cycles' && !isPhysicalUnavailable && cycles.length > 0;
    return (
      <div className={`${styles['panel-body']} ${styles['quota-body']}`}>
        {notice && (
          <Notice
            tone="warning"
            data-testid="trends-quota-stale-notice"
            description={t(
              notice.kind === 'cpa_unreachable'
                ? 'trends.quota.cpa_unreachable_notice'
                : 'trends.quota.stale_notice',
              { at: dayjs(credential.observed_at_ms).format('MM-DD HH:mm') },
            )}
            action={notice.kind === 'cpa_unreachable' ? (
              <Button
                size="sm"
                icon={<ReloadOutlined />}
                loading={isLoading}
                onClick={onRetry}
                data-testid="trends-quota-notice-retry"
              >
                {t('common.retry')}
              </Button>
            ) : notice.canRefreshQuota && onRefreshQuota ? (
              <Button
                size="sm"
                icon={<SyncOutlined />}
                loading={isRefreshingCredential}
                onClick={() => onRefreshQuota(credential)}
                data-testid="trends-quota-notice-refresh"
              >
                {t('quota.btn_refresh_quota')}
              </Button>
            ) : undefined}
          />
        )}
        <div className={styles['quota-toolbar']}>
          <Select
            size="small"
            className={styles['quota-credential-select']}
            value={credential.auth_index}
            aria-label={t('trends.quota.credential_label')}
            popupMatchSelectWidth={false}
            options={credentials.map((item) => ({ value: item.auth_index, label: credentialName(item) }))}
            optionRender={({ value, label }) => credentialOption(value, label, true)}
            labelRender={({ value, label }) => credentialOption(value, label, false)}
            onChange={(next: string) => onChange({ quotaCredential: next, quotaWindow: undefined })}
            data-testid="trends-quota-credential"
          />
          {windows.length > 1 && (
            <div className={`${styles['quota-windows']} scroll-fade-x`}>
              <Segmented
                size="sm"
                value={window.window_id}
                onChange={(next) => onChange({ quotaCredential: credential.auth_index, quotaWindow: String(next) })}
                aria-label={t('trends.quota.window_label')}
                data-testid="trends-quota-window"
                options={windows.map((item) => {
                  const attention = quotaWindowAttention(item);
                  return {
                    value: item.window_id,
                    label: (
                      <span className={styles['flagged-label']}>
                        {windowLabels.get(item.window_id) ?? quotaWindowName(item, t, windows)}
                        {attention && <AttentionDot tone={attention} label={attentionLabel(attention)} />}
                      </span>
                    ),
                  };
                })}
              />
            </div>
          )}
          <div className={styles['quota-toolbar-end']}>
            {showCycleMeasure && (
              <Segmented
                size="sm"
                className={styles['cycle-measure']}
                value={cycleMeasure}
                onChange={(next) => setCycleMeasure(next as 'net_tokens' | 'requests')}
                aria-label={t('trends.quota.cycle_measure')}
                options={[
                  { value: 'net_tokens', label: t('trends.metric.net_tokens') },
                  { value: 'requests', label: t('trends.metric.requests') },
                ]}
              />
            )}
            <span className={styles['quota-links']}>
              {onRefreshQuota && (
                <ToolButton
                  size="sm"
                  variant="ghost"
                  className={`row-action-btn ${styles['quota-refresh']}`}
                  icon={<SyncOutlined spin={isRefreshingCredential} />}
                  label={t('common.action_on', { action: t('quota.btn_refresh_quota'), target: credentialName(credential) })}
                  tooltip={t('quota.btn_refresh_quota')}
                  aria-busy={isRefreshingCredential || undefined}
                  disabled={!canRefreshCredential}
                  onClick={() => {
                    if (!canRefreshCredential || isRefreshingCredential) return;
                    onRefreshQuota(credential);
                  }}
                  data-testid="trends-quota-refresh"
                />
              )}
              <ToolButton
                size="sm"
                variant="ghost"
                className="row-action-btn"
                icon={<LoginOutlined />}
                label={t('trends.quota.open_credentials')}
                onClick={() => onNavigate('/oauth-management')}
              />
              <ToolButton
                size="sm"
                variant="ghost"
                className="row-action-btn"
                icon={<HistoryOutlined />}
                label={t('trends.view_requests')}
                disabled={!eventsHref}
                onClick={() => {
                  const href = isPhysicalUnavailable
                    ? null
                    : quotaEventsHref(credential.auth_index, window, resolveNowMs?.() ?? nowMs);
                  if (href) onNavigate(href);
                }}
                data-testid="trends-quota-events"
              />
            </span>
          </div>
        </div>
        <dl className={styles['quota-figures']}>
          <div className={styles['quota-figure']}>
            <dt>{t('trends.quota.used')}</dt>
            <dd
              data-tone={window.status === 'limit_reached' ? 'danger' : window.status === 'projected_exhaust' ? 'warn' : undefined}
              data-testid="trends-quota-used"
              {...tipCard({
                rows: isPhysicalUnavailable
                  ? [{ value: t('trends.quota.physical_unavailable'), tone: 'muted' }]
                  : [
                      { value: t('trends.quota.current_net', { value: formatTokens(window.current_net_tokens, style) }) },
                      { value: t('trends.quota.current_requests', { n: window.current_requests.toLocaleString('en') }) },
                    ],
                notes: [
                  t('trends.quota.observed', { at: dayjs(credential.observed_at_ms).format('MM-DD HH:mm') }),
                  ...(window.is_approximate && !isPhysicalUnavailable ? [t('trends.quota.approximate_hint')] : []),
                ],
              })}
            >
              {formatPercent(window.used_percent)}
            </dd>
          </div>
          {isExhausted ? (
            <div className={styles['quota-figure']}>
              <dt>{t('trends.quota.fact.exhausted')}</dt>
              <dd data-tone="danger">{instant(window.exhausted_at_ms!)}</dd>
            </div>
          ) : projectedExhaustAt !== undefined ? (
            <div className={styles['quota-figure']}>
              <dt>{t('trends.quota.fact.exhaust')}</dt>
              <dd data-tone="warn">{instant(projectedExhaustAt)}</dd>
            </div>
          ) : window.projected_end_percent !== undefined ? (
            <div className={styles['quota-figure']}>
              <dt>{t('trends.quota.fact.projected_end')}</dt>
              <dd>{formatPercent(window.projected_end_percent)}</dd>
            </div>
          ) : null}
          {window.cycle_reset_ms > nowMs && (
            <div className={styles['quota-figure']}>
              <dt>{t('trends.quota.fact.reset')}</dt>
              <dd data-tip={dayjs(window.cycle_reset_ms).format('YYYY-MM-DD HH:mm')}>{countdown(window.cycle_reset_ms - nowMs)}</dd>
            </div>
          )}
          {window.burn_rate_per_hour !== undefined && (
            <div className={styles['quota-figure']}>
              <dt>{t('trends.quota.fact.burn')}</dt>
              <dd>{t('trends.quota.fact.burn_value', { rate: formatPercent(window.burn_rate_per_hour, 2) })}</dd>
            </div>
          )}
        </dl>
        {view === 'burn' ? (
          points.length === 0 ? (
            <EmptyState size="compact" title={t('trends.quota.no_buckets')} />
          ) : (
            <React.Suspense fallback={<div className="chart-placeholder" style={{ height: 260 }} aria-hidden="true" />}>
              <QuotaBurnChart
                drawingKey={drawingKey}
                points={points}
                cycleStart={window.cycle_start_ms}
                cycleReset={window.cycle_reset_ms}
                divider={quotaDivider(window)}
                nowMs={nowMs}
                projectedExhaustAtMs={projectedExhaustAt}
                projectedEndPercent={window.projected_end_percent}
                isPhysicalUnavailable={isPhysicalUnavailable}
                label={t('trends.quota.chart_label', { name: credentialName(credential), window: activeWindowLabel })}
              />
            </React.Suspense>
          )
        ) : isPhysicalUnavailable ? (
          <EmptyState size="compact" title={t('trends.quota.physical_unavailable')} />
        ) : cycles.length === 0 ? (
          <EmptyState size="compact" title={t('trends.quota.no_cycles')} />
        ) : (
          <React.Suspense fallback={<div className="chart-placeholder" style={{ height: 260 }} aria-hidden="true" />}>
            <QuotaCyclesChart cycles={cycles} measure={cycleMeasure} label={t('trends.quota.view.cycles')} />
          </React.Suspense>
        )}
      </div>
    );
  })();

  return (
    <Panel
      id="trends-quota"
      className={styles.section}
      data-testid="trends-quota"
      title={<PanelTitle extra={data && picked ? viewSwitch : undefined}>{t('trends.quota.title')}</PanelTitle>}
      aria-busy={isLoading || undefined}
    >
      {body}
    </Panel>
  );
};
