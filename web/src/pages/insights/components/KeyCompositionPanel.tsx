import React from 'react';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { ChartLegend } from '../../../components/common/ChartLegend';
import { ResponsiveList } from '../../../components/common/ResponsiveList';
import { BarChartOutlined, DashboardOutlined, TableOutlined } from '../../../components/icons';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { formatTokens, formatTokensFull } from '../../../types/tokenDisplay';
import { formatShare } from '../../../types/insightsFormat';
import { useInsightsFormat } from '../useInsightsFormat';
import { CacheRateText, LatencyText } from './RateText';
import { useColumnSort, type SortableColumn } from './useColumnSort';
import styles from '../insights.module.css';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import {
  anatomyCacheRate, anatomyReasoningShare, buildMatrix, entityProfiles, filterRows, matrixCellKey, measuresAvgTtftMs, metricValue, rankingMetric,
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
  /** A phone has no width for a bar per key, so it offers the table and the load profile. */
  isPhone?: boolean;
  /** The keys and column values the page is narrowed to; the figure keeps the rest, stepped back. */
  selectedKeys: readonly string[];
  selectedColumns: readonly string[];
  /** A segment narrows to its key and column; a bar's remainder to the key alone. */
  onSelect: (keyId: string, columnId: string | null) => void;
  /** A legend entry narrows to its column value. */
  onSelectColumn: (columnId: string) => void;
  onClear: () => void;
}

/**
 * Which models each key used. By default a chart - one bar per key, cut into its models - because
 * the question is about shape ("mostly this model"); the table beside it gives the exact numbers.
 * Latency cannot be cut into parts, so a non-additive metric shows the composition by requests and
 * says so.
 *
 * The panel reads every filter but its own two dimensions, so choosing a segment does not shrink the
 * figure to one bar: the chosen key and model stay at full ink and the rest step back, and the
 * panel's head offers to clear them.
 */
