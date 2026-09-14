import React from 'react';
import { Alert, Button, Card, Skeleton } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { seriesColor, seriesDomainKey } from '../../charts/chartTheme';
import { useThemeMode } from '../../theme/ThemeContext';
import {
  DASHBOARD_MODELS_QUERY_KEY,
  DASHBOARD_MODELS_REFRESH_MS,
  formatModelShare,
  formatModelTokens,
  type DashboardModelUsage,
  type DashboardModelsResponse,
} from '../../types/dashboardModels';
import { isSlidingRange, type DashboardRange } from '../../types/dashboard';

const LazyModelTokenTrend = React.lazy(() =>
  import('../../charts/ModelTokenTrend').then((module) => ({ default: module.ModelTokenTrend }))
);
const LazyModelUsageDonut = React.lazy(() =>
  import('../../charts/ModelUsageDonut').then((module) => ({ default: module.ModelUsageDonut }))
);

export interface ModelUsagePanelsProps {
  /** The window the page's picker selected, serialized exactly as the KPI tiles serialize it. */
  query: string;
  /** The picker's choice, which decides whether the panels poll. */
  range: DashboardRange;
  /** False until the stored preference has been read, so no window is fetched twice. */
  enabled: boolean;
}

/**
 * ModelUsagePanels hosts the two model-level cards above the token activity grid.
 *
 * One query feeds both, and that is a correctness requirement rather than an economy. The two panels
 * are two views of one ranking: the trend's line colours and the ring's slice colours are assigned
 * from the order the endpoint returned, so reading twice would let the two disagree about which
 * models exist and in what order they rank - and a model would then be blue in one panel and green in
 * the other.
 *
 * **Its own cadence, and its own failure.** The page's KPI tiles poll as often as every five seconds
 * through the tail endpoint, which is a cheap read of pre-aggregated buckets. This read walks the
 * detail rows instead (see the repository query for why the rollup's window split is not reusable),
 * so it polls on its own much slower interval and, like the activity grid, is allowed to fail alone:
 * an unavailable read leaves the tiles and the grid beside it readable.
 *
 * Nothing polls for a closed range. A custom window with a picked end is frozen - its numbers cannot
 * change - so re-reading it would spend the page's heaviest query to redraw an identical panel.
 */
