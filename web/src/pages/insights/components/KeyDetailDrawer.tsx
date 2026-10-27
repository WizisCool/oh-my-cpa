import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import { Button } from 'antd';
import { AppDrawer } from '../../../components/common/AppDrawer';
import { FactList } from '../../../components/common/FactList';
import { useT } from '../../../i18n';
import type { InsightsRhythmResponse } from '../../../types/insights';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatTokens, formatTokensFull } from '../../../types/tokenDisplay';
import {
  filterRows, groupTotals, metricValue, rankGroups, sumMeasures,
  type InsightsCube, type InsightsDimension, type InsightsFilters, type InsightsMetric,
} from '../insightsCube';

import type { InsightsLabels } from '../useInsightsLabels';
import { RankingPanel } from './RankingPanel';
import { RhythmGrid } from './RhythmGrid';
import styles from '../insights.module.css';

interface KeyDetailDrawerProps {
  cube: InsightsCube | undefined;
  keyId: string | null;
  filters: InsightsFilters;
  metric: InsightsMetric;
  modelDimension: 'call_point' | 'model';
  labels: InsightsLabels;
  rhythm: InsightsRhythmResponse | undefined;
  isRhythmLoading: boolean;
  isRhythmUncaptured: boolean;
  onClose: () => void;
  onFilter: (keyId: string) => void;
}

/**
 * One key on its own: its totals, which models and providers it used, and when in the week it is
 * busy - the office case's "what is this person's key doing". It keeps the page's other filters, so
 * a key opened from "this week, model X" stays inside them.
 */
export const KeyDetailDrawer: React.FC<KeyDetailDrawerProps> = ({
  cube, keyId, filters, metric, modelDimension, labels, rhythm, isRhythmLoading, isRhythmUncaptured, onClose, onFilter,
}) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const rows = React.useMemo(
    () => (cube && keyId ? filterRows(cube, cube.rows, { ...filters, key: [keyId] }) : []),
    [cube, filters, keyId],
  );
  const total = React.useMemo(() => sumMeasures(rows), [rows]);
  const rank = React.useCallback(
    (dimension: InsightsDimension) => (cube ? rankGroups(groupTotals(cube, rows, dimension), metric) : []),
    [cube, metric, rows],
  );

  return (
    <AppDrawer
      open={keyId !== null}
      onClose={onClose}
      width="medium"
      title={keyId ? labels.label('key', keyId) : undefined}
      footer={keyId ? (
        <Button type="primary" onClick={() => onFilter(keyId)}>{t('insights.filter_to_key')}</Button>
      ) : undefined}
    >
      {keyId && (
        <div className={styles['drawer-body']} data-testid="insights-key-drawer">
          <FactList
            facts={[
              { key: 'mask', label: t('insights.col.mask'), value: labels.detail('key', keyId) ?? labels.label('key', keyId) },
              { key: 'requests', label: t('insights.metric.requests'), value: formatMetric('requests', total.requests, style) },
              { key: 'tokens', label: t('insights.metric.tokens'), value: <span title={formatTokensFull(total.totalTokens)}>{formatTokens(total.totalTokens, style)}</span> },
              { key: 'cost', label: t('insights.metric.cost'), value: formatMetric('cost', metricValue(total, 'cost'), style) },
            ]}
          />
          <RankingPanel
            dimension={modelDimension}
            title={t(`insights.dim.${modelDimension}`)}
            groups={rank(modelDimension)}
            metric={metric}
            labels={labels}
            selected={[]}
          />
          <RankingPanel
            dimension="provider"
            title={t('insights.dim.provider')}
            groups={rank('provider')}
            metric={metric}
            labels={labels}
            selected={[]}
          />
          <RhythmGrid data={rhythm} measure="requests" isLoading={isRhythmLoading} isUncaptured={isRhythmUncaptured} />
        </div>
      )}
    </AppDrawer>
  );
};
