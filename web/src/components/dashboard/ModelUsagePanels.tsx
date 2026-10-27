import React from 'react';
import { Segmented } from 'antd';
import { clsx } from 'clsx';
import { ParagraphPlaceholder } from '../common/ContentPlaceholder';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { useOpenPriceEditor } from '../pricing/PricingEditorContext';
import { seriesColor, seriesDomainKey, seriesGroupLabel as groupLabel } from '../../charts/chartTheme';
import { useTheme } from '../../theme/ThemeContext';
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
import { Panel } from '../common/Panel';
import { ChartLegend } from '../common/ChartLegend';
import { ModelMark } from '../ModelMark';
import selectionStyles from '../common/selection.module.css';
import './dashboard.css';
import { Tooltip } from '../common/Tooltip';

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
 * The two model-level cards: the window's token trend and its usage ring.
 *
 * They are two widgets the operator places independently, and one read feeds both - a correctness
 * requirement rather than an economy. The two panels are two views of one ranking: the trend's line
 * colours and the ring's slice colours are assigned from the order the endpoint returned, so reading
 * twice would let the two disagree about which models exist and in what order they rank - and a
 * model would then be blue in one panel and green in the other. Both call `useDashboardModels` with
 * the same key, so react-query serves them one cache entry and one request.
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
 *
 * **One selection, two views.** The trend's line and the ring's slice are two drawings of one group,
 * so the focus the operator clicks is one fact rather than two: choosing a model in either card
 * chooses it in both. The selection lives in `ModelSeriesFocusProvider` above the cards because they
 * are placed independently - either can be hidden - so no card may own the selection for the other.
 */
