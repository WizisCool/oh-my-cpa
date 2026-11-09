import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Button } from 'antd';
import { CodeOutlined, SyncOutlined } from '../../components/icons';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { formatObservedAgo, formatQuotaMetric, formatQuotaMoney, formatSnapshotRenewalBound, formatTimeWithCountdown, quotaEmptyStateKey, quotaPayloadSummary } from './quotaFormat';
import { QuotaWindowCards } from './QuotaWindowCards';
import { QuotaResetCards } from './QuotaResetCards';
import { CodexAutoReset } from './CodexAutoReset';
import { ToolButton } from '../../components/common/ToolButton';
import { AppModal } from '../../components/common/AppModal';
import { orderQuotaWindows } from './quotaWindowSelection';
import { quotaStatusTag } from './quotaStatusTag';
import { outlivedResetLine, refreshFailureLine } from './quotaAttempt';
import styles from './QuotaPresentation.module.css';
import { Notice } from '../../components/feedback';
import { SectionHeading } from '../../components/common/SectionHeading';
import { Tag } from '../../components/common/Tag';
import { describeQuotaCooldown } from './quotaCooldown';

interface CredentialQuotaBodyProps {
  item: QuotaItem;
  /** How the credential is named where its details open, already masked as the page masks it. */
  credentialLabel: string;
  /** The credential's brand mark, for the details a window opens. */
  credentialMark?: React.ReactNode;
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
 * renders it. A list row renders one cell per quota column of its provider section instead,
 * because a row answers a smaller question and must stay the height of one credential.
 */
export const CredentialQuotaBody: React.FC<CredentialQuotaBodyProps> = ({
  item,
  credentialLabel,
  credentialMark,
  nowMS,
  isDemo,
  isRefreshing,
  onRefresh,
  onClearCooldown,
  onRedeemCredit,
}) => {
  useTimeZone();
  const t = useT();
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = React.useState(false);
  const windows = orderQuotaWindows(item.windows ?? []);
  const availableCredits = item.reset_credits?.available_count ?? 0;
  const creditBalanceText = item.plan?.credits?.unlimited
    ? t('quota.credits_unlimited')
    : item.plan?.credits?.balance;
  const extraUsage = item.plan?.extra_usage;
  const balances = item.plan?.balances ?? [];
  const usageBreakdown = item.plan?.usage_breakdown ?? [];
  const metrics = item.plan?.metrics ?? [];
  const modelCooldowns = (item.model_cooldowns ?? []).filter((cooldown) => cooldown.is_active);
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
  // A plugin publishes no upstream signals; what it sent is the diagnostic it has.
  const payloadSummary = quotaPayloadSummary(item);
  const hasDiagnostics = Object.keys(rawSignals).length > 0
    || payloadSummary.length > 0
    || Object.keys(item.model_quotas ?? {}).length > 0
    || Boolean(item.error)
    || Boolean(item.last_refresh);
  // The attempt is what explains a status the reading alone cannot: the reason and when it
  // happened, printed once above the numbers rather than left to the toast that announced it.
  const failureLine = refreshFailureLine(item, nowMS, t);
  const staleLine = outlivedResetLine(item, t);


  return (
    <div
      className={styles['quota-body']}
      data-quota-body={item.auth_index}
      data-quota-density="expanded"
      data-quota-window-count={windows.length}
      data-quota-unsupported={!item.capabilities?.refresh_supported ? 'true' : undefined}
    >
      {/* What the reading is and when it was taken lead the section, with the tools that act on it. */}
      <div className={styles['quota-status-row']}>
        <div className={styles['quota-status-tags']}>
          {quotaStatusTag(item, t)}
          {!item.capabilities?.refresh_supported && (
            <Tag>{t('omc.quota_unsupported')}</Tag>
          )}
          {item.recommendation?.action === 'reauth' && (
            <Tag tone="warn">{t('omc.reauthenticate')}</Tag>
          )}
        </div>
        <div className={styles['quota-tools']}>
          <span className={styles['card-meta-time']}>{formatObservedAgo(item.observed_at_ms, nowMS, t)}</span>
          {hasDiagnostics && (
            <ToolButton size="small" type="text" icon={<CodeOutlined />} label={t('omc.quota_diagnostics')} onClick={() => setIsDiagnosticsOpen(true)} />
          )}
          {onRefresh && (
            <ToolButton
              size="small"
              type="text"
              icon={<SyncOutlined spin={isRefreshing} />}
              label={t('quota.btn_refresh_quota')}
              disabled={item.disabled || isRefreshing || !item.capabilities?.refresh_supported}
              onClick={() => onRefresh(item.auth_index)}
            />
          )}
        </div>
      </div>

      {failureLine ? (
        <Notice
          tone="error"
          description={failureLine}
          className={styles['quota-diagnostic-alert']}
        />
      ) : item.error ? (
        // A reading that carries a reason but no recorded attempt is one the console has not
        // stored an attempt for yet - a refresh response merged ahead of the read that serves it.
        // Its own words are still what the operator should read.
        <Notice
          tone="error"
          description={item.error}
          className={styles['quota-diagnostic-alert']}
        />
      ) : staleLine ? (
        <Notice
          tone="warning"
          description={staleLine}
          className={styles['quota-diagnostic-alert']}
        />
      ) : null}

      {item.active_cooldown?.is_active && (
        <div className={styles.callout} data-tone="danger">
          <div className={styles['callout-text']}>
            <div className={styles['callout-title']}>{describeQuotaCooldown(item.active_cooldown.reason, t('quota.cooldown_active_desc'))}</div>
            {item.active_cooldown.recover_at_ms && (
              <div className={styles['callout-sub']}>{t('quota.recover_at', { time: formatTimeWithCountdown(item.active_cooldown.recover_at_ms, nowMS, t) })}</div>
            )}
            {item.active_cooldown.retry_at_ms && item.active_cooldown.retry_at_ms !== item.active_cooldown.recover_at_ms && (
              <div className={styles['callout-sub']}>{t('quota.retry_at', { time: formatTimeWithCountdown(item.active_cooldown.retry_at_ms, nowMS, t) })}</div>
            )}
            {!!item.active_cooldown.backoff_level && <div className={styles['callout-sub']}>{t('quota.backoff_level', { level: item.active_cooldown.backoff_level })}</div>}
          </div>
          {onClearCooldown && (
            <Button
              size="small"
              danger
              className={styles['callout-action']}
              disabled={isDemo || !item.capabilities?.clear_cooldown_supported}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={() => onClearCooldown(item.auth_index)}
            >
              {t('quota.clear_cooldown')}
            </Button>
          )}
        </div>
      )}

      {/* Every resting model in one callout, one line each, so a burst of 429s does not stack a
          banner per model above the readings. */}
      {modelCooldowns.length > 0 && (
        <div className={styles.callout} data-tone="danger">
          <div className={styles['callout-text']}>
            {modelCooldowns.map((cooldown) => (
              <div className={styles['callout-line']} key={cooldown.model}>
                <span className={styles['callout-title']}>{t('quota.model_cooldown', { model: cooldown.model ?? '' })}</span>
                {cooldown.recover_at_ms && (
                  <span className={styles['callout-sub']}>{t('quota.recover_at', { time: formatTimeWithCountdown(cooldown.recover_at_ms, nowMS, t) })}</span>
                )}
              </div>
            ))}
          </div>
          {!item.active_cooldown?.is_active && onClearCooldown && (
            <Button size="small" danger className={styles['callout-action']} disabled={isDemo || !item.capabilities?.clear_cooldown_supported}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={() => onClearCooldown(item.auth_index)}>
              {t('quota.clear_all_cooldowns')}
            </Button>
          )}
        </div>
      )}

      {(item.plan?.plan_label || item.plan?.expires_at_ms || creditBalanceText || extraUsage || metrics.length > 0) && (
        <div className={styles['meta-row']}>
          {item.plan?.plan_label && (
            <span className={styles['meta-item']}>
              <span className={styles['meta-label']}>{t('quota.col_plan')}</span>
              <span className={styles['meta-value']}>{item.plan.plan_label}</span>
              {item.plan.subscription_active === false && (
                <span className={styles['meta-tag']} data-subscription-inactive="true">
                  {t('quota.subscription_inactive')}
                </span>
              )}
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
          {creditBalanceText && (
            <span className={styles['meta-item']} data-credit-balance="true">
              <span className={styles['meta-label']}>{t('quota.col_credit_balance')}</span>
              <span className={styles['meta-value']}>{creditBalanceText}</span>
            </span>
          )}
          {extraUsage && (
            <span className={styles['meta-item']} data-extra-usage={extraUsage.is_enabled ? 'on' : 'off'}>
              <span className={styles['meta-label']}>{t('quota.col_extra_usage')}</span>
              <span className={styles['meta-value']}>
                {extraUsage.is_enabled
                  ? t('quota.extra_usage_spent', {
                    used: formatQuotaMoney(extraUsage.used_credits_cents / 100, extraUsage.currency),
                    limit: formatQuotaMoney(extraUsage.monthly_limit_cents / 100, extraUsage.currency),
                  })
                  : t('quota.extra_usage_off')}
              </span>
              {extraUsage.spend_limit_reached && (
                <span className={styles['meta-tag']}>{t('quota.extra_usage_limit_reached')}</span>
              )}
              {extraUsage.user_disabled && (
                <span className={styles['meta-tag']}>{t('quota.extra_usage_user_disabled')}</span>
              )}
              {extraUsage.disabled_reason && (
                <span className={styles['meta-tag']} title={t('quota.extra_usage_reason')}>{extraUsage.disabled_reason}</span>
              )}
            </span>
          )}
          {metrics.map((metric, index) => (
            <span className={styles['meta-item']} key={`${metric.key}-${index}`} data-quota-metric={metric.key}>
              <span className={styles['meta-label']}>{metric.label}</span>
              <span className={styles['meta-value']}>{formatQuotaMetric(metric)}</span>
            </span>
          ))}
        </div>
      )}

      {windows.length > 0 ? (
        <QuotaWindowCards windows={windows} nowMS={nowMS} owner={{ authIndex: item.auth_index, credentialName: credentialLabel, mark: credentialMark }} />
      ) : (
        <div className={styles['no-window']}>{t(quotaEmptyStateKey(item))}</div>
      )}


      <QuotaResetCards
        credits={item.reset_credits}
        grants={item.reset_grants}
        nowMS={nowMS}
        isDemo={isDemo}
        onRedeem={canRedeem ? () => onRedeemCredit?.(item.auth_index) : undefined}
      />

      {item.provider === 'codex' && onRedeemCredit && !isDemo && (
        <CodexAutoReset key={item.auth_index} authIndex={item.auth_index} isDisabled={item.disabled} />
      )}

      {balances.length > 0 && (
        <div className={styles.section} data-quota-balances="true">
          <SectionHeading level="label" as="div" title={t('quota.balances_title')} />
          <div className={styles['reset-list']}>
            {balances.map((balance) => (
              <div className={styles['reset-row']} key={balance.id}>
                <span className={styles['meta-label']} title={balance.id}>
                  {balance.id === 'iguana_necktie' ? t('quota.balance_cloud_session_credits') : balance.id}
                </span>
                <span className={styles['meta-value']}>
                  {t('quota.balance_remaining', { amount: formatQuotaMoney(balance.remaining_usd) })}
                  {` · ${t('quota.balance_spent', { used: formatQuotaMoney(balance.used_usd), limit: formatQuotaMoney(balance.limit_usd) })}`}
                  {balance.reset_at_ms ? ` · ${formatTimeWithCountdown(balance.reset_at_ms, nowMS, t)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {usageBreakdown.length > 0 && (
        <div className={styles.section} data-quota-usage-breakdown="true">
          <SectionHeading level="label" as="div" title={t('quota.usage_breakdown_title')} />
          <div className={styles['reset-list']}>
            {usageBreakdown.map((share, index) => (
              <div className={styles['reset-row']} key={`${share.name}-${index}`}>
                <span className={styles['meta-label']}>{share.name}</span>
                <span className={styles['meta-value']}>
                  {share.share_percent == null ? t('quota.usage_share_unavailable') : `${Math.round(share.share_percent * 10) / 10}%`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasDiagnostics && (
        <AppModal open={isDiagnosticsOpen} onCancel={() => setIsDiagnosticsOpen(false)} footer={null} size="medium" title={t('omc.quota_diagnostics')}>
          <div className={styles['quota-diagnostics']}>
          {item.error && <div className={styles['diagnostic-line']}>{item.error}</div>}
          {item.last_refresh && (
            <div className={styles['diagnostic-line']}>
              <span className={styles['meta-label']}>{t('quota.last_refresh_at')}</span>
              <span>
                {formatObservedAgo(item.last_refresh.attempted_at_ms, nowMS, t)}
                {' · '}
                {t(item.last_refresh.outcome === 'failed' ? 'quota.last_refresh_outcome_failed' : 'quota.last_refresh_outcome_succeeded')}
              </span>
            </div>
          )}
          {Object.entries(rawSignals).map(([key, value]) => (
            <div className={styles['diagnostic-line']} key={`signal-${key}`}>
              <span className={styles['meta-label']}>{key}</span>
              <span className="mono-num">{value}</span>
            </div>
          ))}
          {payloadSummary.map(([label, value], index) => (
            <div className={styles['diagnostic-line']} key={`payload-${index}`} data-quota-payload-line="true">
              <span className={styles['meta-label']}>{label}</span>
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
          </div>
        </AppModal>
      )}

    </div>
  );
};
