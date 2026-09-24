import React from 'react';
import { Alert, Button, Popconfirm, Tag } from 'antd';
import { SyncOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { formatGmtOffsetLabel, formatObservedAgo, formatSnapshotRenewalBound, formatTimeWithCountdown } from './quotaFormat';
import { QuotaProgressBar } from './QuotaProgressBar';
import { orderQuotaWindows } from './quotaWindowSelection';
import { quotaStatusTag } from './quotaStatusTag';
import styles from './QuotaPresentation.module.css';

interface CredentialQuotaBodyProps {
  item: QuotaItem;
  nowMS: number;
  isDemo: boolean;
  isRefreshing?: boolean;
  onRefresh?: (authIndex: string) => void;
  onClearCooldown?: (authIndex: string) => void;
  onRedeemCredit?: (authIndex: string) => void;
}

/**
 * The native quota reading: every window the provider published, in group order, with plan,
 * credits, cooldown, per-window reset actions and the raw diagnostics. The Drawer's quota tab
 * renders it. A list row renders `CompactQuotaView` instead, because a row answers a smaller
 * question and must stay the height of one credential.
 */
export const CredentialQuotaBody: React.FC<CredentialQuotaBodyProps> = ({
  item,
  nowMS,
  isDemo,
  isRefreshing,
  onRefresh,
  onClearCooldown,
  onRedeemCredit,
}) => {
  const t = useT();
  const windows = orderQuotaWindows(item.windows ?? []);
  const availableCredits = item.reset_credits?.available_count ?? 0;
  const applicableCredits = item.reset_credits?.applicable_available_count ?? 0;
  const creditRows = (item.reset_credits?.credits ?? [])
    .filter((credit) => credit.expires_at_ms)
    .sort((left, right) => (left.expires_at_ms ?? 0) - (right.expires_at_ms ?? 0));
  const isSnapshotBound = item.plan?.expires_source === 'credential_snapshot';
  // Upstream's applicable count is not the UI gate: it refines which credits apply right
  // now, and the consume response states the outcome. The bank of credits decides whether
  // the redemption request is offered at all.
  const canRedeem = Boolean(
    onRedeemCredit
      && item.capabilities?.reset_credit_supported
      && availableCredits > 0
      && !item.disabled,
  );
  const rawSignals = {
    ...(item.quota?.signals ?? {}),
    ...(item.raw_signals ?? {}),
  };
  const hasDiagnostics = Object.keys(rawSignals).length > 0
    || Object.keys(item.model_quotas ?? {}).length > 0
    || Boolean(item.error);

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
          kind={window.scope === 'group' || window.scope === 'model' ? undefined : window.kind}
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
      className={styles['quota-body']}
      data-quota-body={item.auth_index}
      data-quota-density="expanded"
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
              {applicableCredits > 0 && applicableCredits !== availableCredits && (
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

      {item.reset_credits && creditRows.length > 0 && (
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
        <div className={styles['section-title']}>{t('quota.windows_title')}</div>
        <div className={styles['windows-list']}>
          {windows.length > 0 ? (
            renderWindowRows(windows)
          ) : (
            <div className={styles['no-window']}>
              {item.disabled
              ? t('quota.credential_disabled')
              : item.capabilities?.refresh_supported === false
                ? t('quota.no_live_probe')
                : t('quota.not_observed_yet')}
            </div>
          )}
        </div>

      </div>

      {hasDiagnostics && (
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

      <div className={styles['quota-body-footer']}>
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
      </div>
    </div>
  );
};
