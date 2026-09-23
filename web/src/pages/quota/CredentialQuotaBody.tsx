import React from 'react';
import { Alert, Button, Popconfirm, Tag } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { formatGmtOffsetLabel, formatObservedAgo, formatSnapshotRenewalBound, formatTimeWithCountdown } from './quotaFormat';
import { QuotaProgressBar } from './QuotaProgressBar';
import styles from './QuotaPresentation.module.css';

export type CredentialQuotaDensity = 'compact' | 'expanded';

interface CredentialQuotaBodyProps {
  item: QuotaItem;
  nowMS: number;
  density: CredentialQuotaDensity;
  isDemo: boolean;
  isRefreshing?: boolean;
  onRefresh?: (authIndex: string) => void;
  onClearCooldown?: (authIndex: string) => void;
  onRedeemCredit?: (authIndex: string) => void;
  onShowAll?: () => void;
  /** Embedded in a unified open row: keep the information, remove card-level footer chrome. */
  embedded?: boolean;
}

function windowRank(kind?: string): number {
  if (kind === 'five_hour') return 0;
  if (kind === 'weekly') return 1;
  if (kind === 'daily') return 2;
  if (kind === 'monthly') return 3;
  return 4;
}

export function orderedQuotaWindows(item: QuotaItem) {
  return [...(item.windows ?? [])].sort((left, right) => windowRank(left.kind) - windowRank(right.kind));
}

function quotaStatusTag(item: QuotaItem, t: ReturnType<typeof useT>) {
  if (item.active_cooldown?.is_active || item.status === 'cooldown') {
    return <Tag color="error" icon={<StopOutlined />} style={{ margin: 0 }}>{t('quota.status_cooldown')}</Tag>;
  }
  switch (item.status) {
    case 'healthy':
      return <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0 }}>{t('quota.status_normal')}</Tag>;
    case 'warning':
      return <Tag color="warning" icon={<WarningOutlined />} style={{ margin: 0 }}>{t('quota.status_warning')}</Tag>;
    case 'exhausted':
      return <Tag color="error" icon={<CloseCircleOutlined />} style={{ margin: 0 }}>{t('quota.status_exceeded')}</Tag>;
    case 'error':
      return <Tag color="error" style={{ margin: 0 }}>{t('quota.status_error')}</Tag>;
    case 'stale':
      return <Tag style={{ margin: 0 }}>{t('quota.status_stale')}</Tag>;
    case 'loading':
      return <Tag color="processing" style={{ margin: 0 }}>{t('common.loading')}</Tag>;
    default:
      return <Tag style={{ margin: 0 }}>{t('quota.status_idle')}</Tag>;
  }
}

function windowLabel(kind: string | undefined, label: string | undefined, t: ReturnType<typeof useT>): string {
  if (kind === 'five_hour') return t('quota.window_five_hour');
  if (kind === 'weekly') return t('quota.window_weekly');
  if (kind === 'daily') return t('quota.window_daily');
  if (kind === 'monthly') return t('quota.window_monthly');
  if (kind === 'credit_usage') return t('quota.window_credit_usage');
  return label || '';
}

