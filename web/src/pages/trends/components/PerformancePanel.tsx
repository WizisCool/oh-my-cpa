import React from 'react';
import { Select } from '@/components/ui/select';
import { Segmented } from '@/components/ui/segmented';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { ChartLegend } from '../../../components/common/ChartLegend';
import { EmptyState } from '../../../components/common/EmptyState';
import { ChartLinesPlaceholder } from '../../../components/common/PageLoading';
import { LoadFailure, Notice } from '../../../components/feedback';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import dayjs from '../../../utils/time';
import type { InsightsBucket } from '../../../types/insights';
import type { TrendsTelemetryResponse } from '../../../types/trends';
import { LazyPerformanceChart as PerformanceChart } from '../../../charts/lazyCharts';
import {
  PERF_MODES,
  PERF_QUANTILES,
  TRENDS_PERF_GROUPS,
  availablePerfGroups,
  perfModeHasSamples,
  perfSeriesForMode,
  resolvePerfBuckets,
  type PerfMode,
  type PerfQuantile,
  type TrendsPerfGroup,
} from '../trendsLogic';
import { TrendsValue, type TrendsIdentity } from '../useTrendsIdentity';
import styles from '../trends.module.css';

const ALL_PERF_ITEMS = '\u0000all';

export interface PerformancePanelProps {
  data: TrendsTelemetryResponse | undefined;
  itemData?: TrendsTelemetryResponse;
  isItemLoading?: boolean;
  itemError?: unknown;
  onRetryItem?: () => void;
  includeAllGroups?: boolean;
  mode: PerfMode;
  group: TrendsPerfGroup;
  selectedItem?: string;
  isPhone: boolean;
  seriesLabel: (series: { id: string; label: string; alias?: string; mask?: string }) => string;
  onModeChange: (mode: PerfMode) => void;
  onGroupChange: (group: TrendsPerfGroup) => void;
  onItemChange: (item: string | undefined) => void;
  isUnavailable?: boolean;
  identity: TrendsIdentity;
  bucketControl: React.ReactNode;
  /** A stretch of buckets swept on a time mode narrows the page to it. */
  onBrush?: (range: { from: number; to: number | null }) => void;
}

/**
 * The speed bench: streaming speed per group, time to first token and total duration as a median
 * with the 95th percentile as its envelope (overall or narrowed to a model, provider, or
 * credential), and every retained request as a point of first token against total time. A bucket
 * without a sample breaks the line rather than dropping it to zero.
 */
