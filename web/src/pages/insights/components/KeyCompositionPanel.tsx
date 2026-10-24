import React from 'react';
import { Segmented } from 'antd';
import { Panel } from '../../../components/common/Panel';
import { PanelTitle } from '../../../components/common/PanelTitle';
import { EmptyState } from '../../../components/common/EmptyState';
import { BarChartOutlined, TableOutlined } from '../../../components/icons';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeContext';
import {
  buildMatrix, matrixCellKey, metricValue, rankingMetric,
  type CubeRow, type InsightsCube, type InsightsDimension, type InsightsMetric,
} from '../insightsCube';
import type { InsightsLabels } from '../useInsightsLabels';
import type { CompositionSegment } from '../charts/InsightsCompositionChart';
import { MatrixTable } from './MatrixTable';
import { InsightsValue } from './InsightsValue';
import { InsightsLegend } from './InsightsLegend';
import { PanelNarrowing } from './PanelNarrowing';

const InsightsCompositionChart = React.lazy(() => import('../charts/InsightsCompositionChart'));

const ROW_LIMIT = 12;
const SEGMENT_LIMIT = 6;

interface KeyCompositionPanelProps {
  cube: InsightsCube;
  rows: readonly CubeRow[];
  columnDimension: InsightsDimension;
  metric: InsightsMetric;
  labels: InsightsLabels;
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
  cube, rows, columnDimension, metric, labels, selectedKeys, selectedColumns, onSelect, onSelectColumn, onClear,
}) => {
  const t = useT();
  const { theme } = useTheme();
  const [view, setView] = React.useState<'chart' | 'table'>('chart');
  const partMetric = rankingMetric(metric);

  const chartMatrix = React.useMemo(
    () => buildMatrix(cube, rows, 'key', columnDimension, partMetric, ROW_LIMIT, SEGMENT_LIMIT),
    [columnDimension, cube, partMetric, rows],
  );
  const tableMatrix = React.useMemo(
    () => buildMatrix(cube, rows, 'key', columnDimension, metric, 20, 10),
    [columnDimension, cube, metric, rows],
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
                size="small"
                value={view}
                onChange={(next) => setView(next as 'chart' | 'table')}
                aria-label={t('insights.view_label')}
                options={[
                  { value: 'chart', icon: <BarChartOutlined />, title: t('insights.view_chart') },
                  { value: 'table', icon: <TableOutlined />, title: t('insights.view_table') },
                ]}
              />
            </>
          )}
        >
          {t('insights.composition_title')}
        </PanelTitle>
      )}
    >
      {chartMatrix.rowIds.length === 0 ? (
        <EmptyState size="compact" title={t('insights.no_usage')} />
      ) : view === 'chart' ? (
        <>
          <InsightsLegend
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
          matrix={tableMatrix}
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
