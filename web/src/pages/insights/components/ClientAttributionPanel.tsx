import React from 'react';
import clsx from 'clsx';
import { useInsightsFormat } from '../useInsightsFormat';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { ToolButton } from '../../../components/common/ToolButton';
import { LobeIcon } from '../../../components/LobeIcon';
import { LoadFailure } from '../../../components/feedback';
import { CodeOutlined, CodeSandboxOutlined, GlobalOutlined, RightOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import type { InsightsClientItem, InsightsClientsResponse } from '../../../types/insights';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { rankGroups, rankingMetric, type CubeMetric, type Measures } from '../../../types/insightsCube';
import { formatShare } from '../../../types/insightsFormat';
import { ownClientMark } from './ClientMarks';
import { clientCoverageShare, clientIconId, clientMeasures, clientProductName, isLocalizedClient } from '../../../types/clientAgents';
import styles from '../insights.module.css';

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
}

function ClientMark({ item }: { item: InsightsClientItem }) {
  const own = ownClientMark(item.id);
  if (own) return own;
  const iconId = clientIconId(item.id);
  if (iconId) return <LobeIcon iconId={iconId} size={16} />;
  if (item.id === 'browser') return <GlobalOutlined />;
  if (item.category === 'agent') return <CodeSandboxOutlined />;
  if (item.category === 'sdk') return <CodeOutlined />;
  return null;
}

/**
 * Which programs sent the traffic - coding agents, SDKs, scripts - read from the request records'
 * User-Agent. The records are kept for less time than the page's facts, so a window reaching past
 * them says how much of it the ranking covers rather than letting the missing part read as idle.
 */
export const ClientAttributionPanel: React.FC<ClientAttributionPanelProps> = ({
  data, metric, isLoading, isUncaptured, error, onRetry, isPlaceholder = false, limit = 8, canViewRequests = true, hrefFor, onNavigate,
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
  const nameOf = (id: string) => (isLocalizedClient(id) ? t(`insights.client.${id}`) : clientProductName(id)!);

  return (
    <Panel
      data-testid="insights-ranking-client"
      title={(
        <PanelTitle
          extra={coverage !== null ? (
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
            const canDrill = group.id !== 'other';
            return (
              <li key={group.id}>
                <div className={styles['ranking-row']}>
                  <span className={styles['value']} data-tip={item.raw_prefix?.trim() || group.id}>
                    <span className={styles['value-mark']} aria-hidden="true"><ClientMark item={item} /></span>
                    <span className={clsx(styles['value-name'], item.category === 'unknown' && styles['is-muted'])}>{nameOf(group.id)}</span>
                  </span>
                  <span className={styles['ranking-value']} data-tip={formatMetricExact(ranking, group.value)}>
                    {formatMetric(ranking, group.value, style)}
                  </span>
                  <span className={styles['ranking-share']}>
                    <span className={styles['ranking-bar']} aria-hidden="true">
                      <span style={{ transform: `scaleX(${width / 100})` }} />
                    </span>
                    {formatShare(group.share)}
                  </span>
                </div>
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
