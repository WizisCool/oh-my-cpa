import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import { Button } from '@/components/ui/button';
import { AppDrawer } from '../../../components/common/AppDrawer';
import { FactList } from '../../../components/common/FactList';
import { MetaLine } from '../../../components/common/MetaLine';
import { useT } from '../../../i18n';
import { formatCacheRate } from '../../../theme/cacheScale';
import type { InsightsRhythmResponse } from '../../../types/insights';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatTokens, formatTokensFull } from '../../../types/tokenDisplay';
import {
  anatomyCacheRate,
  anatomyReasoningShare,
  filterRows,
  groupTotals,
  measuresAvgTtftMs,
  metricValue,
  rankGroups,
  sumMeasures,
  tokenAnatomy,
  type InsightsCube,
  type InsightsDimension,
  type InsightsFilters,
  type CubeMetric,
  type TokenScope,
} from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import type { InsightsLabels } from '../../../hooks/useInsightsLabels';
import { InsightsValue } from './InsightsValue';
import { RankingPanel } from './RankingPanel';
import { RhythmGrid } from './RhythmGrid';
import { TokenAnatomyStrip } from './TokenAnatomyStrip';
import styles from '../insights.module.css';

export interface InsightsEntity {
  dimension: InsightsDimension;
  id: string;
}

interface EntityDetailDrawerProps {
  cube: InsightsCube | undefined;
  /** The page's token scope; `metric` already reads in it, the rhythm follows it. */
  tokenScope: TokenScope;
  entity: InsightsEntity | null;
  filters: InsightsFilters;
  metric: CubeMetric;
  modelDimension: 'call_point' | 'model';
  labels: InsightsLabels;
  rhythm: InsightsRhythmResponse | undefined;
  isRhythmLoading: boolean;
  isRhythmUncaptured: boolean;
  rhythmError?: unknown;
  onRhythmRetry?: () => void;
  onClose: () => void;
  onFilter: (entity: InsightsEntity) => void;
  onViewRequests: (entity: InsightsEntity) => void;
  /** False when the request list could not carry every filter of the entity's view. */
  canViewRequests?: (entity: InsightsEntity) => boolean;
}

/** The two dimensions an entity is read across: what it used, and who used it or what served it. */
function crossDimensions(dimension: InsightsDimension, modelDimension: 'call_point' | 'model'): [InsightsDimension, InsightsDimension] {
  switch (dimension) {
    case 'key':
      return [modelDimension, 'provider'];
    case 'call_point':
    case 'model':
      return ['key', 'provider'];
    case 'provider':
    case 'credential':
      return [modelDimension, 'key'];
  }
}

/**
 * One value on its own - a key, a model, a provider or a credential: its totals, where its tokens
 * went, the two dimensions it crosses, and when in the week it is busy. It keeps the page's other
 * filters, so a model opened from "this week, key X" stays inside them. The head names the value
 * once; the body never repeats it.
 */
