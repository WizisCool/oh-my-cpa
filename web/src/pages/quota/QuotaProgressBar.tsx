import React, { useState, useEffect } from 'react';
import { Progress } from 'antd';
import { useT } from '../../i18n';
import { formatTimeWithCountdown } from './quotaFormat';
import styles from './QuotaPage.module.css';

interface QuotaProgressBarProps {
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
  const [nowMS, setNowMS] = useState(Date.now());

  // Live ticker so reset countdowns tick without a refetch
  useEffect(() => {
    if (!resetAtMS) return;
    const interval = setInterval(() => setNowMS(Date.now()), 15000);
    return () => clearInterval(interval);
  }, [resetAtMS]);

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
        className={styles.progressTrack}
        style={{ height }}
        title={hasData ? `${resolvedLabel}: ${displayPercent}` : undefined}
      >
        <Progress
          percent={hasData ? Math.round(safeRem) : 0}
          showInfo={false}
          strokeColor={strokeColor}
          size={['100%', height]}
          aria-label={resolvedLabel || t('quota.col_windows')}
        />
      </div>
    </div>
  );
};
