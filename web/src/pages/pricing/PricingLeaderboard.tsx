import React from 'react';
import { Segmented } from 'antd';
import { BarChartOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { ModelPrice } from '../../types/pricing';
import styles from './PricingLeaderboard.module.css';

interface PricingLeaderboardProps {
  models: ModelPrice[];
}

/** Standard balanced coding session assumption */
const FIXED_BUDGET = 60; // Fixed $60 budget
const PROMPT_TOKENS = 1000;
const COMPLETION_TOKENS = 300;
const CACHE_READ_TOKENS = 35000;

type DisplayLimit = '10' | '25' | 'all';

/**
 * Dynamic tick generator based on actual data range.
 * Produces 4 to 6 clean, rounded multiplier ticks starting at 1.
 */
function generateTicks(maxRatio: number): number[] {
  if (maxRatio <= 1.2) return [1];
  if (maxRatio <= 2) return [1, 1.25, 1.5, 1.75, 2];
  if (maxRatio <= 3) return [1, 1.5, 2, 2.5, 3];
  if (maxRatio <= 5) return [1, 2, 3, 4, 5];
  if (maxRatio <= 10) return [1, 2.5, 5, 7.5, 10];
  if (maxRatio <= 20) return [1, 5, 10, 15, 20];
  if (maxRatio <= 35) return [1, 5, 10, 20, 30];
  if (maxRatio <= 60) return [1, 10, 25, 40, 50];
  if (maxRatio <= 120) return [1, 10, 25, 50, 75, 100];
  if (maxRatio <= 300) return [1, 10, 50, 100, 200, Math.ceil(maxRatio / 50) * 50];
  if (maxRatio <= 600) return [1, 25, 100, 250, 500];
  if (maxRatio <= 1200) return [1, 50, 200, 500, 1000];
  return [1, 10, 100, 500, 1000, Math.ceil(maxRatio / 500) * 500];
}

/**
 * Maps a ratio (>= 1) to percentage width (from minBarPct up to 100%).
 * Uses linear scale for small ranges (<= 5x), and power (sqrt) scale for larger ranges
 * to keep smaller models visible while accentuating the contrast for higher-volume models.
 */
function getRatioPosition(r: number, topTick: number, isLinear: boolean): number {
  if (topTick <= 1) return 50;
  const clamped = Math.max(1, Math.min(topTick, r));
  const minBarPct = 6;
  const maxBarPct = 100;

  if (isLinear) {
    const fraction = (clamped - 1) / (topTick - 1);
    return minBarPct + (maxBarPct - minBarPct) * fraction;
  }

  // Sqrt power scale
  const fraction = (Math.sqrt(clamped) - 1) / (Math.sqrt(topTick) - 1);
  return minBarPct + (maxBarPct - minBarPct) * fraction;
}

export const PricingLeaderboard: React.FC<PricingLeaderboardProps> = ({ models }) => {
  const t = useT();
  const [limit, setLimit] = React.useState<DisplayLimit>('10');

  // Calculate requests and cost per model for $60 budget
  const rows = React.useMemo(() => {
    return models
      .filter((m) => {
        const p = m.prompt_price_per_1m || 0;
        const c = m.completion_price_per_1m || 0;
        const r = m.cache_read_price_per_1m || 0;
        return p > 0 || c > 0 || r > 0;
      })
      .map((m) => {
        const pPrompt = m.prompt_price_per_1m || 0;
        const pComp = m.completion_price_per_1m || 0;
        const pRead = m.cache_read_price_per_1m > 0 ? m.cache_read_price_per_1m : pPrompt;
        const mult = m.price_multiplier || 1;

        const promptCost = (PROMPT_TOKENS / 1_000_000) * pPrompt;
        const compCost = (COMPLETION_TOKENS / 1_000_000) * pComp;
        const cacheCost = (CACHE_READ_TOKENS / 1_000_000) * pRead;
        const singleReqCost = (promptCost + compCost + cacheCost) * mult;

        const requests = singleReqCost > 0 ? Math.floor(FIXED_BUDGET / singleReqCost) : 0;
        const dailyAvg = Math.round(requests / 30);

        return {
          model: m.model,
          singleReqCost,
          requests,
          dailyAvg,
        };
      })
      .filter((row) => row.requests > 0)
      .sort((a, b) => b.singleReqCost - a.singleReqCost || a.requests - b.requests);
  }, [models]);

  // Visible subset according to display limit
  const visibleRows = React.useMemo(() => {
    if (limit === '10') return rows.slice(0, 10);
    if (limit === '25') return rows.slice(0, 25);
    return rows;
  }, [rows, limit]);

  // Algorithmic scale calculations based on visible data
  const { scaleTicks, calculatedRows } = React.useMemo(() => {
    if (visibleRows.length === 0) {
      return { scaleTicks: [], calculatedRows: [] };
    }

    const baseline = visibleRows[0].requests; // Most expensive model is baseline (1x)
    const maxRequests = Math.max(...visibleRows.map((r) => r.requests));
    const maxRatio = Math.max(1, maxRequests / baseline);

    const rawTicks = generateTicks(maxRatio);
    const topTick = rawTicks[rawTicks.length - 1];
    const isLinear = maxRatio <= 5;

    const scaleTicks = rawTicks.map((val) => ({
      val,
      label: `${val}x`,
      position: getRatioPosition(val, topTick, isLinear),
    }));

    const calculatedRows = visibleRows.map((r) => {
      const ratio = r.requests / baseline;
      const widthPct = getRatioPosition(ratio, topTick, isLinear);
      return {
        ...r,
        ratio,
        widthPct,
      };
    });

    return { scaleTicks, calculatedRows };
  }, [visibleRows]);

  return (
    <div className={styles.leaderboardCard} data-testid="pricing-leaderboard">
      {/* Header Block */}
      <div className={styles.header}>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <BarChartOutlined style={{ color: 'var(--accent)', fontSize: 16 }} />
            <h2 className={styles.title}>{t('pricing.leaderboard.title')}</h2>
            <span className={styles.budgetBadge}>{t('pricing.leaderboard.budget_tag', { n: FIXED_BUDGET })}</span>
          </div>
          <p className={styles.subtitle}>{t('pricing.leaderboard.subtitle')}</p>
        </div>

        <div className={styles.headerRight}>
          {rows.length > 10 ? (
            <Segmented<DisplayLimit>
              size="small"
              value={limit}
              onChange={(val) => setLimit(val)}
              options={[
                { label: t('pricing.leaderboard.top_10'), value: '10' },
                ...(rows.length > 25 ? [{ label: t('pricing.leaderboard.top_25'), value: '25' as DisplayLimit }] : []),
                { label: t('pricing.leaderboard.all_count', { n: rows.length }), value: 'all' },
              ]}
            />
          ) : (
            <span className={styles.modelCountBadge}>{t('pricing.leaderboard.model_count', { n: rows.length })}</span>
          )}
        </div>
      </div>

      {/* Bar Chart Container */}
      <div className={styles.chartContainer}>
        {calculatedRows.length === 0 ? (
          <div style={{ color: 'var(--muted)', textAlign: 'center', padding: '24px 0', fontSize: 13 }}>
            {t('pricing.leaderboard.empty')}
          </div>
        ) : (
          <>
            {/* Chart Body with Background Grid Lines */}
            <div className={styles.chartBody}>
              {/* Algorithmic Vertical Guide Lines */}
              <div className={styles.gridOverlay}>
                {scaleTicks.map((tick) => (
                  <div
                    key={tick.val}
                    className={styles.gridLine}
                    style={{ left: `${tick.position}%` }}
                  />
                ))}
              </div>

              {/* Model Bar Rows */}
              <div className={styles.barList}>
                {calculatedRows.map((row) => (
                  <div key={row.model} className={styles.barRow}>
                    <div className={styles.barPlotCol}>
                      <div
                        className={styles.barFill}
                        style={{ width: `${row.widthPct}%` }}
                      />
                    </div>
                    <div className={styles.barMetaCol}>
                      <span className={styles.requestCount}>
                        {t('pricing.leaderboard.req_count', { n: row.requests.toLocaleString() })}
                      </span>
                      <span className={styles.modelName}>{row.model}</span>
                      <span
                        className={`${styles.ratioBadge} ${row.ratio === 1 ? styles.ratioBaseline : ''}`}
                      >
                        {row.ratio === 1
                          ? t('pricing.leaderboard.baseline')
                          : `${row.ratio < 10 ? row.ratio.toFixed(1) : Math.round(row.ratio)}x`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Expand / Collapse Footer row when more than 10 models exist */}
            {rows.length > 10 && (
              <div className={styles.expandRow}>
                {limit !== 'all' ? (
                  <button
                    type="button"
                    className={styles.expandBtn}
                    onClick={() => setLimit('all')}
                  >
                    {t('pricing.leaderboard.expand_all', { n: rows.length })} <DownOutlined style={{ fontSize: 10 }} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.expandBtn}
                    onClick={() => setLimit('10')}
                  >
                    {t('pricing.leaderboard.collapse_to_10')} <UpOutlined style={{ fontSize: 10 }} />
                  </button>
                )}
              </div>
            )}

            {/* Bottom Algorithmic Scale Axis */}
            <div className={styles.scaleFooter}>
              <div className={styles.scalePlotArea}>
                {scaleTicks.map((tick, idx) => {
                  let alignStyle: React.CSSProperties = { transform: 'translateX(-50%)' };
                  if (idx === 0) alignStyle = { transform: 'translateX(-30%)' };
                  else if (idx === scaleTicks.length - 1) alignStyle = { transform: 'translateX(-80%)' };

                  return (
                    <div
                      key={tick.val}
                      className={styles.scaleTickMark}
                      style={{ left: `${tick.position}%`, ...alignStyle }}
                    >
                      <span className={styles.scaleTickLabel}>{tick.label}</span>
                    </div>
                  );
                })}
              </div>
              <div className={styles.scaleMetaSpacer} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
