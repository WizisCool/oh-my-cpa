import React from 'react';
import { cacheScaleMix, formatCacheRate } from '../../../theme/cacheScale';
import { durationScaleMix } from '../../../theme/durationScale';
import { formatLatency } from '../../../types/insightsFormat';
import styles from '../insights.module.css';

/** A cache-read rate on the console's yellow-to-green ramp, or a dash where no prompt was read. */
export function CacheRateText({ rate }: { rate: number | null }) {
  if (rate === null) return <span className={styles['is-muted']}>—</span>;
  const mix = cacheScaleMix(rate);
  return (
    <span
      className={styles['rate-text']}
      style={{ '--rate-from': mix.from, '--rate-to': mix.to, '--rate-from-share': mix.fromShare } as React.CSSProperties}
    >
      {formatCacheRate(rate)}
    </span>
  );
}

/** A mean total latency on the request list's green-to-orange duration ramp; red stays for failures. */
export function LatencyText({ ms }: { ms: number | null }) {
  const mix = durationScaleMix(ms);
  if (ms === null || mix === null) return <span className={styles['is-muted']}>—</span>;
  return (
    <span
      className={styles['rate-text']}
      style={{ '--rate-from': mix.from, '--rate-to': mix.to, '--rate-from-share': mix.fromShare } as React.CSSProperties}
    >
      {formatLatency(ms)}
    </span>
  );
}
