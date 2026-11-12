import React from 'react';
import { Segmented } from '@/components/ui/segmented';
import { clsx } from 'clsx';
import { Layers } from 'lucide-react';
import { ParagraphPlaceholder } from '../common/ContentPlaceholder';
import { ApiError } from '../../api/client';
import { LazyModelTokenTrend } from '../../charts/lazyCharts';
import { useSwrQuery } from '../../performance/swrContract';
import { dashboardModelsSwr } from './dashboardQueries';
import { useT } from '../../i18n';
import { useOpenPriceEditor } from '../pricing/PricingEditorContext';
import { seriesColorRange, seriesDomainKey, seriesGroupLabel as groupLabel } from '../../charts/chartTheme';
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
} from '../../types/dashboardModels';
import { formatCurrency } from '../../types/currencyDisplay';
import { useDisplayCurrency } from '../../types/CurrencyDisplayContext';
import { isSlidingRange, type DashboardRange } from '../../types/dashboard';
import { LoadFailure } from '../feedback';
import { Panel } from '../common/Panel';
import { ChartLegend } from '../common/ChartLegend';
import { ModelMark } from '../ModelMark';
import './dashboard.css';
import { Tooltip } from '../common/Tooltip';

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
 * **One selection, two views.** The trend's line and the ranking's row are two drawings of one group,
 * so the focus the operator clicks is one fact rather than two: choosing a model in either card
 * chooses it in both. The selection lives in `ModelSeriesFocusProvider` above the cards because they
 * are placed independently - either can be hidden - so no card may own the selection for the other.
 */
function useDashboardModels({ query, range, enabled }: ModelUsagePanelsProps) {
  const { modelView } = useTokenDisplayStyle();
  const sliding = isSlidingRange(range);
  const modelsQuery = React.useMemo(() => withGroupBy(query, modelView), [query, modelView]);
  return useSwrQuery(dashboardModelsSwr, modelsQuery, {
    enabled,
    refetchInterval: sliding ? DASHBOARD_MODELS_REFRESH_MS : false,
    refetchOnWindowFocus: sliding,
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
      size="sm"
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
 * highlighted. A ranking that has not been read yet proves nothing about the key: a card mounting
 * after the shared read expired must not be what drops a selection the model would keep.
 */
function useSeriesFocus(groups: DashboardModelUsage[], hasRanking: boolean): ModelSeriesFocus {
  const focus = React.useContext(ModelSeriesFocusContext);
  if (focus === null) {
    throw new Error('The dashboard model panels must be rendered inside ModelSeriesFocusProvider');
  }
  const { focusedKey, clearFocus } = focus;
  const availableKeys = React.useMemo(() => new Set(groups.map(seriesDomainKey)), [groups]);
  React.useEffect(() => {
    if (hasRanking && focusedKey !== null && !availableKeys.has(focusedKey)) clearFocus();
  }, [availableKeys, clearFocus, focusedKey, hasRanking]);
  return focus;
}

const ModelSeriesName: React.FC<{
  group: DashboardModelUsage;
  foldedLabel: string;
  unnamedLabel: string;
}> = ({ group, foldedLabel, unnamedLabel }) => {
  const label = groupLabel(group, foldedLabel, unnamedLabel);
  return (
    <span className="model-series-name" data-tip={label} data-tip-overflow="">
      {group.folded ? (
        <Layers size={16} strokeWidth={1.75} className="model-series-mark model-series-mark-folded" aria-hidden="true" />
      ) : (
        <ModelMark model={group.model} size={16} className="model-series-mark" />
      )}
      <span className="model-series-text">{label}</span>
    </span>
  );
};

export const ModelTrendPanel: React.FC<ModelTrendPanelProps> = React.memo(function ModelTrendPanel({ hasViewToggle = false, ...props }) {
  const t = useT();
  const { theme } = useTheme();
  const models = useDashboardModels(props);
  const foldedLabel = t('dash.models.folded');
  const unnamedLabel = t('dash.models.unnamed');
  const groups = React.useMemo(() => models.data?.models ?? [], [models.data]);
  const { focusedKey, toggleSeries, clearFocus } = useSeriesFocus(groups, models.data !== undefined);
  const colors = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);

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
              color: colors[index],
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
            <LazyModelTokenTrend groups={groups} focusedKey={focusedKey} foldedLabel={foldedLabel} unnamedLabel={unnamedLabel} totalLabel={t('dash.models.total')} tokenUnitLabel={t('dash.unit_tokens')} onFocusGroup={toggleSeries} onClearFocus={clearFocus} />
          </React.Suspense>
        )}
      </ModelPanelBody>
    </Panel>
  );
});

