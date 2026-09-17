import React from 'react';
import type { ManagementOverviewBucket } from '../../types/management';

export interface ProviderSparklineProps {
  buckets?: ManagementOverviewBucket[];
  total: number;
  successRate: number | null;
  height?: number;
}

export const ProviderSparkline: React.FC<ProviderSparklineProps> = ({
  buckets = [],
  total,
  successRate,
  height = 18,
}) => {
  if (total === 0 || buckets.length === 0) {
    return (
      <svg
        width="100%"
        height={height}
        viewBox="0 0 100 18"
        preserveAspectRatio="none"
        className="provider-sparkline is-empty"
        aria-hidden="true"
      >
        <line
          x1="0"
          y1="16"
          x2="100"
          y2="16"
          stroke="var(--border)"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const values = buckets.map((b) => Math.max(0, (b.success || 0) + (b.failed || 0)));
  const max = Math.max(...values, 1);
  const n = values.length;
  const slotWidth = 100 / n;
  const barWidth = Math.max(0.6, slotWidth * 0.72);
  const offset = (slotWidth - barWidth) / 2;

  // Tone color based on success rate
  const color =
    successRate !== null && successRate < 70
      ? 'var(--danger)'
      : successRate !== null && successRate < 95
        ? 'var(--warn)'
        : 'var(--accent)';

  return (
    <svg
      width="100%"
      height={height}
      viewBox="0 0 100 18"
      preserveAspectRatio="none"
      className="provider-sparkline"
      aria-hidden="true"
    >
      {values.map((v, i) => {
        const barHeight = v > 0 ? Math.max(2, (v / max) * 16) : 0.8;
        const x = i * slotWidth + offset;
        const y = 18 - barHeight;
        const opacity = v > 0 ? 0.9 : 0.2;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            rx={0.5}
            fill={color}
            opacity={opacity}
          />
        );
      })}
    </svg>
  );
};
