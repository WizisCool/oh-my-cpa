import { palette, type ThemeMode } from '../theme/themeConfig';

export type ChartTone = 'accent' | 'success' | 'warn' | 'danger' | 'neutral';

export interface SparkDomain {
  domainMin: number;
  domainMax: number;
}

export interface SparkGeometry {
  linePath: string;
  areaPath: string;
  points: Array<{ x: number; y: number }>;
}

export function sparkColor(mode: ThemeMode, tone: ChartTone): string {
  const colors = palette[mode];
  switch (tone) {
    case 'success':
      return colors.success;
    case 'warn':
      return colors.warn;
    case 'danger':
      return colors.danger;
    case 'neutral':
      return colors.muted;
    case 'accent':
    default:
      return colors.accent;
  }
}

/**
 * sparkDomain keeps a near-flat series from filling the whole box.
 *
 * The area fill reaches the plot floor, so a constant series would render as a
 * solid block. Adding headroom keeps the band readable.
 */
export function sparkDomain(values: number[]): SparkDomain | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const spread = max - min;
  if (spread > 0) {
    return { domainMin: Math.max(0, min - spread * 0.25), domainMax: max + spread * 0.2 };
  }
  const ceiling = max > 0 ? max * 3 : 1;
  return { domainMin: 0, domainMax: ceiling };
}

function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const commands = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[index + 2] ?? next;
    const control1X = current.x + (next.x - previous.x) / 6;
    const control1Y = current.y + (next.y - previous.y) / 6;
    const control2X = next.x - (afterNext.x - current.x) / 6;
    const control2Y = next.y - (afterNext.y - current.y) / 6;
    commands.push(
      `C ${control1X.toFixed(2)} ${control1Y.toFixed(2)}, ${control2X.toFixed(2)} ${control2Y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`,
    );
  }
  return commands.join(' ');
}

/**
 * buildSparkGeometry converts a series into two deliberately separate marks.
 * The area path is fill-only; the line path carries the stroke. Keeping them
 * separate prevents a stroke from drawing the area's closing baseline.
 */
export function buildSparkGeometry(
  values: number[],
  domain: SparkDomain,
  height: number,
  width = 1000,
): SparkGeometry {
  const finite = values.map((value) => (Number.isFinite(value) ? value : 0));
  const spread = domain.domainMax - domain.domainMin || 1;
  const top = 2;
  const bottom = Math.max(top + 1, height - 2);
  const points = finite.map((value, index) => ({
    x: finite.length === 1 ? width / 2 : (index / (finite.length - 1)) * width,
    y: bottom - ((value - domain.domainMin) / spread) * (bottom - top),
  }));
  const linePath = smoothPath(points);
  const areaPath = points.length > 1
    ? `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${height} L ${points[0].x.toFixed(2)} ${height} Z`
    : '';
  return { linePath, areaPath, points };
}
