import React from 'react';
import { Segmented } from '@/components/ui/segmented';
import { clsx } from 'clsx';
import { CircleHelp, Layers } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { TabsList, TabsRoot, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '../common/EmptyState';
import { LoadingRegion } from '../common/Placeholder';
import {
  ModelTrendBarsPlaceholder,
  ModelTrendPlaceholder,
  ModelUsagePlaceholder,
} from './DashboardSkeleton';
import { ApiError } from '../../api/client';
import { LazyModelTokenTrend } from '../../charts/lazyCharts';
import { useSwrQuery } from '../../performance/swrContract';
import { dashboardModelsSwr } from './dashboardQueries';
import { useT } from '../../i18n';
import { useOpenPriceEditor } from '../pricing/PricingEditorContext';
import { seriesColorRange, seriesDomainKey, seriesGroupLabel } from '../../charts/chartTheme';
import { useTheme } from '../../theme/ThemeContext';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import {
  DASHBOARD_MODELS_QUERY_KEY,
  DASHBOARD_MODELS_REFRESH_MS,
  formatModelShare,
  formatModelTokens,
  formatTokensFull,
  withGroupBy,
  type DashboardModelGrouping,
  type DashboardModelUsage,
} from '../../types/dashboardModels';
import type { ModelChartView } from '../../types/tokenDisplay';
import { clientDisplayName } from '../../types/clientAgents';
import { ClientMark } from '../common/ClientMark';
import dayjs from '../../utils/time';
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
 * chooses it in both. The selection lives in `ModelPanelsProvider` above the cards because they
 * are placed independently - either can be hidden - so no card may own the selection for the other.
 *
 * **Two lenses.** Both cards can count the same window by the client program that sent the traffic
 * instead of by model. The lens is the dashboard's own state rather than a third value of the stored
 * grouping view: the request list, the export and Insights read that view, and none of them has a
 * client grouping of model names to switch to.
 */
function useDashboardModels({ query, range, enabled }: ModelUsagePanelsProps, grouping: DashboardModelGrouping) {
  const sliding = isSlidingRange(range);
  const modelsQuery = React.useMemo(() => withGroupBy(query, grouping), [query, grouping]);
  return useSwrQuery(dashboardModelsSwr, modelsQuery, {
    enabled,
    refetchInterval: sliding ? DASHBOARD_MODELS_REFRESH_MS : false,
    refetchOnWindowFocus: sliding,
  });
}

/**
 * What the cards count the window by: its models, or the client programs that sent it. The model
 * lens is further split by the stored grouping view (call point or upstream model).
 */
export type ModelPanelLens = 'models' | 'clients';

function groupingFor(lens: ModelPanelLens, modelView: ModelChartView): DashboardModelGrouping {
  return lens === 'clients' ? 'client' : modelView;
}

// A shared loading boundary keeps the ranking readable while the chart module arrives; its
// chart initialization then yields through the common mount queue.
const chartFallback = <ModelTrendBarsPlaceholder />;

/**
 * The body both cards share for the states before a ranking exists: a skeleton on the first read,
 * the failure when that read failed, and the stale warning above a ranking a later poll could not
 * refresh.
 */
const ModelPanelBody: React.FC<{
  models: ReturnType<typeof useDashboardModels>;
  lens: ModelPanelLens;
  fallback: React.ReactNode;
  children: React.ReactNode;
}> = ({ models, lens, fallback, children }) => {
  const t = useT();
  const isClients = lens === 'clients';
  const { data, isError, error, refetch } = models;
  if (!data && !isError) return <LoadingRegion>{fallback}</LoadingRegion>;
  if (isError && !data) {
    return (
      <ModelPanelsError
        title={t(isClients ? 'dash.clients.error' : 'dash.models.error')}
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
          title={t(isClients ? 'dash.clients.stale' : 'dash.models.stale')}
          onRetry={() => void refetch()}
        />
      )}
      {children}
    </>
  );
};

/**
 * The lens switch, which is the card's title: what the card counts is its subject, so the choice
 * is set as the heading rather than as a control beside one. The tabs sit on the head's own rule,
 * which serves as their rail, and their labels never change, so switching moves only the
 * underline. Pointing at a tab starts reading that lens, so the switch lands on numbers rather
 * than on a skeleton.
 */
