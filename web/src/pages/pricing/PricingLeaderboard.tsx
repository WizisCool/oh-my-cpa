import React from 'react';
import { Segmented } from 'antd';
import { BarChartOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import type { ModelPrice } from '../../types/pricing';
import styles from './PricingLeaderboard.module.css';

interface PricingLeaderboardProps {
  models: ModelPrice[];
}

// Size of one "balanced coding session" — prompt tokens in, completion tokens
// out, at a fixed US dollar budget. Simulated load, not telemetry: it exists so
// the leaderboard can compare models on cost and throughput on one axis.
const FIXED_BUDGET = 60;
const PROMPT_TOKENS = 1000;
const COMPLETION_TOKENS = 300;
const CACHE_READ_TOKENS = 35000;

const MIN_BAR_WIDTH_PCT = 4;
const MAX_BAR_WIDTH_PCT = 58;

type DisplayLimit = '10' | '25' | 'all';

/** Format a number into clean K / M notation (e.g. 1K, 10K, 50K, 260K) */
function formatReqTick(val: number): string {
  if (val >= 1_000_000) {
    const m = val / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (val >= 1_000) {
    const k = val / 1_000;
    return `${k % 1 === 0 ? k : k.toFixed(1)}K`;
  }
  return String(Math.round(val));
}

/**
 * Generate 4 to 6 clean, algorithmic ticks based on actual request range.
 */
function generateRequestTicks(minReq: number, maxReq: number): number[] {
  if (maxReq <= 0) return [];
  if (maxReq === minReq || maxReq / Math.max(1, minReq) <= 1.2) {
    return [Math.round(minReq)];
  }

  const ratio = maxReq / Math.max(1, minReq);

  // For narrow range (<= 5x), use linear steps
  if (ratio <= 5) {
    const range = maxReq - minReq;
    const rawStep = range / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const niceSteps = [1, 2, 2.5, 5, 10].map((s) => s * magnitude);
    const step = niceSteps.find((s) => s >= rawStep) || niceSteps[niceSteps.length - 1];

    const start = Math.floor(minReq / step) * step;
    const ticks: number[] = [];
    for (let cur = Math.max(0, start); cur <= maxReq + step * 0.5; cur += step) {
      if (cur >= minReq * 0.8) ticks.push(cur);
    }
    if (ticks.length < 3) ticks.push(maxReq);
    return ticks;
  }

  // For wide range (> 5x), use power/logarithmic checkpoints
  const allCheckpoints = [
    100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 75000, 100000,
    150000, 200000, 250000, 300000, 400000, 500000, 750000, 1000000, 2000000,
  ];

  // Starting nice tick around minReq
  const startTick =
    minReq < 1000
      ? 1000
      : allCheckpoints.find((cp) => cp >= minReq * 0.85) || minReq;

  // Ending nice tick around maxReq
  const endTick =
    allCheckpoints.find((cp) => cp >= maxReq) ||
    Math.ceil(maxReq / 50000) * 50000;

  // Pick intermediate checkpoints
  const between = allCheckpoints.filter((cp) => cp > startTick && cp < endTick);

  if (between.length <= 4) {
    return [startTick, ...between, endTick];
  }

  // Sample ~3 checkpoints between start and end
  const stepIdx = (between.length - 1) / 3;
  const sampled = [
    between[Math.round(stepIdx)],
    between[Math.round(stepIdx * 2)],
    between[Math.round(stepIdx * 3)],
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  return [startTick, ...sampled, endTick];
}

/**
 * Maps a request count to bar width percentage (MIN_BAR_WIDTH_PCT to MAX_BAR_WIDTH_PCT).
 */
function getBarWidth(
  requests: number,
  minReq: number,
  maxTick: number,
  isLinear: boolean
): number {
  if (maxTick <= minReq) return MIN_BAR_WIDTH_PCT;
  const clamped = Math.max(minReq, Math.min(maxTick, requests));

  if (isLinear) {
    const fraction = (clamped - minReq) / (maxTick - minReq);
    return MIN_BAR_WIDTH_PCT + (MAX_BAR_WIDTH_PCT - MIN_BAR_WIDTH_PCT) * fraction;
  }

  // Sqrt power scale
  const fraction =
    (Math.sqrt(clamped) - Math.sqrt(minReq)) /
    (Math.sqrt(maxTick) - Math.sqrt(minReq));
  return (
    MIN_BAR_WIDTH_PCT +
    (MAX_BAR_WIDTH_PCT - MIN_BAR_WIDTH_PCT) * Math.max(0, Math.min(1, fraction))
  );
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

    const minReq = visibleRows[0].requests; // Most expensive model
    const maxReq = Math.max(...visibleRows.map((r) => r.requests));
    const rawTicks = generateRequestTicks(minReq, maxReq);
    const maxTick = rawTicks[rawTicks.length - 1] || maxReq;
    const isLinear = maxReq / Math.max(1, minReq) <= 5;

    const scaleTicks = rawTicks.map((val) => ({
      val,
      label: formatReqTick(val),
      position: getBarWidth(val, minReq, maxTick, isLinear),
    }));

    const calculatedRows = visibleRows.map((r) => {
      const widthPct = getBarWidth(r.requests, minReq, maxTick, isLinear);
      return {
        ...r,
        widthPct,
      };
    });

    return { scaleTicks, calculatedRows };
  }, [visibleRows]);

  return (
    <div className={styles['leaderboard-card']} data-testid="pricing-leaderboard">
      {/* Header Block */}
      <div className={styles.header}>
        <div className={styles['title-area']}>
          <div className={styles['title-row']}>
            <BarChartOutlined style={{ color: 'var(--accent)', fontSize: 16 }} />
            <h2 className={styles.title}>{t('pricing.leaderboard.title')}</h2>
          </div>
          <p className={styles.subtitle}>{t('pricing.leaderboard.subtitle')}</p>
        </div>

        <div className={styles['header-right']}>
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
            <span className={styles['model-count-badge']}>{t('pricing.leaderboard.model_count', { n: rows.length })}</span>
          )}
        </div>
      </div>

      {/* Bar Chart Container */}
      <div className={styles['chart-container']}>
        {calculatedRows.length === 0 ? (
          <div style={{ color: 'var(--muted)', textAlign: 'center', padding: '24px 0', fontSize: 13 }}>
            {t('pricing.leaderboard.empty')}
          </div>
        ) : (
          <>
            {/* Chart Body with Background Grid Lines */}
            <div className={styles['chart-body']}>
              {/* Algorithmic Vertical Guide Lines */}
              <div className={styles['grid-overlay']}>
                {scaleTicks.map((tick) => (
                  <div
                    key={tick.val}
                    className={styles['grid-line']}
                    style={{ left: `${tick.position}%` }}
                  />
                ))}
              </div>

              {/* Model Bar Rows: Request count and model name directly beside each bar */}
              <div className={styles['bar-list']}>
                {calculatedRows.map((row) => (
                  <div key={row.model} className={styles['bar-row']}>
                    <div className={styles['bar-track']}>
                      <div
                        className={styles['bar-fill']}
                        style={{ width: `${row.widthPct}%` }}
                      />
                      <div className={styles['bar-meta']}>
                        <span className={styles['request-count']}>
                          {t('pricing.leaderboard.req_count', { n: row.requests.toLocaleString() })}
                        </span>
                        <span className={styles['model-name']}>{row.model}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Expand / Collapse Footer row when more than 10 models exist */}
            {rows.length > 10 && (
              <div className={styles['expand-row']}>
                {limit !== 'all' ? (
                  <button
                    type="button"
                    className={styles['expand-btn']}
                    onClick={() => setLimit('all')}
                  >
                    {t('pricing.leaderboard.expand_all', { n: rows.length })} <DownOutlined style={{ fontSize: 10 }} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles['expand-btn']}
                    onClick={() => setLimit('10')}
                  >
                    {t('pricing.leaderboard.collapse_to_10')} <UpOutlined style={{ fontSize: 10 }} />
                  </button>
                )}
              </div>
            )}

            {/* Bottom Algorithmic Scale Axis */}
            <div className={styles['scale-footer']}>
              <div className={styles['scale-plot-area']}>
                {scaleTicks.map((tick, idx) => {
                  let alignStyle: React.CSSProperties = { transform: 'translateX(-50%)' };
                  if (idx === 0) alignStyle = { transform: 'translateX(-20%)' };
                  else if (idx === scaleTicks.length - 1) alignStyle = { transform: 'translateX(-80%)' };

                  return (
                    <div
                      key={tick.val}
                      className={styles['scale-tick-mark']}
                      style={{ left: `${tick.position}%`, ...alignStyle }}
                    >
                      <span className={styles['scale-tick-label']}>{tick.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
