import clsx from 'clsx';
import { useT } from '../../i18n';
import { successRateTone } from '../../types/usageEventMetrics';
import { Meter } from './Meter';
import { Tooltip } from './Tooltip';
import styles from './TrafficCell.module.css';

export interface TrafficCellProps {
  /** The row's traffic over the page's window; `undefined` while it is unknown. */
  traffic: { total: number; successRate: number | null } | undefined;
}

/**
 * A row's request count and success rate over the page's window, with the rate drawn as a meter
 * under it. The Gateway lists (providers, client keys) both show it, so a reader compares the
 * same reading in the same shape on either page.
 */
export function TrafficCell({ traffic }: TrafficCellProps) {
  const t = useT();
  if (!traffic) {
    const hint = t('pro.traffic_unknown');
    // The dash is focusable and named, so a keyboard reaches the hint and a screen reader hears it.
    return (
      <Tooltip title={hint}>
        <span className={styles['muted']} tabIndex={0} role="img" aria-label={hint}>—</span>
      </Tooltip>
    );
  }
  if (traffic.total === 0) return <span className={styles['muted']}>{t('pro.traffic_none')}</span>;
  // The rate's colour is the console's one band (successRateTone), carried by the number as
  // well as by the meter: at a measured 0% the meter has no width to paint.
  const tone = successRateTone(traffic.successRate);
  const rate = traffic.successRate ?? 0;
  return (
    <div className={styles['traffic']}>
      <div className={styles['line']}>
        <span className={styles['requests']}>{t('pro.traffic_requests', { n: traffic.total.toLocaleString() })}</span>
        <span className={clsx(styles['rate'], styles[`tone-${tone}`])}>{`${rate.toFixed(1)}%`}</span>
      </div>
      <Meter className={styles['meter']} value={rate} color={`var(--${tone === 'neutral' ? 'meta' : tone})`} />
    </div>
  );
}