const ModelLensTabs: React.FC<ModelUsagePanelsProps> = (props) => {
  const t = useT();
  const queryClient = useQueryClient();
  const { modelView } = useTokenDisplayStyle();
  const { lens, setLens } = useModelPanels();
  const prefetch = (next: ModelPanelLens) => () => {
    if (props.enabled && next !== lens) void dashboardModelsSwr.prefetch(queryClient, withGroupBy(props.query, groupingFor(next, modelView)));
  };
  return (
    <TabsRoot value={lens} onValueChange={(next) => setLens(next as ModelPanelLens)} className="model-lens">
      <TabsList className="model-lens-list" aria-label={t('dash.models.lens_label')}>
        {(['models', 'clients'] as const).map((value) => (
          <TabsTrigger key={value} value={value} className="model-lens-tab" onPointerEnter={prefetch(value)} onFocus={prefetch(value)}>
            {t(value === 'models' ? 'dash.models.lens_models' : 'dash.models.lens_clients')}
          </TabsTrigger>
        ))}
      </TabsList>
    </TabsRoot>
  );
};

/**
 * How a model is named: by the call point a client asked for, or by the upstream model that served
 * it. It refines the model lens only, so it is not drawn under the client lens.
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
      onChange={(next) => setModelView(next as ModelChartView)}
      aria-label={t('dash.models.view_toggle_label')}
    />
  );
};

export interface ModelTrendPanelProps extends ModelUsagePanelsProps {
  /** True when the usage card, which normally carries the lens tabs, is not on the board. */
  hasLensTabs?: boolean;
}

export interface ModelUsagePanelProps extends ModelUsagePanelsProps {
  /** True when the trend card, which normally carries the naming toggle, is not on the board. */
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

/**
 * A focused group and the grouping whose ranking it was chosen from. A key alone is ambiguous:
 * the held ranking stays clickable while the next grouping loads, and both rankings name their
 * folded tail "folded".
 */
interface SeriesFocus {
  grouping: DashboardModelGrouping;
  key: string;
}

/** The focus and the lens both cards share. */
interface ModelPanelsState {
  focus: SeriesFocus | null;
  toggleSeries: (grouping: DashboardModelGrouping, key: string) => void;
  clearFocus: () => void;
  lens: ModelPanelLens;
  /** Changes the lens. A focus names a group of one lens only, so it clears. */
  setLens: (lens: ModelPanelLens) => void;
}

const ModelPanelsContext = React.createContext<ModelPanelsState | null>(null);

/**
 * Holds the selection and the lens the trend and the usage card read together.
 *
 * The two cards are two views of one ranking, so "the model I am reading" is one fact: choosing it in
 * either card chooses it in both, and a reader compares the line's shape with its slice without
 * finding the name twice. The lens is one fact for the same reason. The state sits above the cards
 * because the operator places them independently - either can be hidden - so neither card may own
 * it for the other. The lens is not stored: the page opens on models, the cards' primary reading.
 */
export const ModelPanelsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [focus, setFocus] = React.useState<SeriesFocus | null>(null);
  const [lens, setLensState] = React.useState<ModelPanelLens>('models');
  const toggleSeries = React.useCallback((grouping: DashboardModelGrouping, key: string) => {
    setFocus((current) => (current?.grouping === grouping && current.key === key ? null : { grouping, key }));
  }, []);
  const clearFocus = React.useCallback(() => setFocus(null), []);
  const setLens = React.useCallback((next: ModelPanelLens) => {
    setFocus(null);
    setLensState(next);
  }, []);
  const state = React.useMemo<ModelPanelsState>(
    () => ({ focus, toggleSeries, clearFocus, lens, setLens }),
    [focus, toggleSeries, clearFocus, lens, setLens],
  );
  return <ModelPanelsContext.Provider value={state}>{children}</ModelPanelsContext.Provider>;
};

function useModelPanels(): ModelPanelsState {
  const state = React.useContext(ModelPanelsContext);
  if (state === null) {
    throw new Error('The dashboard model panels must be rendered inside ModelPanelsProvider');
  }
  return state;
}

