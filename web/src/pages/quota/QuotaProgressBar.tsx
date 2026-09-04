import React from 'react';
import styles from './QuotaPage.module.css';

interface QuotaProgressBarProps {
  label?: string;
  subLabel?: string;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetLabel?: string;
  height?: number;
  showPercent?: boolean;
}

export const QuotaProgressBar: React.FC<QuotaProgressBarProps> = ({
  label,
  subLabel,
  usedPercent,
  remainingPercent,
  resetLabel,
  height = 6,
  showPercent = true,
}) => {
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

  const displayPercent = hasData ? `${Math.round(safeRem)}%` : '--';

  return (
    <div className={styles.progressWrap}>
      {(label || showPercent) && (
        <div className={styles.progressLabelRow}>
          <span className={styles.progressLabel} title={label}>
            {label}
            {subLabel && <span style={{ color: 'var(--meta)', marginLeft: 6 }}>{subLabel}</span>}
          </span>
          {showPercent && <span className={styles.progressValue}>{displayPercent}</span>}
        </div>
      )}

      <div className={styles.progressTrack} style={{ height }} title={hasData ? `剩余: ${displayPercent}` : undefined}>
        <div
          className={`${styles.progressBar} ${barClass}`}
          style={{ width: `${safeRem}%` }}
        />
      </div>

      {resetLabel && (
        <div className={styles.progressResetRow}>
          <span>{resetLabel}</span>
        </div>
      )}
    </div>
  );
};
