import clsx from 'clsx';
import { Meter } from '../../components/common/Meter';
import { Tooltip } from '../../components/common/Tooltip';
import { useT, type TFunc } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { QuotaMetric } from '../../types/quota';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { compactQuotaCapacity, describeCompactQuotaCapacity } from '../quota/quotaCapacity';
import { QuotaCapacityButton, type QuotaCapacityOwner } from '../quota/QuotaCapacityButton';
import { formatQuotaMetric, quotaRemainingPercent, quotaRemainingText, quotaResetCountdown, quotaResetText } from '../quota/quotaFormat';
import { QUOTA_LOW_PERCENT, quotaRemainingStroke } from '../quota/quotaThresholds';
import { quotaWindowKindOf } from '../quota/quotaWindowSelection';
import { packQuotaLines, type QuotaLine, type QuotaLineCell, type QuotaPeriod } from './credentialSections';
import styles from './QuotaGauges.module.css';

const PERIOD_KEYS: Record<QuotaPeriod, MessageKey> = {
  five_hour: 'quota.slot_five_hour', daily: 'quota.slot_daily', weekly: 'quota.slot_weekly', monthly: 'quota.slot_monthly',
};

function lineTitle(line: QuotaLine, t: TFunc): string {
  if (line.label) return line.label;
  return t(line.scope === 'code_review' ? 'omc.quota_family_code_review' : 'omc.quota_family_plan');
}

function cellPeriodTitle(cell: QuotaLineCell, t: TFunc): string | undefined {
  const kind = quotaWindowKindOf(cell.window);
  return kind === 'five_hour' || kind === 'daily' || kind === 'weekly' || kind === 'monthly' ? t(PERIOD_KEYS[kind]) : undefined;
}

/** The plan's limits are named by their period; any other by its period and name, or its name alone. */
function readingName(line: QuotaLine, cell: QuotaLineCell, t: TFunc): string {
  const period = cellPeriodTitle(cell, t);
  if (line.scope === 'standard' && !line.label) return period ?? cell.window.label;
  return period ? t('omc.quota_reading_name', { family: lineTitle(line, t), period }) : lineTitle(line, t);
}

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
  return (
    <div className={styles.lines}>
      {packQuotaLines(lines).map(({ line, cell }) => (
        <QuotaReading
          key={cell.key}
          cell={cell}
          // Every reading names itself, so "5 hours Gemini" and "Weekly Gemini 4 Argon" cannot be
          // mistaken for each other without a header to read them by.
          name={readingName(line, cell, t)}
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
 * unknown usage keeps a countdown. The window's label, reset instant, accuracy and the estimate's
 * basis remain in its tooltip.
 */
function QuotaReading({ cell, name, provider, isMuted, nowMS, owner }: {
  cell: QuotaLineCell;
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
  // Show the unused window's duration, independent of its moving reset estimate. The tooltip
  // preserves that estimate; zero usage does not prove whether the upstream window has started.
  const isUnusedFullCodexWindow = provider === 'codex'
    && window.scope === 'standard'
    && quotaWindowKindOf(window) === 'five_hour'
    && window.used_percent === 0
    && (window.remaining_percent ?? 100) === 100;
  const reset = isUnusedFullCodexWindow ? t('quota.duration_hours', { n: 5 }) : quotaResetCountdown(window, nowMS, t);
  // A plugin window has no estimate; its own words for what is left take the estimate's place.
  const estimate = compactQuotaCapacity(window, tokenStyle, t) ?? window.description;
  const capacity = describeCompactQuotaCapacity(window, tokenStyle, t);
  const detail = [window.label, window.description, quotaResetText(window, nowMS, t), capacity].filter(Boolean);
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
      {/* A reading is plain text, so the shared hint answers touch and keyboard focus without
          turning quota inspection into an action or relying on a hover-only native title. */}
      <Tooltip
        classNames={{ root: styles['tip-popper'] }}
        title={<div className={styles.tip}>{detail.map((line) => <div key={line}>{line}</div>)}</div>}
      >
        <div className={styles.reading} role="group" aria-label={window.label} tabIndex={0}>
          <span className={styles.name} data-tip={name} data-tip-overflow="">{name}</span>
          <span className={styles.value}>
            <span className={styles['value-prefix']}>{t('omc.quota_remaining_prefix')}</span>
            {/* The bar carries the tone; the figure takes it only once the window is nearly spent. */}
            <b style={remaining != null && remaining < QUOTA_LOW_PERCENT ? { color: quotaRemainingStroke(remaining) } : undefined}>{quotaRemainingText(window)}</b>
          </span>
          <Meter className={styles.bar} value={remaining ?? 0} color={quotaRemainingStroke(remaining)} label={remaining == null ? undefined : window.label} />
          {estimate && (owner && window.capacity ? (
            <span className={styles.estimate}>
              <QuotaCapacityButton owner={owner} window={window}>{estimate}</QuotaCapacityButton>
            </span>
          ) : <span className={styles.estimate}>{estimate}</span>)}
          {reset && <span className={styles.reset}>{reset}</span>}
        </div>
      </Tooltip>
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
