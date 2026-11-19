import React from 'react';
import clsx from 'clsx';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { ChartLegend } from '../../../components/common/ChartLegend';
import { ResponsiveList } from '../../../components/common/ResponsiveList';
import { ToolButton } from '../../../components/common/ToolButton';
import { isRecordBodyClick } from '../../../components/common/recordClick';
import {
  ArrowDownOutlined, ArrowUpOutlined, BarChartOutlined, DashboardOutlined, RightOutlined, TableOutlined,
} from '../../../components/icons';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatShare, formatTps } from '../../../types/insightsFormat';
import { useInsightsFormat } from '../useInsightsFormat';
import { CacheRateText, LatencyText } from './RateText';
import { useColumnSort, type SortableColumn } from './useColumnSort';
import styles from '../insights.module.css';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import {
  anatomyAvgTps, anatomyCacheRate, anatomyReasoningShare, buildMatrix, entityProfiles, filterRows, matrixCellKey, measuresAvgTtftMs, metricValue, rankingMetric,
  type CubeRow, type EntityProfile, type InsightsCube, type InsightsDimension, type InsightsFilters, type CubeMetric,
} from '../../../types/insightsCube';
import type { InsightsLabels } from '../../../hooks/useInsightsLabels';
import type { CompositionSegment } from '../charts/InsightsCompositionChart';
import { LazyInsightsCompositionChart as InsightsCompositionChart } from '../../../charts/lazyCharts';
import { MatrixTable } from './MatrixTable';
import { InsightsValue } from './InsightsValue';
import { PanelNarrowing } from './PanelNarrowing';

type CompositionView = 'chart' | 'table' | 'profile';

const ROW_LIMIT = 12;
const SEGMENT_LIMIT = 6;

interface KeyCompositionPanelProps {
  cube: InsightsCube;
  rows: readonly CubeRow[];
  columnDimension: InsightsDimension;
  metric: CubeMetric;
  labels: InsightsLabels;
  /** The page's filters; the load profile reads every one but the column dimension's. */
  filters: InsightsFilters;
  /** A phone has no width for a bar per key, so it offers the load profile and the table. */
  isPhone?: boolean;
  /** The keys and column values the page is narrowed to; the figure keeps the rest, stepped back. */
  selectedKeys: readonly string[];
  selectedColumns: readonly string[];
  /** A segment narrows to its key and column; a bar's remainder to the key alone. */
  onSelect: (keyId: string, columnId: string | null) => void;
  /** A legend entry narrows to its column value. */
  onSelectColumn: (columnId: string) => void;
  /** Opens a model's detail drawer from the load profile. */
  onOpenColumn?: (columnId: string) => void;
  /** Clears only the column dimension filter (for the load profile view). */
  onClearColumns?: () => void;
  onClear: () => void;
}

/**
 * Per-model load profile and key-by-model usage composition. Opens on the model load profile on
 * both desktop and mobile; the segmented control switches to the stacked composition chart
 * (desktop) or shaded key-by-model matrix.
 *
 * Each view reads every filter except its own dimensions, so narrowing to a model or key keeps the
 * rest stepped back on screen and the panel's head offers to clear them.
 */
