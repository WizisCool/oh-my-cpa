import React from 'react';
import styles from '../insights.module.css';

interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  color?: string;
}

/**
 * A row's shape over the window, as one SVG path. A table of keys would otherwise mount one chart
 * instance per row; a path is all a row's trend needs.
 */
export const Sparkline: React.FC<SparklineProps> = React.memo(({ values, width = 88, height = 22, color }) => {
  const max = Math.max(0, ...values);
  if (values.length < 2 || max <= 0) {
    return <svg className={styles['sparkline']} width={width} height={height} aria-hidden="true"><line x1="0" x2={width} y1={height - 1} y2={height - 1} /></svg>;
  }
  const step = width / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 1 - (value / max) * (height - 3)).toFixed(1)}`);
  return (
    <svg className={styles['sparkline']} width={width} height={height} aria-hidden="true">
      <path d={`M0,${height} L${points.join(' L')} L${width},${height} Z`} className={styles['sparkline-area']} style={color ? { fill: color } : undefined} />
      <path d={`M${points.join(' L')}`} className={styles['sparkline-line']} style={color ? { stroke: color } : undefined} />
    </svg>
  );
});
Sparkline.displayName = 'Sparkline';
