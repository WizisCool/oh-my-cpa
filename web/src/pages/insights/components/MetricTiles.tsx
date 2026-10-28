import { currencyReadout, type DisplayCurrency } from '../../../types/currencyDisplay';
import { useDisplayCurrency } from '../../../types/CurrencyDisplayContext';
import { type InsightsCompareWindow } from '../../../types/insights';
import { useInsightsFormat } from '../useInsightsFormat';
import { useCompareWindowLabel } from '../useCompareWindowLabel';
import React from 'react';
import clsx from 'clsx';
import { RollingNumber } from '../../../components/dashboard/RollingNumber';
import { ArrowDownOutlined, ArrowUpOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import { resolveCountFlowReadout, resolveTokenFlowReadout, type TokenNumberStyle } from '../../../types/tokenDisplay';
import type { RollingReadout } from '../../../types/rollingNumber';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { compareMetric, INSIGHTS_METRICS, metricValue, type InsightsMetric, type Measures } from '../insightsCube';
import { changeTrend, formatChange } from '../insightsFormat';
import styles from '../insights.module.css';

interface MetricTilesProps {
  current: Measures;
  /**
   * The window the tiles are measured against and its sums; null when the page is not comparing.
   * The two travel together because the tile's label depends on the window: a running unit is
   * measured against the same elapsed stretch of the period before it, not against all of it.
   */
  baseline: { measures: Measures; window: InsightsCompareWindow; isSameStretch: boolean } | null;
  metric: InsightsMetric;
  onMetricChange: (metric: InsightsMetric) => void;
}

function readoutOf(metric: InsightsMetric, value: number | null, style: TokenNumberStyle, currency: DisplayCurrency): RollingReadout | undefined {
  if (value === null) return undefined;
  switch (metric) {
    case 'cost':
      return currencyReadout(value, currency, 'adaptive');
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
 * a fall, unless it is within chance. The tones are mixed well toward the ink: they say which way a figure moved, and stay
 * clear of the saturated state colours that mark a failure.
 *
 * A unit still running is measured against the same elapsed stretch of the period before it, so the
 * figure under the change is labelled for that stretch rather than left to read as the previous
 * period's total; the window itself is the title.
 */
export const MetricTiles: React.FC<MetricTilesProps> = ({ current, baseline, metric, onMetricChange }) => {
  const t = useT();
  const { currency } = useDisplayCurrency();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const formatCompareWindow = useCompareWindowLabel();

  return (
    <div className={styles['tiles']} role="tablist" aria-label={t('insights.metric_switch')} data-testid="insights-tiles">
      {INSIGHTS_METRICS.map((item) => {
        const value = metricValue(current, item);
        const before = baseline ? metricValue(baseline.measures, item) : null;
        const comparison = baseline ? compareMetric(current, baseline.measures, item) : null;
        const changeText = comparison?.kind === 'change' ? formatChange(comparison.change) : null;
        const changeTitle = [
          comparison?.kind === 'change' && comparison.isNoise ? t('insights.change_noise') : null,
          baseline ? formatCompareWindow(baseline.window) : null,
        ].filter(Boolean).join(' · ');
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
              <RollingNumber readout={readoutOf(item, value, style, currency)} />
            </span>
            <span
              className={styles['tile-change']}
              data-trend={comparison ? changeTrend(comparison) : undefined}
              title={changeTitle || undefined}
            >
              {comparison === null ? null : comparison.kind !== 'change' || changeText === null ? (
                <span className={styles['tile-change-none']}>
                  {comparison.kind === 'new' ? t('insights.change_new') : '—'}
                </span>
              ) : (
                <>
                  {comparison.change > 0 && <ArrowUpOutlined aria-hidden="true" />}
                  {comparison.change < 0 && <ArrowDownOutlined aria-hidden="true" />}
                  {/* The arrow carries the direction, so the figure drops its sign rather than saying it twice. */}
                  <span>{comparison.change === 0 ? changeText : changeText.replace(/^[+−]/, '')}</span>
                  {comparison.isNoise && <span className="sr-only">{t('insights.change_noise')}</span>}
                </>
              )}
              {baseline !== null && (
                <span className={styles['tile-change-was']}>
                  {t(baseline.isSameStretch ? 'insights.change_was_same_stretch' : 'insights.change_was', { value: formatMetric(item, before, style) })}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
};