export const KeyCompositionPanel: React.FC<KeyCompositionPanelProps> = ({
  cube, rows, columnDimension, metric, labels, filters, isPhone = false, selectedKeys, selectedColumns, onSelect, onSelectColumn, onOpenColumn, onClearColumns, onClear,
}) => {
  const t = useT();
  const { theme } = useTheme();
  const [chosenView, setView] = React.useState<CompositionView>('profile');
  const view: CompositionView = isPhone && chosenView === 'chart' ? 'profile' : chosenView;
  const partMetric = rankingMetric(metric);

  const chartMatrix = React.useMemo(
    () => (view === 'chart' ? buildMatrix(cube, rows, 'key', columnDimension, partMetric, ROW_LIMIT, SEGMENT_LIMIT) : null),
    [columnDimension, cube, partMetric, rows, view],
  );
  const profiles = React.useMemo(
    () => (view === 'profile' ? entityProfiles(cube, filterRows(cube, cube.rows, filters, columnDimension), columnDimension) : []),
    [columnDimension, cube, filters, view],
  );
  const tableMatrix = React.useMemo(
    () => (view === 'table' ? buildMatrix(cube, rows, 'key', columnDimension, metric, 20, 10) : null),
    [columnDimension, cube, metric, rows, view],
  );

  const composition = React.useMemo(() => {
    if (!chartMatrix) return null;
    const segments: CompositionSegment[] = chartMatrix.columnIds.map((id, index) => ({
      id, name: labels.label(columnDimension, id), color: theme.palette.series[index % theme.palette.series.length],
    }));
    const values = chartMatrix.columnIds.map((columnId) =>
      chartMatrix.rowIds.map((rowId) => chartMatrix.cells.get(matrixCellKey(rowId, columnId))?.value ?? 0));
    // What a key spent on models outside the top ones, so each bar's length is still the key's whole.
    const rest = chartMatrix.rowIds.map((rowId, row) => {
      const whole = metricValue(chartMatrix.rowTotals.get(rowId)!, partMetric) ?? 0;
      return Math.max(0, whole - values.reduce((sum, series) => sum + series[row], 0));
    });
    if (rest.some((value) => value > 0)) {
      segments.push({ id: null, name: t('insights.folded'), color: theme.palette.muted });
      values.push(rest);
    }
    return {
      rows: chartMatrix.rowIds.map((id) => ({ id, name: labels.label('key', id) })),
      segments,
      values,
    };
  }, [chartMatrix, columnDimension, labels, partMetric, t, theme.palette]);

  const columnName = t(`insights.dim.${columnDimension}`);
  const isNarrowed = selectedKeys.length > 0 || selectedColumns.length > 0;
  const isDimmed = React.useCallback((keyId: string, columnId: string | null) =>
    (selectedKeys.length > 0 && !selectedKeys.includes(keyId))
    || (selectedColumns.length > 0 && (columnId === null || !selectedColumns.includes(columnId))), [selectedColumns, selectedKeys]);

  // The load profile is per-model telemetry independent of the page's active volume metric, so its
  // title names the load profile and its header omits the unrelated metric unit (e.g. "Token").
  const panelTitle = view === 'profile' ? t('insights.view_profile') : t('insights.composition_title');
  const headStatus = view === 'profile'
    ? (selectedColumns.length > 0 ? (
      <PanelNarrowing
        count={selectedColumns.length}
        unit={null}
        onClear={onClearColumns ?? onClear}
      />
    ) : !isPhone && profiles.length > 0 ? (
      <span className={styles['panel-meta']}>{t('insights.profile.count', { n: profiles.length })}</span>
    ) : null)
    : (
      <PanelNarrowing
        count={selectedKeys.length + selectedColumns.length}
        unit={t(`insights.metric.${view === 'chart' ? partMetric : metric}`)}
        onClear={onClear}
      />
    );

  return (
    <Panel
      data-testid="insights-matrix"
      title={(
        <PanelTitle
          extra={(
            <>
              {headStatus}
              <Segmented
                size="sm"
                value={view}
                onChange={(next) => setView(next as CompositionView)}
                aria-label={t('insights.view_label')}
                options={isPhone ? [
                  // Touchscreens have no hover tooltips, so the phone toggle uses readable short labels
                  // with the default load profile on the leading side.
                  { value: 'profile', label: t('insights.view_profile_short'), title: t('insights.view_profile') },
                  { value: 'table', label: t('insights.view_matrix_short'), title: t('insights.view_table') },
                ] : [
                  { value: 'profile', icon: <DashboardOutlined />, title: t('insights.view_profile') },
                  { value: 'chart', icon: <BarChartOutlined />, title: t('insights.view_chart') },
                  { value: 'table', icon: <TableOutlined />, title: t('insights.view_table') },
                ]}
              />
            </>
          )}
        >
          {panelTitle}
        </PanelTitle>
      )}
    >
      {view === 'profile' ? (
        <ModelProfileTable
          profiles={profiles}
          dimension={columnDimension}
          labels={labels}
          isPhone={isPhone}
          selectedIds={selectedColumns}
          onOpen={onOpenColumn}
        />
      ) : view === 'chart' ? (
        !chartMatrix || !composition || chartMatrix.rowIds.length === 0 ? (
          <EmptyState size="compact" title={t('insights.no_usage')} />
        ) : (
          <>
            <ChartLegend
              label={columnName}
              items={composition.segments.map((segment) => (segment.id === null
                ? { id: '\u0000rest', color: segment.color, content: <span>{segment.name}</span> }
                : {
                  id: segment.id,
                  color: segment.color,
                  content: <InsightsValue dimension={columnDimension} id={segment.id} labels={labels} />,
                  isPressed: selectedColumns.includes(segment.id),
                  isDimmed: selectedColumns.length > 0 && !selectedColumns.includes(segment.id),
                  onToggle: () => onSelectColumn(segment.id!),
                }))}
            />
            <React.Suspense fallback={<div className="chart-placeholder" style={{ height: 240 }} aria-hidden="true" />}>
              <InsightsCompositionChart
                rows={composition.rows}
                segments={composition.segments}
                values={composition.values}
                metric={partMetric}
                totalLabel={t('insights.total')}
                label={t('insights.composition_title')}
                isDimmed={isNarrowed ? isDimmed : undefined}
                onSelect={onSelect}
              />
            </React.Suspense>
          </>
        )
      ) : (
        <MatrixTable
          matrix={tableMatrix!}
          rowDimension="key"
          columnDimension={columnDimension}
          metric={metric}
          labels={labels}
          isDimmed={isNarrowed ? isDimmed : undefined}
          onSelectCell={(rowId, columnId) => onSelect(rowId, columnId)}
        />
      )}
    </Panel>
  );
};