export const PerformancePanel: React.FC<PerformancePanelProps> = ({
  data,
  itemData,
  isItemLoading = false,
  itemError = null,
  onRetryItem,
  includeAllGroups = false,
  mode,
  group,
  selectedItem,
  isPhone,
  seriesLabel,
  onModeChange,
  onGroupChange,
  onItemChange,
  isUnavailable,
  identity,
  bucketControl,
  onBrush,
}) => {
  const t = useT();
  const { theme } = useTheme();
  const series = React.useMemo(() => data?.series ?? [], [data]);
  const filterGroups = React.useMemo(() => availablePerfGroups(data, includeAllGroups), [data, includeAllGroups]);
  const activeItem = React.useMemo(
    () => (selectedItem && filterGroups.some((item) => item.id === selectedItem) ? selectedItem : undefined),
    [filterGroups, selectedItem],
  );
  const colorOf = React.useCallback((id: string) => {
    const index = series.findIndex((item) => item.id === id);
    return index < 0 ? theme.palette.muted : theme.palette.series[index % theme.palette.series.length]!;
  }, [series, theme.palette.muted, theme.palette.series]);
  const labelOf = React.useCallback((id: string) => {
    const item = filterGroups.find((entry) => entry.id === id) ?? series.find((entry) => entry.id === id);
    return item ? seriesLabel(item) : id;
  }, [filterGroups, series, seriesLabel]);

  const hasSamples = Boolean(data && (data.summary.tps_samples > 0 || data.summary.ttft_samples > 0 || data.summary.latency_samples > 0));
  const isPercentile = mode === 'ttft' || mode === 'latency';
  const isMultiSeries = mode === 'tps' || (isPercentile && activeItem === undefined);
  const isInteractiveLegend = isMultiSeries || mode === 'scatter';
  const modeSeries = React.useMemo(
    () => perfSeriesForMode(series, data?.scatter ?? [], mode),
    [data?.scatter, mode, series],
  );
  const [quantile, setQuantile] = React.useState<PerfQuantile>('p50');
  const isItemMatchedInSeries = Boolean(activeItem !== undefined && series.some((item) => item.id === activeItem));
  const needsExternalItemData = isPercentile && activeItem !== undefined && !isItemMatchedInSeries;
  const activeBuckets = React.useMemo(
    () => resolvePerfBuckets(data, mode, activeItem, itemData),
    [activeItem, data, itemData, mode],
  );
  const hasModeSamples = perfModeHasSamples(data, mode, activeBuckets, modeSeries);
  const chartHeight = isPhone ? 220 : 280;
  const dimension = data?.group_by ?? group;
  const providerLabel = React.useCallback((id: string) => {
    const matched = dimension === 'provider'
      ? (filterGroups.find((entry) => entry.id === id) ?? series.find((entry) => entry.id === id))
      : undefined;
    return identity.label('provider', matched ?? id);
  }, [dimension, filterGroups, identity, series]);

  const [focusState, setFocusState] = React.useState<{ dimension: string; id: string } | null>(null);
  const focusedKey = React.useMemo(() => {
    if (!focusState || focusState.dimension !== dimension) return null;
    if (data && !modeSeries.some((item) => item.id === focusState.id)) return null;
    return focusState.id;
  }, [data, dimension, focusState, modeSeries]);
  React.useEffect(() => {
    if (focusState && (focusState.dimension !== dimension || (data && !series.some((item) => item.id === focusState.id)))) {
      setFocusState(null);
    }
  }, [data, dimension, focusState, series]);
  const toggleSeriesFocus = React.useCallback((id: string) => {
    setFocusState((curr) => (curr?.dimension === dimension && curr.id === id ? null : { dimension, id }));
  }, [dimension]);
  const clearSeriesFocus = React.useCallback(() => setFocusState(null), []);

  const itemOptionContent = (id: string, fallbackLabel: React.ReactNode) => {
    if (!id || id === ALL_PERF_ITEMS) return fallbackLabel;
    const item = filterGroups.find((entry) => entry.id === id);
    if (!item) return fallbackLabel;
    return (
      <TrendsValue
        mark={identity.mark(dimension, item.id)}
        name={seriesLabel(item)}
        isTipOnOverflow={false}
      />
    );
  };

  const tools = (
    <span className={styles['panel-tools']}>
      {bucketControl}
      <Segmented
        size="sm"
        value={mode}
        onChange={(next) => onModeChange(next as PerfMode)}
        aria-label={t('trends.perf.mode_label')}
        data-testid="trends-perf-mode"
        options={PERF_MODES.map((value) => ({ value, label: t(`trends.perf.mode.${value}`) }))}
      />
      <Select
        size="small"
        variant={isPhone ? 'borderless' : undefined}
        value={group}
        aria-label={t('trends.group_label')}
        popupMatchSelectWidth={false}
        options={TRENDS_PERF_GROUPS.map((value) => ({ value, label: t(`trends.group.${value}`) }))}
        onChange={(next: TrendsPerfGroup) => onGroupChange(next)}
        data-testid="trends-perf-group"
      />
    </span>
  );

  const multiLegend = (
    <ChartLegend
      key={dimension}
      label={t('trends.group_label')}
      testId="trends-perf-legend"
      items={[
        ...modeSeries.map((item) => {
          const isFocused = focusedKey === item.id;
          return {
            id: item.id,
            color: colorOf(item.id),
            content: <TrendsValue mark={identity.mark(dimension, item.id)} name={labelOf(item.id)} isTipOnOverflow={false} />,
            title: t(isFocused ? 'dash.models.clear_series_focus' : 'dash.models.focus_series'),
            isPressed: isFocused,
            isDimmed: focusedKey !== null && !isFocused,
            onToggle: () => toggleSeriesFocus(item.id),
          };
        }),
        ...(mode !== 'scatter' ? [{ id: 'all', isDashed: true, content: <span>{t('trends.perf.all')}</span> }] : []),
        ...(mode === 'scatter' ? [{ id: 'failed', color: theme.palette.danger, content: <span>{t('trends.perf.failed')}</span> }] : []),
      ]}
    />
  );

  return (
    <Panel
      id="trends-performance"
      className={styles.section}
      data-testid="trends-performance"
      title={<PanelTitle extra={tools}>{t('trends.perf.title')}</PanelTitle>}
      aria-busy={isItemLoading || undefined}
    >
      {!data && isUnavailable ? (
        <EmptyState size="compact" title={t('trends.unavailable')} />
      ) : !data ? (
        <div className="chart-placeholder" style={{ height: 280 }} aria-hidden="true"><ChartLinesPlaceholder height={280} kind="trend" /></div>
      ) : (
        <div className={styles['panel-body']}>
          {data.coverage.is_truncated_by_retention && (
            <Notice
              tone="info"
              data-testid="trends-retention-notice"
              description={data.coverage.retention_start_ms !== undefined
                ? t('trends.perf.retention', { at: dayjs(data.coverage.retention_start_ms).format('YYYY-MM-DD HH:mm') })
                : t('trends.perf.retention_unknown')}
            />
          )}
          {!hasSamples ? (
            <EmptyState size="compact" title={t('trends.perf.empty')} />
          ) : (
            <>
              {isPercentile ? (
                <div className={styles['perf-legend-row']}>
                  {activeItem === undefined ? (
                    (modeSeries.length > 0 || hasModeSamples) && multiLegend
                  ) : (
                    <ChartLegend
                      label={t(`trends.perf.mode.${mode}`)}
                      items={[
                        { id: 'p50', color: theme.palette.timingGreen, content: <span>P50</span> },
                        { id: 'p95', color: theme.palette.timingOrange, content: <span>{t('trends.perf.p95_band')}</span> },
                      ]}
                    />
                  )}
                  <span className={styles['perf-legend-tools']}>
                    {activeItem === undefined && (
                      <Segmented
                        size="sm"
                        value={quantile}
                        onChange={(next) => setQuantile(next as PerfQuantile)}
                        aria-label={t('trends.perf.quantile_label')}
                        data-testid="trends-perf-quantile"
                        options={PERF_QUANTILES.map((value) => ({ value, label: value.toUpperCase() }))}
                      />
                    )}
                    {filterGroups.length > 0 && (
                      <Select
                        size="small"
                        variant={isPhone ? 'borderless' : undefined}
                        className={styles['perf-item-select']}
                        value={activeItem ?? ALL_PERF_ITEMS}
                        aria-label={t('trends.perf.filter_label')}
                        popupMatchSelectWidth={false}
                        loading={isItemLoading}
                        options={[
                          { value: ALL_PERF_ITEMS, label: t(`trends.perf.all_group.${group}`) },
                          ...filterGroups.map((item) => ({ value: item.id, label: seriesLabel(item) })),
                        ]}
                        optionRender={({ value, label }) => itemOptionContent(value, label)}
                        labelRender={({ value, label }) => itemOptionContent(value, label)}
                        onChange={(next: string) => onItemChange(next === ALL_PERF_ITEMS ? undefined : next)}
                        data-testid="trends-perf-item"
                      />
                    )}
                  </span>
                </div>
              ) : (
                hasModeSamples && modeSeries.length > 0 && multiLegend
              )}
              {needsExternalItemData && itemError ? (
                <LoadFailure tone="warning" title={t('trends.error_title')} error={itemError} onRetry={onRetryItem} />
              ) : needsExternalItemData && !itemData ? (
                <div className="chart-placeholder" style={{ height: chartHeight }} aria-hidden="true">
                  <ChartLinesPlaceholder height={chartHeight} kind="trend" />
                </div>
              ) : !hasModeSamples ? (
                <EmptyState size="compact" title={t('trends.perf.empty')} />
              ) : (
                <React.Suspense fallback={<div className="chart-placeholder" style={{ height: chartHeight }} aria-hidden="true" />}>
                  <PerformanceChart
                    mode={mode}
                    bucket={data.window.bucket as InsightsBucket}
                    window={data.window}
                    buckets={activeBuckets}
                    series={modeSeries}
                    scatter={data.scatter}
                    groupBy={data.group_by}
                    isMultiSeries={isMultiSeries}
                    quantile={quantile}
                    colorOf={colorOf}
                    labelOf={labelOf}
                    providerLabel={providerLabel}
                    label={t(`trends.perf.mode.${mode}`)}
                    height={chartHeight}
                    focusedKey={isInteractiveLegend ? focusedKey : null}
                    onFocusGroup={isInteractiveLegend ? toggleSeriesFocus : undefined}
                    onClearFocus={isInteractiveLegend ? clearSeriesFocus : undefined}
                    onBrush={mode === 'scatter' ? undefined : onBrush}
                  />
                </React.Suspense>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
};
