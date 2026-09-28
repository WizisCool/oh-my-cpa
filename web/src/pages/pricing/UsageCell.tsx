import { useT } from '../../i18n';
import { formatTokensFull } from '../../types/tokenDisplay';
import type { PricingUsage } from '../../types/pricing';
import { formatUsd } from '../../types/pricingDisplay';
import styles from './PricingPage.module.css';

/**
 * A row's traffic and spend over the book's window. Traffic with no price shows a dash for the
 * spend and counts the unpriced requests beside it: a zero would claim those calls were free.
 */
export function UsageCell({ usage }: { usage: PricingUsage }) {
  const t = useT();
  if (usage.requests === 0) return <span className={styles.dimmed}>{t('pricing.usage.none')}</span>;
  const unpriced = usage.requests - usage.priced_requests;
  return (
    <span className={styles.usage}>
      <strong>{usage.cost_usd == null ? '—' : formatUsd(usage.cost_usd)}</strong>
      <span className={styles.dimmed}>
        {t('pricing.usage.requests', { n: formatTokensFull(usage.requests) })}
        {unpriced > 0 && ` · ${t('pricing.usage.partial', { n: formatTokensFull(unpriced) })}`}
      </span>
    </span>
  );
}