export const KeyCompositionPanel: React.FC<KeyCompositionPanelProps> = ({
  cube, rows, columnDimension, metric, labels, filters, isPhone = false, selectedKeys, selectedColumns, onSelect, onSelectColumn, onClear,
}) => {
  const t = useT();
  const { theme } = useTheme();
  const [chosenView, setView] = React.useState<CompositionView>('chart');
  const view: CompositionView = isPhone && chosenView === 'chart' ? 'profile' : chosenView;
  const partMetric = rankingMetric(metric);

  const chartMatrix = React.useMemo(
    () => buildMatrix(cube, view === 'profile' ? [] : rows, 'key', columnDimension, partMetric, ROW_LIMIT, SEGMENT_LIMIT),
    [columnDimension, cube, partMetric, rows, view],
  );
  // Only the profile view reads the profile, so the default chart never walks the rows for it.
  const profiles = React.useMemo(
    () => (view === 'profile' ? entityProfiles(cube, filterRows(cube, cube.rows, filters, columnDimension), columnDimension) : []),
    [columnDimension, cube, filters, view],
  );
  const tableMatrix = React.useMemo(
    () => (view === 'table' ? buildMatrix(cube, rows, 'key', columnDimension, metric, 20, 10) : null),
    [columnDimension, cube, metric, rows, view],
  );

  const composition = React.useMemo(() => {
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
  return (
    <Panel
      data-testid="insights-matrix"
      title={(
        <PanelTitle
          extra={(
            <>
              <PanelNarrowing
                count={selectedKeys.length + selectedColumns.length}
                unit={t(`insights.metric.${view === 'chart' ? partMetric : metric}`)}
                onClear={onClear}
              />
              <Segmented
                size="sm"
                value={view}
                onChange={(next) => setView(next as CompositionView)}
                aria-label={t('insights.view_label')}
                options={[
                  ...(isPhone ? [] : [{ value: 'chart', icon: <BarChartOutlined />, title: t('insights.view_chart') }]),
                  { value: 'table', icon: <TableOutlined />, title: t('insights.view_table') },
                  { value: 'profile', icon: <DashboardOutlined />, title: t('insights.view_profile') },
                ]}
              />
            </>
          )}
        >
          {t('insights.composition_title')}
        </PanelTitle>
      )}
    >
      {view === 'profile' ? (
        <ModelProfileTable profiles={profiles} dimension={columnDimension} labels={labels} isPhone={isPhone} />
      ) : chartMatrix.rowIds.length === 0 ? (
        <EmptyState size="compact" title={t('insights.no_usage')} />
      ) : view === 'chart' ? (
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

const perRequest = (value: number, requests: number) => (requests > 0 ? value / requests : null);
const netInput = (profile: EntityProfile) => perRequest(profile.anatomy.uncachedInput, profile.measures.requests);
const output = (profile: EntityProfile) => perRequest(profile.anatomy.completionTotal, profile.measures.requests);
const latency = (profile: EntityProfile) => metricValue(profile.measures, 'latency');

/**
 * How each model is used, request by request: how much uncached prompt and completion one call
 * carries, how much of it is reasoning or cache, and how long it takes to start and to finish.
 */
function ModelProfileTable({ profiles, dimension, labels, isPhone }: {
  profiles: readonly EntityProfile[];
  dimension: InsightsDimension;
  labels: InsightsLabels;
  isPhone: boolean;
}) {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric } = useInsightsFormat();
  const columns = React.useMemo<SortableColumn<EntityProfile>[]>(() => {
    const tokens = (value: number | null) => (value === null ? '—' : <span data-tip={formatTokensFull(Math.round(value))}>{formatTokens(value, style)}</span>);
    return [
      { key: 'name', title: t(`insights.dim.${dimension}`), render: (_, profile) => <InsightsValue dimension={dimension} id={profile.id} labels={labels} /> },
      { key: 'requests', title: t('insights.metric.requests'), align: 'right', sortValue: (profile) => profile.measures.requests, render: (_, profile) => formatMetric('requests', profile.measures.requests, style) },
      { key: 'net_input', title: t('insights.profile.net_input'), align: 'right', sortValue: netInput, render: (_, profile) => tokens(netInput(profile)) },
      { key: 'output', title: t('insights.profile.output'), align: 'right', sortValue: output, render: (_, profile) => tokens(output(profile)) },
      {
        key: 'reasoning', title: t('insights.anatomy.reasoning_share'), align: 'right', sortValue: (profile) => anatomyReasoningShare(profile.anatomy),
        render: (_, profile) => {
          const share = anatomyReasoningShare(profile.anatomy);
          return share === null ? '—' : formatShare(share / 100);
        },
      },
      { key: 'cache', title: t('insights.anatomy.cache_rate'), align: 'right', sortValue: (profile) => anatomyCacheRate(profile.anatomy), render: (_, profile) => <CacheRateText rate={anatomyCacheRate(profile.anatomy)} /> },
      {
        key: 'ttft', title: t('insights.col.ttft'), align: 'right', sortValue: (profile) => measuresAvgTtftMs(profile.measures),
        render: (_, profile) => <span className={styles['is-muted']}>{formatMetric('latency', measuresAvgTtftMs(profile.measures), style)}</span>,
      },
      { key: 'latency', title: t('insights.metric.latency'), align: 'right', sortValue: latency, render: (_, profile) => <LatencyText ms={latency(profile)} /> },
    ];
  }, [dimension, formatMetric, labels, style, t]);
  const sorted = useColumnSort(columns, profiles);
  const sortOptions = React.useMemo(
    () => columns.filter((column) => column.sortValue).map((column) => ({ value: String(column.key), label: column.title as string })),
    [columns],
  );
  return (
    <>
      {isPhone && (
        // A phone row has no header to click, so the order is chosen here; it is the order the table keeps.
        <div className={styles['profile-sort']}>
          <Select
            size="sm"
            aria-label={t('insights.sort_label')}
            value={sorted.sortKey === null ? 'requests' : String(sorted.sortKey)}
            options={sortOptions}
            onChange={(key: string) => sorted.sortBy(key)}
          />
        </div>
      )}
      <ResponsiveList<EntityProfile>
        // A phone row names each field by its header, which stays plain text there rather than a sort control.
        columns={isPhone ? columns : sorted.columns}
        dataSource={sorted.data}
        rowKey="id"
        isLoading={false}
        emptyText={t('insights.no_usage')}
        pageSize={20}
        phone={{ identity: 'name' }}
        tableProps={{ size: 'small', className: styles['key-table'] }}
      />
    </>
  );
}
