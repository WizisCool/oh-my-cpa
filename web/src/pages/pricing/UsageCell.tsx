import { Link } from 'react-router-dom';
import { Tooltip } from 'antd';
import { useT } from '../../i18n';
import { formatTokensFull } from '../../types/tokenDisplay';
import type { PricingUsage } from '../../types/pricing';
import { formatUsd } from '../../types/pricingDisplay';
import styles from './PricingPage.module.css';

/** The request-records dimension a row's traffic was grouped on: the model for a price, the provider for a channel. */
export interface UsageCellScope {
  key: 'model' | 'provider';
  value: string;
}

/**
 * usageRecordsLink opens the request records on exactly the traffic a cell counts: the same
 * 30-day window the book aggregates over, narrowed to one model or channel, and optionally to
 * the requests the book could not price.
 */
export function usageRecordsLink(scope: UsageCellScope, unpricedOnly = false): string {
  const params = new URLSearchParams({ preset: '30d' });
  params.set(scope.key, scope.value);
  if (unpricedOnly) params.set('cost', 'unpriced');
  return `/usage/events?${params.toString()}`;
}

/**
 * A row's traffic and spend over the book's window. Traffic with no price shows a dash for the
 * spend and counts the unpriced requests on their own line: a zero would claim those calls were
 * free, and sharing the request line made the column wrap mid-phrase.
 */
export function UsageCell({ usage, scope }: { usage: PricingUsage; scope?: UsageCellScope }) {
  const t = useT();
  if (usage.requests === 0) return <span className={styles.dimmed}>{t('pricing.usage.none')}</span>;
  const unpriced = usage.requests - usage.priced_requests;
  const requests = t('pricing.usage.requests', { n: formatTokensFull(usage.requests) });
  const partial = t('pricing.usage.partial', { n: formatTokensFull(unpriced) });
  return (
    <span className={styles.usage}>
      <strong>{usage.cost_usd == null ? '—' : formatUsd(usage.cost_usd)}</strong>
      {scope ? (
        <Link className={styles['usage-requests']} to={usageRecordsLink(scope)}>{requests}</Link>
      ) : (
        <span className={styles['usage-requests']}>{requests}</span>
      )}
      {unpriced > 0 && (
        <Tooltip title={t('pricing.unpriced_note')}>
          {scope ? (
            <Link className={styles['usage-unpriced']} to={usageRecordsLink(scope, true)} data-testid="pricing-usage-unpriced">
              {partial}
            </Link>
          ) : (
            <span className={styles['usage-unpriced']} data-testid="pricing-usage-unpriced">{partial}</span>
          )}
        </Tooltip>
      )}
    </span>
  );
}
