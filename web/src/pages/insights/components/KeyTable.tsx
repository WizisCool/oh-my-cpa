import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import dayjs from '../../../utils/time';
import { ResponsiveList } from '../../../components/common/ResponsiveList';
import { useT } from '../../../i18n';
import type { InsightsCompareWindow } from '../../../types/insights';
import { formatTokens, formatTokensFull } from '../../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import {
  compareMetric, measuresAvgTtftMs, measuresCacheRate, measuresReasoningShare, metricValue, NO_COMPARISON, rankingMetric,
  type CubeMetric, type RankedGroup,
} from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import { CacheRateText } from './RateText';
import { ComparisonText } from './ComparisonText';
import type { InsightsLabels } from '../../../hooks/useInsightsLabels';
import { Sparkline } from './Sparkline';
import { useColumnSort, type SortableColumn } from './useColumnSort';
import { InsightsValue } from './InsightsValue';
import styles from '../insights.module.css';

interface KeyTableProps {
  groups: readonly RankedGroup[];
  sparklines: Map<string, number[]>;
  lastActive: Map<string, number>;
  metric: CubeMetric;
  labels: InsightsLabels;
  /** The window the change column is measured against, so its title can name it. */
  compare?: InsightsCompareWindow | null;
  isLoading: boolean;
  onOpen: (id: string) => void;
}

const COUNT = new Intl.NumberFormat('en');

const cacheRate = (group: RankedGroup) => measuresCacheRate(group.measures);
const reasoningShare = (group: RankedGroup) => measuresReasoningShare(group.measures);

/**
 * Every key side by side: what the issue asked for - one table answering "who used how much of what".
 * The order is the page's ranking; each column sorts. Anywhere on a row opens the key's detail; the
 * name stays a button so the keyboard reaches it too.
 */
export const KeyTable: React.FC<KeyTableProps> = ({ groups, sparklines, lastActive, metric, labels, compare, isLoading, onOpen }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const ranking = rankingMetric(metric);

  const columns = React.useMemo<SortableColumn<RankedGroup>[]>(() => [
    {
      key: 'name',
      title: t('insights.col.key'),
      render: (_, group) => (
        <button type="button" className={styles['key-name']} onClick={() => onOpen(group.id)}>
          <InsightsValue dimension="key" id={group.id} labels={labels} />
          {labels.detail('key', group.id) && <span className={styles['key-mask']}>{labels.detail('key', group.id)}</span>}
        </button>
      ),
    },
    {
      key: 'requests',
      title: t('insights.metric.requests'),
      align: 'right',
      sortValue: (group) => group.measures.requests,
      render: (_, group) => COUNT.format(group.measures.requests),
    },
    {
      key: 'input',
      title: t('insights.col.input'),
      align: 'right',
      sortValue: (group) => group.measures.inputTokens,
      render: (_, group) => <span data-tip={formatTokensFull(group.measures.inputTokens)}>{formatTokens(group.measures.inputTokens, style)}</span>,
    },
    {
      key: 'output',
      title: t('insights.col.output'),
      align: 'right',
      sortValue: (group) => group.measures.outputTokens,
      render: (_, group) => <span data-tip={formatTokensFull(group.measures.outputTokens)}>{formatTokens(group.measures.outputTokens, style)}</span>,
    },
    {
      key: 'cost',
      title: t('insights.metric.cost'),
      align: 'right',
      sortValue: (group) => metricValue(group.measures, 'cost'),
      render: (_, group) => formatMetric('cost', metricValue(group.measures, 'cost'), style),
    },
    {
      key: 'cache',
      title: t('insights.anatomy.cache_rate'),
      align: 'right',
      sortValue: cacheRate,
      render: (_, group) => <CacheRateText rate={cacheRate(group)} />,
    },
    {
      key: 'reasoning',
      title: t('insights.anatomy.reasoning_share'),
      align: 'right',
      sortValue: reasoningShare,
      render: (_, group) => {
        const share = reasoningShare(group);
        return share === null ? '—' : formatShare(share / 100);
      },
    },
    {
      key: 'ttft',
      title: t('insights.col.ttft'),
      align: 'right',
      sortValue: (group) => measuresAvgTtftMs(group.measures),
      render: (_, group) => formatMetric('latency', measuresAvgTtftMs(group.measures), style),
    },
    {
      key: 'latency',
      title: t('insights.metric.latency'),
      align: 'right',
      sortValue: (group) => metricValue(group.measures, 'latency'),
      render: (_, group) => formatMetric('latency', metricValue(group.measures, 'latency'), style),
    },
    {
      key: 'trend',
      title: t('insights.col.trend'),
      render: (_, group) => <Sparkline values={sparklines.get(group.id) ?? []} />,
    },
    {
      key: 'share',
      title: t('insights.col.share'),
      align: 'right',
      sortValue: (group) => group.share,
      render: (_, group) => formatShare(group.share),
    },
    {
      key: 'change',
      title: t('insights.col.change'),
      align: 'right',
      render: (_, group) => (
        <ComparisonText comparison={group.previous ? compareMetric(group.measures, group.previous, ranking, group.previousRaw ?? undefined) : NO_COMPARISON} compare={compare} className={styles['change-text']} />
      ),
    },
    {
      key: 'last',
      title: t('insights.col.last_active'),
      align: 'right',
      sortValue: (group) => lastActive.get(group.id) ?? null,
      render: (_, group) => {
        const last = lastActive.get(group.id);
        return last === undefined ? '—' : dayjs(last).format('MM-DD HH:mm');
      },
    },
  ], [compare, labels, lastActive, onOpen, ranking, sparklines, style, t, formatMetric]);

  const sorted = useColumnSort(columns, groups);

  return (
    <ResponsiveList<RankedGroup>
      columns={sorted.columns}
      dataSource={sorted.data}
      rowKey="id"
      isLoading={isLoading}
      emptyText={t('insights.no_usage')}
      pageSize={20}
      phone={{ identity: 'name', skip: ['trend', 'input', 'output', 'cache', 'reasoning', 'ttft', 'latency', 'change'] }}
      tableProps={{
        size: 'small',
        className: styles['key-table'],
        onRow: (group) => ({ onClick: () => onOpen(group.id), className: styles['key-row'] }),
      }}
    />
  );
};
