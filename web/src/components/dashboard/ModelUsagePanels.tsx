import React from 'react';
import { Card, Segmented, Tooltip } from 'antd';
import { ParagraphPlaceholder } from '../common/ContentPlaceholder';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { useOpenPriceEditor } from '../pricing/PricingEditorContext';
import { seriesColor, seriesDomainKey } from '../../charts/chartTheme';
import { useTheme } from '../../theme/ThemeContext';
import type { ThemePalette } from '../../theme/palette';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import {
  DASHBOARD_MODELS_QUERY_KEY,
  DASHBOARD_MODELS_REFRESH_MS,
  formatModelShare,
  formatModelTokens,
  formatTokensFull,
  withGroupBy,
  type DashboardModelUsage,
  type DashboardModelsResponse,
} from '../../types/dashboardModels';
import { formatCost } from '../../types/tokenDisplay';
import { isSlidingRange, type DashboardRange } from '../../types/dashboard';
import { LoadFailure } from '../feedback';

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
 *
 * **The grouping is part of the query.** The view toggle asks the endpoint to rank by call point (the
 * alias a client requested) or by upstream model, and the choice rides in the request rather than in
 * a client-side regroup: the ranking, the fold and the colour assignment are the server's single
 * answer for exactly the grouping on screen. Switching views re-reads the window's ranking, and each
 * view keeps its own cache entry so the two never patch into each other.
 */
