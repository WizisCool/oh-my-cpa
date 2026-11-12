import { Button } from '@/components/ui/button';
import { useT } from '../../i18n';
import { ThunderboltOutlined } from '../../components/icons';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import type { ClaudeResetGrant, CodexResetCreditsInfo } from '../../types/quota';
import { formatCountdown, formatShortDateTime } from './quotaFormat';
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
 * The resets a credential holds: Codex's bank of reset credits, which this console can spend, and
 * Claude's grants, which it only lists. Each is a card naming what it restores, how many are left
 * and until when.
 */
export function QuotaResetCards({ credits, grants = [], nowMS, isDemo, onRedeem }: QuotaResetCardsProps) {
  const t = useT();
  const liveGrants = grants.filter((grant) => grant.resets_left > 0);
  const expiries = (credits?.credits ?? [])
    .map((credit) => credit.expires_at_ms)
    .filter((expiresAtMS): expiresAtMS is number => expiresAtMS != null && expiresAtMS > nowMS)
    .sort((left, right) => left - right);
  const hasCredits = (credits?.available_count ?? 0) > 0;
  if (!hasCredits && liveGrants.length === 0) return null;
  const until = (atMS: number) => {
    const countdown = formatCountdown(atMS, nowMS, t);
    return countdown ? `${formatShortDateTime(atMS)} · ${countdown}` : formatShortDateTime(atMS);
  };
  return (
    <section className={styles.group} aria-label={t('quota.resets_title')}>
      <div className={styles['group-name']}>{t('quota.resets_title')}</div>
      <div className={styles.grid}>
        {hasCredits && credits && (
          <div className={styles.card} data-quota-reset="credits">
            <span className={styles.head}>
              <span className={styles.name}>{t('quota.reset_credits_title')}</span>
              <span className={styles.value}>
                <span className={styles['value-prefix']}>{t('quota.reset_available')}</span>
                <b>{credits.available_count}</b>
              </span>
            </span>
            {expiries.length > 0 && (
              <span className={styles.detail} data-tip={expiries.map(until).join('\n')}>
                {t('quota.reset_credit_expires', { when: until(expiries[0]) })}
              </span>
            )}
            {credits.applicable_available_count > 0 && credits.applicable_available_count !== credits.available_count && (
              <span className={styles.detail}>{t('omc.quota_credit_applicable', { n: credits.applicable_available_count })}</span>
            )}
            {onRedeem && (
              <span className={styles.foot}>
                <span />
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