export const ModelUsagePanel: React.FC<ModelUsagePanelsProps> = React.memo(function ModelUsagePanel(props) {
  const t = useT();
  const { theme } = useTheme();
  const { modelView, style: tokenStyle } = useTokenDisplayStyle();
  const openPriceEditor = useOpenPriceEditor();
  const models = useDashboardModels(props);
  const foldedLabel = t('dash.models.folded');
  const unnamedLabel = t('dash.models.unnamed');
  const groups = React.useMemo(() => models.data?.models ?? [], [models.data]);
  const total = models.data?.total_tokens ?? 0;
  const { focusedKey, toggleSeries } = useSeriesFocus(groups, models.data !== undefined);
  const colors = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);
  // A pointer over a row or a segment marks that group in the bar and washes its row; only a click
  // dims the rest, and that choice is the one the trend card shares. The mark clears when the pointer
  // leaves the bar or the list, not between two rows, so crossing a row boundary never flickers.
  // Mouse only - a tap is a choice.
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null);
  const markedKey = hoveredKey ?? focusedKey;
  const onHover = (key: string) => (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') setHoveredKey(key);
  };
  const clearHover = () => setHoveredKey(null);

  return (
    <Panel
      className="dashboard-tile model-usage-card"
      title={
        <span className="model-usage-title">
          <span className="tile-label">{t('dash.models.usage_title')}</span>
          {groups.length > 0 ? <ModelUsageTotal groups={groups} totalTokens={total} /> : null}
        </span>
      }
      extra={<ModelViewToggle />}
    >
      <ModelPanelBody models={models}>
        {groups.length === 0 ? (
          <p className="empty-copy model-empty">{t('dash.models.empty')}</p>
        ) : (
          <>
            {/*
              The card's one drawing: a bar the groups divide between them, so the parts read as parts
              of one total. Everything under it is text. A segment keeps a dot's width at the smallest
              shares, and its colour is the one the trend draws the group in.
            */}
            <div className="model-usage-bar" aria-hidden="true" data-has-mark={markedKey !== null || undefined} onPointerLeave={clearHover}>
              {groups.map((group, index) =>
                group.tokens > 0 ? (
                  <span
                    key={seriesDomainKey(group)}
                    className="model-usage-segment"
                    data-marked={markedKey === seriesDomainKey(group) || undefined}
                    style={{ flexGrow: group.tokens, background: colors[index] }}
                    onPointerEnter={onHover(seriesDomainKey(group))}
                    onClick={() => toggleSeries(seriesDomainKey(group))}
                  />
                ) : null,
              )}
            </div>
            <ol className="model-usage-list" aria-label={t('dash.models.usage_title')} data-has-focus={focusedKey !== null || undefined} onPointerLeave={clearHover}>
              {groups.map((group, index) => {
                const key = seriesDomainKey(group);
                const isFocused = focusedKey === key;
                return (
                  // Reading order is name, cost, volume, share - what the group is, what it cost, how
                  // much it moved, and its slice of the window.
                  <li
                    className="model-usage-row"
                    key={key}
                    data-hovered={hoveredKey === key || undefined}
                    data-focused={isFocused || undefined}
                    onPointerEnter={onHover(key)}
                  >
                    <span className="model-usage-name">
                      <span className="model-usage-key" style={{ background: colors[index] }} aria-hidden="true" />
                      <button type="button" className="model-usage-name-button" aria-pressed={isFocused} onClick={() => toggleSeries(key)}>
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
                      data-tip={`${formatTokensFull(group.tokens)} ${t('dash.unit_tokens')}`}
                    >
                      {formatModelTokens(group.tokens, tokenStyle)}
                    </span>
                    <span className="model-usage-share">{formatModelShare(group.tokens, total)}</span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </ModelPanelBody>
    </Panel>
  );
});

/** Whether a group carries a priced spend - which may be an explicit zero, a free model. */
function isPriced(group: DashboardModelUsage): group is DashboardModelUsage & { cost_usd: number } {
  return group.priced_requests > 0 && group.cost_usd != null;
}

/**
 * The window's sum in the card's head: every group's volume and, where any of it was priced, the
 * spend. The spend is summed over the priced requests only, so a window with unpriced traffic shows
 * it in the quieter ink and names the priced share - the same reading the row's own cost cell gives.
 */
const ModelUsageTotal: React.FC<{ groups: readonly DashboardModelUsage[]; totalTokens: number }> = ({ groups, totalTokens }) => {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const { currency } = useDisplayCurrency();
  let cost = 0;
  let priced = 0;
  let requests = 0;
  for (const group of groups) {
    requests += group.requests;
    if (!isPriced(group)) continue;
    cost += group.cost_usd;
    priced += group.priced_requests;
  }
  const isPartial = priced > 0 && priced < requests;
  return (
    <span className="model-usage-total" data-tip={`${formatTokensFull(totalTokens)} ${t('dash.unit_tokens')}`}>
      <span className="model-usage-total-label">{t('dash.models.total')}</span>
      <b>{formatModelTokens(totalTokens, tokenStyle)}</b>
      <span className="model-usage-total-unit">{t('dash.unit_tokens')}</span>
      {priced > 0 ? (
        <b
          className={clsx('model-usage-total-cost', isPartial && 'is-partial')}
          data-tip={isPartial ? t('dash.models.cost_partial', { priced, total: requests }) : undefined}
        >
          {formatCurrency(cost, currency)}
          {isPartial ? <span className="sr-only">{` (${t('dash.models.cost_partial', { priced, total: requests })})`}</span> : null}
        </b>
      ) : null}
    </span>
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
  const { currency } = useDisplayCurrency();
  const isUnpriced = group.priced_requests <= 0 || group.cost_usd == null;
  const isPartial = !isUnpriced && group.priced_requests < group.requests;
  const text = isUnpriced ? '—' : formatCurrency(group.cost_usd, currency);
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
      <span className={className}>
        {text}
        <span className="sr-only">{` (${note})`}</span>
      </span>
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
