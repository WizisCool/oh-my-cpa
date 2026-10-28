import React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Select } from 'antd';
import { api, apiErrorCode } from '../../api/client';
import { useT } from '../../i18n';
import { useTheme } from '../../theme/ThemeContext';
import { usePreference } from '../../hooks/usePreference';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useViewSearchParams } from '../../hooks/useViewSearchParams';
import { useScrollAnchor } from '../../hooks/useScrollAnchor';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import dayjs from '../../utils/time';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_BUCKETS,
  INSIGHTS_RANGE_PREFERENCE,
  comparesSameStretch,
  insightsPollInterval,
  insightsRangeParams,
  parseInsightsRange,
  type InsightsBucketChoice,
  type InsightsRange,
} from '../../types/insights';
import { PageHeader } from '../../components/common/PageHeader';
import { Panel } from '../../components/common/Panel';
import { PanelTitle } from '../../components/common/PanelTitle';
import { EmptyState } from '../../components/common/EmptyState';
import { ToolButton } from '../../components/common/ToolButton';
import { RefreshButton } from '../../components/common/RefreshButton';
import { ActionMenu } from '../../components/common/ActionMenu';
import { LoadingRegion, Placeholder } from '../../components/common/Placeholder';
import { SwapOutlined } from '../../components/icons';
import { LoadFailure } from '../../components/feedback';
import {
  FOLDED_ID,
  buildFlow,
  decodeInsightsCube,
  filterRows,
  groupSparklines,
  groupTotals,
  isAdditiveMetric,
  isOAuthRow,
  lastActiveBuckets,
  rankGroups,
  sumMeasures,
  trendSeries,
  type CubeRow,
  type FlowNode,
  type InsightsDimension,
  type InsightsFilters,
  type InsightsMetric,
} from './insightsCube';
import {
  INSIGHTS_GROUPINGS,
  readInsightsView,
  toggleFilter,
  writeInsightsView,
  type InsightsGrouping,
  type InsightsViewState,
} from './insightsViewState';
import { useInsightsLabels } from './useInsightsLabels';
import { useCompareWindowLabel } from './useCompareWindowLabel';
import { InsightsRangeControl } from './components/InsightsRangeControl';
import { InsightsFilterBar } from './components/InsightsFilterBar';
import { MetricTiles } from './components/MetricTiles';
import { RankingPanel } from './components/RankingPanel';
import { KeyTable } from './components/KeyTable';
import { KeyCompositionPanel } from './components/KeyCompositionPanel';
import { InsightsValue } from './components/InsightsValue';
import { ChartLegend } from '../../components/common/ChartLegend';
import { PanelNarrowing } from './components/PanelNarrowing';
import { RhythmGrid } from './components/RhythmGrid';
import { KeyDetailDrawer } from './components/KeyDetailDrawer';
import styles from './insights.module.css';

const InsightsTrendChart = React.lazy(() => import('./charts/InsightsTrendChart'));
const InsightsFlowChart = React.lazy(() => import('./charts/InsightsFlowChart'));

const TREND_TOP = 5;
const FLOW_TOP = 6;
const HOUR_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The rhythm read's parameters: the request list's filter vocabulary, so the server needs no second one. */
const RHYTHM_PARAMETERS: Record<InsightsDimension, string> = {
  key: 'api_key', call_point: 'model_alias', model: 'model', provider: 'provider', credential: 'auth_index',
};

