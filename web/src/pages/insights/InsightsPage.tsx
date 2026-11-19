import React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Select } from '@/components/ui/select';
import { api, apiErrorCode } from '../../api/client';
import { useT } from '../../i18n';
import { useTheme } from '../../theme/ThemeContext';
import { usePreference } from '../../hooks/usePreference';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useViewSearchParams } from '../../hooks/useViewSearchParams';
import { useScrollAnchor } from '../../hooks/useScrollAnchor';
import { useProviderBranding } from '../../hooks/useProviderBranding';
import { createServingProviderResolver } from '../../types/usageEventIdentity';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import dayjs from '../../utils/time';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_BUCKETS,
  INSIGHTS_RANGE_PREFERENCE,
  insightsPollInterval,
  insightsRangeParams,
  parseInsightsRange,
  type InsightsBucketChoice,
  type InsightsRange,
  type InsightsWindow,
} from '../../types/insights';
import { PageHeader } from '../../components/common/PageHeader';
import { Panel } from '../../components/common/Panel';
import { PanelTitle } from '../../components/common/PanelTitle';
import { EmptyState } from '../../components/common/EmptyState';
import { ToolButton } from '../../components/common/ToolButton';
import { ActionMenu } from '../../components/common/ActionMenu';
import { ChartLinesPlaceholder, InsightsSkeleton } from '../../components/common/PageLoading';
import { DownloadOutlined, SwapOutlined } from '../../components/icons';
import { saveBlob } from '../../utils/download';
import { exportFileName } from '../../agent/export';
import { LoadFailure } from '../../components/feedback';
import {
  FOLDED_ID,
  attributeServingProviders,
  baselineMeasures,
  buildFlow,
  comparisonScale,
  cubeMetric,
  decodeInsightsCube,
  filterRows,
  groupBaselines,
  groupSparklines,
  groupTotals,
  isAdditiveMetric,
  isOAuthRow,
  lastActiveBuckets,
  rankGroups,
  sumMeasures,
  tokenAnatomy,
  trendSeries,
  type CubeRow,
  type FlowNode,
  type InsightsDimension,
  type InsightsFilterKey,
  type InsightsFilters,
  type InsightsMetric,
} from '../../types/insightsCube';
import {
  INSIGHTS_GROUPINGS,
  readInsightsView,
  requestFilterValues,
  toggleFilter,
  writeInsightsView,
  type InsightsGrouping,
  type InsightsViewState,
} from './insightsViewState';
import { useInsightsLabels } from '../../hooks/useInsightsLabels';
import { useCompareWindowLabel } from '../../hooks/useCompareWindowLabel';
import { InsightsRangeControl } from './components/InsightsRangeControl';
import { InsightsFilterBar } from './components/InsightsFilterBar';
import { MetricTiles } from './components/MetricTiles';
import { RankingPanel } from './components/RankingPanel';
import { KeyTable } from './components/KeyTable';
import { KeyCompositionPanel } from './components/KeyCompositionPanel';
import { InsightsValue } from './components/InsightsValue';
import { ChartLegend } from '../../components/common/ChartLegend';
import { DeferredPanel } from '../../components/common/DeferredPanel';
import { useIsRouteActive, useIsRoutePollingActive } from '../../performance/routeContract';
import { PanelNarrowing } from './components/PanelNarrowing';
import { RhythmGrid } from './components/RhythmGrid';
import { EntityDetailDrawer, type InsightsEntity } from './components/EntityDetailDrawer';
import { TokenAnatomyStrip } from './components/TokenAnatomyStrip';
import { RollingNumberGroup } from '../../components/dashboard/RollingNumber';
import { ClientAttributionPanel } from './components/ClientAttributionPanel';
import { canDrillUsageEvents, insightsCsv, usageEventsHref, type ExportEntity } from './insightsDrill';
import {
  LazyInsightsFlowChart as InsightsFlowChart,
  LazyInsightsTrendChart as InsightsTrendChart,
} from '../../charts/lazyCharts';
import styles from './insights.module.css';

const TREND_TOP = 5;
const FLOW_TOP = 6;
const HOUR_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The rhythm read's parameters: the request list's filter vocabulary, so the server needs no second one. */
const RHYTHM_PARAMETERS: ReadonlyArray<[Exclude<InsightsDimension, 'provider' | 'credential'>, string]> = [
  ['key', 'api_key'], ['call_point', 'model_alias'], ['model', 'model'],
];

function rhythmParams(
  range: InsightsRange,
  filters: InsightsFilters,
  request: { provider: readonly string[]; credential: readonly string[] },
): string {
  const params = new URLSearchParams(insightsRangeParams(range));
  for (const [dimension, parameter] of RHYTHM_PARAMETERS) {
    for (const value of filters[dimension] ?? []) params.append(parameter, value);
  }
  // The read takes request records; a provider value names the connection, and the credentials that
  // served its rows are how that vocabulary spells one.
  for (const value of request.provider) params.append('provider', value);
  for (const value of request.credential) params.append('auth_index', value);
  for (const value of filters.client ?? []) params.append('client_agent', value);
  return params.toString();
}

/** The cube read: the window, and the client programs the server reads it for. */
function cubeParams(range: InsightsRange, bucket: InsightsBucketChoice, clients: readonly string[] | undefined): string {
  const params = new URLSearchParams(insightsRangeParams(range, bucket));
  for (const value of clients ?? []) params.append('client_agent', value);
  return params.toString();
}

