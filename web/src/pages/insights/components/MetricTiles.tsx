import React from 'react';
import clsx from 'clsx';
import { RollingNumber } from '../../../components/dashboard/RollingNumber';
import { ArrowDownOutlined, ArrowUpOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import { resolveCountFlowReadout, resolveTokenFlowReadout, type TokenNumberStyle } from '../../../types/tokenDisplay';
import type { RollingReadout } from '../../../types/rollingNumber';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { INSIGHTS_METRICS, metricValue, relativeChange, type InsightsMetric, type Measures } from '../insightsCube';
import { changeTrend, formatChange, formatMetric, formatMetricExact } from '../insightsFormat';
import styles from '../insights.module.css';

interface MetricTilesProps {
  current: Measures;
  /** The comparison window's sums; null when the page is not comparing. */
  previous: Measures | null;
  metric: InsightsMetric;
  onMetricChange: (metric: InsightsMetric) => void;
}

function readoutOf(metric: InsightsMetric, value: number | null, style: TokenNumberStyle): RollingReadout | undefined {
  if (value === null) return undefined;
  switch (metric) {
    case 'cost':
      return { number: value, prefix: '$', suffix: '', format: { minimumFractionDigits: 2, maximumFractionDigits: value !== 0 && value < 0.01 ? 4 : 2 } };
    case 'tokens':
      return resolveTokenFlowReadout(value, style);
    case 'requests':
      return resolveCountFlowReadout(value);
    case 'latency':
      return value >= 1000
        ? { number: value / 1000, suffix: 's', format: { minimumFractionDigits: 2, maximumFractionDigits: 2 } }
        : { number: Math.round(value), suffix: 'ms', format: { maximumFractionDigits: 0 } };
  }
}

/**
 * The window's four headline numbers, each also the switch for what the trend plots.
 *
 * The change against the comparison window carries an arrow and a muted red for a rise or green for
 * a fall. The tones are mixed well toward the ink: they say which way a figure moved, and stay
 * clear of the saturated state colours that mark a failure.
 */
export const MetricTiles: React.FC<MetricTilesProps> = ({ current, previous, metric, onMetricChange }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();

  return (
    <div className={styles['tiles']} role="tablist" aria-label={t('insights.metric_switch')} data-testid="insights-tiles">
      {INSIGHTS_METRICS.map((item) => {
        const value = metricValue(current, item);
        const before = previous ? metricValue(previous, item) : null;
        const change = previous ? relativeChange(value, before) : null;
        const changeText = formatChange(change);
        const isActive = item === metric;
        return (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={clsx(styles['tile'], isActive && styles['tile-active'])}
            onClick={() => onMetricChange(item)}
            data-testid={`insights-tile-${item}`}
          >
            <span className={styles['tile-label']}>{t(`insights.metric.${item}`)}</span>
            <span className={styles['tile-value']} title={formatMetricExact(item, value)}>
              <RollingNumber readout={readoutOf(item, value, style)} />
            </span>
            <span className={styles['tile-change']} data-trend={previous === null ? undefined : changeTrend(change)}>
              {previous === null ? null : changeText === null ? (
                <span className={styles['tile-change-none']}>
                  {(before === null || before === 0) && (value ?? 0) > 0 ? t('insights.change_new') : '—'}
                </span>
              ) : (
                <>
                  {change !== null && change > 0 && <ArrowUpOutlined aria-hidden="true" />}
                  {change !== null && change < 0 && <ArrowDownOutlined aria-hidden="true" />}
                  {/* The arrow carries the direction, so the figure drops its sign rather than saying it twice. */}
                  <span>{change === 0 ? changeText : changeText.replace(/^[+−]/, '')}</span>
                </>
              )}
              {previous !== null && (
                <span className={styles['tile-change-was']}>{t('insights.change_was', { value: formatMetric(item, before, style) })}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
};