/**
 * The read both cards draw, and the grouping the ranking on screen belongs to.
 *
 * A new grouping is read while the previous ranking stays on screen - the query keeps it as a
 * placeholder - so `shown` names the grouping of the data actually drawn, not the one asked for:
 * the held ranking keeps its own names and marks until the new one lands, and its landing is the
 * one change the cards animate. `isPending` is the wait between the two.
 */
function useLensModels(props: ModelUsagePanelsProps) {
  const { modelView } = useTokenDisplayStyle();
  const { lens } = useModelPanels();
  const grouping = groupingFor(lens, modelView);
  const models = useDashboardModels(props, grouping);
  const [shown, setShown] = React.useState(grouping);
  const hasArrived = models.data !== undefined && !models.isPlaceholderData;
  if (hasArrived && shown !== grouping) setShown(grouping);
  const isPending = !hasArrived && models.data !== undefined;
  // With nothing held - a first read, or one that failed - the card speaks for the lens asked for.
  const current = isPending ? shown : grouping;
  return {
    models,
    shown: current,
    shownLens: current === 'client' ? 'clients' as const : 'models' as const,
    isPending,
  };
}

/** How one lens names its groups: in the legend, the list, the tooltip and the accessible label. */
interface GroupNaming {
  labelOf: (entry: { folded: boolean; model: string }) => string;
  markOf: (group: DashboardModelUsage) => React.ReactNode;
}

function useGroupNaming(lens: ModelPanelLens): GroupNaming {
  const t = useT();
  return React.useMemo<GroupNaming>(() => {
    if (lens === 'clients') {
      const foldedLabel = t('dash.clients.folded');
      return {
        labelOf: (entry) => (entry.folded ? foldedLabel : clientDisplayName(entry.model, t)),
        markOf: (group) => (
          <span className="model-series-mark model-series-client-mark" aria-hidden="true">
            <ClientMark
              id={group.model}
              category={group.category}
              fallback={<CircleHelp size={16} strokeWidth={1.75} className="model-series-mark-folded" />}
            />
          </span>
        ),
      };
    }
    const foldedLabel = t('dash.models.folded');
    const unnamedLabel = t('dash.models.unnamed');
    return {
      labelOf: (entry) => seriesGroupLabel(entry, foldedLabel, unnamedLabel),
      markOf: (group) => <ModelMark model={group.model} size={16} className="model-series-mark" />,
    };
  }, [lens, t]);
}

/**
 * The shared selection, resolved against the ranking the calling card is drawing.
 *
 * A key that is no longer in the ranking - the grouping changed, the window no longer ranks that
 * model, or it fell out of the fold - is cleared rather than kept: a focus with no matching group
 * would fade every remaining series and leave the reader looking at a dim chart with nothing
 * highlighted. A ranking that has not been read yet proves nothing about the key: a card mounting
 * after the shared read expired must not be what drops a selection the model would keep.
 */
function useSeriesFocus(groups: DashboardModelUsage[], hasRanking: boolean, shown: DashboardModelGrouping): ModelSeriesFocus {
  const { focus, toggleSeries, clearFocus } = useModelPanels();
  const availableKeys = React.useMemo(() => new Set(groups.map(seriesDomainKey)), [groups]);
  const isStale = focus !== null && (focus.grouping !== shown || !availableKeys.has(focus.key));
  React.useEffect(() => {
    if (hasRanking && isStale) clearFocus();
  }, [clearFocus, hasRanking, isStale]);
  const toggle = React.useCallback((key: string) => toggleSeries(shown, key), [shown, toggleSeries]);
  return { focusedKey: isStale ? null : focus?.key ?? null, toggleSeries: toggle, clearFocus };
}

const SeriesName: React.FC<{ group: DashboardModelUsage; naming: GroupNaming }> = ({ group, naming }) => {
  const label = naming.labelOf(group);
  return (
    <span className="model-series-name" data-tip={label} data-tip-overflow="">
      {group.folded ? (
        <Layers size={16} strokeWidth={1.75} className="model-series-mark model-series-mark-folded" aria-hidden="true" />
      ) : (
        naming.markOf(group)
      )}
      <span className="model-series-text">{label}</span>
    </span>
  );
};