/** A window as the header names it; see the call site for the rules. */
function formatWindowSpan(window: { from: number; to: number; open_end: boolean }, untilNow: string): string {
  const from = dayjs(window.from);
  const to = dayjs(window.to);
  const thisYear = dayjs().year();
  const isWholeDays = from.format('HH:mm') === '00:00' && (window.open_end || to.add(1, 'millisecond').format('HH:mm:ss') === '00:00:00');
  const day = (moment: typeof from) => moment.format(moment.year() === thisYear ? 'MM-DD' : 'YYYY-MM-DD');
  const stamp = (moment: typeof from) => (isWholeDays ? day(moment) : `${day(moment)} ${moment.format('HH:mm')}`);
  if (window.open_end) return `${stamp(from)} – ${untilNow}`;
  if (isWholeDays && from.isSame(to, 'day')) return day(from);
  return `${stamp(from)} – ${isWholeDays || !from.isSame(to, 'day') ? stamp(to) : to.format('HH:mm')}`;
}

function ChartFallback({ height, kind = 'trend' }: { height: number; kind?: 'trend' | 'flow' | 'rhythm' }) {
  return (
    <div className="chart-placeholder" style={{ height }} aria-hidden="true">
      <ChartLinesPlaceholder height={height} kind={kind} />
    </div>
  );
}

/**
 * Insights: the console's analytical page, beside the dashboard's live one.
 *
 * One read per window - the cube, every dimension tuple's usage per bucket - and everything on the
 * page is pivoted from it in the browser, so filtering, regrouping and switching the metric answer on
 * the frame they are asked, and every panel ranks and colours the same snapshot. The window is a stored
 * preference; what the reader narrowed and measured is in the URL, so a view is a link.
 */