const latency = (profile: EntityProfile) => metricValue(profile.measures, 'latency');
const avgTps = (profile: EntityProfile) => anatomyAvgTps(profile.anatomy, profile.measures.latencySumMs);

/**
 * How each model performs across the selected slice: traffic volume, token efficiency (reasoning
 * share and cache-read rate), responsiveness (TTFT and average latency), and output throughput
 * (average TPS).
 */
function ModelProfileTable({ profiles, dimension, labels, isPhone, selectedIds, onOpen }: {
  profiles: readonly EntityProfile[];
  dimension: InsightsDimension;
  labels: InsightsLabels;
  isPhone: boolean;
  selectedIds: readonly string[];
  onOpen?: (id: string) => void;
}) {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const columns = React.useMemo<SortableColumn<EntityProfile>[]>(() => [
    {
      key: 'name',
      title: t(`insights.dim.${dimension}`),
      render: (_, profile) => (onOpen ? (
        <button type="button" className={styles['key-name']} onClick={() => onOpen(profile.id)}>
          <InsightsValue dimension={dimension} id={profile.id} labels={labels} />
        </button>
      ) : (
        <InsightsValue dimension={dimension} id={profile.id} labels={labels} />
      )),
    },
    { key: 'requests', title: t('insights.metric.requests'), align: 'right', sortValue: (profile) => profile.measures.requests, render: (_, profile) => formatMetric('requests', profile.measures.requests, style) },
    {
      key: 'reasoning', title: t('insights.anatomy.reasoning_share'), align: 'right', sortValue: (profile) => anatomyReasoningShare(profile.anatomy),
      render: (_, profile) => {
        const share = anatomyReasoningShare(profile.anatomy);
        return share === null ? <span className={styles['is-muted']}>—</span> : formatShare(share / 100);
      },
    },
    { key: 'cache', title: t('insights.anatomy.cache_rate'), align: 'right', sortValue: (profile) => anatomyCacheRate(profile.anatomy), render: (_, profile) => <CacheRateText rate={anatomyCacheRate(profile.anatomy)} /> },
    {
      key: 'ttft', title: t('insights.col.ttft'), align: 'right', sortValue: (profile) => measuresAvgTtftMs(profile.measures),
      render: (_, profile) => {
        const value = measuresAvgTtftMs(profile.measures);
        return value === null ? <span className={styles['is-muted']}>—</span> : <span className={styles['profile-ttft']}>{formatMetric('latency', value, style)}</span>;
      },
    },
    { key: 'latency', title: t('insights.metric.latency'), align: 'right', sortValue: latency, render: (_, profile) => <LatencyText ms={latency(profile)} /> },
    {
      key: 'tps', title: t('insights.profile.avg_tps'), align: 'right', sortValue: avgTps,
      render: (_, profile) => {
        const tps = avgTps(profile);
        return tps === null ? <span className={styles['is-muted']}>—</span> : formatTps(tps);
      },
    },
  ], [dimension, formatMetric, labels, onOpen, style, t]);
  const sorted = useColumnSort(columns, profiles);
  const activeSortKey = sorted.sortKey === null ? 'requests' : String(sorted.sortKey);
  const isAscending = sorted.sortOrder === 'ascending';
  const sortOptions = React.useMemo(
    () => columns.filter((column) => column.sortValue).map((column) => ({ value: String(column.key), label: column.title as string })),
    [columns],
  );
  // Row 1: volume & token efficiency; Row 2: responsiveness & throughput. Matches the desktop
  // column order 1:1 and fills both 3×2 and ultra-narrow 2×3 grids with zero orphan slots.
  const phoneMetrics = React.useMemo(
    () => [
      { key: 'requests', label: t('insights.metric.requests') },
      { key: 'reasoning', label: t('insights.profile.reasoning_short') },
      { key: 'cache', label: t('insights.profile.cache_short') },
      { key: 'ttft', label: t('insights.col.ttft') },
      { key: 'latency', label: t('insights.profile.latency_short') },
      { key: 'tps', label: t('insights.profile.avg_tps') },
    ] as const,
    [t],
  );

  const renderPhoneCard = (profile: EntityProfile, cell: (columnKey: string) => React.ReactNode) => {
    const isSelected = selectedIds.includes(profile.id);
    const isDimmed = selectedIds.length > 0 && !isSelected;
    return (
      <article
        className={clsx(styles['profile-card'], onOpen && styles['profile-card-interactive'])}
        data-testid="phone-row"
        data-selected={isSelected || undefined}
        data-dimmed={isDimmed ? 'true' : undefined}
        onClick={onOpen ? (event) => {
          if (isRecordBodyClick(event)) onOpen(profile.id);
        } : undefined}
      >
        <div className={styles['profile-card-head']}>
          {onOpen ? (
            <button
              type="button"
              className={styles['profile-card-title']}
              onClick={() => onOpen(profile.id)}
            >
              <InsightsValue dimension={dimension} id={profile.id} labels={labels} />
            </button>
          ) : (
            <span className={styles['profile-card-title']}>
              <InsightsValue dimension={dimension} id={profile.id} labels={labels} />
            </span>
          )}
          {onOpen && <RightOutlined className={styles['profile-card-open']} aria-hidden="true" />}
        </div>
        <dl className={styles['profile-card-grid']}>
          {phoneMetrics.map((item) => (
            <div
              key={item.key}
              className={styles['profile-card-cell']}
              data-sorted={activeSortKey === item.key || undefined}
            >
              <dt>{item.label}</dt>
              <dd>{cell(item.key)}</dd>
            </div>
          ))}
        </dl>
      </article>
    );
  };

  return (
    <>
      {isPhone && profiles.length > 0 && (
        // A phone card has no column headers to click, so the sort field and direction sit together
        // above the cards with the model count anchoring the leading side.
        <div className={styles['profile-toolbar']}>
          <span className={styles['profile-count']}>{t('insights.profile.count', { n: profiles.length })}</span>
          <div className={styles['profile-sort']}>
            <Select
              size="sm"
              className={styles['profile-sort-select']}
              popupMatchSelectWidth={false}
              aria-label={t('insights.sort_label')}
              value={activeSortKey}
              options={sortOptions}
              onChange={(key: string) => sorted.sortBy(key, 'descending')}
            />
            <ToolButton
              size="sm"
              icon={isAscending ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              label={t(isAscending ? 'insights.sort_desc' : 'insights.sort_asc')}
              onClick={() => sorted.sortBy(activeSortKey, isAscending ? 'descending' : 'ascending')}
            />
          </div>
        </div>
      )}
      <div className={isPhone ? styles['profile-list'] : undefined}>
        <ResponsiveList<EntityProfile>
          columns={isPhone ? columns : sorted.columns}
          dataSource={sorted.data}
          rowKey="id"
          isLoading={false}
          emptyText={t('insights.no_usage')}
          pageSize={isPhone ? 8 : 20}
          phone={{ render: renderPhoneCard }}
          tableProps={{
            size: 'small',
            className: styles['key-table'],
            onRow: (profile) => {
              const isSelected = selectedIds.includes(profile.id);
              const isDimmed = selectedIds.length > 0 && !isSelected;
              return {
                onClick: onOpen ? (event) => {
                  if (isRecordBodyClick(event)) onOpen(profile.id);
                } : undefined,
                className: clsx(
                  onOpen && styles['key-row'],
                  isSelected && styles['profile-row-selected'],
                  isDimmed && styles['profile-row-dimmed'],
                ),
              };
            },
          }}
        />
      </div>
    </>
  );
}
