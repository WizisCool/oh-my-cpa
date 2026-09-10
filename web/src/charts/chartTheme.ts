/**
 * Chart theming for Ant Design Charts (G2 v5 spec).
 *
 * Every colour here comes from `themeConfig.palette`, the single source of
 * truth declared in docs/design.md, so charts follow the active app theme
 * instead of G2's built-in blue palette. These are plain option factories: the
 * library renders every chart, this file only supplies brand values.
 *
 * Note on config shape: Ant Design Charts v2 turns several top-level keys
 * (`area`, `line`, `point`) into *additional* child marks. Tiny.Area already
 * ships with an area child, so passing `area: {...}` here would stack a second
 * opaque polygon on top — the styling therefore rides on the inherited
 * top-level `style`.
 */
import { palette, type ThemeMode } from '../theme/themeConfig';

export type ChartTone = 'accent' | 'success' | 'warn' | 'danger' | 'neutral';

export interface ChartColors {
  accent: string;
  success: string;
  warn: string;
  danger: string;
  neutral: string;
  text: string;
  heading: string;
  border: string;
  surface: string;
  background: string;
  fontFamily: string;
}

const monoFont = [
  '"Sarasa Mono SC"',
  '"Sarasa UI SC"',
  '"Sarasa Term SC"',
  '"更纱黑体 SC"',
  '"Berkeley Mono"',
  '"IBM Plex Mono"',
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Monaco',
  'Consolas',
  '"Liberation Mono"',
  'monospace',
].join(', ');

/** chartColors resolves design tokens for one theme mode. */
export function chartColors(mode: ThemeMode): ChartColors {
  const source = palette[mode];
  return {
    accent: source.accent,
    success: source.success,
    warn: source.warn,
    danger: source.danger,
    neutral: source.muted,
    text: source.muted,
    heading: source.fg,
    border: source.border,
    surface: source.surface,
    background: source.bg,
    fontFamily: monoFont,
  };
}

export function toneColor(colors: ChartColors, tone: ChartTone): string {
  switch (tone) {
    case 'success':
      return colors.success;
    case 'warn':
      return colors.warn;
    case 'danger':
      return colors.danger;
    case 'neutral':
      return colors.neutral;
    case 'accent':
    default:
      return colors.accent;
  }
}

/**
 * sparkDomain keeps a near-flat series from filling the whole box.
 *
 * An area mark fills down to the scale floor, so a constant series would render
 * as a solid block. Adding headroom above the maximum keeps the band readable.
 */
export function sparkDomain(values: number[]): { domainMin: number; domainMax: number } | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return undefined;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const spread = max - min;
  if (spread > 0) {
    return { domainMin: Math.max(0, min - spread * 0.25), domainMax: max + spread * 0.2 };
  }
  // Flat series: sit it in the lower third of the slot instead of filling it.
  const ceiling = max > 0 ? max * 3 : 1;
  return { domainMin: 0, domainMax: ceiling };
}

interface SparkOverrides {
  height?: number;
  domain?: { domainMin: number; domainMax: number };
  tooltip?: false | Record<string, unknown>;
}

/**
 * sparkOptions configures a compact trend: hairline stroke, flat low-opacity
 * fill (0.13, enough to read the trend without competing with the numbers),
 * no axes, no legend, no entrance animation.
 */
export function sparkOptions(mode: ThemeMode, tone: ChartTone = 'accent', overrides: SparkOverrides = {}) {
  const colors = chartColors(mode);
  const color = toneColor(colors, tone);
  const scale: Record<string, unknown> = {
    color: { range: [color] },
    y: {
      nice: true,
      ...(overrides.domain ? { domainMin: overrides.domain.domainMin, domainMax: overrides.domain.domainMax } : {}),
    },
  };
  return {
    autoFit: true,
    animate: false,
    padding: 0,
    margin: 0,
    legend: false,
    axis: { x: false, y: false },
    tooltip: overrides.tooltip ?? false,
    // The tooltip body is authored by `tooltip` above; its *look* is an
    // interaction option, because G2 renders the panel as HTML outside the
    // canvas and styles it from there.
    interaction: {
      tooltip: {
        css: tooltipStyle(mode),
        // G2's area and line marks always draw a hover rule, and its built-in
        // colour is a near-black hairline: invisible on the dark background,
        // a hard grey stroke on the light one. Canvas styles cannot read CSS
        // variables, so this one rides the palette for the active mode.
        style: { crosshairsStroke: colors.border, crosshairsStrokeOpacity: 1 },
      },
    },
    color,
    scale,
    // A smooth curve reads as a trend; hard polyline segments read as a chart
    // library default. design.md keeps the fill flat (no gradients).
    shapeField: 'smooth',
    style: {
      fill: color,
      fillOpacity: 0.1,
      stroke: color,
      lineWidth: 1.5,
      fontFamily: colors.fontFamily,
    },
  } as const;
}

