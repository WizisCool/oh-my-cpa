import React from 'react';
import { Progress } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import {
  formatObservedAgo,
  quotaRemainingPercent,
  quotaRemainingText,
  quotaResetCountdown,
  quotaResetText,
  quotaWindowLabel,
} from './quotaFormat';
import { quotaRemainingStroke } from './quotaThresholds';
import { orderQuotaWindows, pickCompactQuotaWindows, quotaWindowKindOf } from './quotaWindowSelection';
import { quotaStatusTag } from './quotaStatusTag';
import styles from './QuotaPresentation.module.css';

interface CompactQuotaViewProps {
  item: QuotaItem;
  nowMS: number;
}

/**
 * The list row's quota reading, and the only place a row renders quota.
 *
 * A row and a Drawer answer different questions, so they are two components rather than one
 * with a density switch. The row carries the credential's own model family - the first
 * group the provider reports, the one named after the credential - as its five-hour and
 * weekly windows, side by side, each with its share, its bar and when it resets, plus how
 * many banked reset credits the account holds as a reading.
 *
 * It carries no control of its own. Spending a reset credit is irreversible, so it belongs
 * to the Drawer's Quota tab, where the credit expiries it consumes are on screen beside the
 * confirmation; a row is a reading, and the row's Details action and its menu are the way in.
 * Every other family an endpoint like Antigravity publishes, the credit expiries, cooldowns
 * and raw diagnostics are in that same tab, which renders the complete native reading through
 * `CredentialQuotaBody`.
 */
export const CompactQuotaView: React.FC<CompactQuotaViewProps> = ({
  item,
  nowMS,
}) => {
  const t = useT();
  const windows = pickCompactQuotaWindows(orderQuotaWindows(item.windows ?? []));
  const planText = item.plan?.plan_label;
  const isCooling = item.active_cooldown?.is_active;
  const availableCredits = item.reset_credits?.available_count ?? 0;

  return (
    <div
      className={styles.compact}
      data-quota-body={item.auth_index}
      data-quota-density="compact"
      data-quota-window-count={(item.windows ?? []).length}
      data-quota-unsupported={!item.capabilities?.refresh_supported ? 'true' : undefined}
    >
      <div className={styles.head}>
        {quotaStatusTag(item, t)}
        {planText && <span className={styles.plan}>{planText}</span>}
        {availableCredits > 0 && (
          <span className={styles.credit} title={t('omc.quota_credit_available_hint')}>
            <ThunderboltOutlined /> {t('omc.quota_credit_available', { n: availableCredits })}
          </span>
        )}
        <span className={styles.observed}>{formatObservedAgo(item.observed_at_ms, nowMS, t)}</span>
      </div>

      {isCooling && (
        <div className={`${styles['rec-banner']} ${styles['rec-banner-danger']}`}>
          <span className={styles['banner-dot']} style={{ background: 'var(--danger)' }} />
          <div className={styles['rec-text']}>
            {item.active_cooldown?.reason || t('quota.cooldown_active_desc')}
          </div>
        </div>
      )}

      {windows.length > 0 ? (
        <div className={styles.windows}>
          {windows.map((window) => {
            const remaining = quotaRemainingPercent(window);
            const kind = quotaWindowKindOf(window);
            return (
              <div
                className={styles.window}
                key={window.id}
                data-quota-compact-window={kind ?? window.scope}
                data-quota-window-label={window.label}
              >
                <div className={styles['window-head']}>
                  <span className={styles['window-label']} title={window.label}>
                    {quotaWindowLabel(kind, window.label, t)}
                  </span>
                  <span className={styles['window-value']}>{quotaRemainingText(window)}</span>
                </div>
                <div className={styles.bar}>
                  <Progress
                    percent={remaining ?? 0}
                    showInfo={false}
                    strokeColor={quotaRemainingStroke(remaining)}
                    strokeWidth={4}
                  />
                </div>
                <span className={styles['window-reset']} title={quotaResetText(window, nowMS, t)}>
                  {quotaResetCountdown(window, nowMS, t)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty}>
          {item.disabled
              ? t('quota.credential_disabled')
              : item.capabilities?.refresh_supported === false
                ? t('quota.no_live_probe')
                : t('quota.not_observed_yet')}
        </div>
      )}
    </div>
  );
};
