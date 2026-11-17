import React from 'react';
import clsx from 'clsx';
import { useInsightsFormat } from '../useInsightsFormat';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { ToolButton } from '../../../components/common/ToolButton';
import { LoadFailure } from '../../../components/feedback';
import { RightOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import type { InsightsClientsResponse } from '../../../types/insights';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { rankGroups, rankingMetric, type CubeMetric, type Measures } from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import { ClientMark } from '../../../components/common/ClientMark';
import { clientCoverageShare, clientDisplayName, clientMeasures, type ClientCategory } from '../../../types/clientAgents';
import { PanelNarrowing } from './PanelNarrowing';
import styles from '../insights.module.css';

/** A client program as the page names it: its mark and name, the raw User-Agent prefix on hover. */
export const ClientValue: React.FC<{ id: string; category?: ClientCategory; rawPrefix?: string; className?: string }> = ({ id, category, rawPrefix, className }) => {
  const t = useT();
  return (
    <span className={clsx(styles['value'], className)} data-tip={rawPrefix?.trim() || undefined}>
      <span className={styles['value-mark']} aria-hidden="true"><ClientMark id={id} category={category} /></span>
      <span className={clsx(styles['value-name'], category === 'unknown' && styles['is-muted'])}>{clientDisplayName(id, t)}</span>
    </span>
  );
};

interface ClientAttributionPanelProps {
  data: InsightsClientsResponse | undefined;
  metric: CubeMetric;
  isLoading: boolean;
  isUncaptured: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** The rows still belong to the previous filters while the new read is on its way. */
  isPlaceholder?: boolean;
  limit?: number;
  /** False when the request list could not carry every filter of the page. */
  canViewRequests?: boolean;
  /** The request list for one client, inside the page's window and filters. */
  hrefFor: (clientAgent: string) => string;
  onNavigate: (href: string) => void;
  /** The clients the page is narrowed to; the read ranks every client regardless. */
  selected?: readonly string[];
  /** A row narrows the whole page to its client. */
  onSelect?: (clientAgent: string) => void;
  /** Drops the client filter. */
  onClear?: () => void;
}

/**
 * Which programs sent the traffic - coding agents, SDKs, scripts - read from the request records'
 * User-Agent. The records are kept for less time than the page's facts, so a window reaching past
 * them says how much of it the ranking covers rather than letting the missing part read as idle.
 */
export const ClientAttributionPanel: React.FC<ClientAttributionPanelProps> = ({
  data, metric, isLoading, isUncaptured, error, onRetry, isPlaceholder = false, limit = 8, canViewRequests = true, hrefFor, onNavigate,
  selected = [], onSelect, onClear,
}) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const ranking = rankingMetric(metric);
  const items = React.useMemo(() => new Map((data?.clients ?? []).map((item) => [item.id, item])), [data]);
  const groups = React.useMemo(() => {
    const totals = new Map<string, Measures>();
    for (const item of data?.clients ?? []) totals.set(item.id, clientMeasures(item));
    return rankGroups(totals, metric).filter((group) => group.measures.requests > 0);
  }, [data, metric]);
  const coverage = data ? clientCoverageShare(data.coverage) : null;
  const top = groups[0]?.value ?? 0;
  const isNarrowed = selected.length > 0;

  return (
    <Panel
      data-testid="insights-ranking-client"
      data-narrowed={isNarrowed || undefined}
      title={(
        <PanelTitle
          extra={isNarrowed && onClear ? (
            <PanelNarrowing count={selected.length} unit={t(`insights.metric.${ranking}`)} onClear={onClear} />
          ) : coverage !== null ? (
            <span className={styles['panel-meta']} data-testid="insights-client-coverage">
              {t('insights.client.coverage', { n: formatShare(coverage / 100) })}
            </span>
          ) : undefined}
        >
          {t('insights.ranking.client')}
        </PanelTitle>
      )}
    >
      {isUncaptured ? (
        <div className={styles['filter-values-empty']}>{t('insights.client.uncaptured')}</div>
      ) : error && !data ? (
        <LoadFailure title={t('insights.client.error_title')} error={error} onRetry={onRetry} />
      ) : groups.length === 0 ? (
        isLoading ? <div className={styles['ranking-placeholder']} aria-hidden="true" /> : <EmptyState size="compact" title={t('insights.no_usage')} />
      ) : (
        <ol className={clsx(styles['ranking-list'], styles['ranking-list-plain'])}>
          {groups.slice(0, limit).map((group) => {
            const item = items.get(group.id)!;
            const width = top > 0 && group.value !== null ? Math.max(2, (group.value / top) * 100) : 0;
            // `other` folds many programs together, so it names no one client to narrow to or list.
            const canDrill = group.id !== 'other';
            const isSelected = selected.includes(group.id);
            const canSelect = Boolean(onSelect) && canDrill;
            const RowElement = canSelect ? 'button' : 'div';
            return (
              <li key={group.id} data-selected={isSelected || undefined} data-dimmed={isNarrowed && !isSelected ? 'true' : undefined}>
                <RowElement
                  {...(canSelect ? {
                    type: 'button' as const,
                    'aria-pressed': isSelected,
                    onClick: () => onSelect?.(group.id),
                  } : {})}
                  className={clsx(styles['ranking-row'], canSelect && styles['ranking-row-interactive'])}
                >
                  <ClientValue id={item.id} category={item.category} rawPrefix={item.raw_prefix || group.id} />
                  <span className={styles['ranking-value']} data-tip={formatMetricExact(ranking, group.value)}>
                    {formatMetric(ranking, group.value, style)}
                  </span>
                  <span className={styles['ranking-share']}>
                    <span className={styles['ranking-bar']} aria-hidden="true">
                      <span style={{ transform: `scaleX(${width / 100})` }} />
                    </span>
                    {formatShare(group.share)}
                  </span>
                </RowElement>
                {canDrill ? (
                  <ToolButton
                    variant="ghost"
                    size="sm"
                    className={clsx(styles['ranking-open'], styles['ranking-open-tool'])}
                    icon={<RightOutlined />}
                    label={t('insights.view_requests')}
                    disabled={isPlaceholder || !canViewRequests}
                    onClick={() => onNavigate(hrefFor(group.id))}
                  />
                ) : <span className={styles['ranking-open-spacer']} aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
};
