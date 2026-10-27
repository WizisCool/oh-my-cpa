import type { EChartsCoreOption } from './core';
import type { ThemePalette } from '../../theme/palette';
import { MOTION_FAST, MOTION_ROLL } from '../../theme/themeConfig';

/**
 * The ECharts theme, derived from the console's palette.
 *
 * Every ink comes from a palette token at full opacity, the same contract the dashboard's charts keep:
 * the series slots for categories, `borderSoft` for the grid, `border` for the axis rule, `fg2` for
 * axis labels and `muted` for the pointer. The background is transparent because a chart is drawn on
 * the panel it sits in, never on a surface of its own. Built per palette, so switching theme repaints
 * the chart in place (`setTheme`) rather than recreating it.
 */
export function buildEchartsTheme(palette: ThemePalette, fontFamily: string): Record<string, unknown> {
  // Pie and sankey own longer series defaults, which otherwise override global motion options.
  const seriesMotion = {
    animationDuration: MOTION_ROLL.duration,
    animationDurationUpdate: MOTION_ROLL.duration,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
  };
  const axis = {
    axisLine: { show: true, lineStyle: { color: palette.border, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: palette.fg2, fontFamily, fontSize: 11 },
    splitLine: { show: true, lineStyle: { color: palette.borderSoft, width: 1 } },
    nameTextStyle: { color: palette.muted, fontFamily },
  };
  return {
    color: [...palette.series],
    backgroundColor: 'transparent',
    textStyle: { color: palette.fg2, fontFamily, fontSize: 11 },
    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: { ...axis, axisLine: { show: false } },
    timeAxis: axis,
    line: { ...seriesMotion, symbol: 'none', smooth: false, lineStyle: { width: 1.6 } },
    bar: { ...seriesMotion, itemStyle: { borderRadius: 0 } },
    pie: { ...seriesMotion },
    sankey: { ...seriesMotion, label: { color: palette.fg, fontFamily }, lineStyle: { color: palette.fg2, opacity: 0.18 } },
    tooltip: {
      backgroundColor: palette.surface,
      borderColor: palette.border,
      borderWidth: 1,
      padding: [6, 8],
      textStyle: { color: palette.fg, fontFamily, fontSize: 11 },
      axisPointer: {
        lineStyle: { color: palette.muted, width: 1 },
        shadowStyle: { color: palette.hover, opacity: 0.6 },
        crossStyle: { color: palette.muted },
      },
    },
    brush: {
      brushStyle: { color: palette.selected, borderColor: palette.accent, borderWidth: 1 },
    },
  };
}

/**
 * The motion every dashboard and Insights chart runs: the console's `roll` token, so a mark morphs between two
 * revisions at the tempo the dashboard's readouts sweep at. Reduced motion swaps the geometry in
 * place - the chart is SVG, but its animation is the library's, which CSS cannot reach.
 */
export function echartsMotion(isReducedMotion: boolean): Record<string, unknown> {
  if (isReducedMotion) return { animation: false, stateAnimation: { duration: 0 } };
  return {
    animation: true,
    stateAnimation: { duration: MOTION_FAST.duration, easing: 'cubicOut' },
    animationDuration: MOTION_ROLL.duration,
    animationDurationUpdate: MOTION_ROLL.duration,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
  };
}

/** Apply after page options so a chart cannot opt out of the console's accessibility policy. */
export function applyEchartsMotion(option: EChartsCoreOption, isReducedMotion: boolean): EChartsCoreOption {
  const motion = echartsMotion(isReducedMotion);
  const mapOptions = (value: unknown, project: (entry: Record<string, unknown>) => Record<string, unknown>) =>
    Array.isArray(value) ? value.map(project) : project((value ?? {}) as Record<string, unknown>);
  return {
    ...motion,
    ...option,
    ...(isReducedMotion ? motion : {}),
    // Explicit normal values restore animations that ECharts would otherwise retain on merge.
    series: option.series === undefined ? undefined : mapOptions(option.series, series => ({
      ...motion,
      ...series,
      ...(isReducedMotion ? motion : { animation: series.animation ?? true }),
    })),
    tooltip: mapOptions(option.tooltip, tooltip => ({
      ...tooltip,
      transitionDuration: isReducedMotion ? 0 : tooltip.transitionDuration ?? MOTION_FAST.duration / 1000,
      axisPointer: {
        ...tooltip.axisPointer as object,
        animation: !isReducedMotion,
        animationDurationUpdate: isReducedMotion ? 0 : MOTION_FAST.duration,
      },
    })),
    axisPointer: mapOptions(option.axisPointer, pointer => ({
      ...pointer,
      animation: !isReducedMotion,
      animationDurationUpdate: isReducedMotion ? 0 : MOTION_FAST.duration,
    })),
  };
}
