import { theme, type ThemeConfig } from 'antd';

import type { ResolvedPalette, ThemePalette } from './palette';

/**
 * The palette projected onto Ant Design, and onto the stylesheet's custom properties.
 *
 * This module computes nothing about colour. A palette is resolved once in `palette.ts`, and this
 * is one of the surfaces that reads it - the same way the chart runtime, the Monaco editor and the
 * brand artwork do. That separation is why a custom palette reaches every one of those surfaces
 * without any of them knowing custom palettes exist.
 */

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

/**
 * The app's mono stack, exported for the chart runtime.
 *
 * A canvas cannot inherit a font: the axis and tooltip text a chart draws is measured and painted by
 * the library, so it needs the family as a string rather than through the cascade. Sharing this constant
 * is what keeps chart text in the same type scale as everything around it instead of falling back to
 * the library's own sans-serif default.
 */
export const MONO_FONT_STACK = monoFont;

/**
 * A named motion token, in the shape both consumers read it: WAAPI takes an `EffectTiming` (which is
 * this with every field optional) and the chart library takes `duration?: number` with an easing
 * string, so naming the two fields is what lets one token serve both without a cast.
 */
export interface MotionToken {
  readonly duration: number;
  readonly easing: string;
}

/**
 * docs/design.md §7's `roll` token: the dashboard's KPI readouts sweeping to a new value, and the
 * AntV marks behind them morphing between two revisions.
 *
 * The only motion in the console longer than `base`, and the only one allowed to run on a poll the
 * reader did not ask for - §7 rules 8 and 5 scope it, and ADR 0007 / ADR 0008 record the trade-off.
 * It lives here rather than in the components that consume it because it is a design token: a digit
 * move at `base` is indistinguishable from a redraw, which is the state 240ms exists to leave.
 */
