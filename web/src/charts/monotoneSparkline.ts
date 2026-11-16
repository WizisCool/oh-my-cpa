export interface SparklinePoint {
  readonly x: number;
  readonly y: number | null;
  readonly t: number;
  readonly value: number | null;
}

interface SparklineMarker {
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
  /** Exactly one bucket carries a value; it is drawn as a dot at its own x. */
  readonly singlePoint: SparklineMarker | null;
}

export interface SparklineMargin {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Vertical value range mapped onto the plot; values outside it rest on the nearer edge. */
export interface SparklineDomain {
  readonly min: number;
  readonly max: number;
}

/** How a ratio series fits its own range instead of hanging from zero. */
export interface SparklineFit {
  /** Smallest span shown, so a steady series reads as a gentle wave rather than noise blown up. */
  readonly minSpan: number;
  readonly floor: number;
  readonly ceiling: number;
}

export const DEFAULT_SPARKLINE_MARGIN: SparklineMargin = {
  top: 6,
  right: 6,
  bottom: 2,
  left: 6,
};

// A bucket fed less than this share of the average bucket's volume does not set a ratio's range:
// a stray request at night or the bucket that has only just begun can swing to any ratio, and
// letting it set the scale would pin every well-fed bucket against one edge.
const FIT_LIGHT_SHARE = 0.1;

/**
 * Fits a ratio series to the range its well-fed buckets span. A light bucket cannot stretch the
 * scale; it still plots, on the nearer edge, and the readout still prints its exact value.
 */
export function fitSparklineDomain(
  samples: ReadonlyArray<{ readonly value: number | null; readonly weight?: number }>,
  fit: SparklineFit,
): SparklineDomain {
  const measured = samples.flatMap((sample) =>
    sample.value !== null && Number.isFinite(sample.value)
      ? [{ value: sample.value, weight: Math.max(0, sample.weight ?? 0) }]
      : []);
  if (measured.length === 0) return { min: fit.floor, max: fit.ceiling };

  const meanWeight = measured.reduce((sum, sample) => sum + sample.weight, 0) / measured.length;
  const wellFed = measured.filter((sample) => sample.weight >= meanWeight * FIT_LIGHT_SHARE);
  const values = (wellFed.length > 0 ? wellFed : measured).map((sample) => sample.value);
  const low = Math.min(...values);
  const high = Math.max(...values);

  const span = Math.min(fit.ceiling - fit.floor, Math.max(fit.minSpan, high - low));
  let min = (low + high - span) / 2;
  min = Math.min(Math.max(min, fit.floor), fit.ceiling - span);
  return { min, max: min + span };
}

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
 * A null sample has no value to plot (a ratio over an idle bucket): it keeps its time slot and
 * its readout, and the curve runs on between its measured neighbours instead of breaking.
 * Without a `domain` the scale hangs from zero up to the largest value.
 */
export function buildMonotoneSparkline(
  samples: ReadonlyArray<{ readonly t: number; readonly value: number | null }>,
  width: number,
  height: number,
  margin: SparklineMargin = DEFAULT_SPARKLINE_MARGIN,
  domain?: SparklineDomain,
): SparklineGeometry {
  const x0 = margin.left;
  const x1 = Math.max(x0 + 1, width - margin.right);
  const yTop = margin.top;
  const yBottom = Math.max(yTop + 1, height - margin.bottom);
  const n = samples.length;

  let maxValue = 0;
  for (const sample of samples) {
    if (sample.value !== null && Number.isFinite(sample.value) && sample.value > maxValue) maxValue = sample.value;
  }
  const hasPositiveValue = maxValue > 0;
  const domainMin = domain ? domain.min : 0;
  const domainSpan = domain ? Math.max(domain.max - domain.min, Number.EPSILON) : (hasPositiveValue ? maxValue : 1);
  const plotWidth = x1 - x0;
  const plotHeight = yBottom - yTop;

  const points: SparklinePoint[] = new Array<SparklinePoint>(n);
  const measured: SparklineMarker[] = [];
  for (let i = 0; i < n; i += 1) {
    const sample = samples[i]!;
    const x = n === 1 ? (x0 + x1) / 2 : x0 + (i / (n - 1)) * plotWidth;
    if (sample.value === null || !Number.isFinite(sample.value)) {
      points[i] = { x, y: null, t: sample.t, value: null };
      continue;
    }
    const v = Math.max(0, sample.value);
    const ratio = Math.min(1, Math.max(0, (v - domainMin) / domainSpan));
    const marker: SparklineMarker = { x, y: yBottom - ratio * plotHeight, t: sample.t, value: v };
    points[i] = marker;
    measured.push(marker);
  }

  const base = { points, x0, x1, yTop, yBottom, hasPositiveValue };
  if (measured.length < 2) {
    return { ...base, linePath: '', areaPath: '', singlePoint: measured[0] ?? null };
  }

  const m = measured.length;
  const tangents = new Float64Array(m);
  for (let i = 1; i < m - 1; i += 1) {
    const prev = measured[i - 1]!;
    const curr = measured[i]!;
    const next = measured[i + 1]!;
    tangents[i] = slope3(prev.x, prev.y, curr.x, curr.y, next.x, next.y);
  }
  if (m === 2) {
    const slope = (measured[1]!.y - measured[0]!.y) / (measured[1]!.x - measured[0]!.x || 1);
    tangents[0] = slope;
    tangents[1] = slope;
  } else {
    tangents[0] = slope2(measured[0]!.x, measured[0]!.y, measured[1]!.x, measured[1]!.y, tangents[1]!);
    tangents[m - 1] = slope2(
      measured[m - 2]!.x,
      measured[m - 2]!.y,
      measured[m - 1]!.x,
      measured[m - 1]!.y,
      tangents[m - 2]!,
    );
  }

  const first = measured[0]!;
  const last = measured[m - 1]!;
  const segments: string[] = [`M${fmt(first.x)},${fmt(first.y)}`];
  for (let i = 0; i < m - 1; i += 1) {
    const p0 = measured[i]!;
    const p1 = measured[i + 1]!;
    const dx = (p1.x - p0.x) / 3;
    const t0 = tangents[i]!;
    const t1 = tangents[i + 1]!;
    segments.push(
      `C${fmt(p0.x + dx)},${fmt(p0.y + dx * t0)},${fmt(p1.x - dx)},${fmt(p1.y - dx * t1)},${fmt(p1.x)},${fmt(p1.y)}`,
    );
  }
  const linePath = segments.join('');
  return {
    ...base,
    linePath,
    areaPath: `${linePath}L${fmt(last.x)},${fmt(yBottom)}L${fmt(first.x)},${fmt(yBottom)}Z`,
    singlePoint: null,
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