export const ModelTrendPanel: React.FC<ModelTrendPanelProps> = React.memo(function ModelTrendPanel({ hasLensTabs = false, ...props }) {
  const t = useT();
  const { theme } = useTheme();
  const { lens } = useModelPanels();
  const { models, shown, shownLens, isPending } = useLensModels(props);
  const naming = useGroupNaming(shownLens);
  const isClients = shownLens === 'clients';
  const title = t('dash.models.trend_title');
  const groups = React.useMemo(() => models.data?.models ?? [], [models.data]);
  const { focusedKey, toggleSeries, clearFocus } = useSeriesFocus(groups, models.data !== undefined, shown);
  const colors = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);

  return (
    <Panel
      className={clsx('dashboard-tile model-trend-card', hasLensTabs && 'has-lens')}
      data-pending={isPending || undefined}
      // The trend takes the lens tabs as its title only while the usage card is off the board.
      title={hasLensTabs ? <ModelLensTabs {...props} /> : <span className="tile-label">{title}</span>}
      // The naming toggle sits here, where the head has room; it refines the model lens only.
      extra={lens === 'clients' ? undefined : <ModelViewToggle />}
    >
      <ModelPanelBody models={models} lens={shownLens} fallback={<ModelTrendPlaceholder hasHeader={false} />}>
        {groups.length === 0 ? (
          <EmptyState size="compact" title={t(isClients ? 'dash.clients.empty' : 'dash.models.empty')} />
        ) : (
          <>
            {/* Keyed by grouping, so a new ranking's names arrive together while a poll keeps them. */}
            <ChartLegend
              key={shown}
              className="model-trend-legend"
              label={title}
              testId="model-trend-legend"
              items={groups.map((group, index) => {
                const key = seriesDomainKey(group);
                return {
                  id: key,
                  color: colors[index],
                  content: <SeriesName group={group} naming={naming} />,
                  title: t(focusedKey === key ? 'dash.models.clear_series_focus' : 'dash.models.focus_series'),
                  isPressed: focusedKey === key,
                  isDimmed: focusedKey !== null && focusedKey !== key,
                  onToggle: () => toggleSeries(key),
                };
              })}
            />
            <React.Suspense fallback={chartFallback}>
              <LazyModelTokenTrend groups={groups} focusedKey={focusedKey} labelOf={naming.labelOf} totalLabel={t('dash.models.total')} tokenUnitLabel={t('dash.unit_tokens')} onFocusGroup={toggleSeries} onClearFocus={clearFocus} />
            </React.Suspense>
          </>
        )}
      </ModelPanelBody>
    </Panel>
  );
});

