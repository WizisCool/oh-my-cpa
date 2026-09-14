import { palette, type ThemeMode } from '../theme/themeConfig';

export type ChartTone = 'accent' | 'success' | 'warn' | 'danger' | 'neutral';

export interface BarMark {
  index: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
  length: number;
  isZero: boolean;
}

export interface BarStripGeometry {
  bars: BarMark[];
  domainMin: number;
  domainMax: number;
  height: number;
  width: number;
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
 * buildBarGeometry computes the mark geometry for a horizontal bar strip.
 *
 * One bar is generated per time bucket, laid out across the width of the card.
 * Bar length encodes the bucket's value monotonically.
 * Zero-value buckets remain representable with a distinct non-zero baseline mark
 * and an explicit isZero flag so they never silently vanish or crash the visual strip.
 * Empty and single-bucket series are supported safely without throwing.
 */
export function buildBarGeometry(
  values: number[],
  height: number,
  width = 1000,
): BarStripGeometry {
  if (values.length === 0) {
    return { bars: [], domainMin: 0, domainMax: 0, height, width };
  }

  const finite = values.map((val) => (Number.isFinite(val) && val >= 0 ? val : 0));
  const max = Math.max(...finite);
  const domainMin = 0;
  const domainMax = max > 0 ? max : 1;

  const count = finite.length;
  const slotWidth = width / count;
  const barWidth = Math.max(1, slotWidth * 0.7);
  const minBarLength = 2; // representable zero-value bucket mark

  const bars: BarMark[] = finite.map((value, index) => {
    const isZero = value === 0;
    const normalized = max > 0 ? value / max : 0;
    const length = isZero ? minBarLength : minBarLength + normalized * Math.max(0, height - minBarLength);
    const x = index * slotWidth + (slotWidth - barWidth) / 2;
    const y = height - length;

    return {
      index,
      value,
      x,
      y,
      width: barWidth,
      height: length,
      length,
      isZero,
    };
  });

  return { bars, domainMin, domainMax, height, width };
}
