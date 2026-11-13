import clsx from 'clsx';
import { quotaWindowFullName } from '../quota/quotaWindowSelection';
import { Meter } from '../../components/common/Meter';
import { useT } from '../../i18n';
import type { QuotaMetric } from '../../types/quota';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { compactQuotaCapacity } from '../quota/quotaCapacity';
import { QuotaCapacityButton, type QuotaCapacityOwner } from '../quota/QuotaCapacityButton';
import { formatQuotaMetric, quotaRemainingPercent, quotaRemainingText, quotaResetCountdown } from '../quota/quotaFormat';
import { QUOTA_LOW_PERCENT, quotaRemainingStroke } from '../quota/quotaThresholds';
import { quotaWindowKindOf } from '../quota/quotaWindowSelection';
import { packQuotaLines, quotaReadingName, type QuotaLine, type QuotaLineCell } from './credentialSections';
import styles from './QuotaGauges.module.css';

/**
 * A credential's limits in two tracks: the first line's short limit - nearly every provider's five
 * hours - in the first and its long one - the week - in the second, so those two stand in the same
 * place on every credential. Further limits follow two to a line, and a limit left alone draws
 * across both tracks as one long bar.
 */
export function QuotaLines({ lines, provider, isMuted, nowMS, owner }: {
  lines: QuotaLine[];
  provider: string;
  isMuted: boolean;
  nowMS: number;
  owner?: QuotaCapacityOwner;
}) {
  const t = useT();
  const allWindows = lines.flatMap((line) => line.cells.map((cell) => cell.window));
  return (
    <div className={styles.lines}>
      {packQuotaLines(lines).map(({ line, cell }) => (
        <QuotaReading
          key={cell.key}
          cell={cell}
          siblings={allWindows}
          // Every reading names itself, so "5 hours Gemini" and "Weekly Gemini 4 Argon" cannot be
          // mistaken for each other without a header to read them by.
          name={quotaReadingName(line, cell, t)}
          provider={provider}
          isMuted={isMuted}
          nowMS={nowMS}
          owner={owner}
        />
      ))}
    </div>
  );
}

/**
 * One reading: its name and the share left, the bar, then the window's estimated size and when it
 * resets. Explicitly unused, full Codex five-hour readings show the window duration; rounded or
 * unknown usage keeps a countdown. The estimate opens the window's capacity details.
 */
function QuotaReading({ cell, siblings, name, provider, isMuted, nowMS, owner }: {
  cell: QuotaLineCell;
  siblings: readonly QuotaLineCell['window'][];
  name: string;
  provider: string;
  isMuted: boolean;
  nowMS: number;
  owner?: QuotaCapacityOwner;
}) {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const { window } = cell;
  const remaining = quotaRemainingPercent(window);
  // Use the unrounded upstream reading: a displayed 100% alone does not prove zero usage.
  // Show the unused window's duration, independent of its moving reset estimate: zero usage does not
  // prove whether the upstream window has started.
  const isUnusedFullCodexWindow = provider === 'codex'
    && window.scope === 'standard'
    && quotaWindowKindOf(window) === 'five_hour'
    && window.used_percent === 0
    && (window.remaining_percent ?? 100) === 100;
  const reset = isUnusedFullCodexWindow ? t('quota.duration_hours', { n: 5 }) : quotaResetCountdown(window, nowMS, t);
  // A plugin window has no estimate; its own words for what is left take the estimate's place.
  const estimate = compactQuotaCapacity(window, tokenStyle, t) ?? window.description;
  return (
    <div
      className={clsx(
        styles.cell,
        cell.spans ? styles['slot-span'] : cell.slot === 'long' ? styles['slot-long'] : styles['slot-short'],
        isMuted && styles.muted,
      )}
      data-quota-column={cell.key}
      data-quota-window-label={window.label}
      data-quota-spans={cell.spans ? 'true' : undefined}
    >
      <div className={styles.reading} role="group" aria-label={quotaWindowFullName(window)}>
        <span className={styles.name} data-tip={name} data-tip-overflow="">{name}</span>
        <span className={styles.value}>
          <span className={styles['value-prefix']}>{t('omc.quota_remaining_prefix')}</span>
          {/* The bar carries the tone; the figure takes it only once the window is nearly spent. */}
          <b style={remaining != null && remaining < QUOTA_LOW_PERCENT ? { color: quotaRemainingStroke(remaining) } : undefined}>{quotaRemainingText(window)}</b>
        </span>
        <Meter className={styles.bar} value={remaining ?? 0} color={quotaRemainingStroke(remaining)} label={remaining == null ? undefined : quotaWindowFullName(window)} />
        {estimate && (owner && window.capacity ? (
          <span className={styles.estimate}>
            <QuotaCapacityButton owner={owner} window={window} windows={siblings}>{estimate}</QuotaCapacityButton>
          </span>
        ) : <span className={styles.estimate}>{estimate}</span>)}
        {reset && <span className={styles.reset}>{reset}</span>}
      </div>
    </div>
  );
}

/**
 * A plugin's summary figures - credit balances, gift tokens - as quiet facts. Under the readings
 * they are footnotes in the readings' small type, often restating a bar's own words; alone, they
 * are the credential's reading and take the readings' name-and-figure line instead.
 */
export function QuotaMetrics({ metrics, isMuted, isStandalone }: {
  metrics: QuotaMetric[];
  isMuted: boolean;
  isStandalone: boolean;
}) {
  return (
    <div className={clsx(styles.metrics, isMuted && styles.muted)} data-standalone={isStandalone ? 'true' : undefined}>
      {metrics.map((metric, index) => (
        <span key={`${metric.key}-${index}`} className={styles.metric} data-quota-metric={metric.key}>
          <span className={styles['metric-label']}>{metric.label}</span>
          <b className={styles['metric-value']}>{formatQuotaMetric(metric)}</b>
        </span>
      ))}
    </div>
  );
}

/** Twelve hours of traffic as bars, failures stacked in the danger ink; nothing when none was reported. */
export function ActivitySpark({ buckets, failures, label }: { buckets: number[]; failures: number[]; label: string }) {
  if (buckets.length === 0) return null;
  const peak = Math.max(1, ...buckets);
  return (
    <span className={styles.spark} role="img" aria-label={label}>
      {buckets.map((count, index) => {
        const failed = failures[index] ?? 0;
        return (
          <span key={index} className={styles['spark-bar']} style={{ height: `${Math.max(8, (count / peak) * 100)}%` }} data-empty={count === 0 ? 'true' : undefined}>
            {failed > 0 && <span className={styles['spark-failed']} style={{ height: `${(failed / count) * 100}%` }} />}
          </span>
        );
      })}
    </span>
  );
}
