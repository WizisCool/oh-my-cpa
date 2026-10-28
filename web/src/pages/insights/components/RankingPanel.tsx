import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import clsx from 'clsx';
import { Button } from 'antd';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { SearchInput } from '../../../components/common/SearchInput';
import { RightOutlined } from '../../../components/icons';
import { InsightsValue } from './InsightsValue';
import { PanelNarrowing } from './PanelNarrowing';
import { useT } from '../../../i18n';
import type { InsightsCompareWindow } from '../../../types/insights';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { compareMetric, NO_COMPARISON, rankingMetric, type InsightsDimension, type InsightsMetric, type RankedGroup } from '../insightsCube';
import { formatShare } from '../insightsFormat';
import { ComparisonText } from './ComparisonText';
import type { InsightsLabels } from '../useInsightsLabels';
import styles from '../insights.module.css';

/** Past this many groups an unfolded ranking can be searched; a hundred credentials are not scanned by eye. */
const SEARCH_THRESHOLD = 12;

interface RankingPanelProps {
  dimension: InsightsDimension;
  title: string;
  groups: readonly RankedGroup[];
  metric: InsightsMetric;
  labels: InsightsLabels;
  /** The trend's colour for a group, when this panel ranks what the trend stacks by. */
  colorOf?: (id: string) => string | undefined;
  selected: readonly string[];
  /** The window the changes are measured against, so their title can name it. */
  compare?: InsightsCompareWindow | null;
  limit?: number;
  /** A row filters the page to its group; without it the ranking is read-only. */
  onSelect?: (dimension: InsightsDimension, id: string) => void;
  /** Drops this panel's own filter. */
  onClear?: (dimension: InsightsDimension) => void;
  /** A group's name opens its detail rather than filtering; only keys have one. */
  onOpen?: (id: string) => void;
  testId?: string;
}

/**
 * One dimension's groups, largest first, read like the dashboard's model list: a name, its amount,
 * its share with a short meter, and the change.
 *
 * A panel ranks under every filter but its own, so choosing a row keeps the others in view: the
 * chosen ones are marked and the rest step back, which is how the reader sees that the page is
 * narrowed and by what. The meter is monochrome unless the trend above stacks by this dimension, in
 * which case the row carries the trend's colour so the two read as one figure. A long ranking shows
 * its head and unfolds into a bounded, searchable list, so a deployment with a hundred credentials
 * does not get a page a hundred rows longer.
 */
export const RankingPanel: React.FC<RankingPanelProps> = ({
  dimension, title, groups, metric, labels, colorOf, selected, compare, limit = 8, onSelect, onClear, onOpen, testId,
}) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const [isExpanded, setExpanded] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const ranking = rankingMetric(metric);
  const needle = search.trim().toLowerCase();
  const matching = isExpanded && needle
    ? groups.filter((group) => `${labels.label(dimension, group.id)} ${labels.detail(dimension, group.id) ?? ''} ${group.id}`.toLowerCase().includes(needle))
    : groups;
  const shown = isExpanded ? matching : groups.slice(0, limit);
  const top = groups[0]?.value ?? 0;
  const RowElement = onSelect ? 'button' : 'div';
  const hasComparison = groups.some((group) => group.previous !== null);
  const isNarrowed = selected.length > 0;

  return (
    <Panel
      data-testid={testId}
      data-narrowed={isNarrowed || undefined}
      title={(
        <PanelTitle
          extra={(
            <PanelNarrowing count={onClear ? selected.length : 0} unit={t(`insights.metric.${ranking}`)} onClear={() => onClear?.(dimension)} />
          )}
        >
          {title}
        </PanelTitle>
      )}
    >
      {isExpanded && groups.length > SEARCH_THRESHOLD && (
        <SearchInput value={search} onChange={setSearch} label={t('insights.filter_search')} className={styles['ranking-search']} />
      )}
      {groups.length === 0 ? (
        <EmptyState size="compact" title={t('insights.no_usage')} />
      ) : shown.length === 0 ? (
        <div className={styles['filter-values-empty']}>{t('insights.filter_no_values')}</div>
      ) : (
        <ol className={clsx(styles['ranking-list'], !hasComparison && styles['ranking-list-plain'], isExpanded && styles['ranking-list-expanded'])}>
          {shown.map((group) => {
            const color = colorOf?.(group.id);
            const comparison = group.previous ? compareMetric(group.measures, group.previous, ranking) : NO_COMPARISON;
            const isSelected = selected.includes(group.id);
            const width = top > 0 && group.value !== null ? Math.max(2, (group.value / top) * 100) : 0;
            return (
              <li key={group.id} data-dimmed={isNarrowed && !isSelected ? 'true' : undefined}>
                <RowElement
                  {...(onSelect ? {
                    type: 'button' as const,
                    'aria-pressed': isSelected,
                    onClick: () => onSelect(dimension, group.id),
                    title: t(isSelected ? 'insights.click_to_unfilter' : 'insights.click_to_filter'),
                  } : {})}
                  className={clsx(styles['ranking-row'], onSelect && styles['ranking-row-interactive'], isSelected && styles['ranking-row-selected'])}
                >
                  <InsightsValue dimension={dimension} id={group.id} labels={labels} hasDetail />
                  <span className={styles['ranking-value']} title={formatMetricExact(ranking, group.value)}>
                    {formatMetric(ranking, group.value, style)}
                  </span>
                  <span className={styles['ranking-share']}>
                    <span className={styles['ranking-bar']} aria-hidden="true">
                      <span style={{ transform: `scaleX(${width / 100})`, background: color }} />
                    </span>
                    {formatShare(group.share)}
                  </span>
                  {hasComparison && (
                    <ComparisonText comparison={comparison} compare={compare} className={styles['ranking-change']} />
                  )}
                </RowElement>
                {onOpen && labels.isNonKey(group.id) === false && (
                  <button
                    type="button"
                    className={styles['ranking-open']}
                    onClick={() => onOpen(group.id)}
                    aria-label={t('insights.open_detail')}
                    title={t('insights.open_detail')}
                  >
                    <RightOutlined />
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {groups.length > limit && (
        <Button
          type="text"
          size="small"
          className={styles['ranking-more']}
          onClick={() => { setExpanded((value) => !value); setSearch(''); }}
          aria-expanded={isExpanded}
        >
          {isExpanded ? t('insights.show_less') : t('insights.show_all', { n: groups.length })}
        </Button>
      )}
    </Panel>
  );
};
