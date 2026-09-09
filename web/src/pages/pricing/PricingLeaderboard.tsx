import React from 'react';
import { InputNumber, Popover, Segmented, Select } from 'antd';
import {
  SlidersOutlined,
  CheckCircleOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import type { ModelPrice } from '../../types/pricing';
import styles from './PricingLeaderboard.module.css';

interface PricingLeaderboardProps {
  models: ModelPrice[];
}

type ScenarioKey = 'coding' | 'heavy' | 'chat' | 'custom';

interface ScenarioPreset {
  key: ScenarioKey;
  prompt: number;
  completion: number;
  cacheRead: number;
}

const PRESETS: Record<Exclude<ScenarioKey, 'custom'>, ScenarioPreset> = {
  coding: {
    key: 'coding',
    prompt: 1000,
    completion: 300,
    cacheRead: 35000,
  },
  heavy: {
    key: 'heavy',
    prompt: 3000,
    completion: 1200,
    cacheRead: 80000,
  },
  chat: {
    key: 'chat',
    prompt: 1500,
    completion: 500,
    cacheRead: 0,
  },
};

const BUDGET_PRESETS = [10, 30, 50, 100, 200];

export const PricingLeaderboard: React.FC<PricingLeaderboardProps> = ({ models }) => {
  const t = useT();

  const [budget, setBudget] = React.useState<number>(100);
  const [scenarioKey, setScenarioKey] = React.useState<ScenarioKey>('coding');
  const [customPrompt, setCustomPrompt] = React.useState<number>(1000);
  const [customCompletion, setCustomCompletion] = React.useState<number>(300);
  const [customCacheRead, setCustomCacheRead] = React.useState<number>(35000);
  const [sortBy, setSortBy] = React.useState<'requests_desc' | 'requests_asc' | 'cost_asc'>('requests_desc');

  // Derive current scenario token values
  const promptTokens = scenarioKey === 'custom' ? customPrompt : PRESETS[scenarioKey].prompt;
  const compTokens = scenarioKey === 'custom' ? customCompletion : PRESETS[scenarioKey].completion;
  const cacheReadTokens = scenarioKey === 'custom' ? customCacheRead : PRESETS[scenarioKey].cacheRead;

  // Calculate costs and request counts for all priced models
  const calculatedRows = React.useMemo(() => {
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
        // If cache read rate is not discounted, it's billed as input prompt rate (standard provider pricing)
        const pRead = m.cache_read_price_per_1m > 0 ? m.cache_read_price_per_1m : pPrompt;
        const mult = m.price_multiplier || 1;

        const promptCost = (promptTokens / 1_000_000) * pPrompt;
        const compCost = (compTokens / 1_000_000) * pComp;
        const cacheCost = (cacheReadTokens / 1_000_000) * pRead;
        const singleReqCost = (promptCost + compCost + cacheCost) * mult;

        const noCacheCost =
          ((promptTokens + cacheReadTokens) / 1_000_000 * pPrompt + (compTokens / 1_000_000) * pComp) * mult;

        const savingsPct =
          noCacheCost > singleReqCost && noCacheCost > 0
            ? Math.round(((noCacheCost - singleReqCost) / noCacheCost) * 100)
            : 0;

        const requests = singleReqCost > 0 ? Math.floor(budget / singleReqCost) : 0;
        const dailyAvg = Math.round(requests / 30);

        return {
          model: m.model,
          source: m.source,
          multiplier: mult,
          promptRate: pPrompt,
          compRate: pComp,
          readRate: pRead,
          promptCost,
          compCost,
          cacheCost,
          singleReqCost,
          requests,
          dailyAvg,
          savingsPct,
          hasBonus: savingsPct >= 40 || mult < 1,
        };
      })
      .filter((row) => row.requests > 0)
      .sort((a, b) => {
        if (sortBy === 'cost_asc') {
          return a.singleReqCost - b.singleReqCost;
        }
        if (sortBy === 'requests_asc') {
          return a.requests - b.requests;
        }
        return b.requests - a.requests;
      });
  }, [models, budget, promptTokens, compTokens, cacheReadTokens, sortBy]);

  // Compute log scale bounds for bar widths
  const { minLog, maxLog } = React.useMemo(() => {
    if (calculatedRows.length === 0) return { minLog: 1, maxLog: 5 };
    const reqs = calculatedRows.map((r) => r.requests);
    const min = Math.min(...reqs);
    const max = Math.max(...reqs);
    // Use minimum baseline around 50 or 0.5 * min so smaller items remain clearly visible
    const baseMin = Math.max(10, min * 0.4);
    const baseMax = Math.max(100, max);
    return {
      minLog: Math.log10(baseMin),
      maxLog: Math.log10(baseMax),
    };
  }, [calculatedRows]);

  const getBarWidthPct = (requests: number) => {
    if (maxLog <= minLog) return 30;
    const logVal = Math.log10(Math.max(1, requests));
    const ratio = (logVal - minLog) / (maxLog - minLog);
    // Clamp width between 4% and 56% so bar text has plenty of room on the right
    return Math.max(4, Math.min(56, ratio * 56));
  };

  return (
    <div className={styles.leaderboardCard} data-testid="pricing-leaderboard">
      {/* 1. Header Block */}
      <div className={styles.header}>
        <div className={styles.titleArea}>
          <div className={styles.titleRow}>
            <TrophyOutlined style={{ color: '#c3cb46', fontSize: 17 }} />
            <h2 className={styles.title}>{t('pricing.leaderboard.title')}</h2>
            <span className={styles.tagBadge}>Opencode Benchmark</span>
          </div>
          <p className={styles.subtitle}>
            {t('pricing.leaderboard.subtitle', { budget })}
          </p>
        </div>

        {/* Sort & Presets */}
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>排序:</span>
          <Select
            size="small"
            value={sortBy}
            onChange={(val) => setSortBy(val)}
            style={{ width: 150 }}
            options={[
              { label: '最多请求 (降序)', value: 'requests_desc' },
              { label: '原图升序 (110 → 45K)', value: 'requests_asc' },
              { label: '单次最省 (按成本)', value: 'cost_asc' },
            ]}
          />
        </div>
      </div>

      {/* 2. Interactive Controls Toolbar */}
      <div className={styles.controlsBar}>
        <div className={styles.controlsLeft}>
          {/* Budget Preset Switcher */}
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>{t('pricing.leaderboard.budget')}:</span>
            <div className={styles.budgetTabs}>
              {BUDGET_PRESETS.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`${styles.budgetTab} ${budget === amount ? styles.budgetTabActive : ''}`}
                  onClick={() => setBudget(amount)}
                >
                  ${amount}
                </button>
              ))}
            </div>
            <InputNumber
              size="small"
              min={1}
              max={100000}
              value={budget}
              onChange={(val) => val && setBudget(val)}
              prefix="$"
              style={{ width: 85, fontFamily: 'monospace' }}
            />
          </div>

          {/* Scenario Presets */}
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>{t('pricing.leaderboard.scenario')}:</span>
            <Segmented<ScenarioKey>
              size="small"
              value={scenarioKey}
              onChange={(val) => setScenarioKey(val)}
              options={[
                { label: t('pricing.leaderboard.scenario_coding'), value: 'coding' },
                { label: t('pricing.leaderboard.scenario_heavy'), value: 'heavy' },
                { label: t('pricing.leaderboard.scenario_chat'), value: 'chat' },
                {
                  label: (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <SlidersOutlined />
                      {t('pricing.leaderboard.scenario_custom')}
                    </span>
                  ),
                  value: 'custom',
                },
              ]}
            />
          </div>
        </div>
      </div>

      {/* 3. Custom Token Inputs (Expandable when Custom is selected) */}
      {scenarioKey === 'custom' && (
        <div className={styles.customTokensBox}>
          <div className={styles.tokenInputGroup}>
            <span>{t('pricing.leaderboard.prompt_tokens')}:</span>
            <InputNumber
              size="small"
              min={0}
              step={500}
              value={customPrompt}
              onChange={(val) => setCustomPrompt(val ?? 0)}
              style={{ width: 100, fontFamily: 'monospace' }}
            />
          </div>
          <div className={styles.tokenInputGroup}>
            <span>{t('pricing.leaderboard.comp_tokens')}:</span>
            <InputNumber
              size="small"
              min={0}
              step={100}
              value={customCompletion}
              onChange={(val) => setCustomCompletion(val ?? 0)}
              style={{ width: 100, fontFamily: 'monospace' }}
            />
          </div>
          <div className={styles.tokenInputGroup}>
            <span>{t('pricing.leaderboard.cache_read_tokens')}:</span>
            <InputNumber
              size="small"
              min={0}
              step={5000}
              value={customCacheRead}
              onChange={(val) => setCustomCacheRead(val ?? 0)}
              style={{ width: 110, fontFamily: 'monospace' }}
            />
          </div>
        </div>
      )}

      {/* 4. Opencode Style Horizontal Bars Container */}
      <div className={styles.chartContainer}>
        {/* Subtle Vertical Guideline Grid (Aligned to 1x, 10x, 25x, 50x, 100x, 250x) */}
        <div className={styles.gridLines}>
          <div className={styles.gridLine} />
          <div className={styles.gridLine} />
          <div className={styles.gridLine} />
          <div className={styles.gridLine} />
          <div className={styles.gridLine} />
          <div className={styles.gridLine} />
        </div>

        {/* Model Bar Rows */}
        <div className={styles.barList}>
          {calculatedRows.length === 0 ? (
            <div style={{ color: 'var(--muted)', textAlign: 'center', padding: '24px 0', fontSize: 13 }}>
              {t('pricing.leaderboard.empty')}
            </div>
          ) : (
            calculatedRows.map((row) => {
              const widthPct = getBarWidthPct(row.requests);
              const bonusPct = row.savingsPct > 0 ? row.savingsPct : 0;

              const tooltipContent = (
                <div className={styles.tooltipCard}>
                  <div className={styles.tooltipHeader}>
                    <span className={styles.tooltipModelTitle}>{row.model}</span>
                    <span className={styles.badgeTag}>{row.source}</span>
                  </div>

                  <div className={styles.tooltipMetricRow}>
                    <span style={{ color: 'var(--muted)' }}>预算 ${budget} 可用:</span>
                    <span className={styles.tooltipMetricValue}>
                      {row.requests.toLocaleString()} {t('pricing.leaderboard.req_unit')}
                    </span>
                  </div>

                  <div className={styles.tooltipMetricRow}>
                    <span style={{ color: 'var(--muted)' }}>单次请求成本:</span>
                    <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                      ${row.singleReqCost.toFixed(6)}
                    </span>
                  </div>

                  <div className={styles.tooltipMetricRow}>
                    <span style={{ color: 'var(--muted)' }}>30 天日均容量:</span>
                    <span style={{ fontFamily: 'monospace', color: 'var(--fg)' }}>
                      ~{row.dailyAvg.toLocaleString()} 次/天
                    </span>
                  </div>

                  <div className={styles.tooltipBreakdown}>
                    <div className={styles.breakdownItem}>
                      <span>Prompt ({promptTokens.toLocaleString()} t):</span>
                      <span>${row.promptCost.toFixed(6)}</span>
                    </div>
                    <div className={styles.breakdownItem}>
                      <span>Comp ({compTokens.toLocaleString()} t):</span>
                      <span>${row.compCost.toFixed(6)}</span>
                    </div>
                    {cacheReadTokens > 0 && (
                      <div className={styles.breakdownItem}>
                        <span>Cache Read ({cacheReadTokens.toLocaleString()} t):</span>
                        <span>${row.cacheCost.toFixed(6)}</span>
                      </div>
                    )}
                    {row.multiplier !== 1 && (
                      <div className={styles.breakdownItem}>
                        <span>计费倍率:</span>
                        <span>×{row.multiplier}</span>
                      </div>
                    )}
                  </div>

                  {row.savingsPct > 0 && (
                    <div className={styles.savingsNote}>
                      <CheckCircleOutlined />
                      {t('pricing.leaderboard.cache_saving', { pct: row.savingsPct })}
                    </div>
                  )}
                </div>
              );

              return (
                <Popover key={row.model} content={tooltipContent} placement="top" mouseEnterDelay={0.08} arrow={false}>
                  <div className={styles.barRow}>
                    <div className={styles.barTrack}>
                      {/* Bar fill with smooth width animation */}
                      <div className={styles.barFill} style={{ width: `${widthPct}%` }}>
                        {/* Two-tone bonus bar for high cache efficiency / 2x usage */}
                        {bonusPct > 0 && (
                          <div
                            className={styles.barBonus}
                            style={{ width: `${Math.min(35, bonusPct * 0.4)}%`, marginLeft: 'auto' }}
                          />
                        )}
                      </div>

                      {/* Number + Model Name right beside bar */}
                      <div className={styles.barMeta}>
                        <span className={styles.requestCount}>{row.requests.toLocaleString()}</span>
                        <span className={styles.modelName}>{row.model}</span>
                        {row.hasBonus && (
                          <span className={`${styles.badgeTag} ${styles.badgeBonus}`}>
                            {row.savingsPct >= 40 ? `节省 ${row.savingsPct}%` : '2x usage'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Popover>
              );
            })
          )}
        </div>

        {/* 5. Scale Marks at Bottom (1x, 10x, 25x, 50x, 100x, 250x...) */}
        <div className={styles.scaleAxis}>
          <span className={styles.scaleTick}>1x</span>
          <span className={styles.scaleTick}>10x</span>
          <span className={styles.scaleTick}>25x</span>
          <span className={styles.scaleTick}>50x</span>
          <span className={styles.scaleTick}>100x</span>
          <span className={styles.scaleTick}>250x+</span>
        </div>
      </div>
    </div>
  );
};