export const EntityDetailDrawer: React.FC<EntityDetailDrawerProps> = ({
  cube, tokenScope, entity, filters, metric, modelDimension, labels, rhythm, isRhythmLoading, isRhythmUncaptured, rhythmError, onRhythmRetry,
  onClose, onFilter, onViewRequests, canViewRequests,
}) => {
  const t = useT();
  // A blank identity (traffic that named no credential) is no filter value: neither the page nor the
  // request list would narrow to it, so neither action is offered.
  const hasRepresentableId = Boolean(entity?.id.trim());
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const entityFilters = React.useMemo(
    () => (entity ? { ...filters, [entity.dimension]: [entity.id] } : filters),
    [entity, filters],
  );
  const rows = React.useMemo(
    () => (cube && entity ? filterRows(cube, cube.rows, entityFilters) : []),
    [cube, entity, entityFilters],
  );
  const total = React.useMemo(() => sumMeasures(rows), [rows]);
  const anatomy = React.useMemo(() => tokenAnatomy(total), [total]);
  const rank = React.useCallback(
    (dimension: InsightsDimension) => (cube ? rankGroups(groupTotals(cube, rows, dimension), metric) : []),
    [cube, metric, rows],
  );
  const rhythmMeasure = metric === 'cost' ? 'cost' : metric === 'tokens' || metric === 'net_tokens' ? 'tokens' : 'requests';
  const reasoningShare = anatomyReasoningShare(anatomy);
  const detail = entity ? labels.detail(entity.dimension, entity.id) : undefined;
  const [first, second] = entity ? crossDimensions(entity.dimension, modelDimension) : (['key', 'provider'] as const);

  return (
    <AppDrawer
      widthKey="insights_entity"
      open={entity !== null}
      onClose={onClose}
      width="medium"
      title={entity ? (
        <span className={styles['drawer-head']}>
          <InsightsValue dimension={entity.dimension} id={entity.id} labels={labels} />
          <MetaLine tone="quiet">
            <span>{t(`insights.dim.${entity.dimension}`)}</span>
            {detail && <span>{detail}</span>}
          </MetaLine>
        </span>
      ) : undefined}
      footer={entity ? (
        <>
          <Button
            variant="secondary"
            disabled={!hasRepresentableId || (canViewRequests ? !canViewRequests(entity) : false)}
            onClick={() => onViewRequests(entity)}
          >
            {t('insights.view_requests_link')}
          </Button>
          <Button variant="primary" disabled={!hasRepresentableId} onClick={() => onFilter(entity)}>{t('insights.filter_to_entity')}</Button>
        </>
      ) : undefined}
    >
      {entity && (
        <div className={styles['drawer-body']} data-testid="insights-entity-drawer" data-dimension={entity.dimension}>
          <FactList
            facts={[
              {
                key: 'requests',
                label: t('insights.metric.requests'),
                value: total.failures > 0
                  ? t('insights.requests_with_failures', { n: formatMetric('requests', total.requests, style), failed: formatMetric('requests', total.failures, style) })
                  : formatMetric('requests', total.requests, style),
              },
              { key: 'tokens', label: t('insights.metric.tokens'), value: <span data-tip={formatTokensFull(total.totalTokens)}>{formatTokens(total.totalTokens, style)}</span> },
              { key: 'net', label: t('insights.anatomy.net_tokens'), value: <span data-tip={formatTokensFull(anatomy.netTokens)}>{formatTokens(anatomy.netTokens, style)}</span> },
              { key: 'cache', label: t('insights.anatomy.cache_rate'), value: formatCacheRate(anatomyCacheRate(anatomy)) },
              { key: 'reasoning', label: t('insights.anatomy.reasoning_share'), value: reasoningShare === null ? '—' : formatShare(reasoningShare / 100) },
              { key: 'latency', label: t('insights.metric.latency'), value: formatMetric('latency', metricValue(total, 'latency'), style) },
              { key: 'ttft', label: t('insights.col.ttft'), value: formatMetric('latency', measuresAvgTtftMs(total), style) },
              { key: 'cost', label: t('insights.metric.cost'), value: formatMetric('cost', metricValue(total, 'cost'), style) },
            ]}
          />
          <TokenAnatomyStrip anatomy={anatomy} isCompact />
          <RankingPanel dimension={first} title={t(`insights.dim.${first}`)} groups={rank(first)} metric={metric} labels={labels} selected={[]} limit={5} />
          <RankingPanel dimension={second} title={t(`insights.dim.${second}`)} groups={rank(second)} metric={metric} labels={labels} selected={[]} limit={5} />
          <RhythmGrid data={rhythm} measure={rhythmMeasure} tokenScope={tokenScope} isLoading={isRhythmLoading} isUncaptured={isRhythmUncaptured} error={rhythmError} onRetry={onRhythmRetry} />
        </div>
      )}
    </AppDrawer>
  );
};