export const CredentialQuotaBody: React.FC<CredentialQuotaBodyProps> = ({
  item,
  nowMS,
  density,
  isDemo,
  isRefreshing,
  onRefresh,
  onClearCooldown,
  onRedeemCredit,
  onShowAll,
  embedded = false,
}) => {
  const t = useT();
  const windows = orderedQuotaWindows(item);
  const isCompact = density === 'compact';
  const primaryWindowCount = isCompact ? Math.min(2, windows.length) : windows.length;
  const displayWindows = isCompact ? windows.slice(0, primaryWindowCount) : windows;
  const hiddenWindowCount = Math.max(0, windows.length - displayWindows.length);
  const availableCredits = item.reset_credits?.available_count ?? 0;
  const applicableCredits = item.reset_credits?.applicable_available_count ?? 0;
  const creditRows = (item.reset_credits?.credits ?? [])
    .filter((credit) => credit.expires_at_ms)
    .sort((left, right) => (left.expires_at_ms ?? 0) - (right.expires_at_ms ?? 0));
  const isSnapshotBound = item.plan?.expires_source === 'credential_snapshot';
  const canRedeem = Boolean(
    onRedeemCredit
      && item.capabilities?.reset_credit_supported
      && applicableCredits > 0
      && !item.disabled,
  );
  const rawSignals = {
    ...(item.quota?.signals ?? {}),
    ...(item.raw_signals ?? {}),
  };
  const hasDiagnostics = Object.keys(rawSignals).length > 0
    || Object.keys(item.model_quotas ?? {}).length > 0
    || Boolean(item.error);

  const compactWindow = windows[0];
  if (isCompact) {
    const planText = item.plan?.plan_label
      ? `${item.plan.plan_label}${item.plan.expires_at_ms
        ? ` · ${isSnapshotBound
          ? formatSnapshotRenewalBound(item.plan.expires_at_ms)
          : formatTimeWithCountdown(item.plan.expires_at_ms, nowMS, t)}`
        : ''}`
      : '';
    return (
      <div
        className={`${styles['quota-body']} ${styles['quota-body-compact']}`}
        data-quota-body={item.auth_index}
        data-quota-density="compact"
        data-quota-window-count={windows.length}
        data-quota-unsupported={!item.capabilities?.refresh_supported ? 'true' : undefined}
      >
        <div className={styles['quota-compact-summary']}>
          {quotaStatusTag(item, t)}
          {planText && <span className={styles['quota-compact-plan']}>{planText}</span>}
          {item.reset_credits && (
            <span className={styles['quota-compact-plan']}>
              {t('quota.col_reset_count')} {availableCredits}
            </span>
          )}
          <span className={styles['quota-compact-time']}>{formatObservedAgo(item.observed_at_ms, nowMS, t)}</span>
          {onShowAll && (
            <Button type="link" size="small" onClick={onShowAll}>
              {windows.length > 0
                ? t('omc.quota_show_all_windows', { n: windows.length })
                : t('common.details')}
            </Button>
          )}
          {onRefresh && (
            <Button
              type="text"
              size="small"
              icon={<SyncOutlined spin={isRefreshing} />}
              aria-label={`${t('quota.btn_refresh_quota')}: ${item.name}`}
              disabled={item.disabled || isRefreshing || !item.capabilities?.refresh_supported}
              onClick={() => onRefresh(item.auth_index)}
            />
          )}
        </div>
        {item.active_cooldown?.is_active && (
          <div className={`${styles['rec-banner']} ${styles['rec-banner-danger']}`}>
            <span className={styles['banner-dot']} style={{ background: 'var(--danger)' }} />
            <div className={styles['rec-text']}>
              {item.active_cooldown.reason || t('quota.cooldown_active_desc')}
            </div>
            {onClearCooldown && (
              <Button
                size="small"
                danger
                disabled={isDemo || !item.capabilities?.clear_cooldown_supported}
                onClick={() => onClearCooldown(item.auth_index)}
              >
                {t('quota.clear_cooldown')}
              </Button>
            )}
          </div>
        )}
        {compactWindow ? (
          <div className={styles['quota-compact-window']}>
            <span>{compactWindow.scope === 'group' ? compactWindow.label : windowLabel(compactWindow.kind, compactWindow.label, t)}</span>
            <strong>
              {compactWindow.remaining_percent != null
                ? `${Math.round(Math.max(0, Math.min(100, compactWindow.remaining_percent)))}%`
                : compactWindow.used_percent != null
                  ? `${Math.round(Math.max(0, Math.min(100, 100 - compactWindow.used_percent)))}%`
                  : '--'}
            </strong>
            <span>
              {compactWindow.reset_at_ms
                ? `${compactWindow.reset_accuracy && compactWindow.reset_accuracy !== 'exact' ? '~' : ''}${formatTimeWithCountdown(compactWindow.reset_at_ms, nowMS, t)}`
                : compactWindow.reset_label || ''}
            </span>
          </div>
        ) : (
          <div className={styles['no-window']}>
            {item.disabled ? t('quota.credential_disabled') : t('quota.no_window_data')}
          </div>
        )}
      </div>
    );
  }

  const renderWindowRows = (rows: typeof windows) => {
    const rendered: React.ReactNode[] = [];
    let lastGroup: string | null = null;
    rows.forEach((window) => {
      const group = window.scope === 'group' ? window.label.split(' · ')[0] : null;
      if (group && lastGroup && group !== lastGroup) {
        rendered.push(<div key={`divider-${window.id}`} className={styles['window-divider']} aria-hidden="true" />);
      }
      rendered.push(
        <QuotaProgressBar
          key={window.id}
          nowMS={nowMS}
          kind={window.kind}
          label={window.label}
          usedPercent={window.used_percent}
          remainingPercent={window.remaining_percent}
          resetAtMS={window.reset_at_ms}
          resetLabel={window.reset_label}
          resetAccuracy={window.reset_accuracy}
        />,
      );
      if (group) lastGroup = group;
    });
    return rendered;
  };

  return (
    <div
      className={`${styles['quota-body']} ${isCompact ? styles['quota-body-compact'] : ''}`}
      data-quota-body={item.auth_index}
      data-quota-density={density}
      data-quota-window-count={windows.length}
      data-quota-unsupported={!item.capabilities?.refresh_supported ? 'true' : undefined}
    >
      <div className={styles['quota-status-row']}>
        {quotaStatusTag(item, t)}
        {!item.capabilities?.refresh_supported && (
          <Tag style={{ margin: 0 }}>{t('omc.quota_unsupported')}</Tag>
        )}
        {item.recommendation?.action === 'reauth' && (
          <Tag color="warning" style={{ margin: 0 }}>{t('omc.reauthenticate')}</Tag>
        )}
        {embedded && <span className={styles['quota-status-time']}>{formatObservedAgo(item.observed_at_ms, nowMS, t)}</span>}
        {embedded && onRefresh && (
          <Button
            type="text"
            size="small"
            icon={<SyncOutlined spin={isRefreshing} />}
            aria-label={`${t('quota.btn_refresh_quota')}: ${item.name}`}
            disabled={item.disabled || isRefreshing || !item.capabilities?.refresh_supported}
            onClick={() => onRefresh(item.auth_index)}
          />
        )}
        {embedded && canRedeem && onRedeemCredit && (
          <Popconfirm
            title={t('quota.redeem_credit_confirm_title')}
            description={t('quota.redeem_credit_confirm_desc')}
            onConfirm={() => onRedeemCredit(item.auth_index)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
          >
            <Button
              type="text"
              size="small"
              icon={<ThunderboltOutlined />}
              aria-label={`${t('quota.btn_reset_quota')}: ${item.name}`}
              disabled={isDemo}
            />
          </Popconfirm>
        )}
      </div>

      {item.error && (
        <Alert
          type="error"
          showIcon
          description={item.error}
          className={styles['quota-diagnostic-alert']}
        />
      )}

      {(item.plan?.plan_label || item.plan?.expires_at_ms || item.reset_credits) && (
        <div className={styles['meta-row']}>
          {item.plan?.plan_label && (
            <span className={styles['meta-item']}>
              <span className={styles['meta-label']}>{t('quota.col_plan')}</span>
              <span className={styles['meta-value']}>{item.plan.plan_label}</span>
            </span>
          )}
          {item.plan?.expires_at_ms && (
            <span className={styles['meta-item']} data-renewal-source={item.plan.expires_source ?? 'unknown'}>
              <span className={styles['meta-label']}>{t('quota.col_renewal')}</span>
              <span className={styles['meta-value']}>
                {isSnapshotBound
                  ? formatSnapshotRenewalBound(item.plan.expires_at_ms)
                  : formatTimeWithCountdown(item.plan.expires_at_ms, nowMS, t)}
              </span>
              {isSnapshotBound && (
                <span className={styles['meta-tag']} title={t('quota.renewal_snapshot_hint')}>
                  {t('quota.renewal_snapshot')}
                </span>
              )}
              {item.plan.auto_renews === false && (
                <span className={styles['meta-tag']} data-renewal-not-renewing="true" title={t('quota.renewal_not_renewing_hint')}>
                  {t('quota.renewal_not_renewing')}
                </span>
              )}
            </span>
          )}
          {item.reset_credits && (
            <span className={styles['meta-item']}>
              <span className={styles['meta-label']}>{t('quota.col_reset_count')}</span>
              <span className={styles['meta-value']}>{availableCredits}</span>
              {applicableCredits !== availableCredits && (
                <span className={styles['meta-tag']} title={t('omc.quota_credit_applicable_hint')}>
                  {t('omc.quota_credit_applicable', { n: applicableCredits })}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {item.active_cooldown?.is_active && (
        <div className={`${styles['rec-banner']} ${styles['rec-banner-danger']}`}>
          <span className={styles['banner-dot']} style={{ background: 'var(--danger)' }} />
          <div className={styles['rec-text']}>
            <div>{item.active_cooldown.reason || t('quota.cooldown_active_desc')}</div>
            {item.active_cooldown.recover_at_ms && (
              <div className={styles['rec-sub-danger']}>
                {t('quota.recover_at', { time: formatTimeWithCountdown(item.active_cooldown.recover_at_ms, nowMS, t) })}
              </div>
            )}
          </div>
          {onClearCooldown && (
            <Button
              size="small"
              danger
              disabled={isDemo || !item.capabilities?.clear_cooldown_supported}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={() => onClearCooldown(item.auth_index)}
            >
              {t('quota.clear_cooldown')}
            </Button>
          )}
        </div>
      )}

      {!isCompact && item.reset_credits && creditRows.length > 0 && (
        <div className={styles.section}>
          <div className={styles['section-title']}>
            {t('quota.reset_expiry_title_zoned', { zone: formatGmtOffsetLabel(new Date(nowMS)) })}
          </div>
          <div className={styles['reset-list']}>
            {creditRows.map((credit, index) => (
              <div className={styles['reset-row']} key={credit.id || index}>
                <span className={styles['meta-label']}>{t('quota.reset_occurrence', { n: index + 1 })}</span>
                <span className={styles['meta-value']}>
                  {credit.expires_at_ms ? formatTimeWithCountdown(credit.expires_at_ms, nowMS, t) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={styles.section}>
        {!embedded && <div className={styles['section-title']}>{t('quota.windows_title')}</div>}
        <div className={styles['windows-list']}>
          {displayWindows.length > 0 ? (
            renderWindowRows(displayWindows)
          ) : (
            <div className={styles['no-window']}>
              {item.disabled ? t('quota.credential_disabled') : t('quota.no_window_data')}
            </div>
          )}
        </div>
        {isCompact && hiddenWindowCount > 0 && onShowAll && (
          <Button
            type="link"
            size="small"
            className={styles['quota-show-all']}
            onClick={onShowAll}
          >
            {t('omc.quota_show_all_windows', { n: windows.length })}
          </Button>
        )}
        {isCompact && hiddenWindowCount === 0 && windows.length > 0 && onShowAll && (
          <Button
            type="link"
            size="small"
            className={styles['quota-show-all']}
            onClick={onShowAll}
          >
            {t('common.details')}
          </Button>
        )}
      </div>

      {!isCompact && hasDiagnostics && (
        <details className={styles['quota-diagnostics']}>
          <summary>{t('omc.quota_diagnostics')}</summary>
          {item.error && <div className={styles['diagnostic-line']}>{item.error}</div>}
          {Object.entries(rawSignals).map(([key, value]) => (
            <div className={styles['diagnostic-line']} key={`signal-${key}`}>
              <span className={styles['meta-label']}>{key}</span>
              <span className="mono-num">{value}</span>
            </div>
          ))}
          {Object.entries(item.model_quotas ?? {}).map(([model, observation]) => (
            <div className={styles['diagnostic-line']} key={`model-${model}`}>
              <span className={styles['meta-label']}>{model}</span>
              <span className="mono-num">
                {Object.entries(observation.signals ?? {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || '—'}
              </span>
            </div>
          ))}
        </details>
      )}

      {!embedded && <div className={styles['quota-body-footer']}>
        <div className={styles['card-meta-time']}>{formatObservedAgo(item.observed_at_ms, nowMS, t)}</div>
        <div className={styles['card-actions']}>
          {canRedeem && (
            <Popconfirm
              title={t('quota.redeem_credit_confirm_title')}
              description={t('quota.redeem_credit_confirm_desc')}
              onConfirm={() => onRedeemCredit?.(item.auth_index)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                disabled={isDemo}
                title={isDemo ? t('demo.blocked') : undefined}
              >
                {t('quota.btn_reset_quota')}
              </Button>
            </Popconfirm>
          )}
          {onRefresh && (
            <Button
              size="small"
              icon={<SyncOutlined spin={isRefreshing} />}
              aria-label={t('quota.btn_refresh_quota')}
              disabled={item.disabled || isRefreshing || !item.capabilities?.refresh_supported}
              onClick={() => onRefresh(item.auth_index)}
            >
              {t('quota.btn_refresh_quota')}
            </Button>
          )}
        </div>
      </div>}
    </div>
  );
};
