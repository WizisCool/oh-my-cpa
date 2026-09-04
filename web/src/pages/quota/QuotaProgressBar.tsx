import React, { useState, useEffect } from 'react';
import { useT } from '../../i18n';
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
  height = 6,
  showPercent = true,
}) => {
  const t = useT();
  const [nowMS, setNowMS] = useState(Date.now());

  // Live timer every 15 seconds for relative reset text
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

  // Determine semantic color class
  let barClass = styles.barMuted;
  if (hasData) {
    if (safeRem <= 0) {
      barClass = styles.barDanger;
    } else if (safeRem < 20) {
      barClass = styles.barWarn;
    } else if (safeRem >= 70) {
      barClass = styles.barSuccess;
    } else {
      barClass = styles.barAccent;
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

  // Compute live relative reset string
  const computedResetLabel = (() => {
    if (!resetAtMS) return resetLabel;
    const diff = resetAtMS - nowMS;
    if (diff <= 0) return t('quota.recovered');
    const totalMinutes = Math.ceil(diff / 60000);
    if (totalMinutes < 60) return `${totalMinutes} ${t('quota.mins_later')}`;
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const timeStr = new Date(resetAtMS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (hours < 24) {
      return mins > 0
        ? `${timeStr} (${hours}h ${mins}m ${t('quota.later')})`
        : `${timeStr} (${hours}h ${t('quota.later')})`;
    }
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return `${timeStr} (${days}d ${remH}h ${t('quota.later')})`;
  })();

  const displayPercent = hasData ? `${Math.round(safeRem)}%` : '--';

  return (
    <div className={styles.progressWrap}>
      {(resolvedLabel || showPercent) && (
        <div className={styles.progressLabelRow}>
          <span className={styles.progressLabel} title={resolvedLabel}>
            {resolvedLabel}
            {subLabel && <span style={{ color: 'var(--meta)', marginLeft: 6 }}>{subLabel}</span>}
          </span>
          {showPercent && <span className={styles.progressValue}>{displayPercent}</span>}
        </div>
      )}

      <div
        className={styles.progressTrack}
        style={{ height }}
        role="progressbar"
        aria-valuenow={Math.round(safeRem)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={resolvedLabel || t('quota.col_windows')}
        title={hasData ? `${resolvedLabel}: ${displayPercent}` : undefined}
      >
        <div
          className={`${styles.progressBar} ${barClass}`}
          style={{ width: `${safeRem}%` }}
        />
      </div>

      {computedResetLabel && (
        <div className={styles.progressResetRow}>
          <span>{computedResetLabel}</span>
        </div>
      )}
    </div>
  );
};