export const ModelUsagePanels: React.FC<ModelUsagePanelsProps> = ({ query, range, enabled }) => {
  const t = useT();
  const { themeMode } = useThemeMode();
  const sliding = isSlidingRange(range);

  const { data, isError, error, refetch } = useQuery<DashboardModelsResponse>({
    queryKey: [DASHBOARD_MODELS_QUERY_KEY, query],
    queryFn: () => api.getDashboardModels(query),
    enabled,
    refetchInterval: sliding ? DASHBOARD_MODELS_REFRESH_MS : false,
    refetchOnWindowFocus: sliding,
    staleTime: DASHBOARD_MODELS_REFRESH_MS / 2,
    // A refresh that failed keeps the panels the operator is reading: replacing a month of ranking
    // with an error card because one poll timed out is worse than showing slightly old data.
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });

  const foldedLabel = t('dash.models.folded');
  const unnamedLabel = t('dash.models.unnamed');
  const groups = data?.models ?? [];
  const total = data?.total_tokens ?? 0;

  // The ring and the trend are loaded together because they are drawn together; one skeleton covers
  // both so the two never appear a frame apart, which reads as one of them failing.
  const chartFallback = <div className="model-chart-skeleton" aria-hidden="true" />;

  return (
    <div className="dashboard-models">
      <Card className="dashboard-tile is-wide model-trend-card" styles={{ body: { padding: 20 } }}>
        <div className="tile-label">{t('dash.models.trend_title')}</div>
        {!data && !isError ? (
          <Skeleton active={false} title={false} paragraph={{ rows: 4, width: ['100%', '90%', '95%', '80%'] }} />
        ) : isError && !data ? (
          <ModelPanelsError
            message={error instanceof ApiError ? error.message : t('dash.error_desc')}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            {isError && (
              <Alert
                className="model-stale-alert"
                type="warning"
                showIcon
                description={t('dash.models.stale')}
                action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>{t('common.retry')}</Button>}
              />
            )}
            <ModelLegend groups={groups} foldedLabel={foldedLabel} unnamedLabel={unnamedLabel} themeMode={themeMode} />
            {groups.length === 0 ? (
              <p className="empty-copy model-empty">{t('dash.models.empty')}</p>
            ) : (
              <React.Suspense fallback={chartFallback}>
                <LazyModelTokenTrend groups={groups} foldedLabel={foldedLabel} height={240} />
              </React.Suspense>
            )}
          </>
        )}
      </Card>

      <Card className="dashboard-tile is-wide model-usage-card" styles={{ body: { padding: 20 } }}>
        <div className="tile-label">{t('dash.models.usage_title')}</div>
        {!data && !isError ? (
          <Skeleton active={false} title={false} paragraph={{ rows: 4, width: ['100%', '90%', '95%', '80%'] }} />
        ) : isError && !data ? (
          <ModelPanelsError
            message={error instanceof ApiError ? error.message : t('dash.error_desc')}
            onRetry={() => void refetch()}
          />
        ) : groups.length === 0 ? (
          <p className="empty-copy model-empty">{t('dash.models.empty')}</p>
        ) : (
          <div className="model-usage-body">
            <React.Suspense fallback={chartFallback}>
              <LazyModelUsageDonut groups={groups} totalTokens={total} foldedLabel={foldedLabel} height={220} />
            </React.Suspense>
            {/*
              The ranked list is the ring's legend, its label column and its values in one. A separate
              library legend would print the same ranking a second time with no numbers, and a reader
              comparing two models needs the numbers - a slice's angle is a poor way to compare 5.9%
              against 4.6%.
            */}
            <ol className="model-usage-list">
              {groups.map((group, index) => (
                <li className="model-usage-row" key={seriesDomainKey(group)}>
                  <span className="model-usage-swatch" style={{ background: seriesColor(themeMode, index) }} aria-hidden="true" />
                  <span className="model-usage-name" title={groupLabel(group, foldedLabel, unnamedLabel)}>
                    {groupLabel(group, foldedLabel, unnamedLabel)}
                  </span>
                  <span className="model-usage-tokens">{formatModelTokens(group.tokens)}</span>
                  <span className="model-usage-share">{formatModelShare(group.tokens, total)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Card>
    </div>
  );
};

/**
 * groupLabel is what a group is called on screen.
 *
 * The folded remainder carries no model name by design - its label is the client's to translate, which
 * is why the API marks it with a flag instead of reserving a string. A named group with an empty name is
 * a different case: the API would not normally emit one, but an empty string in a legend cell reads as
 * missing data rather than as an unnamed group, so it gets the shared "unnamed" copy the rest of the
 * console uses. The label never becomes the group's identity: colour and React keys both come from
 * `seriesDomainKey`, so a group that is renamed here keeps its colour and its row.
 */
function groupLabel(group: DashboardModelUsage, foldedLabel: string, unnamedLabel: string): string {
  if (group.folded) return foldedLabel;
  return group.model.trim() === '' ? unnamedLabel : group.model;
}

/**
 * ModelLegend is the trend's key.
 *
 * It exists because the trend draws up to six lines and a line with no label is unreadable. It is the
 * app's own DOM rather than the chart library's legend so it is set in the console's type scale, and
 * it numbers the swatches so the colour identity is legible without relying on the hue alone.
 *
 * The colour alone is never the only encoding: each entry prints the model's name, and the usage list
 * beside the ring prints the name, the volume and the share. A reader who cannot separate two hues
 * reads the label instead - which is the rule `docs/design.md` sets for every state colour in the app.
 */
const ModelLegend: React.FC<{
  groups: DashboardModelUsage[];
  foldedLabel: string;
  unnamedLabel: string;
  themeMode: 'dark' | 'light';
}> = ({ groups, foldedLabel, unnamedLabel, themeMode }) => (
  <ul className="model-legend">
    {groups.map((group, index) => (
      <li className="model-legend-item" key={seriesDomainKey(group)}>
        <span className="model-legend-swatch" style={{ background: seriesColor(themeMode, index) }} aria-hidden="true" />
        <span className="model-legend-label" title={groupLabel(group, foldedLabel, unnamedLabel)}>
          {groupLabel(group, foldedLabel, unnamedLabel)}
        </span>
      </li>
    ))}
  </ul>
);

const ModelPanelsError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => {
  const t = useT();
  return (
    <Alert
      className="model-alert"
      type="error"
      showIcon
      description={`${t('dash.models.error')} — ${message}`}
      action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>{t('common.retry')}</Button>}
    />
  );
};

export { DASHBOARD_MODELS_QUERY_KEY };
