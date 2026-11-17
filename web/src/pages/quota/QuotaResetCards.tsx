import clsx from 'clsx';
import { Button } from '@/components/ui/button';
import { useT } from '../../i18n';
import { ThunderboltOutlined } from '../../components/icons';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import type { ClaudeResetGrant, CodexResetCreditsInfo } from '../../types/quota';
import { formatShortDateTime, formatTimeWithCountdown, orderCodexResetCredits } from './quotaFormat';
import styles from './QuotaWindowCards.module.css';

export interface QuotaResetCardsProps {
  credits?: CodexResetCreditsInfo;
  grants?: ClaudeResetGrant[];
  nowMS: number;
  isDemo: boolean;
  /** Present when a credit can be spent from here. */
  onRedeem?: () => void;
}

/**
 * The resets a credential holds: Codex's bank of reset credits, which lists every available credit
 * and its expiry so manual redemptions can be planned directly, and Claude's grants, which it only
 * lists.
 */
export function QuotaResetCards({ credits, grants = [], nowMS, isDemo, onRedeem }: QuotaResetCardsProps) {
  const t = useT();
  const liveGrants = grants.filter((grant) => grant.resets_left > 0);
  const hasCredits = (credits?.available_count ?? 0) > 0;
  if (!hasCredits && liveGrants.length === 0) return null;
  const creditRows = hasCredits && credits ? orderCodexResetCredits(credits.credits) : [];
  const hasApplicableNote = Boolean(
    credits && credits.applicable_available_count > 0 && credits.applicable_available_count !== credits.available_count,
  );
  const until = (atMS: number) => formatTimeWithCountdown(atMS, nowMS, t);
  return (
    <section className={styles.group} aria-label={t('quota.resets_title')}>
      <div className={styles['group-name']}>{t('quota.resets_title')}</div>
      <div className={styles.grid}>
        {hasCredits && credits && (
          <div className={clsx(styles.card, styles['credits-card'])} data-quota-reset="credits">
            <span className={styles.head}>
              <span className={styles.name}>{t('quota.reset_credits_title')}</span>
              <span className={styles.value}>
                <span className={styles['value-prefix']}>{t('quota.reset_available')}</span>
                <b>{credits.available_count}</b>
              </span>
            </span>
            {creditRows.length > 0 && (
              <dl className={styles['credit-list']} data-quota-reset-list="credits" aria-label={t('quota.reset_credits_title')}>
                {creditRows.map((credit, index) => {
                  const hasExpiry = credit.expires_at_ms != null && Number.isFinite(credit.expires_at_ms) && credit.expires_at_ms > 0;
                  const isExpired = hasExpiry && credit.expires_at_ms! <= nowMS;
                  const expiryText = !hasExpiry
                    ? '—'
                    : isExpired
                      ? t('quota.reset_credit_expired', { when: formatShortDateTime(credit.expires_at_ms!) })
                      : t('quota.reset_credit_expires', { when: until(credit.expires_at_ms!) });
                  return (
                    <div
                      className={styles['credit-row']}
                      key={`${credit.id || 'credit'}-${index}`}
                      data-quota-reset-credit={credit.id || String(index)}
                    >
                      <dt className={styles['credit-label']}>{t('quota.reset_credit_item', { n: index + 1 })}</dt>
                      <dd className={styles['credit-expiry']} data-expired={isExpired ? 'true' : undefined}>
                        {expiryText}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
            {(hasApplicableNote || onRedeem) && (
              <span className={clsx(styles.foot, styles['reset-foot'])}>
                {hasApplicableNote ? (
                  <span className={styles.detail}>{t('omc.quota_credit_applicable', { n: credits.applicable_available_count })}</span>
                ) : (
                  <span />
                )}
                {onRedeem && (
                  <ConfirmAction
                    title={t('quota.redeem_credit_confirm_title')}
                    description={t('quota.redeem_credit_confirm_desc')}
                    onConfirm={onRedeem}
                    isDanger
                  >
                    <Button size="sm" icon={<ThunderboltOutlined />} disabled={isDemo} data-tip={isDemo ? t('demo.blocked') : undefined}>
                      {t('quota.btn_reset_quota')}
                    </Button>
                  </ConfirmAction>
                )}
              </span>
            )}
          </div>
        )}
        {/* A grant is named by the provider's own label and nothing else: what it restores is the
            provider's entitlement to state, and a guess could promise a reset it does not give. */}
        {liveGrants.map((grant) => (
          <div className={styles.card} key={grant.id} data-quota-reset="grant">
            <span className={styles.head}>
              <span className={styles['grant-name']} data-tip={grant.label} data-tip-overflow="">{grant.label || t('quota.reset_grant_untitled')}</span>
              <span className={styles.value}>
                <span className={styles['value-prefix']}>{t('quota.reset_available')}</span>
                <b>{grant.resets_left}</b>
                <span className={styles['value-prefix']}>/ {grant.resets_total}</span>
              </span>
            </span>
            {grant.ends_at_ms && <span className={styles.detail}>{t('quota.reset_grant_until', { when: until(grant.ends_at_ms) })}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