/**
 * lineOptions is the same treatment without the fill, for series where a band
 * would be misleading (rates, cost).
 */
export function lineOptions(mode: ThemeMode, tone: ChartTone = 'accent', overrides: SparkOverrides = {}) {
  const base = sparkOptions(mode, tone, overrides);
  const colors = chartColors(mode);
  return {
    ...base,
    shapeField: 'smooth',
    style: {
      stroke: toneColor(colors, tone),
      lineWidth: 1.5,
      fontFamily: colors.fontFamily,
    },
  } as const;
}

/** axisChartOptions keeps readable axes for the larger trend panels. */
export function axisChartOptions(mode: ThemeMode, tone: ChartTone = 'accent') {
  const colors = chartColors(mode);
  const color = toneColor(colors, tone);
  return {
    autoFit: true,
    animate: false,
    legend: false,
    color,
    scale: { color: { range: [color] }, y: { nice: true } },
    style: { stroke: color, lineWidth: 1.6, fontFamily: colors.fontFamily },
    axis: {
      x: {
        labelFill: colors.text,
        labelFontSize: 10,
        labelFontFamily: colors.fontFamily,
        line: true,
        lineStroke: colors.border,
        tickStroke: colors.border,
        labelAutoHide: true,
      },
      y: {
        labelFill: colors.text,
        labelFontSize: 10,
        labelFontFamily: colors.fontFamily,
        grid: true,
        gridStroke: colors.border,
        gridStrokeOpacity: 0.55,
        gridLineDash: [2, 3],
      },
    },
    interaction: {
      tooltip: {
        shared: true,
        css: tooltipStyle(mode),
        style: { crosshairsStroke: colors.border, crosshairsStrokeOpacity: 1 },
      },
    },
  } as const;
}

/**
 * tooltipStyle restyles the HTML panel G2 floats over the chart.
 *
 * G2 builds the tooltip as `.g2-tooltip` DOM in the chart container and styles
 * it by deep-mixing `interaction.tooltip.css` over its own defaults — a white
 * panel, a drop shadow, Roboto, round dots and a 0.4s ease that trails the
 * cursor. Those defaults are the one part of a chart that never went through
 * the palette, so the dashboard tooltip still looked like another product.
 *
 * Every value below resolves a CSS custom property first and keeps the palette
 * for `mode` as the fallback. The var() form is what makes it theme-reactive:
 * a tooltip that is already mounted repaints the moment `data-theme` flips,
 * with no chart rebuild and no second copy of the palette in CSS.
 *
 * Property names are kebab-case on purpose — G2 concatenates them straight into
 * `element.style.cssText`, and only an exact key match replaces its default.
 */
export function tooltipStyle(mode: ThemeMode) {
  const colors = chartColors(mode);
  return {
    '.g2-tooltip': {
      'background-color': `var(--surface, ${colors.surface})`,
      color: `var(--fg-2, ${colors.text})`,
      border: `1px solid var(--border, ${colors.border})`,
      'border-radius': '4px',
      'box-shadow': 'none',
      padding: '8px 10px',
      'min-width': '0',
      'max-width': '260px',
      // design.md: the mono stack is inherited, never re-declared.
      'font-family': 'inherit',
      'font-size': '12px',
      'line-height': '18px',
      // Motion here is compositor-only. A panel that eases into place after
      // the pointer reads as lag, not polish — it has to feel hand-following.
      transition: 'none',
    },
    '.g2-tooltip-title': {
      color: `var(--muted, ${colors.text})`,
      'font-size': '11px',
      'letter-spacing': '.06em',
      'margin-bottom': '2px',
    },
    '.g2-tooltip-list': {
      margin: '0',
      padding: '0',
      'list-style-type': 'none',
    },
    '.g2-tooltip-list-item': {
      'line-height': '18px',
    },
    // Series pips are 7×7 squares with a 2px radius (design.md), never circles.
    '.g2-tooltip-list-item-marker': {
      width: '7px',
      height: '7px',
      'border-radius': '2px',
      'margin-right': '8px',
    },
    '.g2-tooltip-list-item-name-label': {
      color: `var(--fg-2, ${colors.text})`,
    },
    '.g2-tooltip-list-item-value': {
      color: `var(--fg, ${colors.heading})`,
      'font-weight': '600',
      'font-variant-numeric': 'tabular-nums',
      'margin-left': '24px',
    },
  };
}
