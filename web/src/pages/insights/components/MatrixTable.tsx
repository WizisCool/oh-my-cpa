import { useInsightsFormat } from '../useInsightsFormat';
import React from 'react';
import clsx from 'clsx';
import { EmptyState } from '../../../components/common/EmptyState';
import { useT } from '../../../i18n';
import { heatmapRampMix, heatmapRampPosition } from '../../../theme/heatmapRamp';
import { useTokenDisplayStyle } from '../../../types/tokenDisplayContext';
import { matrixCellKey, metricValue, type InsightsDimension, type InsightsMatrix, type InsightsMetric } from '../insightsCube';

import type { InsightsLabels } from '../useInsightsLabels';
import { InsightsValue } from './InsightsValue';
import styles from '../insights.module.css';

interface MatrixTableProps {
  matrix: InsightsMatrix;
  rowDimension: InsightsDimension;
  columnDimension: InsightsDimension;
  metric: InsightsMetric;
  labels: InsightsLabels;
  /** Steps back the cells outside the page's narrowing. */
  isDimmed?: (rowId: string, columnId: string) => boolean;
  /** Narrows the page to one cell: both its row's and its column's value. */
  onSelectCell: (rowId: string, columnId: string) => void;
}

/**
 * Two dimensions crossed - keys by model, by default - as a table of shaded cells: the exact view
 * behind the composition chart, for a reader who wants the numbers rather than the shape.
 *
 * A DOM table rather than a chart: it is read row by row and copied from, its headers have to stay in
 * view while it scrolls, and the shading is the activity grid's ramp (square root against the busiest
 * cell, mixed in CSS from the ramp tokens), so a busy cell here and a busy day there are one colour.
 * Latency cannot shade (its scale is not the volume ramp's), so a non-additive matrix prints its
 * numbers on the
 * volume's shading.
 */
export const MatrixTable: React.FC<MatrixTableProps> = ({ matrix, rowDimension, columnDimension, metric, labels, isDimmed, onSelectCell }) => {
  const t = useT();
  const { style } = useTokenDisplayStyle();
  const { formatMetric, formatMetricExact } = useInsightsFormat();
  const shadeMetric: InsightsMetric = metric === 'cost' || metric === 'tokens' || metric === 'requests' ? metric : 'requests';
  const shadeMax = React.useMemo(() => {
    let max = 0;
    for (const cell of matrix.cells.values()) max = Math.max(max, metricValue(cell.measures, shadeMetric) ?? 0);
    return max;
  }, [matrix, shadeMetric]);

  return (
    <>
      {matrix.rowIds.length === 0 ? (
        <EmptyState size="compact" title={t('insights.no_usage')} />
      ) : (
        <div className={styles['matrix-scroll']}>
          <table className={styles['matrix']}>
            <thead>
              <tr>
                <th className={styles['matrix-corner']} scope="col">{t(`insights.dim.${rowDimension}`)}</th>
                {matrix.columnIds.map((columnId) => (
                  <th key={columnId} scope="col" title={columnId}>
                    <InsightsValue dimension={columnDimension} id={columnId} labels={labels} className={styles['matrix-column-label']} />
                  </th>
                ))}
                <th scope="col" className={styles['matrix-total']}>{t('insights.total')}</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rowIds.map((rowId) => {
                const rowTotal = matrix.rowTotals.get(rowId);
                return (
                  <tr key={rowId}>
                    <th scope="row" title={rowId}>
                      <InsightsValue dimension={rowDimension} id={rowId} labels={labels} />
                    </th>
                    {matrix.columnIds.map((columnId) => {
                      const cell = matrix.cells.get(matrixCellKey(rowId, columnId));
                      if (!cell) return <td key={columnId} className={styles['matrix-empty']} />;
                      const shadeValue = metricValue(cell.measures, shadeMetric) ?? 0;
                      const shade = heatmapRampMix(shadeValue, shadeMax);
                      // Past the ramp's midpoint the busy stop dominates, and the body ink no longer
                      // clears contrast on it in the light theme; the cell takes the on-accent ink.
                      const isDense = heatmapRampPosition(shadeValue, shadeMax) > 0.55;
                      return (
                        <td key={columnId} data-dimmed={isDimmed?.(rowId, columnId) || undefined}>
                          <button
                            type="button"
                            className={clsx(styles['matrix-cell'], isDense && styles['matrix-cell-dense'])}
                            style={{ '--heatmap-quiet-share': shade.fromShare } as React.CSSProperties}
                            title={`${labels.label(rowDimension, rowId)} · ${labels.label(columnDimension, columnId)}: ${formatMetricExact(metric, cell.value) ?? formatMetric(metric, cell.value, style)}`}
                            onClick={() => onSelectCell(rowId, columnId)}
                          >
                            {formatMetric(metric, cell.value, style)}
                          </button>
                        </td>
                      );
                    })}
                    <td className={styles['matrix-total']}>{rowTotal ? formatMetric(metric, metricValue(rowTotal, metric), style) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};
