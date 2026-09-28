import React from 'react';
import { Alert, Button } from 'antd';
import dayjs from 'dayjs';
import { DollarOutlined } from '../icons';
import { useT } from '../../i18n';
import { formatTokensFull } from '../../types/tokenDisplay';
import type { RequestCostBreakdown } from '../../types/pricing';
import { formatMultiplier, formatRatePer1M, formatUsd, nanosToUsd } from '../../types/pricingDisplay';
import { describeTier } from './PricingParts';
import { channelIdentity } from './pricingIdentity';
import { useOpenPriceEditor } from './PricingEditorContext';
import styles from './Pricing.module.css';

export interface CostBreakdownViewProps {
  breakdown: RequestCostBreakdown | undefined;
  model: string;
  /** The stored amount from the record itself, used when the breakdown could not be loaded. */
  costUsd?: number | null;
}

/**
 * Why a request cost what it did: the tier that applied, each token bucket at its rate, both
 * multipliers, and which price version it was locked against. The stored amount is the answer;
 * the rows are its explanation, and a disagreement between them is stated rather than hidden.
 *
 * An unpriced request offers to price its model in place. The new price governs later requests
 * only, which is said beside the button, because "price this" on a past request invites the
 * belief that it will be repriced.
 */
export const CostBreakdownView: React.FC<CostBreakdownViewProps> = ({ breakdown, model, costUsd }) => {
  const t = useT();
  const openEditor = useOpenPriceEditor();
  const setPrice = openEditor ? (
    <div className={styles['breakdown-action']}>
      <Button size="small" icon={<DollarOutlined />} onClick={() => openEditor(model)} data-testid="cost-set-price">
        {t('cost.set_price', { model })}
      </Button>
      <span className={styles['mode-hint']}>{t('cost.set_price_note')}</span>
    </div>
  ) : null;

  if (!breakdown) {
    return (
      <div className={styles.breakdown}>
        <div className={styles['breakdown-total']}>
          <span>{t('cost.total')}</span>
          <strong>{costUsd == null ? '—' : formatUsd(costUsd)}</strong>
        </div>
        <p className={styles['mode-hint']}>{t('cost.unavailable')}</p>
      </div>
    );
  }
  if (breakdown.status === 'unpriced' || breakdown.status === 'legacy_unpriced') {
    return (
      <div className={styles.breakdown} data-testid="cost-breakdown">
        <p className={styles['mode-hint']}>{t(breakdown.status === 'unpriced' ? 'cost.unpriced' : 'cost.legacy_unpriced')}</p>
        {setPrice}
      </div>
    );
  }
  const { quote, price_version: version, channel } = breakdown;
  const stored = nanosToUsd(breakdown.stored_nanos);
  return (
    <div className={styles.breakdown} data-testid="cost-breakdown">
      {(breakdown.status === 'invalid_price' || breakdown.invalid_reason) && (
        <Alert type="warning" showIcon title={t('cost.invalid', { reason: breakdown.invalid_reason ?? '' })} />
      )}
      {quote?.tier && <p className={styles['breakdown-tier']}>{t('cost.tier', { tier: describeTier(t, quote.tier) })}</p>}
      {quote && (
        <table className={styles['breakdown-table']}>
          <thead>
            <tr>
              <th scope="col">{t('cost.col.bucket')}</th>
              <th scope="col">{t('cost.col.tokens')}</th>
              <th scope="col">{t('cost.col.rate')}</th>
              <th scope="col">{t('cost.col.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {quote.buckets.filter((bucket) => bucket.tokens > 0).map((bucket) => (
              <tr key={bucket.kind}>
                <th scope="row">{t(`cost.bucket.${bucket.kind}`)}</th>
                <td>{formatTokensFull(bucket.tokens)}</td>
                <td>{formatRatePer1M(bucket.rate_per_1m)}</td>
                <td>{formatUsd(nanosToUsd(bucket.nanos))}</td>
              </tr>
            ))}
            {quote.model_multiplier !== 1 && (
              <tr>
                <th scope="row">{t('cost.model_multiplier')}</th>
                <td colSpan={3}>{formatMultiplier(quote.model_multiplier)}</td>
              </tr>
            )}
            {channel && (
              <tr>
                <th scope="row">{t('cost.channel_multiplier', { channel: channelIdentity(channel.channel).label })}</th>
                <td colSpan={3}>{formatMultiplier(channel.multiplier)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className={styles['breakdown-total']}>
        <span>{t('cost.total')}</span>
        <strong>{stored === null ? '—' : formatUsd(stored)}</strong>
      </div>
      {quote && breakdown.status === 'priced' && !breakdown.recomputed_matches && (
        <p className={styles['field-error']}>{t('cost.mismatch')}</p>
      )}
      {version && (
        <p className={styles['breakdown-source']}>
          {version.price.source === 'manual'
            ? t('cost.source_manual')
            : version.price.source === 'modelsdev'
              ? t('cost.source_modelsdev')
              : t('cost.source_openrouter', { id: version.price.upstream_id || version.price.model })}
          {' · '}
          {t('cost.effective', { time: dayjs(version.effective_from_ms).format('YYYY-MM-DD HH:mm') })}
        </p>
      )}
    </div>
  );
};
