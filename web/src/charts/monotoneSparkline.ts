export interface SparklinePoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  readonly value: number;
}

export interface SparklineGeometry {
  readonly points: readonly SparklinePoint[];
  readonly linePath: string;
  readonly areaPath: string;
  readonly x0: number;
  readonly x1: number;
  readonly yTop: number;
  readonly yBottom: number;
  readonly hasPositiveValue: boolean;
  readonly isSinglePoint: boolean;
}

export interface SparklineMargin {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const DEFAULT_SPARKLINE_MARGIN: SparklineMargin = {
  top: 6,
  right: 6,
  bottom: 2,
  left: 6,
};

function sign(x: number): number {
  return x < 0 ? -1 : 1;
}

/** Fritsch-Carlson interior tangent matching d3-shape `curveMonotoneX` (`slope3`). */
function slope3(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number {
  const h0 = x1 - x0;
  const h1 = x2 - x1;
  const s0 = (y1 - y0) / (h0 || (h1 < 0 ? -0 : 0));
  const s1 = (y2 - y1) / (h1 || (h0 < 0 ? -0 : 0));
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}

/** One-sided endpoint tangent matching d3-shape `curveMonotoneX` (`slope2`). */
function slope2(x0: number, y0: number, x1: number, y1: number, t: number): number {
  const h = x1 - x0;
  return h ? (3 * (y1 - y0) / h - t) / 2 : t;
}

function fmt(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Builds monotone cubic Hermite SVG line and closed area paths (`curveMonotoneX`) without
 * pulling in Recharts or d3-shape, preserving non-negativity and local extrema with zero overshoot.
 */
export function buildMonotoneSparkline(
  samples: ReadonlyArray<{ readonly t: number; readonly value: number }>,
  width: number,
  height: number,
  margin: SparklineMargin = DEFAULT_SPARKLINE_MARGIN,
): SparklineGeometry {
  const x0 = margin.left;
  const x1 = Math.max(x0 + 1, width - margin.right);
  const yTop = margin.top;
  const yBottom = Math.max(yTop + 1, height - margin.bottom);
  const n = samples.length;

  if (n === 0) {
    return {
      points: [],
      linePath: '',
      areaPath: '',
      x0,
      x1,
      yTop,
      yBottom,
      hasPositiveValue: false,
      isSinglePoint: false,
    };
  }

  let maxValue = 0;
  for (let i = 0; i < n; i += 1) {
    const v = samples[i]!.value;
    if (v > maxValue) maxValue = v;
  }
  const hasPositiveValue = maxValue > 0;
  const domainMax = hasPositiveValue ? maxValue : 1;
  const plotWidth = x1 - x0;
  const plotHeight = yBottom - yTop;

  const points: SparklinePoint[] = new Array<SparklinePoint>(n);
  if (n === 1) {
    const sample = samples[0]!;
    const v = Math.max(0, sample.value);
    points[0] = {
      x: (x0 + x1) / 2,
      y: yBottom - (v / domainMax) * plotHeight,
      t: sample.t,
      value: v,
    };
    return {
      points,
      linePath: '',
      areaPath: '',
      x0,
      x1,
      yTop,
      yBottom,
      hasPositiveValue,
      isSinglePoint: true,
    };
  }

  for (let i = 0; i < n; i += 1) {
    const sample = samples[i]!;
    const v = Math.max(0, sample.value);
    points[i] = {
      x: x0 + (i / (n - 1)) * plotWidth,
      y: yBottom - (v / domainMax) * plotHeight,
      t: sample.t,
      value: v,
    };
  }

  if (n === 2) {
    const p0 = points[0]!;
    const p1 = points[1]!;
    const linePath = `M${fmt(p0.x)},${fmt(p0.y)}L${fmt(p1.x)},${fmt(p1.y)}`;
    const areaPath = `${linePath}L${fmt(p1.x)},${fmt(yBottom)}L${fmt(p0.x)},${fmt(yBottom)}Z`;
    return {
      points,
      linePath,
      areaPath,
      x0,
      x1,
      yTop,
      yBottom,
      hasPositiveValue,
      isSinglePoint: false,
    };
  }

  const tangents = new Float64Array(n);
  for (let i = 1; i < n - 1; i += 1) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;
    tangents[i] = slope3(prev.x, prev.y, curr.x, curr.y, next.x, next.y);
  }
  tangents[0] = slope2(points[0]!.x, points[0]!.y, points[1]!.x, points[1]!.y, tangents[1]!);
  tangents[n - 1] = slope2(
    points[n - 2]!.x,
    points[n - 2]!.y,
    points[n - 1]!.x,
    points[n - 1]!.y,
    tangents[n - 2]!,
  );

  const first = points[0]!;
  const segments: string[] = [`M${fmt(first.x)},${fmt(first.y)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const dx = (p1.x - p0.x) / 3;
    const t0 = tangents[i]!;
    const t1 = tangents[i + 1]!;
    segments.push(
      `C${fmt(p0.x + dx)},${fmt(p0.y + dx * t0)},${fmt(p1.x - dx)},${fmt(p1.y - dx * t1)},${fmt(p1.x)},${fmt(p1.y)}`,
    );
  }

  const linePath = segments.join('');
  const last = points[n - 1]!;
  const areaPath = `${linePath}L${fmt(last.x)},${fmt(yBottom)}L${fmt(first.x)},${fmt(yBottom)}Z`;

  return {
    points,
    linePath,
    areaPath,
    x0,
    x1,
    yTop,
    yBottom,
    hasPositiveValue,
    isSinglePoint: false,
  };
}

  /** Resolves the nearest bucket index for a pointer x-coordinate relative to the host box,
   * accounting for SVG `viewBox="0 0 logicalWidth H"` + `preserveAspectRatio="none"` scaling. */
export function resolveSparklineIndex(
  localX: number,
  hostWidth: number,
  count: number,
  margin: SparklineMargin = DEFAULT_SPARKLINE_MARGIN,
  logicalWidth = 240,
): number | null {
  if (count <= 0) return null;
  if (count === 1) return 0;
  const safeHostWidth = hostWidth > 0 ? hostWidth : logicalWidth;
  const viewBoxX = (localX / safeHostWidth) * logicalWidth;
  const x0 = margin.left;
  const span = Math.max(1, logicalWidth - margin.left - margin.right);
  const ratio = (viewBoxX - x0) / span;
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
}

/** Converts a logical SVG viewBox x-coordinate back into host pixel space. */
export function sparklineViewBoxToHostX(
  viewBoxX: number,
  hostWidth: number,
  logicalWidth = 240,
): number {
  const safeHostWidth = hostWidth > 0 ? hostWidth : logicalWidth;
  return (viewBoxX / logicalWidth) * safeHostWidth;
}

/** Places a pinned-top tooltip beside `cursorX` without escaping `[0, containerWidth]`. */
export function clampSparklineTooltipX(
  cursorX: number,
  containerWidth: number,
  tooltipWidth: number,
  offset = 18,
): number {
  const safeWidth = Math.max(0, containerWidth);
  const maxLeft = Math.max(0, safeWidth - tooltipWidth);
  if (cursorX + offset + tooltipWidth <= safeWidth) {
    return Math.max(0, Math.min(maxLeft, Math.round(cursorX + offset)));
  }
  if (cursorX - offset - tooltipWidth >= 0) {
    return Math.max(0, Math.min(maxLeft, Math.round(cursorX - offset - tooltipWidth)));
  }
  return cursorX <= safeWidth / 2 ? maxLeft : 0;
}