export const ModelUsagePanel: React.FC<ModelUsagePanelProps> = React.memo(function ModelUsagePanel({ hasViewToggle = false, ...props }) {
  const t = useT();
  const { theme } = useTheme();
  const { modelView, style: tokenStyle } = useTokenDisplayStyle();
  const openPriceEditor = useOpenPriceEditor();
  const { models, shown, shownLens, isPending } = useLensModels(props);
  const naming = useGroupNaming(shownLens);
  const isClients = shownLens === 'clients';
  const lensLabel = t(isClients ? 'dash.models.lens_clients' : 'dash.models.lens_models');
  const coveredFrom = isClients ? models.data?.covered_from : undefined;
  const groups = React.useMemo(() => models.data?.models ?? [], [models.data]);
  const total = models.data?.total_tokens ?? 0;
  const { focusedKey, toggleSeries } = useSeriesFocus(groups, models.data !== undefined, shown);
  const colors = React.useMemo(() => seriesColorRange(theme.palette, groups), [theme.palette, groups]);
  const { lens } = useModelPanels();
  const hasNamingToggle = hasViewToggle && lens === 'models';
  // A pointer over a row or a segment marks that group in the bar and washes its row; only a click
  // dims the rest, and that choice is the one the trend card shares. The mark clears when the pointer
  // leaves the bar or the list, not between two rows, so crossing a row boundary never flickers.
  // Mouse only - a tap is a choice. A choice outranks a passing pointer: while a group is chosen the
  // bar keeps marking it, so reaching for another row on the way to the trend does not unmark it.
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null);
  const markedKey = focusedKey ?? hoveredKey;
  const onHover = (key: string) => (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') setHoveredKey(key);
  };
  const clearHover = () => setHoveredKey(null);

  return (
    <Panel
      className="dashboard-tile model-usage-card has-lens"
      data-pending={isPending || undefined}
      title={<ModelLensTabs {...props} />}
      // Client attribution is kept only as long as the request records, so a client window that
      // reaches past them says where it starts. While the trend card, the naming toggle's usual
      // place, is off the board, the toggle takes the right slot instead.
      extra={hasNamingToggle ? <ModelViewToggle /> : coveredFrom !== undefined ? (
        <span className="model-usage-since">{t('dash.clients.since', { time: dayjs(coveredFrom).format('MM-DD HH:mm') })}</span>
      ) : undefined}
    >
      <ModelPanelBody models={models} lens={shownLens} fallback={<ModelUsagePlaceholder hasHeader={false} />}>
        {groups.length === 0 ? (
          <EmptyState size="compact" title={t(isClients ? 'dash.clients.empty' : 'dash.models.empty')} />
        ) : (
          <>
            {/*
              The card's one drawing: a bar the groups divide between them, so the parts read as parts
              of one total. Everything under it is text. A segment keeps a dot's width at the smallest
              shares, and its colour is the one the trend draws the group in. Segments are keyed by rank,
              so a regrouping re-divides the one bar - each rank keeps its colour and only its width
              moves - instead of replacing it.
            */}
            <div className="model-usage-bar" aria-hidden="true" data-has-mark={markedKey !== null || undefined} onPointerLeave={clearHover}>
              {groups.map((group, index) =>
                group.tokens > 0 ? (
                  <span
                    key={index}
                    className="model-usage-segment"
                    data-marked={markedKey === seriesDomainKey(group) || undefined}
                    style={{ flexGrow: group.tokens, background: colors[index] }}
                    onPointerEnter={onHover(seriesDomainKey(group))}
                    onClick={() => toggleSeries(seriesDomainKey(group))}
                  />
                ) : null,
              )}
            </div>
            {/* Keyed by grouping: a new grouping is a new ranking whose rows arrive together, while a
                poll of the same grouping updates the rows in place. */}
            <ol key={shown} className="model-usage-list" aria-label={lensLabel} data-has-focus={focusedKey !== null || undefined} onPointerLeave={clearHover}>
              {groups.map((group, index) => {
                const key = seriesDomainKey(group);
                const isFocused = focusedKey === key;
                return (
                  // Reading order is name, cost, volume, share - what the group is, what it cost, how
                  // much it moved, and its slice of the window.
                  <li
                    className="model-usage-row"
                    key={key}
                    style={{ '--row-index': index } as React.CSSProperties}
                    data-hovered={hoveredKey === key || undefined}
                    data-focused={isFocused || undefined}
                    onPointerEnter={onHover(key)}
                  >
                    <span className="model-usage-name">
                      <span className="model-usage-key" style={{ background: colors[index] }} aria-hidden="true" />
                      <button type="button" className="model-usage-name-button" aria-pressed={isFocused} onClick={() => toggleSeries(key)}>
                        <SeriesName group={group} naming={naming} />
                      </button>
                    </span>
                    <ModelCost
                      group={group}
                      // Only the model view names what a price is keyed on: a call point may be an alias
                      // whose requests are priced under the upstream model it resolved to.
                      onPrice={openPriceEditor && !isClients && modelView === 'model' && !group.folded && group.model && group.model !== 'unknown' ? () => openPriceEditor(group.model) : undefined}
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
      <Tooltip card={{ notes: [note, t('dash.models.set_price')] }}>
        <button type="button" className={`${className} model-usage-cost-action`} onClick={onPrice} aria-label={`${text}, ${note}. ${t('dash.models.set_price')}`}>
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

const ModelPanelsError: React.FC<{ title: string; message: string; onRetry: () => void }> = ({ title, message, onRetry }) => (
  <LoadFailure className="model-alert" title={title} detail={message} onRetry={onRetry} />
);

export { DASHBOARD_MODELS_QUERY_KEY };