export const ModelUsagePanels: React.FC<ModelUsagePanelsProps> = ({ query, range, enabled }) => {
  const t = useT();
  const { theme } = useTheme();
  const { modelView, setModelView, style: tokenStyle } = useTokenDisplayStyle();
  const openPriceEditor = useOpenPriceEditor();
  const sliding = isSlidingRange(range);

  const modelsQuery = React.useMemo(() => withGroupBy(query, modelView), [query, modelView]);
  const { data, isError, error, refetch } = useQuery<DashboardModelsResponse>({
    queryKey: [DASHBOARD_MODELS_QUERY_KEY, modelsQuery],
    queryFn: () => api.getDashboardModels(modelsQuery),
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

  // A shared loading boundary keeps the ranking readable while both chart modules arrive;
  // their expensive canvas creation then yields through the common mount queue.
  const chartFallback = <div className="model-chart-skeleton" aria-hidden="true" />;

  const viewToggle = (
    <Segmented
      className="model-view-toggle"
      size="small"
      value={modelView}
      options={[
        { value: 'call', label: t('dash.models.view_call') },
        { value: 'model', label: t('dash.models.view_model') },
      ]}
      onChange={(next) => setModelView(next as 'call' | 'model')}
      aria-label={t('dash.models.view_toggle_label')}
    />
  );

  return (
    <div className="dashboard-models">
      <Card
        className="dashboard-tile is-wide model-trend-card"
        styles={{ body: { padding: 20 } }}
        title={<span className="tile-label">{t('dash.models.trend_title')}</span>}
      >
        {!data && !isError ? (
          <ParagraphPlaceholder rows={4} />
        ) : isError && !data ? (
          <ModelPanelsError
            message={error instanceof ApiError ? error.message : t('dash.error_desc')}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            {isError && (
              <LoadFailure
                className="model-stale-alert"
                tone="warning"
                title={t('dash.models.stale')}
                onRetry={() => void refetch()}
              />
            )}
            <ModelLegend groups={groups} foldedLabel={foldedLabel} unnamedLabel={unnamedLabel} palette={theme.palette} />
            {groups.length === 0 ? (
              <p className="empty-copy model-empty">{t('dash.models.empty')}</p>
            ) : (
              <React.Suspense fallback={chartFallback}>
                <LazyModelTokenTrend groups={groups} foldedLabel={foldedLabel} tokenUnitLabel={t('dash.unit_tokens')} height={240} />
              </React.Suspense>
            )}
          </>
        )}
      </Card>

      <Card
        className="dashboard-tile is-wide model-usage-card"
        styles={{ body: { padding: 20 } }}
        title={<span className="tile-label">{t('dash.models.usage_title')}</span>}
        extra={viewToggle}
      >
        {!data && !isError ? (
          <ParagraphPlaceholder rows={4} />
        ) : isError && !data ? (
          <ModelPanelsError
            message={error instanceof ApiError ? error.message : t('dash.error_desc')}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            {isError && (
              <LoadFailure
                className="model-stale-alert"
                tone="warning"
                title={t('dash.models.stale')}
                onRetry={() => void refetch()}
              />
            )}
            {groups.length === 0 ? (
              <p className="empty-copy model-empty">{t('dash.models.empty')}</p>
            ) : (
              <div className="model-usage-body">
                <React.Suspense fallback={chartFallback}>
                  <LazyModelUsageDonut groups={groups} totalTokens={total} foldedLabel={foldedLabel} tokenUnitLabel={t('dash.unit_tokens')} />
                </React.Suspense>
                {/*
                  The ranked list is the ring's legend, its label column and its values in one. A separate
                  library legend would print the same ranking a second time with no numbers, and a reader
                  comparing two models needs the numbers - a slice's angle is a poor way to compare 5.9%
                  against 4.6%.
                */}
                <ol className="model-usage-list">
                  {groups.map((group, index) => (
                    // Reading order is name, cost, volume, share - widest to narrowest claim: what
                    // the group is, what it cost, how much it moved, and its slice of the window.
                    // The cost sits beside the name rather than at the far edge because it is the
                    // second thing an operator reads a spend table for, and the share stays last
                    // where it continues the percentage column of the ring beside it.
                    <li className="model-usage-row" key={seriesDomainKey(group)}>
                      <span className="model-usage-swatch" style={{ background: seriesColor(theme.palette, index) }} aria-hidden="true" />
                      <span className="model-usage-name" title={groupLabel(group, foldedLabel, unnamedLabel)}>
                        {groupLabel(group, foldedLabel, unnamedLabel)}
                      </span>
                      <ModelCost
                        group={group}
                        // Only the model view names what a price is keyed on: a call point may be an alias
                        // whose requests are priced under the upstream model it resolved to.
                        onPrice={openPriceEditor && modelView === 'model' && !group.folded && group.model ? () => openPriceEditor(group.model) : undefined}
                      />
                      <span
                        className="model-usage-tokens"
                        // The exact count lives in the accessible name: the compact cell is for scanning,
                        // and the rounding it applies must never be mistaken for the number itself.
                        title={`${formatTokensFull(group.tokens)} ${t('dash.unit_tokens')}`}
                      >
                        {formatModelTokens(group.tokens, tokenStyle)}
                      </span>
                      <span className="model-usage-share">{formatModelShare(group.tokens, total)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};

/**
 * ModelCost is the ranked list's cost cell.
 *
 * The amount is the group's own spend at request-time prices. A group with priced requests prints the
 * amount, and prints the priced share beside it when that share is partial - a spend summed over part
 * of the traffic is not the spend of the whole, and the cell would otherwise read as complete. A group
 * with no priced request at all reports that instead of a zero: a zero would claim these calls were
 * free, which is the one thing an unpriced window never proves.
 */
const ModelCost: React.FC<{ group: DashboardModelUsage; onPrice?: () => void }> = ({ group, onPrice }) => {
  const t = useT();
  const isUnpriced = group.priced_requests <= 0 || group.cost_usd == null;
  const isPartial = !isUnpriced && group.priced_requests < group.requests;
  const text = isUnpriced ? '—' : formatCost(group.cost_usd);
  const className = `model-usage-cost${isUnpriced ? ' is-unpriced' : isPartial ? ' is-partial' : ''}`;
  if (!isUnpriced && !isPartial) return <span className={className}>{text}</span>;
  const note = isUnpriced
    ? t('dash.models.cost_unpriced')
    : t('dash.models.cost_partial', { priced: group.priced_requests, total: group.requests });
  // An incomplete cost is the one a price fixes, so where the group is a real upstream model the
  // cell opens the price editor for it rather than only explaining the gap.
  if (onPrice) {
    return (
      <Tooltip title={`${note} · ${t('dash.models.set_price')}`}>
        <button type="button" className={`${className} model-usage-cost-action`} onClick={onPrice} aria-label={`${note} · ${t('dash.models.set_price')}`}>
          {text}
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={note}>
      <span className={className}>{text}</span>
    </Tooltip>
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
  palette: ThemePalette;
}> = ({ groups, foldedLabel, unnamedLabel, palette }) => (
  <ul className="model-legend">
    {groups.map((group, index) => (
      <li className="model-legend-item" key={seriesDomainKey(group)}>
        <span className="model-legend-swatch" style={{ background: seriesColor(palette, index) }} aria-hidden="true" />
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
    <LoadFailure className="model-alert" title={t('dash.models.error')} detail={message} onRetry={onRetry} />
  );
};

export { DASHBOARD_MODELS_QUERY_KEY };
