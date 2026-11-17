import { type InsightsCompareWindow } from '../../../types/insights';
import { useInsightsFormat } from '../useInsightsFormat';
import { useComparisonTip } from '../../../hooks/useCompareWindowLabel';
import { tipCard } from '../../../components/common/tipCard';
import React from 'react';
import { StatTiles } from '../../../components/common/StatTiles';
import { RollingNumber } from '../../../components/dashboard/RollingNumber';
import { ArrowDownOutlined, ArrowUpOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import { useDisplayCurrency } from '../../../types/CurrencyDisplayContext';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { compareMetric, cubeMetric, INSIGHTS_METRICS, metricValue, type InsightsMetric, type Measures, type TokenScope } from '../../../types/insightsCube';
import { changeTrend, formatChange, metricReadout } from '../../../types/insightsFormat';
import styles from '../insights.module.css';

interface MetricTilesProps {
  current: Measures;
  /**
   * The window the tiles are measured against, its robust progress-scaled baseline (`measures`),
   * and its unscaled raw totals (`raw`) for sample-size confidence; null when not comparing.
   */
  baseline: { measures: Measures; raw: Measures; window: InsightsCompareWindow } | null;
  metric: InsightsMetric;
  /** The scope the token tile reads in. */
  tokenScope: TokenScope;
  onMetricChange: (metric: InsightsMetric) => void;
}

/**
 * The window's four headline numbers, each also the switch for what the trend plots.
 *
 * The figures roll to a new reading the way the dashboard's do; the page groups them with the token
 * parts, so a filter that moves them all sweeps them together. The change against the comparison window carries an arrow and a
 * muted red for a rise or green for a fall, unless it is within chance. The tones are mixed well
 * toward the ink: they say which way a figure moved, and stay clear of the saturated state colours
 * that mark a failure.
 */
export const MetricTiles: React.FC<MetricTilesProps> = ({ current, baseline, metric, tokenScope, onMetricChange }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { currency } = useDisplayCurrency();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const comparisonTip = useComparisonTip();

  const tiles = INSIGHTS_METRICS.map((item) => {
    const measured = cubeMetric(item, tokenScope);
    const value = metricValue(current, measured);
    const readout = metricReadout(measured, value, style, currency);
    const before = baseline ? metricValue(baseline.measures, measured) : null;
    const comparison = baseline ? compareMetric(current, baseline.measures, measured, baseline.raw) : null;
    const changeText = comparison?.kind === 'change' ? formatChange(comparison.change) : null;
    const changeCard = comparison && baseline ? comparisonTip({ comparison, compare: baseline.window }) : null;
    return {
      key: item,
      label: t(`insights.metric.${measured}`),
      value: (
        <span data-tip={formatMetricExact(measured, value)}>
          {readout ? <RollingNumber readout={readout} /> : formatMetric(measured, value, style)}
        </span>
      ),
      // Without a comparison the foot stays mounted and empty, so turning one on moves nothing.
      foot: comparison === null ? null : (
        <>
          <span className={styles['tile-change']} data-trend={changeTrend(comparison)} {...tipCard(changeCard)}>
            {comparison.kind !== 'change' || changeText === null ? (
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
          </span>
          <span className={styles['tile-change-was']}>
            {t('insights.change_was', { value: formatMetric(measured, before, style) })}
          </span>
        </>
      ),
    };
  });

  return (
    <StatTiles
      tiles={tiles}
      selected={metric}
      onSelect={onMetricChange}
      ariaLabel={t('insights.metric_switch')}
      phoneLayout="grid"
      testId="insights-tiles"
      tileTestIdPrefix="insights-tile"
    />
  );
};
