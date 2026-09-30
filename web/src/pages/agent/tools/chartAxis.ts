import type { DisplayView } from '../../../agent/types';

/**
 * The category axis one agent display uses.
 *
 * Model identifiers are the category names here, so the axis keeps labels horizontal and
 * ellipsises the ones that do not fit: rotated model names read vertically in a tall gutter and
 * push the plot out of the answer's reading rhythm. The tooltip carries the full value.
 */
export function agentChartAxis(formatX: (value: string) => string): { x: Record<string, unknown>; y: Record<string, unknown> } {
  return {
    x: {
      labelFormatter: formatX,
      labelAutoRotate: false,
      labelAutoEllipsis: true,
      labelAutoHide: true,
    },
    y: { labelFormatter: (value: number) => value.toLocaleString() },
  };
}

/** The axis a pie needs: none; the slices carry their shares and the tooltip carries the values. */
export function isPieChart(chart: DisplayView['chart']): boolean {
  return chart?.type === 'pie';
}
