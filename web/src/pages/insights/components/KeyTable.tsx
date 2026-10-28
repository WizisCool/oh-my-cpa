import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import type { ColumnsType } from 'antd/es/table';
import dayjs from '../../../utils/time';
import { ResponsiveList } from '../../../components/common/ResponsiveList';
import { useT } from '../../../i18n';
import { formatTokens, formatTokensFull } from '../../../types/tokenDisplay';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { compareMetric, metricValue, NO_COMPARISON, rankingMetric, type InsightsMetric, type RankedGroup } from '../insightsCube';
import { formatShare } from '../insightsFormat';
import { ComparisonText } from './ComparisonText';
import type { InsightsLabels } from '../useInsightsLabels';
import { Sparkline } from './Sparkline';
import { InsightsValue } from './InsightsValue';
import styles from '../insights.module.css';

interface KeyTableProps {
  groups: readonly RankedGroup[];
  sparklines: Map<string, number[]>;
  lastActive: Map<string, number>;
  metric: InsightsMetric;
  labels: InsightsLabels;
  isLoading: boolean;
  onOpen: (id: string) => void;
}

const COUNT = new Intl.NumberFormat('en');

function byNumber(pick: (group: RankedGroup) => number | null) {
  return (left: RankedGroup, right: RankedGroup) => (pick(left) ?? -Infinity) - (pick(right) ?? -Infinity);
}

/**
 * Every key side by side: what the issue asked for - one table answering "who used how much of what".
 * The order is the page's ranking; each column sorts. Anywhere on a row opens the key's detail; the
 * name stays a button so the keyboard reaches it too.
 */
export const KeyTable: React.FC<KeyTableProps> = ({ groups, sparklines, lastActive, metric, labels, isLoading, onOpen }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const ranking = rankingMetric(metric);

  const columns = React.useMemo<ColumnsType<RankedGroup>>(() => [
    {
      key: 'name',
      title: t('insights.col.key'),
      render: (_, group) => (
        <button type="button" className={styles['key-name']} onClick={() => onOpen(group.id)} title={group.id}>
          <InsightsValue dimension="key" id={group.id} labels={labels} />
          {labels.detail('key', group.id) && <span className={styles['key-mask']}>{labels.detail('key', group.id)}</span>}
        </button>
      ),
    },
    {
      key: 'requests',
      title: t('insights.metric.requests'),
      align: 'right',
      sorter: byNumber((group) => group.measures.requests),
      render: (_, group) => COUNT.format(group.measures.requests),
    },
    {
      key: 'input',
      title: t('insights.col.input'),
      align: 'right',
      sorter: byNumber((group) => group.measures.inputTokens),
      render: (_, group) => <span title={formatTokensFull(group.measures.inputTokens)}>{formatTokens(group.measures.inputTokens, style)}</span>,
    },
    {
      key: 'output',
      title: t('insights.col.output'),
      align: 'right',
      sorter: byNumber((group) => group.measures.outputTokens),
      render: (_, group) => <span title={formatTokensFull(group.measures.outputTokens)}>{formatTokens(group.measures.outputTokens, style)}</span>,
    },
    {
      key: 'cost',
      title: t('insights.metric.cost'),
      align: 'right',
      sorter: byNumber((group) => metricValue(group.measures, 'cost')),
      render: (_, group) => formatMetric('cost', metricValue(group.measures, 'cost'), style),
    },
    {
      key: 'latency',
      title: t('insights.metric.latency'),
      align: 'right',
      sorter: byNumber((group) => metricValue(group.measures, 'latency')),
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
      sorter: byNumber((group) => group.share),
      render: (_, group) => formatShare(group.share),
    },
    {
      key: 'change',
      title: t('insights.col.change'),
      align: 'right',
      render: (_, group) => (
        <ComparisonText comparison={group.previous ? compareMetric(group.measures, group.previous, ranking) : NO_COMPARISON} className={styles['change-text']} />
      ),
    },
    {
      key: 'last',
      title: t('insights.col.last_active'),
      align: 'right',
      sorter: byNumber((group) => lastActive.get(group.id) ?? null),
      render: (_, group) => {
        const last = lastActive.get(group.id);
        return last === undefined ? '—' : dayjs(last).format('MM-DD HH:mm');
      },
    },
  ], [labels, lastActive, onOpen, ranking, sparklines, style, t, formatMetric]);

  return (
    <ResponsiveList<RankedGroup>
      columns={columns}
      dataSource={groups}
      rowKey="id"
      isLoading={isLoading}
      emptyText={t('insights.no_usage')}
      pageSize={20}
      phone={{ identity: 'name', skip: ['trend', 'input', 'output', 'latency', 'change'] }}
      tableProps={{
        size: 'small',
        className: styles['key-table'],
        onRow: (group) => ({ onClick: () => onOpen(group.id), className: styles['key-row'] }),
      }}
    />
  );
};
