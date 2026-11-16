export interface SparklinePoint {
  readonly x: number;
  readonly y: number | null;
  readonly t: number;
  readonly value: number | null;
}

export interface SparklineMarker {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  readonly value: number;
}

export interface SparklineGeometry {
  readonly points: readonly SparklinePoint[];
  readonly isolatedPoints: readonly SparklineMarker[];
  readonly linePath: string;
  readonly areaPath: string;
  readonly x0: number;
  readonly x1: number;
  readonly yTop: number;
  readonly yBottom: number;
  readonly hasData: boolean;
  readonly hasPositiveValue: boolean;
  readonly hasGaps: boolean;
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
 * Null samples break the series cleanly at their true time-grid slots instead of interpolating
 * across idle stretches or collapsing them to zero.
 */
export function buildMonotoneSparkline(
  samples: ReadonlyArray<{ readonly t: number; readonly value: number | null }>,
  width: number,
  height: number,
  margin: SparklineMargin = DEFAULT_SPARKLINE_MARGIN,
  maxDomain?: number,
): SparklineGeometry {
  const x0 = margin.left;
  const x1 = Math.max(x0 + 1, width - margin.right);
  const yTop = margin.top;
  const yBottom = Math.max(yTop + 1, height - margin.bottom);
  const n = samples.length;

  if (n === 0) {
    return {
      points: [],
      isolatedPoints: [],
      linePath: '',
      areaPath: '',
      x0,
      x1,
      yTop,
      yBottom,
      hasData: false,
      hasPositiveValue: false,
      hasGaps: false,
      isSinglePoint: false,
    };
  }

  let maxValue = 0;
  let hasData = false;
  let hasGaps = false;
  for (let i = 0; i < n; i += 1) {
    const raw = samples[i]!.value;
    if (raw === null || !Number.isFinite(raw)) {
      hasGaps = true;
      continue;
    }
    hasData = true;
    const v = Math.max(0, raw);
    if (v > maxValue) maxValue = v;
  }
  const hasPositiveValue = maxValue > 0;
  const domainMax =
    maxDomain !== undefined && Number.isFinite(maxDomain) && maxDomain > 0
      ? Math.max(maxDomain, maxValue)
      : (hasPositiveValue ? maxValue : 1);
  const plotWidth = x1 - x0;
  const plotHeight = yBottom - yTop;

  const points: SparklinePoint[] = new Array<SparklinePoint>(n);
  if (n === 1) {
    const sample = samples[0]!;
    const x = (x0 + x1) / 2;
    if (sample.value === null || !Number.isFinite(sample.value)) {
      points[0] = { x, y: null, t: sample.t, value: null };
      return {
        points,
        isolatedPoints: [],
        linePath: '',
        areaPath: '',
        x0,
        x1,
        yTop,
        yBottom,
        hasData: false,
        hasPositiveValue: false,
        hasGaps: true,
        isSinglePoint: false,
      };
    }
    const v = Math.max(0, sample.value);
    points[0] = {
      x,
      y: yBottom - (v / domainMax) * plotHeight,
      t: sample.t,
      value: v,
    };
    return {
      points,
      isolatedPoints: [],
      linePath: '',
      areaPath: '',
      x0,
      x1,
      yTop,
      yBottom,
      hasData: true,
      hasPositiveValue,
      hasGaps: false,
      isSinglePoint: true,
    };
  }

  const runs: SparklineMarker[][] = [];
  let activeRun: SparklineMarker[] | null = null;
  for (let i = 0; i < n; i += 1) {
    const sample = samples[i]!;
    const x = x0 + (i / (n - 1)) * plotWidth;
    if (sample.value === null || !Number.isFinite(sample.value)) {
      points[i] = { x, y: null, t: sample.t, value: null };
      activeRun = null;
      continue;
    }
    const v = Math.max(0, sample.value);
    const y = yBottom - (v / domainMax) * plotHeight;
    const marker: SparklineMarker = { x, y, t: sample.t, value: v };
    points[i] = marker;
    if (!activeRun) {
      activeRun = [marker];
      runs.push(activeRun);
    } else {
      activeRun.push(marker);
    }
  }

  const lineSegments: string[] = [];
  const areaSegments: string[] = [];
  const isolatedPoints: SparklineMarker[] = [];

  for (const run of runs) {
    if (run.length === 1) {
      isolatedPoints.push(run[0]!);
      continue;
    }
    if (run.length === 2) {
      const p0 = run[0]!;
      const p1 = run[1]!;
      const seg = `M${fmt(p0.x)},${fmt(p0.y)}L${fmt(p1.x)},${fmt(p1.y)}`;
      lineSegments.push(seg);
      areaSegments.push(`${seg}L${fmt(p1.x)},${fmt(yBottom)}L${fmt(p0.x)},${fmt(yBottom)}Z`);
      continue;
    }
    const m = run.length;
    const tangents = new Float64Array(m);
    for (let i = 1; i < m - 1; i += 1) {
      const prev = run[i - 1]!;
      const curr = run[i]!;
      const next = run[i + 1]!;
      tangents[i] = slope3(prev.x, prev.y, curr.x, curr.y, next.x, next.y);
    }
    tangents[0] = slope2(run[0]!.x, run[0]!.y, run[1]!.x, run[1]!.y, tangents[1]!);
    tangents[m - 1] = slope2(
      run[m - 2]!.x,
      run[m - 2]!.y,
      run[m - 1]!.x,
      run[m - 1]!.y,
      tangents[m - 2]!,
    );

    const first = run[0]!;
    const segments: string[] = [`M${fmt(first.x)},${fmt(first.y)}`];
    for (let i = 0; i < m - 1; i += 1) {
      const p0 = run[i]!;
      const p1 = run[i + 1]!;
      const dx = (p1.x - p0.x) / 3;
      const t0 = tangents[i]!;
      const t1 = tangents[i + 1]!;
      segments.push(
        `C${fmt(p0.x + dx)},${fmt(p0.y + dx * t0)},${fmt(p1.x - dx)},${fmt(p1.y - dx * t1)},${fmt(p1.x)},${fmt(p1.y)}`,
      );
    }
    const runLine = segments.join('');
    const last = run[m - 1]!;
    lineSegments.push(runLine);
    areaSegments.push(`${runLine}L${fmt(last.x)},${fmt(yBottom)}L${fmt(first.x)},${fmt(yBottom)}Z`);
  }

  return {
    points,
    isolatedPoints,
    linePath: lineSegments.join(''),
    areaPath: areaSegments.join(''),
    x0,
    x1,
    yTop,
    yBottom,
    hasData,
    hasPositiveValue,
    hasGaps,
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