export const MOTION_ROLL: MotionToken = { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * Glyph presence within a readout - a digit entering or leaving the number - on the `base` token.
 *
 * A presence fade is not the readout's motion but the acknowledgement that its digit count changed,
 * and holding it to `base` is what stops an arriving `,000` from trailing the sweep over `roll`.
 */
export const MOTION_ROLL_PRESENCE: MotionToken = { duration: 100, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

export function createThemeConfig(resolved: Pick<ResolvedPalette, 'mode' | 'palette'>): ThemeConfig {
  const dark = resolved.mode === 'dark';
  const t = resolved.palette;

  const noShadow = {
    boxShadow: 'none',
    boxShadowSecondary: 'none',
    boxShadowTertiary: 'none',
    boxShadowCard: 'none',
    boxShadowDrawerUp: 'none',
    boxShadowDrawerDown: 'none',
    boxShadowDrawerLeft: 'none',
    boxShadowDrawerRight: 'none',
  } as const;

  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      fontFamily: monoFont,
      fontSize: 14,
      fontSizeSM: 13,
      fontSizeLG: 16,
      fontSizeXL: 20,
      fontSizeHeading1: 24,
      fontSizeHeading2: 20,
      fontSizeHeading3: 16,
      fontSizeHeading4: 14,
      ...noShadow,

      colorPrimary: t.accentHover,
      colorPrimaryHover: t.accentActive,
      colorPrimaryActive: t.accentActive,
      colorInfo: t.accent,
      colorLink: t.accent,
      colorLinkHover: t.accent,
      colorSuccess: t.success,
      colorWarning: t.warn,
      colorError: t.danger,

      colorTextBase: t.fg,
      colorBgBase: t.bg,
      colorText: t.fg,
      colorTextSecondary: t.fg2,
      colorTextTertiary: t.muted,
      colorTextQuaternary: t.meta,
      colorBorder: t.border,
      colorBorderSecondary: t.borderSoft,
      colorSplit: t.borderSoft,
      colorBgContainer: t.bg,
      colorBgElevated: t.elevated,
      colorBgLayout: t.bg,
      colorFillTertiary: t.surface,
      colorFillQuaternary: t.surface,
      colorBgSpotlight: t.tooltipBg,

      borderRadius: 4,
      borderRadiusLG: 6,
      borderRadiusSM: 4,
      wireframe: false,
      motionDurationFast: '0.05s',
      motionDurationMid: '0.1s',
      motionDurationSlow: '0.1s',
    },
    components: {
      Layout: {
        bodyBg: t.bg,
        headerBg: t.bg,
        headerHeight: 56,
        headerPadding: '0 24px 0 16px',
        siderBg: t.bg,
      },
      Menu: {
        itemBg: t.bg,
        darkItemBg: t.bg,
        subMenuItemBg: t.bg,
        darkSubMenuItemBg: t.bg,
        popupBg: t.elevated,
        itemHeight: 34,
        iconMarginInlineEnd: 10,
        itemBorderRadius: 4,
        itemColor: t.muted,
        darkItemColor: t.muted,
        itemHoverColor: t.fg,
        darkItemHoverBg: t.hover,
        darkItemHoverColor: t.fg,
        itemSelectedBg: 'transparent',
        itemSelectedColor: t.fg,
        darkItemSelectedBg: 'transparent',
        darkItemSelectedColor: t.fg,
        activeBarBorderWidth: 0,
      },
      Card: {
        ...noShadow,
        paddingLG: 20,
        borderRadiusLG: 4,
        colorBorderSecondary: t.border,
      },
      Table: {
        headerBg: dark ? t.bg : t.surface,
        borderColor: t.borderSoft,
        rowHoverBg: t.rowHover,
        headerColor: t.muted,
        cellPaddingBlockSM: 8,
        cellPaddingInlineSM: 12,
        fontSize: 13.5,
        fontSizeSM: 13,
        headerSplitColor: t.border,
      },
      Button: {
        controlHeight: 32,
        controlHeightSM: 28,
        fontSizeSM: 13,
        fontWeight: 500,
        // The label of a filled primary control. Ant Design derives this token from
        // `colorTextLightSolid`, which is white in every palette, so a palette whose accent fill is
        // light would otherwise draw a white label on it. `accentOn` is solved by the derivation, so
        // this is the same value on a built-in palette and on an operator's own.
        primaryColor: t.accentOn,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
        iconGap: 6,
      },
      Input: {
        controlHeight: 32,
        controlHeightSM: 28,
        fontSizeSM: 13,
        activeBorderColor: t.accent,
        hoverBorderColor: t.muted,
        activeShadow: `0 0 0 2px ${t.accent}22`,
      },
      InputNumber: {
        controlHeight: 32,
        controlHeightSM: 28,
        fontSizeSM: 13,
        activeBorderColor: t.accent,
        hoverBorderColor: t.muted,
        activeShadow: `0 0 0 2px ${t.accent}22`,
      },
      Segmented: {
        controlHeight: 32,
        controlHeightSM: 28,
        fontSizeSM: 13,
        trackBg: dark ? t.bg : t.border,
        itemSelectedBg: dark ? t.border : t.elevated,
        itemColor: t.fg2,
        itemSelectedColor: t.fg,
        itemHoverBg: 'transparent',
      },
      Tabs: {
        horizontalItemPadding: '8px 4px',
        horizontalMargin: '0 0 16px 0',
        itemSelectedColor: t.fg,
        itemHoverColor: t.fg,
        titleFontSizeSM: 13.5,
        titleFontSize: 14,
      },
      Drawer: { ...noShadow },
      Modal: { ...noShadow },
      Popover: { ...noShadow, colorBgElevated: t.elevated },
      Dropdown: { ...noShadow, colorBgElevated: t.elevated },
      Select: { optionSelectedBg: t.selected, optionSelectedColor: t.fg, colorBgElevated: t.elevated },
      Tooltip: { colorBgSpotlight: t.tooltipBg },
      Switch: { colorPrimary: t.success, colorPrimaryHover: t.success },
      Tag: { borderRadiusSM: 4, defaultBg: t.bg },
      Progress: { remainingColor: t.border },
      Descriptions: { itemPaddingBottom: 10 },
      Statistic: { contentFontSize: 26 },
      Alert: { borderRadiusLG: 4 },
      Empty: { colorIcon: t.meta },
      Spin: { colorPrimary: t.muted },
    },
  };
}

export function themePaletteCssVariables(palette: ThemePalette): Record<string, string> {
  const variables: Record<string, string> = {
    '--bg': palette.bg,
    '--surface': palette.surface,
    '--bg-surface': palette.surface,
    '--elevated': palette.elevated,
    '--fg': palette.fg,
    '--fg-2': palette.fg2,
    '--muted': palette.muted,
    '--meta': palette.meta,
    '--border': palette.border,
    '--border-soft': palette.borderSoft,
    '--hover-inset': palette.hoverInset,
    '--selected-inset': palette.selected,
    '--accent': palette.accent,
    '--accent-hover': palette.accentHover,
    '--accent-active': palette.accentActive,
    '--accent-on': palette.accentOn,
    '--success': palette.success,
    '--warn': palette.warn,
    '--danger': palette.danger,
    '--cache-rate-yellow': palette.cacheRateYellow,
    '--cache-rate-green': palette.cacheRateGreen,
    '--heatmap-quiet': palette.heatmapQuiet,
    '--heatmap-busy': palette.heatmapBusy,
    '--heatmap-zero-unrecorded': palette.heatmapZeroUnrecorded,
    '--heatmap-zero-recorded': palette.heatmapZeroRecorded,
    '--heatmap-tip-link': palette.heatmapTipLink,
    '--series-track': palette.seriesTrack,
  };
  palette.series.forEach((color, index) => {
    variables[`--series-${index + 1}`] = color;
  });
  return variables;
}
