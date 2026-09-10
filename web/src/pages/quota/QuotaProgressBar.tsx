import React from 'react';
import { Progress } from 'antd';
import { useT } from '../../i18n';
import { formatTimeWithCountdown } from './quotaFormat';
import styles from './QuotaPage.module.css';

interface QuotaProgressBarProps {
  nowMS: number;
  kind?: string;
  label?: string;
  subLabel?: string;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetAtMS?: number | null;
  resetLabel?: string;
  height?: number;
  showPercent?: boolean;
}

export const QuotaProgressBar: React.FC<QuotaProgressBarProps> = ({
  nowMS,
  kind,
  label,
  subLabel,
  usedPercent,
  remainingPercent,
  resetAtMS,
  resetLabel,
  height = 8,
  showPercent = true,
}) => {
  const t = useT();

  // Derive remaining and used percentages
  let rem = remainingPercent;
  if (rem == null && usedPercent != null) {
    rem = Math.max(0, Math.min(100, 100 - usedPercent));
  }

  const hasData = rem != null;
  const safeRem = hasData ? Math.max(0, Math.min(100, rem!)) : 0;

  // CPAMC-style three buckets: plenty green, getting low yellow, nearly gone red
  let strokeColor = 'var(--muted)';
  if (hasData) {
    if (safeRem >= 70) {
      strokeColor = 'var(--success)';
    } else if (safeRem >= 25) {
      strokeColor = 'var(--warn)';
    } else {
      strokeColor = 'var(--danger)';
    }
  }

  // Localize window label
  const resolvedLabel = (() => {
    if (kind === 'five_hour') return t('quota.window_five_hour');
    if (kind === 'weekly') return t('quota.window_weekly');
    if (kind === 'daily') return t('quota.window_daily');
    if (kind === 'monthly') return t('quota.window_monthly');
    if (kind === 'credit_usage') return t('quota.window_credit_usage');
    return label || '';
  })();

  // Reset cell: "09/05 19:43 · 4小时后"; backend-provided label as fallback
  const computedResetText = (() => {
    if (resetAtMS) {
      if (resetAtMS - nowMS <= 0) return t('quota.recovered');
      return formatTimeWithCountdown(resetAtMS, nowMS, t);
    }
    return resetLabel || '';
  })();

  const displayPercent = hasData ? `${Math.round(safeRem)}%` : '--';

  return (
    <div className={styles.progressWrap}>
      <div className={styles.progressLabelRow}>
        <span className={styles.progressLabel} title={resolvedLabel}>
          {resolvedLabel}
          {subLabel && <span className={styles.progressSubLabel}>{subLabel}</span>}
        </span>
        {showPercent && (
          <span className={styles.progressValue} style={{ color: hasData ? undefined : 'var(--meta)' }}>
            {displayPercent}
          </span>
        )}
        <span className={styles.progressReset} title={computedResetText || undefined}>
          {computedResetText}
        </span>
      </div>

      <div
        style={{ width: '100%', lineHeight: 1 }}
        title={hasData ? `${resolvedLabel}: ${displayPercent}` : undefined}
      >
        <Progress
          percent={hasData ? safeRem : 0}
          showInfo={false}
          strokeColor={strokeColor}
          strokeWidth={height}
          style={{ margin: 0, padding: 0, display: 'block' }}
          aria-label={resolvedLabel || t('quota.col_windows')}
        />
      </div>
    </div>
  );
};