function rhythmParams(range: InsightsRange, filters: InsightsFilters): string {
  const params = new URLSearchParams(insightsRangeParams(range));
  for (const [dimension, parameter] of Object.entries(RHYTHM_PARAMETERS) as Array<[InsightsDimension, string]>) {
    for (const value of filters[dimension] ?? []) params.append(parameter, value);
  }
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

function ChartFallback({ height }: { height: number }) {
  return <div className="chart-placeholder" style={{ height }} aria-hidden="true" />;
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
  const { modelView } = useTokenDisplayStyle();
  const modelDimension: 'call_point' | 'model' = modelView === 'model' ? 'model' : 'call_point';

  // Each narrowing, regrouping or metric switch is one step of the browser's Back.
  const [search, setSearch] = useViewSearchParams();
  const view = React.useMemo(() => readInsightsView(search), [search]);
  const setView = React.useCallback((patch: Partial<InsightsViewState>) => {
    setSearch((current) => writeInsightsView({ ...readInsightsView(current), ...patch }));
  }, [setSearch]);
  // A narrowing reshapes the panels above the row it was chosen in; the row stays under the finger.
  const anchorPress = useScrollAnchor(search.toString());

  const { value: range, ready: isRangeReady, set: setRange } = usePreference<InsightsRange>(
    INSIGHTS_RANGE_PREFERENCE, DEFAULT_INSIGHTS_RANGE, parseInsightsRange,
  );

  const cubeQuery = useQuery({
    queryKey: ['insights-cube', insightsRangeParams(range, view.bucket)],
    queryFn: () => api.getInsightsCube(insightsRangeParams(range, view.bucket)),
    enabled: isRangeReady,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    refetchInterval: (query) => insightsPollInterval(query.state.data?.window),
  });
  const cube = React.useMemo(() => (cubeQuery.data ? decodeInsightsCube(cubeQuery.data) : undefined), [cubeQuery.data]);
  const labels = useInsightsLabels(cube);
  const formatCompareWindow = useCompareWindowLabel();

  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const rhythmQueryString = rhythmParams(range, view.filters);
  const rhythmQuery = useQuery({
    queryKey: ['insights-rhythm', rhythmQueryString],
    queryFn: () => api.getInsightsRhythm(rhythmQueryString),
    enabled: isRangeReady,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: (count, error) => apiErrorCode(error) !== 'demo_uncaptured' && count < 2,
    meta: { silent: true },
  });
  const drawerRhythmString = openKey ? rhythmParams(range, { ...view.filters, key: [openKey] }) : '';
  const drawerRhythmQuery = useQuery({
    queryKey: ['insights-rhythm', drawerRhythmString],
    queryFn: () => api.getInsightsRhythm(drawerRhythmString),
    enabled: isRangeReady && openKey !== null,
    staleTime: 60_000,
    retry: (count, error) => apiErrorCode(error) !== 'demo_uncaptured' && count < 2,
    meta: { silent: true },
  });

  const metric = view.metric;
  const isLineMetric = !isAdditiveMetric(metric);
  const [selectedTrendIds, setSelectedTrendIds] = React.useState<string[]>([]);
  const rows = React.useMemo(() => (cube ? filterRows(cube, cube.rows, view.filters) : []), [cube, view.filters]);
  const previousRows = React.useMemo(() => (cube ? filterRows(cube, cube.previous, view.filters) : []), [cube, view.filters]);
  const isComparing = view.isComparing && Boolean(cube?.compare);
  const current = React.useMemo(() => sumMeasures(rows), [rows]);
  // The window and the sums travel together: a tile's label depends on which stretch was compared,
  // not only on the figures.
  const baseline = React.useMemo(
    () => (isComparing && cube?.compare
      ? { measures: sumMeasures(previousRows), window: cube.compare, isSameStretch: comparesSameStretch(cube.window) }
      : null),
    [cube, isComparing, previousRows],
  );

  const rank = React.useCallback((dimension: InsightsDimension) => {
    if (!cube) return [];
    return rankGroups(groupTotals(cube, rows, dimension), metric, isComparing ? groupTotals(cube, previousRows, dimension) : undefined);
  }, [cube, isComparing, metric, previousRows, rows]);
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
    return rankGroups(groupTotals(cube, pick(cube.rows), dimension), metric, isComparing ? groupTotals(cube, pick(cube.previous), dimension) : undefined);
  }, [cube, isComparing, metric, view.filters]);
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
    setView({ filters: toggleFilter(view.filters, dimension, id) });
  }, [setView, view.filters]);
  const toggleTrendGroup = React.useCallback((id: string) => {
    setSelectedTrendIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);
  const clearFilter = React.useCallback((dimension: InsightsDimension) => {
    const next = { ...view.filters };
    delete next[dimension];
    setView({ filters: next });
  }, [setView, view.filters]);
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

  const shownWindow = cube?.window;
  const isHourAllowed = !shownWindow || shownWindow.to - shownWindow.from <= HOUR_LIMIT_MS;
  const rhythmMeasure = metric === 'cost' ? 'cost' : metric === 'tokens' ? 'tokens' : 'requests';
  // The span in the fewest characters that still name it: no year inside the current one, no clock
  // on a window that starts and ends on day boundaries. The exact instants and the deployment's zone
  // are the hover, so the line under the title stays a reading rather than a timestamp dump.
  const subtitle = shownWindow ? (
    <span className={styles['window-span']} title={`${dayjs(shownWindow.from).format('YYYY-MM-DD HH:mm')} – ${shownWindow.open_end ? t('dash.range.until_now') : dayjs(shownWindow.to).format('YYYY-MM-DD HH:mm')} · ${shownWindow.timezone}`}>
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
      value={view.bucket}
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
      label={t(view.isComparing ? 'insights.compare_off' : 'insights.compare_on')}
      type={view.isComparing ? 'primary' : 'default'}
      ghost={view.isComparing}
      aria-pressed={view.isComparing}
      disabled={!cube?.compare}
      onClick={() => setView({ isComparing: !view.isComparing })}
      data-testid="insights-compare"
    />
  );
  const refreshButton = (
    <RefreshButton label={t('header.refresh_all')} isRefreshing={cubeQuery.isFetching} onRefresh={() => { void cubeQuery.refetch(); void rhythmQuery.refetch(); }} />
  );

  const header = (
    <PageHeader
      className={styles['head']}
      title={t('nav.insights')}
      subtitle={subtitle}
      actions={(
        <>
          <InsightsRangeControl range={range} onChange={(next) => void setRange(next)} />
          {compareButton}
          {refreshButton}
        </>
      )}
      mobileActions={(
        <>
          <InsightsRangeControl range={range} onChange={(next) => void setRange(next)} />
          <ActionMenu>
            {compareButton}
            {refreshButton}
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
        <LoadingRegion className={styles['tiles']}>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className={styles['tile']}>
              <Placeholder width="50%" row={index} className="placeholder-line is-meta" />
              <Placeholder width="70%" height={24} row={index + 1} />
              <Placeholder width="40%" row={index + 2} className="placeholder-line is-meta" />
            </div>
          ))}
        </LoadingRegion>
        <Panel className={styles['trend-panel']}><ChartFallback height={280} /></Panel>
      </div>
    );
  }

  const isEmpty = cube.rows.length === 0;
  const rankingLimit = isPhone ? 5 : 8;
  const groupingOptions = INSIGHTS_GROUPINGS.map((grouping) => ({ value: grouping, label: t(`insights.group.${grouping}`) }));

  return (
    <div className={`terminal-page ${styles['page']}`} data-testid="insights-page" onPointerDownCapture={anchorPress}>
      {header}
      <InsightsFilterBar cube={cube} filters={view.filters} labels={labels} modelDimension={modelDimension} onChange={(filters) => setView({ filters })} onOpenKey={setOpenKey} />
      {cubeQuery.isError && (
        <LoadFailure
          tone="warning"
          title={t('insights.error_title')}
          error={cubeQuery.error}
          onRetry={() => void cubeQuery.refetch()}
        />
      )}
      <MetricTiles current={current} baseline={baseline} metric={metric} onMetricChange={(next: InsightsMetric) => setView({ metric: next })} />
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
                  value={view.grouping}
                  options={groupingOptions}
                  onChange={(grouping: InsightsGrouping) => setView({ grouping })}
                  aria-label={t('insights.group_label')}
                  popupMatchSelectWidth={false}
                />
                {bucketControl}
              </>
            )}
          >
            {t('insights.trend_label', { metric: t(`insights.metric.${metric}`) })}
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
                  title: t('insights.legend_toggle'),
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
              label={t('insights.trend_label', { metric: t(`insights.metric.${metric}`) })}
              onBrush={isPhone ? undefined : brush}
              height={isPhone ? 220 : 280}
            />
          </React.Suspense>
          </>
        )}
      </Panel>
      <div className={styles['rankings']} data-layout={panels.key.length === 1 ? 'single-key' : 'grid'}>
        <RankingPanel dimension="key" title={t('insights.dim.key')} groups={panels.key} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor('key')} selected={view.filters.key ?? []} onSelect={selectFilter} onClear={clearFilter} onOpen={setOpenKey} limit={rankingLimit} testId="insights-ranking-key" />
        <RankingPanel dimension={modelDimension} title={t(`insights.dim.${modelDimension}`)} groups={panels.model} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor(modelDimension)} selected={view.filters[modelDimension] ?? []} onSelect={selectFilter} onClear={clearFilter} limit={rankingLimit} testId="insights-ranking-model" />
        <RankingPanel dimension="provider" title={t('insights.ranking.provider')} groups={panels.provider} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor('provider')} selected={view.filters.provider ?? []} onSelect={selectFilter} onClear={clearFilter} limit={rankingLimit} testId="insights-ranking-provider" />
        <RankingPanel dimension="credential" title={t('insights.ranking.credential')} groups={panels.credential} metric={metric} labels={labels} compare={baseline?.window}
          colorOf={groupedColor('credential')} selected={view.filters.credential ?? []} onSelect={selectFilter} onClear={clearFilter} limit={rankingLimit} testId="insights-ranking-credential" />
      </div>
      {/* On a phone the key ranking above already lists every key and opens its detail; the table
          would repeat it as a column of label rows. */}
      {!isPhone && (
      <Panel
        className={styles['table-panel']}
        data-testid="insights-keys"
        title={<PanelTitle extra={<span className={styles['panel-meta']}>{t('insights.key_count', { n: clientKeys.length })}</span>}>{t('insights.keys_title')}</PanelTitle>}
      >
        <KeyTable groups={rankings.key} sparklines={sparklines} lastActive={lastActive} metric={metric} labels={labels} compare={baseline?.window} isLoading={cubeQuery.isLoading} onOpen={setOpenKey} />
      </Panel>
      )}
      {/* A bar per key needs the width to name the key and still show its parts; a phone has the table above. */}
      {!isPhone && (
        <KeyCompositionPanel
          cube={cube}
          rows={compositionRows}
          columnDimension={modelDimension}
          metric={metric}
          labels={labels}
          selectedKeys={view.filters.key ?? []}
          selectedColumns={view.filters[modelDimension] ?? []}
          onSelect={(keyId, columnId) => {
            const isSame = (view.filters.key ?? []).join() === keyId
              && (view.filters[modelDimension] ?? []).join() === (columnId ?? '');
            const next = { ...view.filters };
            delete next.key;
            delete next[modelDimension];
            // Choosing the segment already chosen takes it back, as a ranking row does.
            setView({ filters: isSame ? next : { ...next, key: [keyId], ...(columnId === null ? {} : { [modelDimension]: [columnId] }) } });
          }}
          onSelectColumn={(columnId) => selectFilter(modelDimension, columnId)}
          onClear={() => {
            const next = { ...view.filters };
            delete next.key;
            delete next[modelDimension];
            setView({ filters: next });
          }}
        />
      )}
      {/* A flow needs its three columns to say anything; a phone gets the rankings above instead. */}
      {flow && flow.links.length > 0 && (
        <Panel
          data-testid="insights-flow"
          title={(
            <PanelTitle
              extra={(
                <PanelNarrowing
                  count={flowDimensions.reduce((sum, dimension) => sum + (view.filters[dimension]?.length ?? 0), 0)}
                  unit={t(`insights.metric.${isAdditiveMetric(metric) ? metric : 'requests'}`)}
                  onClear={() => {
                    const next = { ...view.filters };
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
          <React.Suspense fallback={<ChartFallback height={320} />}>
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
      )}
      <RhythmGrid
        data={rhythmQuery.data}
        measure={rhythmMeasure}
        isLoading={rhythmQuery.isLoading}
        isUncaptured={apiErrorCode(rhythmQuery.error) === 'demo_uncaptured'}
      />
      <div className={styles['footnote']}>
        {cube.window.widened && <span>{t('insights.widened')}</span>}
        {baseline && <span>{formatCompareWindow(baseline.window)}</span>}
        {current.requests > 0 && current.costedRequests < current.requests && (
          <span>{t('insights.cost_partial', { n: Math.round((current.costedRequests / current.requests) * 100) })}</span>
        )}
        {cube.window.to - cube.window.from > 400 * DAY_MS && <span>{t('insights.long_window')}</span>}
      </div>
      <KeyDetailDrawer
        cube={cube}
        keyId={openKey}
        filters={view.filters}
        metric={metric}
        modelDimension={modelDimension}
        labels={labels}
        rhythm={drawerRhythmQuery.data}
        isRhythmLoading={drawerRhythmQuery.isLoading}
        isRhythmUncaptured={apiErrorCode(drawerRhythmQuery.error) === 'demo_uncaptured'}
        onClose={() => setOpenKey(null)}
        onFilter={(keyId) => {
          setOpenKey(null);
          setView({ filters: { ...view.filters, key: [keyId] } });
        }}
      />
    </div>
  );
};

export default InsightsPage;