function useDashboardModels({ query, range, enabled }: ModelUsagePanelsProps) {
  const { modelView } = useTokenDisplayStyle();
  const sliding = isSlidingRange(range);
  const modelsQuery = React.useMemo(() => withGroupBy(query, modelView), [query, modelView]);
  return useQuery<DashboardModelsResponse>({
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
}

// A shared loading boundary keeps the ranking readable while the chart module arrives; its
// chart initialization then yields through the common mount queue.
const chartFallback = <div className="model-chart-skeleton" aria-hidden="true" />;

/**
 * The body both cards share for the states before a ranking exists: a skeleton on the first read,
 * the failure when that read failed, and the stale warning above a ranking a later poll could not
 * refresh.
 */
const ModelPanelBody: React.FC<{ models: ReturnType<typeof useDashboardModels>; children: React.ReactNode }> = ({ models, children }) => {
  const t = useT();
  const { data, isError, error, refetch } = models;
  if (!data && !isError) return <ParagraphPlaceholder rows={4} />;
  if (isError && !data) {
    return (
      <ModelPanelsError
        message={error instanceof ApiError ? error.message : t('dash.error_desc')}
        onRetry={() => void refetch()}
      />
    );
  }
  return (
    <>
      {isError && (
        <LoadFailure
          className="model-stale-alert"
          tone="warning"
          title={t('dash.models.stale')}
          onRetry={() => void refetch()}
        />
      )}
      {children}
    </>
  );
};

/**
 * The grouping toggle. It governs both cards and normally sits on the usage card, where the
 * difference between a call point and an upstream model is read; the trend card carries it instead
 * when the usage card is hidden, so the trend's grouping never becomes unreachable. Both copies write
 * the one stored preference, so they cannot disagree.
 */
const ModelViewToggle: React.FC = () => {
  const t = useT();
  const { modelView, setModelView } = useTokenDisplayStyle();
  return (
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
};

export interface ModelTrendPanelProps extends ModelUsagePanelsProps {
  /** True when the usage card, which normally carries the grouping toggle, is not on the board. */
  hasViewToggle?: boolean;
}

/**
 * One focused model and the controls both cards drive it with. Focus is a reading aid, never a
 * filter: the other groups stay on screen and in the tooltip, because the selected model's shape only
 * means something beside them.
 */
interface ModelSeriesFocus {
  focusedKey: string | null;
  toggleSeries: (key: string) => void;
  clearFocus: () => void;
}

const ModelSeriesFocusContext = React.createContext<ModelSeriesFocus | null>(null);

/**
 * Holds the selection the trend and the usage card read together.
 *
 * The two cards are two views of one ranking, so "the model I am reading" is one fact: choosing it in
 * either card chooses it in both, and a reader compares the line's shape with its slice without
 * finding the name twice. The state sits above the cards because the operator places them
 * independently - either can be hidden - so neither card may own the selection for the other.
 */
export const ModelSeriesFocusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const toggleSeries = React.useCallback((key: string) => {
    setFocusedKey((current) => (current === key ? null : key));
  }, []);
  const clearFocus = React.useCallback(() => setFocusedKey(null), []);
  const focus = React.useMemo<ModelSeriesFocus>(
    () => ({ focusedKey, toggleSeries, clearFocus }),
    [focusedKey, toggleSeries, clearFocus],
  );
  return <ModelSeriesFocusContext.Provider value={focus}>{children}</ModelSeriesFocusContext.Provider>;
};

/**
 * The shared selection, resolved against the ranking the calling card is drawing.
 *
 * A key that is no longer in the ranking - the grouping changed, the window no longer ranks that
 * model, or it fell out of the fold - is cleared rather than kept: a focus with no matching group
 * would fade every remaining series and leave the reader looking at a dim chart with nothing
 * highlighted.
 */
function useSeriesFocus(groups: DashboardModelUsage[]): ModelSeriesFocus {
  const focus = React.useContext(ModelSeriesFocusContext);
  if (focus === null) {
    throw new Error('The dashboard model panels must be rendered inside ModelSeriesFocusProvider');
  }
  const { focusedKey, clearFocus } = focus;
  const availableKeys = React.useMemo(() => new Set(groups.map(seriesDomainKey)), [groups]);
  React.useEffect(() => {
    if (focusedKey !== null && !availableKeys.has(focusedKey)) clearFocus();
  }, [availableKeys, clearFocus, focusedKey]);
  return focus;
}

const ModelSeriesName: React.FC<{
  group: DashboardModelUsage;
  foldedLabel: string;
  unnamedLabel: string;
}> = ({ group, foldedLabel, unnamedLabel }) => {
  const label = groupLabel(group, foldedLabel, unnamedLabel);
  return (
    <span className="model-series-name" title={label}>
      {!group.folded && <ModelMark model={group.model} size={16} className="model-series-mark" />}
      <span className="model-series-text">{label}</span>
    </span>
  );
};

export const ModelTrendPanel: React.FC<ModelTrendPanelProps> = ({ hasViewToggle = false, ...props }) => {
  const t = useT();
  const { theme } = useTheme();
  const models = useDashboardModels(props);
  const foldedLabel = t('dash.models.folded');
  const unnamedLabel = t('dash.models.unnamed');
  const groups = React.useMemo(() => models.data?.models ?? [], [models.data]);
  const { focusedKey, toggleSeries, clearFocus } = useSeriesFocus(groups);

  return (
    <Panel
      className="dashboard-tile model-trend-card"
      title={<span className="tile-label">{t('dash.models.trend_title')}</span>}
      extra={hasViewToggle ? <ModelViewToggle /> : undefined}
    >
      <ModelPanelBody models={models}>
        <ChartLegend
          className="model-trend-legend"
          label={t('dash.models.trend_title')}
          testId="model-trend-legend"
          items={groups.map((group, index) => {
            const key = seriesDomainKey(group);
            return {
              id: key,
              color: seriesColor(theme.palette, index),
              content: <ModelSeriesName group={group} foldedLabel={foldedLabel} unnamedLabel={unnamedLabel} />,
              title: t(focusedKey === key ? 'dash.models.clear_series_focus' : 'dash.models.focus_series'),
              isPressed: focusedKey === key,
              isDimmed: focusedKey !== null && focusedKey !== key,
              onToggle: () => toggleSeries(key),
            };
          })}
        />
        {groups.length === 0 ? (
          <p className="empty-copy model-empty">{t('dash.models.empty')}</p>
        ) : (
          <React.Suspense fallback={chartFallback}>
            <LazyModelTokenTrend groups={groups} focusedKey={focusedKey} foldedLabel={foldedLabel} unnamedLabel={unnamedLabel} tokenUnitLabel={t('dash.unit_tokens')} height={240} onFocusGroup={toggleSeries} onClearFocus={clearFocus} />
          </React.Suspense>
        )}
      </ModelPanelBody>
    </Panel>
  );
};

export const ModelUsagePanel: React.FC<ModelUsagePanelsProps> = (props) => {
  const t = useT();
  const { theme } = useTheme();
  const { modelView, style: tokenStyle } = useTokenDisplayStyle();
  const openPriceEditor = useOpenPriceEditor();
  const models = useDashboardModels(props);
  const foldedLabel = t('dash.models.folded');
  const unnamedLabel = t('dash.models.unnamed');
  const groups = React.useMemo(() => models.data?.models ?? [], [models.data]);
  const total = models.data?.total_tokens ?? 0;
  const { focusedKey, toggleSeries, clearFocus } = useSeriesFocus(groups);

  return (
    <Panel
      className="dashboard-tile model-usage-card"
      title={<span className="tile-label">{t('dash.models.usage_title')}</span>}
      extra={<ModelViewToggle />}
    >
      <ModelPanelBody models={models}>
        {groups.length === 0 ? (
          <p className="empty-copy model-empty">{t('dash.models.empty')}</p>
        ) : (
          <div className="model-usage-body">
            <React.Suspense fallback={chartFallback}>
              <LazyModelUsageDonut groups={groups} totalTokens={total} focusedKey={focusedKey} foldedLabel={foldedLabel} unnamedLabel={unnamedLabel} tokenUnitLabel={t('dash.unit_tokens')} onFocusGroup={toggleSeries} onClearFocus={clearFocus} />
            </React.Suspense>
            {/*
              The ranked list is the ring's legend, its label column and its values in one. A separate
              library legend would print the same ranking a second time with no numbers, and a reader
              comparing two models needs the numbers - a slice's angle is a poor way to compare 5.9%
              against 4.6%.
            */}
            <ol className="model-usage-list" aria-label={t('dash.models.usage_title')}>
              {groups.map((group, index) => (
                // Reading order is name, cost, volume, share - widest to narrowest claim: what
                // the group is, what it cost, how much it moved, and its slice of the window.
                // The cost sits beside the name rather than at the far edge because it is the
                // second thing an operator reads a spend table for, and the share stays last
                // where it continues the percentage column of the ring beside it.
                <li className="model-usage-row" key={seriesDomainKey(group)}>
                  <span className="model-usage-swatch" style={{ background: seriesColor(theme.palette, index) }} aria-hidden="true" />
                  <span className="model-usage-name">
                    <button
                      type="button"
                      className={clsx('model-usage-name-button', selectionStyles['selection-control'])}
                      aria-pressed={focusedKey === seriesDomainKey(group)}
                      data-dimmed={focusedKey !== null && focusedKey !== seriesDomainKey(group)}
                      title={t(focusedKey === seriesDomainKey(group) ? 'dash.models.clear_series_focus' : 'dash.models.focus_series')}
                      onClick={() => toggleSeries(seriesDomainKey(group))}
                    >
                      <ModelSeriesName group={group} foldedLabel={foldedLabel} unnamedLabel={unnamedLabel} />
                    </button>
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
      </ModelPanelBody>
    </Panel>
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

const ModelPanelsError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => {
  const t = useT();
  return (
    <LoadFailure className="model-alert" title={t('dash.models.error')} detail={message} onRetry={onRetry} />
  );
};

export { DASHBOARD_MODELS_QUERY_KEY };