export const InsightsPage: React.FC = () => {
  useTimeZone();
  const t = useT();
  const { theme } = useTheme();
  const isPhone = useIsPhoneViewport();
  const isRouteActive = useIsRouteActive();
  const isPollingActive = useIsRoutePollingActive();
  const { modelView } = useTokenDisplayStyle();
  const modelDimension: 'call_point' | 'model' = modelView === 'model' ? 'model' : 'call_point';

  // Each narrowing, regrouping or metric switch is one step of the browser's Back.
  const [search, setSearch] = useViewSearchParams();
  // What the reader asked for, and the view the page is drawn from. A filter, a metric or a grouping
  // reshapes every panel and chart on the page, and drawn in the click's own task that was most of
  // a second before the press itself showed. The page now draws from a deferred copy: the pressed
  // row, tile or segment answers on the next frame, and the panels follow in an interruptible
  // render that a second click can overtake.
  const requestedView = React.useMemo(() => readInsightsView(search), [search]);
  const view = React.useDeferredValue(requestedView);
  const isViewPending = view !== requestedView;
  const setView = React.useCallback((patch: Partial<InsightsViewState>) => {
    setSearch((current) => writeInsightsView({ ...readInsightsView(current), ...patch }));
  }, [setSearch]);
  // A narrowing reshapes the panels above the row it was chosen in; the row stays under the finger.
  const anchorPress = useScrollAnchor(view);

  const { value: range, ready: isRangeReady, loaded: isRangeStored, set: setRange } = usePreference<InsightsRange>(
    INSIGHTS_RANGE_PREFERENCE, DEFAULT_INSIGHTS_RANGE, parseInsightsRange,
  );

  const cubeQueryString = cubeParams(range, requestedView.bucket, requestedView.filters.client);
  const cubeQuery = useQuery({
    queryKey: ['insights-cube', cubeQueryString],
    queryFn: () => api.getInsightsCube(cubeQueryString),
    enabled: isRangeReady,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
  });
  const { configuredProviders, archivedCredentialsByIndex } = useProviderBranding();
  // A provider's own name is the identity of the connection that answered, and the credential that
  // served a row is what says which connection that was: CPA labels an API-key request with its
  // protocol family, which is also the label of that family's OAuth channel.
  const servingProvider = React.useMemo(
    () => createServingProviderResolver(configuredProviders, archivedCredentialsByIndex),
    [configuredProviders, archivedCredentialsByIndex],
  );
  const cube = React.useMemo(() => {
    if (!cubeQuery.data) return undefined;
    return attributeServingProviders(decodeInsightsCube(cubeQuery.data), servingProvider);
  }, [cubeQuery.data, servingProvider]);
  const labels = useInsightsLabels(cube);
  const formatCompareWindow = useCompareWindowLabel();
  const navigate = useNavigate();

  const [openEntity, setOpenEntity] = React.useState<InsightsEntity | null>(null);
  React.useEffect(() => {
    if (!isRouteActive) setOpenEntity((current) => (current !== null ? null : current));
  }, [isRouteActive]);
  const openDetail = React.useCallback((dimension: InsightsDimension, id: string) => setOpenEntity({ dimension, id }), []);
  // The rhythm read filters request records, where a connection is the credentials that served it;
  // the page's provider filter names the connection.
  const requestFilters = React.useMemo(() => requestFilterValues(cube, view.filters), [cube, view.filters]);
  const rhythmQueryString = rhythmParams(range, view.filters, requestFilters);
  const areRequestFiltersReady = isRangeReady && (!(view.filters.provider?.length) || Boolean(cube));
  const rhythmQuery = useQuery({
    queryKey: ['insights-rhythm', rhythmQueryString],
    queryFn: () => api.getInsightsRhythm(rhythmQueryString),
    enabled: areRequestFiltersReady,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
    retry: (count, error) => apiErrorCode(error) !== 'demo_uncaptured' && count < 2,
    meta: { silent: true },
  });
  // Client attribution takes the rhythm read's parameters but its own filter, the way a ranking
  // reads every filter but its own: choosing a client keeps the others listed. A connection's
  // credentials then come from the cube read for every client - the client's own cube holds only
  // the credentials that client used - which is usually the cube read just before the choice.
  const clientsFilters = React.useMemo(() => ({ ...view.filters, client: undefined }), [view.filters]);
  const needsAllClientsCube = Boolean(view.filters.client?.length) && Boolean(view.filters.provider?.length);
  const allClientsCubeString = cubeParams(range, requestedView.bucket, undefined);
  const allClientsCubeQuery = useQuery({
    queryKey: ['insights-cube', allClientsCubeString],
    queryFn: () => api.getInsightsCube(allClientsCubeString),
    enabled: isRangeReady && needsAllClientsCube,
    staleTime: 15_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
  });
  const allClientsCube = React.useMemo(() => {
    if (!needsAllClientsCube) return cube;
    return allClientsCubeQuery.data ? attributeServingProviders(decodeInsightsCube(allClientsCubeQuery.data), servingProvider) : undefined;
  }, [allClientsCubeQuery.data, cube, needsAllClientsCube, servingProvider]);
  // A failed read of the connection's credentials outlives a later read that no longer needs it.
  const allClientsCubeError = needsAllClientsCube ? allClientsCubeQuery.error : null;
  const clientsRequestFilters = React.useMemo(() => requestFilterValues(allClientsCube, clientsFilters), [allClientsCube, clientsFilters]);
  const clientsQueryString = rhythmParams(range, clientsFilters, clientsRequestFilters);
  const areClientFiltersReady = isRangeReady && (!(view.filters.provider?.length) || Boolean(allClientsCube));
  const clientsQuery = useQuery({
    queryKey: ['insights-clients', clientsQueryString],
    queryFn: () => api.getInsightsClients(clientsQueryString),
    enabled: areClientFiltersReady,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: isPollingActive,
    refetchInterval: (query) => (isPollingActive ? insightsPollInterval(query.state.data?.window) : false),
    retry: (count, error) => apiErrorCode(error) !== 'demo_uncaptured' && count < 2,
    meta: { silent: true },
  });
  const drawerFilters = React.useMemo(
    () => (openEntity ? { ...view.filters, [openEntity.dimension]: [openEntity.id] } : null),
    [openEntity, view.filters],
  );
  const drawerRhythmString = drawerFilters ? rhythmParams(range, drawerFilters, requestFilterValues(cube, drawerFilters)) : '';
  const drawerRhythmQuery = useQuery({
    queryKey: ['insights-rhythm', drawerRhythmString],
    queryFn: () => api.getInsightsRhythm(drawerRhythmString),
    enabled: isRouteActive && isRangeReady && openEntity !== null,
    staleTime: 60_000,
    retry: (count, error) => apiErrorCode(error) !== 'demo_uncaptured' && count < 2,
    meta: { silent: true },
  });

  // When a cached Insights slot resumes after being parked off-screen, revalidate stale cube and
  // rhythm snapshots (including closed calendar presets whose server-resolved bounds cross midnight,
  // where `refetchOnWindowFocus` was suppressed while the route was inactive).
  const wasRouteActiveRef = React.useRef(isRouteActive);
  React.useEffect(() => {
    const becameActive = isRouteActive && !wasRouteActiveRef.current;
    wasRouteActiveRef.current = isRouteActive;
    if (!becameActive || !isRangeReady) return;
    if (cubeQuery.isStale && !cubeQuery.isFetching) {
      void cubeQuery.refetch();
    }
    if (needsAllClientsCube && allClientsCubeQuery.isStale && !allClientsCubeQuery.isFetching) {
      void allClientsCubeQuery.refetch();
    }
    if (areRequestFiltersReady && rhythmQuery.isStale && !rhythmQuery.isFetching) {
      void rhythmQuery.refetch();
    }
    if (areClientFiltersReady && clientsQuery.isStale && !clientsQuery.isFetching) {
      void clientsQuery.refetch();
    }
  }, [
    isRouteActive,
    isRangeReady,
    areRequestFiltersReady,
    areClientFiltersReady,
    cubeQuery.isStale,
    cubeQuery.isFetching,
    cubeQuery.refetch,
    needsAllClientsCube,
    allClientsCubeQuery.isStale,
    allClientsCubeQuery.isFetching,
    allClientsCubeQuery.refetch,
    rhythmQuery.isStale,
    rhythmQuery.isFetching,
    rhythmQuery.refetch,
    clientsQuery.isStale,
    clientsQuery.isFetching,
    clientsQuery.refetch,
  ]);

  // The token metric is read in the page's scope; every projection sums the rows it already sums.
  const metric = cubeMetric(view.metric, view.tokenScope);
  const isLineMetric = !isAdditiveMetric(metric);
  const [selectedTrendIds, setSelectedTrendIds] = React.useState<string[]>([]);
  const rows = React.useMemo(() => (cube ? filterRows(cube, cube.rows, view.filters) : []), [cube, view.filters]);
  const previousRows = React.useMemo(() => (cube ? filterRows(cube, cube.previous, view.filters) : []), [cube, view.filters]);
  const isComparing = view.isComparing && Boolean(cube?.compare);
  const current = React.useMemo(() => sumMeasures(rows), [rows]);
  const anatomy = React.useMemo(() => tokenAnatomy(current), [current]);
  const scale = React.useMemo(() => (cube ? comparisonScale(cube) : 1), [cube]);
  // The comparison baseline is derived from the full previous period's sub-buckets using an
  // outlier-robust mean scaled to the current window's elapsed duration.
  const baseline = React.useMemo(() => {
    if (!isComparing || !cube?.compare) return null;
    const result = baselineMeasures(previousRows, scale);
    return { measures: result.baseline, raw: result.raw, window: cube.compare };
  }, [cube, isComparing, previousRows, scale]);

  const rank = React.useCallback((dimension: InsightsDimension) => {
    if (!cube) return [];
    const prevGroup = isComparing ? groupBaselines(cube, previousRows, dimension, scale) : undefined;
    return rankGroups(groupTotals(cube, rows, dimension), metric, prevGroup?.baseline, prevGroup?.raw);
  }, [cube, isComparing, metric, previousRows, rows, scale]);
  // A ranking panel reads every filter but its own, the way the filter picker counts: choosing a model
  // keeps the other models listed, stepped back, so the narrowing is visible where it was made. The
  // dashboard's split applies on top - a request served through an OAuth sign-in is credited to that
  // credential, any other to its AI provider - so the two panels never name the same traffic twice.
  const rankPanel = React.useCallback((dimension: InsightsDimension, admits?: (row: CubeRow) => boolean) => {
    if (!cube) return [];
    const pick = (source: readonly CubeRow[]) => {
      const narrowed = filterRows(cube, source, view.filters, dimension);
      return admits ? narrowed.filter(admits) : narrowed;
    };
    const prevGroup = isComparing ? groupBaselines(cube, pick(cube.previous), dimension, scale) : undefined;
    return rankGroups(groupTotals(cube, pick(cube.rows), dimension), metric, prevGroup?.baseline, prevGroup?.raw);
  }, [cube, isComparing, metric, scale, view.filters]);
  const rankings = React.useMemo(() => ({
    key: rank('key'),
    model: rank(modelDimension),
  }), [modelDimension, rank]);
  const panels = React.useMemo(() => ({
    key: rankPanel('key'),
    model: rankPanel(modelDimension),
    provider: cube ? rankPanel('provider', (row) => !isOAuthRow(cube, row)) : [],
    credential: cube ? rankPanel('credential', (row) => isOAuthRow(cube, row)) : [],
  }), [cube, modelDimension, rankPanel]);

  const groupingDimension: InsightsDimension | null = view.grouping === 'none'
    ? null
    : view.grouping === 'model' ? modelDimension : view.grouping;
  React.useEffect(() => { setSelectedTrendIds([]); }, [groupingDimension, metric, view.filters]);
  // The trend stacks every request, so it ranks its groups over all of them rather than over a panel's half.
  const trendIds = React.useMemo(() => {
    if (!groupingDimension) return [];
    const ranked = groupingDimension === modelDimension ? rankings.model : groupingDimension === 'key' ? rankings.key : rank(groupingDimension);
    return ranked.map((group) => group.id);
  }, [groupingDimension, modelDimension, rank, rankings]);
  const trendTop = React.useMemo(() => trendIds.slice(0, TREND_TOP), [trendIds]);
  const trendAll = React.useMemo(
    () => (cube ? trendSeries(cube, rows, metric, groupingDimension, trendTop) : []),
    [cube, groupingDimension, metric, rows, trendTop],
  );
  // Latency over unlike groups has no stable "Others" reading, so a line view plots only named groups.
  const trend = React.useMemo(
    () => (isLineMetric ? trendAll.filter((group) => !group.folded) : trendAll),
    [isLineMetric, trendAll],
  );
  const trendTooltipAll = React.useMemo(
    () => (cube && isAdditiveMetric(metric) && trendIds.length > TREND_TOP
      ? trendSeries(cube, rows, metric, groupingDimension, trendIds)
      : trend),
    [cube, groupingDimension, metric, rows, trend, trendIds],
  );
  const visibleTrend = React.useMemo(
    () => (selectedTrendIds.length === 0 ? trend : trend.filter((group) => selectedTrendIds.includes(group.id))),
    [selectedTrendIds, trend],
  );
  const visibleTrendTooltip = React.useMemo(
    () => (selectedTrendIds.length === 0 ? trendTooltipAll : trendTooltipAll.filter((group) => selectedTrendIds.includes(group.id))),
    [selectedTrendIds, trendTooltipAll],
  );
  React.useEffect(() => {
    const available = new Set(trend.map((group) => group.id));
    setSelectedTrendIds((current) => {
      const next = current.filter((id) => available.has(id));
      return next.length === current.length ? current : next;
    });
  }, [trend]);
  const trendTotal = React.useMemo(
    () => (cube ? trendSeries(cube, rows, metric, null, [])[0] : undefined),
    [cube, metric, rows],
  );
  const trendTotals = React.useMemo(() => {
    if (!trendTotal) return [];
    if (!isAdditiveMetric(metric) || selectedTrendIds.length === 0) return trendTotal.values;
    // A stack is its visible parts: a narrowed bar chart must not label the stack with hidden groups.
    return trendTotal.values.map((_, index) => visibleTrend.reduce((sum, group) => sum + (group.values[index] ?? 0), 0));
  }, [isAdditiveMetric, metric, selectedTrendIds, trendTotal, visibleTrend]);
  const trendTotalSamples = trendTotal?.samples ?? [];
  const trendColor = React.useCallback((id: string) => {
    if (groupingDimension === null) return theme.palette.series[0];
    if (id === FOLDED_ID) return theme.palette.muted;
    const index = trendTop.indexOf(id);
    return index < 0 ? theme.palette.muted : theme.palette.series[index % theme.palette.series.length];
  }, [groupingDimension, theme.palette, trendTop]);
  const trendLabel = React.useCallback((id: string) => {
    if (groupingDimension === null) return t(`insights.metric.${metric}`);
    return labels.label(groupingDimension, id);
  }, [groupingDimension, labels, metric, t]);
  const groupedColor = React.useCallback(
    (dimension: InsightsDimension) => (groupingDimension === dimension
      ? (id: string) => (trendTop.includes(id) ? trendColor(id) : undefined)
      : undefined),
    [groupingDimension, trendColor, trendTop],
  );

  const selectFilter = React.useCallback((dimension: InsightsDimension, id: string) => {
    if (id === FOLDED_ID) return;
    setView({ filters: toggleFilter(requestedView.filters, dimension, id) });
  }, [setView, requestedView.filters]);
  const toggleTrendGroup = React.useCallback((id: string) => {
    setSelectedTrendIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);
  const clearFilter = React.useCallback((dimension: InsightsFilterKey) => {
    const next = { ...requestedView.filters };
    delete next[dimension];
    setView({ filters: next });
  }, [setView, requestedView.filters]);
  const selectTrendGroup = React.useCallback((id: string | null) => {
    setSelectedTrendIds(id === null ? [] : [id]);
  }, []);

  const brush = React.useCallback((fromIndex: number, toIndex: number) => {
    if (!cube) return;
    const starts = cube.bucketStarts;
    const from = Math.max(starts[fromIndex] ?? cube.window.from, cube.window.from);
    const isThroughNow = cube.window.open_end && toIndex >= starts.length - 1;
    const to = Math.min((starts[toIndex + 1] ?? cube.window.to + 1) - 1, cube.window.to);
    void setRange({ from, to: isThroughNow ? null : to });
  }, [cube, setRange]);

  // Like the rankings, the flow and the composition read every filter but their own dimensions, so a
  // choice made on them steps the rest back instead of collapsing the figure it was made on.
  const flowDimensions = React.useMemo(() => ['key', modelDimension, 'provider'] as InsightsDimension[], [modelDimension]);
  const flow = React.useMemo(
    () => (cube && !isPhone ? buildFlow(cube, filterRows(cube, cube.rows, view.filters, flowDimensions), flowDimensions, metric, FLOW_TOP) : null),
    [cube, flowDimensions, isPhone, metric, view.filters],
  );
  const isFlowNarrowed = flowDimensions.some((dimension) => (view.filters[dimension]?.length ?? 0) > 0);
  const flowDimmed = React.useCallback((node: FlowNode) => {
    const selected = view.filters[node.dimension] ?? [];
    return selected.length > 0 && (node.folded || !selected.includes(node.value));
  }, [view.filters]);
  const compositionRows = React.useMemo(
    () => (cube ? filterRows(cube, cube.rows, view.filters, ['key', modelDimension]) : []),
    [cube, modelDimension, view.filters],
  );
  const flowColor = React.useCallback((node: FlowNode) => {
    if (node.folded) return theme.palette.border;
    if (node.level > 0) return theme.palette.muted;
    const index = rankings.key.findIndex((group) => group.id === node.value);
    return theme.palette.series[Math.max(0, index) % theme.palette.series.length];
  }, [rankings.key, theme.palette]);
  const flowLabel = React.useCallback((node: FlowNode) => labels.label(node.dimension, node.folded ? FOLDED_ID : node.value), [labels]);

  const sparklines = React.useMemo(() => (cube ? groupSparklines(cube, rows, 'key', metric) : new Map<string, number[]>()), [cube, metric, rows]);
  const lastActive = React.useMemo(() => (cube ? lastActiveBuckets(cube, rows, 'key') : new Map<string, number>()), [cube, rows]);
  const clientKeys = React.useMemo(() => rankings.key.filter((group) => !labels.isNonKey(group.id)), [labels, rankings.key]);

  const eventsHref = React.useCallback(
    (filters: InsightsFilters, clientAgent?: string, window?: InsightsWindow) => (cube ? usageEventsHref(cube, filters, clientAgent, window) : '/usage/events'),
    [cube],
  );
  const exportCsv = React.useCallback(() => {
    if (!cube) return;
    const entities: ExportEntity[] = [];
    const add = (dimension: InsightsDimension) => {
      for (const group of rankGroups(groupTotals(cube, rows, dimension), 'requests')) {
        entities.push({
          dimension: t(`insights.dim.${dimension}`),
          name: labels.label(dimension, group.id),
          detail: labels.detail(dimension, group.id) ?? '',
          measures: group.measures,
          anatomy: tokenAnatomy(group.measures),
        });
      }
    };
    add(modelDimension);
    add('key');
    const header = [
      t('insights.csv.dimension'), t('insights.csv.name'), t('insights.csv.detail'), t('insights.metric.requests'), t('insights.csv.failures'),
      t('insights.anatomy.uncached_input'), t('insights.anatomy.cache_read'), t('insights.anatomy.cache_write'),
      t('insights.anatomy.regular_output'), t('insights.anatomy.reasoning'), t('insights.metric.tokens'), t('insights.anatomy.net_tokens'),
      t('insights.csv.cache_rate'), t('insights.csv.ttft_ms'), t('insights.csv.latency_ms'), t('insights.csv.cost_usd'),
    ];
    saveBlob(new Blob([insightsCsv(header, entities)], { type: 'text/csv;charset=utf-8' }), exportFileName('omc-insights', 'csv', new Date()));
  }, [cube, rows, labels, modelDimension, t]);

  const shownWindow = cube?.window;
  const isHourAllowed = !shownWindow || shownWindow.to - shownWindow.from <= HOUR_LIMIT_MS;
  const rhythmMeasure = metric === 'cost' ? 'cost' : metric === 'requests' || metric === 'latency' ? 'requests' : 'tokens';
  // The span in the fewest characters that still name it: no year inside the current one, no clock
  // on a window that starts and ends on day boundaries. The exact instants and the deployment's zone
  // are the hover, so the line under the title stays a reading rather than a timestamp dump.
  const subtitle = shownWindow ? (
    <span className={styles['window-span']} data-tip={`${dayjs(shownWindow.from).format('YYYY-MM-DD HH:mm')} – ${shownWindow.open_end ? t('dash.range.until_now') : dayjs(shownWindow.to).format('YYYY-MM-DD HH:mm')} (${shownWindow.timezone})`}>
      {formatWindowSpan(shownWindow, t('dash.range.until_now'))}
    </span>
  ) : t('dash.loading');

  // How finely the trend is cut. It belongs to the chart, not to the window: the window says which
  // days are read, this says whether each bar is an hour, a day, a week or a month of them. "Auto"
  // names what it resolved to, so the choice is never a mystery setting.
  const bucketControl = (
    <Select
      size="small"
      variant={isPhone ? 'borderless' : undefined}
      className={styles['bucket-control']}
      value={requestedView.bucket}
      // A phone has one line for the title and both controls, so "Auto" shows only what it resolved to.
      labelRender={isPhone && view.bucket === 'auto' && shownWindow ? () => t(`insights.bucket.${shownWindow.bucket}`) : undefined}
      aria-label={t('insights.bucket_label')}
      popupMatchSelectWidth={false}
      options={INSIGHTS_BUCKETS.map((bucket) => ({
        value: bucket,
        label: bucket === 'auto' && shownWindow
          ? t('insights.bucket.auto_resolved', { bucket: t(`insights.bucket.${shownWindow.bucket}`) })
          : t(`insights.bucket.${bucket}`),
        disabled: bucket === 'hour' && !isHourAllowed,
        title: bucket === 'hour' && !isHourAllowed ? t('insights.bucket.hour_limit') : undefined,
      }))}
      onChange={(next: InsightsBucketChoice) => setView({ bucket: next })}
    />
  );
  const compareButton = (
    <ToolButton
      icon={<SwapOutlined />}
      label={t(requestedView.isComparing ? 'insights.compare_off' : 'insights.compare_on')}
      variant={requestedView.isComparing ? 'active' : 'secondary'}
      aria-pressed={requestedView.isComparing}
      disabled={!cube?.compare}
      onClick={() => setView({ isComparing: !requestedView.isComparing })}
      data-testid="insights-compare"
    />
  );

  const exportButton = (
    <ToolButton
      icon={<DownloadOutlined />}
      label={t('insights.export_csv')}
      disabled={!cube || rows.length === 0}
      onClick={exportCsv}
      data-testid="insights-export"
    />
  );

  const header = (
    <PageHeader
      className={styles['head']}
      title={t('nav.insights')}
      subtitle={subtitle}
      actions={(
        <>
          <InsightsRangeControl range={range} onChange={(next) => void setRange(next)} isDisabled={!isRangeStored} />
          {compareButton}
          {exportButton}
        </>
      )}
      mobileActions={(
        <>
          <InsightsRangeControl range={range} onChange={(next) => void setRange(next)} isDisabled={!isRangeStored} />
          <ActionMenu>
            {compareButton}
            {exportButton}
          </ActionMenu>
        </>
      )}
    />
  );

  if (!cube) {
    if (cubeQuery.isError) {
      return (
        <div className={`terminal-page ${styles['page']}`}>
          {header}
          <LoadFailure
            title={t('insights.error_title')}
            error={cubeQuery.error}
            onRetry={() => void cubeQuery.refetch()}
          />
        </div>
      );
    }
    return (
      <div className={`terminal-page ${styles['page']}`}>
        {header}
        <InsightsSkeleton hasHeader={false} />
      </div>
    );
  }

  const isEmpty = cube.rows.length === 0;
  const rankingLimit = isPhone ? 5 : 8;
  const metricName = t(`insights.metric.${metric}`);
  const clientPanel = (
    <ClientAttributionPanel
      // A ranking kept from the previous filters would read under credentials that could not be
      // resolved for these, so the failure replaces it rather than sitting behind it.
      data={allClientsCubeError ? undefined : clientsQuery.data}
      metric={metric}
      isLoading={clientsQuery.isLoading || allClientsCubeQuery.isLoading}
      isUncaptured={apiErrorCode(clientsQuery.error) === 'demo_uncaptured'}
      // The ranking cannot be read until the connection's credentials are, so their failure is its own.
      error={allClientsCubeError ?? clientsQuery.error}
      onRetry={() => void (allClientsCubeError ? allClientsCubeQuery.refetch() : clientsQuery.refetch())}
      // Either read still on the previous window or filters would build a link from mismatched halves.
      isPlaceholder={clientsQuery.isPlaceholderData || cubeQuery.isPlaceholderData}
      limit={rankingLimit}
      // A client's link reads like the ranking does: under every filter but the client, with the
      // connection spelled as all of its credentials.
      canViewRequests={allClientsCube ? canDrillUsageEvents(allClientsCube, clientsFilters) : false}
      hrefFor={(clientAgent) => (allClientsCube ? usageEventsHref(allClientsCube, clientsFilters, clientAgent, clientsQuery.data?.window) : '/usage/events')}
      onNavigate={navigate}
      selected={requestedView.filters.client ?? []}
      onSelect={(clientAgent) => setView({ filters: toggleFilter(requestedView.filters, 'client', clientAgent) })}
      onClear={() => clearFilter('client')}
    />
  );
  const groupingOptions = INSIGHTS_GROUPINGS.map((grouping) => ({ value: grouping, label: t(`insights.group.${grouping}`) }));

  return (
    <div className={`terminal-page ${styles['page']}`} data-testid="insights-page" aria-busy={isViewPending || undefined} onPointerDownCapture={anchorPress}>
      {header}
      <InsightsFilterBar
        cube={cube}
        filters={requestedView.filters}
        labels={labels}
        modelDimension={modelDimension}
        clients={clientsQuery.data?.clients}
        onChange={(filters) => setView({ filters })}
        onOpen={openDetail}
        onViewRequests={() => navigate(eventsHref(requestedView.filters))}
        canViewRequests={cube ? canDrillUsageEvents(cube, requestedView.filters) : false}
      />
      {cubeQuery.isError && (
        <LoadFailure
          tone="warning"
          title={t('insights.error_title')}
          error={cubeQuery.error}
          onRetry={() => void cubeQuery.refetch()}
        />
      )}
      {/* One group, so a filter that moves the headline figures and the token parts rolls them as
          one sweep with a single measurement, rather than one per readout. The tiles switch what the
          trend plots, so the trend sits right under them and the token parts follow it. */}
      <RollingNumberGroup>
        <MetricTiles current={current} baseline={baseline} metric={requestedView.metric} tokenScope={view.tokenScope} onMetricChange={(next: InsightsMetric) => setView({ metric: next })} />
        <Panel
          className={styles['trend-panel']}
          title={(
            <PanelTitle
              extra={(
                <>
                  <Select
                    size="small"
                    variant={isPhone ? 'borderless' : undefined}
                    className={styles['grouping-select']}
                    value={requestedView.grouping}
                    options={groupingOptions}
                    onChange={(grouping: InsightsGrouping) => setView({ grouping })}
                    aria-label={t('insights.group_label')}
                    popupMatchSelectWidth={false}
                  />
                  {bucketControl}
                </>
              )}
            >
              {t('insights.trend_label', { metric: metricName })}
            </PanelTitle>
          )}
        >
          {isEmpty ? (
            <EmptyState size="compact" title={t('insights.no_usage')} description={t('insights.no_usage_hint')} />
          ) : (
            <>
            {groupingDimension && (
              <ChartLegend
                label={t('insights.group_label')}
                testId="insights-trend-legend"
                items={[
                  ...trend.map((group) => ({
                    id: group.id,
                    color: trendColor(group.id),
                    content: group.folded
                      ? <span>{t('insights.folded')}</span>
                      : <InsightsValue dimension={groupingDimension} id={group.id} labels={labels} />,
                    // The legend chooses which series the chart draws; it never filters the page.
                    isPressed: selectedTrendIds.includes(group.id),
                    isDimmed: selectedTrendIds.length > 0 && !selectedTrendIds.includes(group.id),
                    onToggle: () => toggleTrendGroup(group.id),
                  })),
                  ...(isLineMetric && trend.length > 1
                    ? [{ id: '\u0000total', isDashed: true, content: <span>{t('insights.total')}</span>, testId: 'insights-legend-total' }]
                    : []),
                ]}
              />
            )}
            <React.Suspense fallback={<ChartFallback height={280} />}>
              <InsightsTrendChart
                bucketStarts={cube.bucketStarts}
                bucket={cube.window.bucket}
                groupingDimension={groupingDimension}
                groups={visibleTrend}
                tooltipGroups={visibleTrendTooltip}
                totals={trendTotals}
                totalSamples={trendTotalSamples}
                showTotal={isLineMetric && trend.length > 1}
                onSelectGroup={selectTrendGroup}
                colorOf={trendColor}
                labelOf={trendLabel}
                metric={metric}
                totalLabel={t('insights.total')}
                label={t('insights.trend_label', { metric: metricName })}
                onBrush={isPhone ? undefined : brush}
                height={isPhone ? 220 : 280}
              />
            </React.Suspense>
            </>
          )}
        </Panel>
        {!isEmpty && (
          <TokenAnatomyStrip
            anatomy={anatomy}
            scope={requestedView.tokenScope}
            onScopeChange={(tokenScope) => setView({ tokenScope })}
            testId="insights-anatomy"
          />
        )}
      </RollingNumberGroup>
      {/* Every ranking keeps its place whatever the window holds, so a reader's eye goes back to where
          a panel was. The models and the programs that called them, the two most read, share the wide
          first row; keys, providers and credentials share the next. Only the width rearranges them. */}
      <div className={styles['rankings']}>
        <RankingPanel dimension={modelDimension} title={t(`insights.dim.${modelDimension}`)} groups={panels.model} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor(modelDimension)} selected={requestedView.filters[modelDimension] ?? []} onSelect={selectFilter} onClear={clearFilter} onOpen={openDetail} limit={rankingLimit} testId="insights-ranking-model" />
        {clientPanel}
        <RankingPanel dimension="key" title={t('insights.dim.key')} groups={panels.key} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor('key')} selected={requestedView.filters.key ?? []} onSelect={selectFilter} onClear={clearFilter} onOpen={openDetail} limit={rankingLimit} testId="insights-ranking-key" />
        <RankingPanel dimension="provider" title={t('insights.ranking.provider')} groups={panels.provider} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor('provider')} selected={requestedView.filters.provider ?? []} onSelect={selectFilter} onClear={clearFilter} onOpen={openDetail} limit={rankingLimit} testId="insights-ranking-provider" />
        <RankingPanel dimension="credential" title={t('insights.ranking.credential')} groups={panels.credential} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor('credential')} selected={requestedView.filters.credential ?? []} onSelect={selectFilter} onClear={clearFilter} onOpen={openDetail} limit={rankingLimit} testId="insights-ranking-credential" />
      </div>
      {/* On a phone the key ranking above already lists every key and opens its detail; the table
          would repeat it as a column of label rows. */}
      {!isPhone && (
      <Panel
        className={styles['table-panel']}
        data-testid="insights-keys"
        title={<PanelTitle extra={<span className={styles['panel-meta']}>{t('insights.key_count', { n: clientKeys.length })}</span>}>{t('insights.keys_title')}</PanelTitle>}
      >
        <KeyTable groups={rankings.key} sparklines={sparklines} lastActive={lastActive} metric={metric} labels={labels} compare={baseline?.window} isLoading={cubeQuery.isLoading} onOpen={(id) => openDetail('key', id)} />
      </Panel>
      )}
      {/* Opens on the per-model load profile on both desktop and phone; desktop also switches to
          the key-by-model composition chart and matrix, phone switches between profile and matrix. */}
      {(
        <DeferredPanel
          priority="p1"
          fallback={<Panel className={styles['trend-panel']}><ChartFallback height={280} /></Panel>}
        >
          <KeyCompositionPanel
            cube={cube}
            rows={compositionRows}
            columnDimension={modelDimension}
            metric={metric}
            labels={labels}
            filters={view.filters}
            isPhone={isPhone}
            selectedKeys={view.filters.key ?? []}
            selectedColumns={view.filters[modelDimension] ?? []}
            onSelect={(keyId, columnId) => {
              const isSame = (requestedView.filters.key ?? []).join() === keyId
                && (requestedView.filters[modelDimension] ?? []).join() === (columnId ?? '');
              const next = { ...requestedView.filters };
              delete next.key;
              delete next[modelDimension];
              // Choosing the segment already chosen takes it back, as a ranking row does.
              setView({ filters: isSame ? next : { ...next, key: [keyId], ...(columnId === null ? {} : { [modelDimension]: [columnId] }) } });
            }}
            onSelectColumn={(columnId) => selectFilter(modelDimension, columnId)}
            onOpenColumn={(columnId) => openDetail(modelDimension, columnId)}
            onClearColumns={() => clearFilter(modelDimension)}
            onClear={() => {
              const next = { ...requestedView.filters };
              delete next.key;
              delete next[modelDimension];
              setView({ filters: next });
            }}
          />
        </DeferredPanel>
      )}
      {/* A flow needs its three columns to say anything; a phone gets the rankings above instead. */}
      {flow && flow.links.length > 0 && (
        <DeferredPanel
          priority="p2"
          fallback={<Panel className={styles['trend-panel']}><ChartFallback height={320} kind="flow" /></Panel>}
        >
          <Panel
            data-testid="insights-flow"
            title={(
              <PanelTitle
                extra={(
                  <PanelNarrowing
                    count={flowDimensions.reduce((sum, dimension) => sum + (view.filters[dimension]?.length ?? 0), 0)}
                    unit={t(`insights.metric.${isAdditiveMetric(metric) ? metric : 'requests'}`)}
                    onClear={() => {
                      const next = { ...requestedView.filters };
                      for (const dimension of flowDimensions) delete next[dimension];
                      setView({ filters: next });
                    }}
                  />
                )}
              >
                {t('insights.flow_title')}
              </PanelTitle>
            )}
          >
            <React.Suspense fallback={<ChartFallback height={320} kind="flow" />}>
              <InsightsFlowChart
                nodes={flow.nodes}
                links={flow.links}
                metric={isAdditiveMetric(metric) ? metric : 'requests'}
                colorOf={flowColor}
                labelOf={flowLabel}
                isDimmed={isFlowNarrowed ? flowDimmed : undefined}
                onSelect={selectFilter}
                label={t('insights.flow_title')}
              />
            </React.Suspense>
          </Panel>
        </DeferredPanel>
      )}
      <DeferredPanel
        priority="p2"
        fallback={<Panel className={styles['trend-panel']}><ChartFallback height={220} kind="rhythm" /></Panel>}
      >
        <RhythmGrid
          data={rhythmQuery.data}
          measure={rhythmMeasure}
          tokenScope={view.tokenScope}
          isLoading={rhythmQuery.isLoading}
          error={rhythmQuery.error}
          onRetry={() => void rhythmQuery.refetch()}
          isUncaptured={apiErrorCode(rhythmQuery.error) === 'demo_uncaptured'}
        />
      </DeferredPanel>
      <div className={styles['footnote']}>
        {cube.window.widened && <span>{t('insights.widened')}</span>}
        {cube.window.clipped && <span>{t('insights.client_clipped')}</span>}
        {baseline && <span>{formatCompareWindow(baseline.window)}</span>}
        {current.requests > 0 && current.costedRequests < current.requests && (
          <span>{t('insights.cost_partial', { n: Math.round((current.costedRequests / current.requests) * 100) })}</span>
        )}
        {cube.window.to - cube.window.from > 400 * DAY_MS && <span>{t('insights.long_window')}</span>}
      </div>
      <EntityDetailDrawer
        cube={cube}
        tokenScope={view.tokenScope}
        entity={openEntity}
        filters={view.filters}
        metric={metric}
        modelDimension={modelDimension}
        labels={labels}
        rhythm={drawerRhythmQuery.data}
        isRhythmLoading={drawerRhythmQuery.isLoading}
        isRhythmUncaptured={apiErrorCode(drawerRhythmQuery.error) === 'demo_uncaptured'}
        rhythmError={drawerRhythmQuery.error}
        onRhythmRetry={() => void drawerRhythmQuery.refetch()}
        onClose={() => setOpenEntity(null)}
        onFilter={(entity) => {
          setOpenEntity(null);
          setView({ filters: { ...requestedView.filters, [entity.dimension]: [entity.id] } });
        }}
        canViewRequests={(entity) => canDrillUsageEvents(cube, { ...view.filters, [entity.dimension]: [entity.id] })}
        onViewRequests={(entity) => {
          setOpenEntity(null);
          navigate(eventsHref({ ...view.filters, [entity.dimension]: [entity.id] }));
        }}
      />
    </div>
  );
};

export default InsightsPage;
