import React from 'react';
import clsx from 'clsx';
import { Button } from '@/components/ui/button';
import { useT } from '../../i18n';
import { ThunderboltOutlined } from '../../components/icons';
import { MetaLine } from '../../components/common/MetaLine';
import type { ClaudeResetGrant, CodexResetCreditsInfo } from '../../types/quota';
import {
  formatCodexResetCreditExpiry,
  formatTimeWithCountdown,
  orderCodexResetCredits,
  resolveSelectedCodexResetCredit,
} from './quotaFormat';
import { RedeemResetCreditDialog } from './RedeemResetCreditDialog';
import styles from './QuotaWindowCards.module.css';

export interface QuotaResetCardsProps {
  credits?: CodexResetCreditsInfo;
  grants?: ClaudeResetGrant[];
  /** The credential the credits belong to, as the redemption dialog names it. */
  credentialLabel: string;
  nowMS: number;
  isDemo: boolean;
  isRedeeming?: boolean;
  /** Present when a credit can be spent from here; receives the chosen credit ID when listed. */
  onRedeem?: (creditId?: string) => unknown | Promise<unknown>;
}

/**
 * The resets a credential holds, read at the same flat card level as the quota windows above.
 * The drawer only shows them: each Codex credit is a quiet card with its expiry, and choosing
 * which one to spend waits for Reset quota, which opens the shared redemption dialog. Claude
 * grants remain read-only cards in the same grid rhythm.
 */
export function QuotaResetCards({ credits, grants = [], credentialLabel, nowMS, isDemo, isRedeeming = false, onRedeem }: QuotaResetCardsProps) {
  const t = useT();
  const creditsHeadingId = React.useId();
  const [isDialogOpen, setIsDialogOpen] = React.useState(false);
  const liveGrants = grants.filter((grant) => grant.resets_left > 0);
  const hasCredits = (credits?.available_count ?? 0) > 0;
  if (!hasCredits && liveGrants.length === 0) return null;

  const creditRows = hasCredits && credits ? orderCodexResetCredits(credits.credits) : [];
  const { eligibleCount } = resolveSelectedCodexResetCredit(creditRows, null, nowMS);
  const hasApplicableNote = Boolean(
    credits && credits.applicable_available_count > 0 && credits.applicable_available_count !== credits.available_count,
  );
  const hasListedButNoneEligible = creditRows.length > 0 && eligibleCount === 0;
  const isRedeemDisabled = isDemo || isRedeeming || hasListedButNoneEligible;
  const redeemTip = isDemo
    ? t('demo.blocked')
    : hasListedButNoneEligible
      ? t('quota.reset_credit_none_eligible')
      : undefined;

  const until = (atMS: number) => formatTimeWithCountdown(atMS, nowMS, t);
  return (
    <>
      {hasCredits && credits && (
        <section className={styles.group} data-quota-reset="credits" aria-labelledby={creditsHeadingId}>
          <div className={styles['reset-bar']}>
            <div className={styles['reset-bar-info']}>
              <span id={creditsHeadingId} className={styles['group-name']}>{t('quota.reset_credits_title')}</span>
              <MetaLine className={styles['reset-bar-meta']}>
                <span>
                  {t('quota.reset_available')} <b>{credits.available_count}</b>
                </span>
                {hasApplicableNote && (
                  <span>{t('omc.quota_credit_applicable', { n: credits.applicable_available_count })}</span>
                )}
              </MetaLine>
            </div>
            {onRedeem && (
              <Button
                size="sm"
                icon={<ThunderboltOutlined />}
                loading={isRedeeming}
                disabled={isRedeemDisabled}
                data-tip={redeemTip}
                onClick={() => setIsDialogOpen(true)}
              >
                {t('quota.btn_reset_quota')}
              </Button>
            )}
          </div>
          {creditRows.length > 0 && (
            <div className={styles.grid} data-quota-reset-list="credits">
              {creditRows.map((credit, index) => {
                const expiry = formatCodexResetCreditExpiry(credit, nowMS, t);
                return (
                  <div
                    className={clsx(styles.card, styles['credit-card'])}
                    key={`${credit.id || 'credit'}-${index}`}
                    data-quota-reset-credit={credit.id || String(index)}
                  >
                    <span className={styles.head}>
                      <span className={styles['credit-label']}>{t('quota.reset_credit_item', { n: index + 1 })}</span>
                      <span className={styles['credit-primary']} data-expired={expiry.isExpired ? 'true' : undefined}>
                        {expiry.primary}
                      </span>
                    </span>
                    {expiry.dateText && <span className={styles['credit-date']}>{expiry.dateText}</span>}
                  </div>
                );
              })}
            </div>
          )}
          {onRedeem && (
            <RedeemResetCreditDialog
              open={isDialogOpen}
              credits={credits}
              targetName={credentialLabel}
              nowMS={nowMS}
              onConfirm={onRedeem}
              onClose={() => setIsDialogOpen(false)}
            />
          )}
        </section>
      )}
      {liveGrants.length > 0 && (
        <section className={styles.group} aria-label={t('quota.resets_title')}>
          <div className={styles['group-name']}>{t('quota.resets_title')}</div>
          <div className={styles.grid}>
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
      )}
    </>
  );
}
