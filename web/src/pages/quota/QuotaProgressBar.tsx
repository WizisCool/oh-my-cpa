import React from 'react';
import { Progress } from 'antd';
import { useT } from '../../i18n';
import { formatTimeWithCountdown, quotaRemainingPercent, quotaWindowLabel, resetAccuracyMarker } from './quotaFormat';
import { quotaRemainingStroke } from './quotaThresholds';
import styles from './QuotaPresentation.module.css';

interface QuotaProgressBarProps {
  nowMS: number;
  kind?: string;
  label?: string;
  subLabel?: string;
  usedPercent?: number | null;
  remainingPercent?: number | null;
  resetAtMS?: number | null;
  resetLabel?: string;
  resetAccuracy?: 'exact' | 'derived' | 'approximate';
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
  resetAccuracy = 'exact',
  height = 8,
  showPercent = true,
}) => {
  const t = useT();

  // A credential may report only usage; derive the remaining share from it
  // rather than showing no bar at all. The colour rule is shared with the list row's bars.
  const clampedRemaining = quotaRemainingPercent({ remaining_percent: remainingPercent ?? undefined, used_percent: usedPercent ?? undefined });
  const hasData = clampedRemaining != null;
  const strokeColor = quotaRemainingStroke(clampedRemaining);

  const resolvedLabel = quotaWindowLabel(kind, label, t);

  // Reset cell: "09/05 19:43 · in 4 hours"; backend-provided label as fallback. A passed
  // instant is only "recovered" when upstream stated it exactly: the row beside this cell
  // makes the same distinction, and a derived instant supports no such claim.
  const resetMarker = resetAccuracyMarker(resetAccuracy);
  const computedResetText = (() => {
    if (resetAtMS) {
      if (resetAtMS - nowMS > 0) return `${resetMarker}${formatTimeWithCountdown(resetAtMS, nowMS, t)}`;
      if (!resetMarker) return t('quota.recovered');
      return resetLabel ? `${resetMarker}${resetLabel}` : '';
    }
    return resetLabel ? `${resetMarker}${resetLabel}` : '';
  })();

  const displayPercent = hasData ? `${clampedRemaining}%` : '--';

  return (
    <div className={styles['progress-wrap']}>
      <div className={styles['progress-label-row']}>
        <span className={styles['progress-label']} title={resolvedLabel}>
          {resolvedLabel}
          {subLabel && <span className={styles['progress-sub-label']}>{subLabel}</span>}
        </span>
        {showPercent && (
          <span className={styles['progress-value']} style={{ color: hasData ? undefined : 'var(--meta)' }}>
            {displayPercent}
          </span>
        )}
        <span
          className={styles['progress-reset']}
          title={resetAccuracy === 'exact' ? computedResetText || undefined : t('quota.reset_estimated_hint')}
        >
          {computedResetText}
        </span>
      </div>

      <div
        style={{ width: '100%', lineHeight: 1 }}
        title={hasData ? `${resolvedLabel}: ${displayPercent}` : undefined}
      >
        <Progress
          percent={clampedRemaining ?? 0}
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
