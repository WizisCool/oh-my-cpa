import { theme, type ThemeConfig } from 'antd';

import { THREAD_FILL_SHARES, THREAD_RADII, type ResolvedPalette, type ThemePalette } from './palette';

/**
 * The palette projected onto Ant Design, and onto the stylesheet's custom properties.
 *
 * This module computes nothing about colour. A palette is resolved once in `palette.ts`, and this
 * is one of the surfaces that reads it - the same way the chart runtime, the Monaco editor and the
 * brand artwork do. That separation is why a custom palette reaches every one of those surfaces
 * without any of them knowing custom palettes exist. Phone layouts use the existing spacing scale
 * in CSS; shared component tokens keep their desktop sizes.
 */

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
export const MOTION_ROLL_PRESENCE: MotionToken = { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * docs/design.md §7's `scroll` token: one wheel notch or scrolling key gliding to where it would have
 * jumped (`web/src/utils/scrollSmoothing.ts`).
 *
 * Long enough that a 100px notch reads as travel rather than a cut, short enough that a turning
 * wheel never trails the hand: each notch retargets the glide, so the token bounds the lag behind the
 * last notch, not the length of a scroll. The easing is easeOutCubic, spelled here as its CSS curve,
 * rather than the console's `ease`: that curve starts at rest, and a glide restarted at every notch
 * would stall at each one.
 */
export const MOTION_SCROLL: MotionToken = { duration: 160, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' };

/**
 * docs/design.md §7's `route` token: one hop of a stored request travelling the routing map, from
 * the caller to the gateway or from the gateway to the credential that answered it.
 *
 * The only motion that runs on a live signal rather than on an action or a poll (§7 rule 9). It is
 * longer than `roll` because the reader has to follow a point across most of the map's width, which
 * a quarter second does not allow; it is a fixed length rather than one scaled by distance so a
 * reroute's second hop lands on the same beat as a first. The easing starts and ends at rest, unlike
 * the console's `ease`, because the hop begins at one node and settles on another.
 */
export const MOTION_ROUTE: MotionToken = { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };

/** The answering credential's acknowledgement when a hop lands on it: one fade, never repeated. */
export const MOTION_ROUTE_LAND: MotionToken = { duration: 420, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * A routing-map node or lane lighting as a request reaches it and settling back: the light rises
 * over the first sixth and decays over the rest, so a card glows as the dot docks and cools while the
 * reader's eye moves on, instead of blinking.
 */
export const MOTION_ROUTE_GLOW: MotionToken = { duration: 1200, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' };

/**
 * A routing-map row sliding to close or open a gap as rows enter and leave the rolling minute. On
 * the decelerating curve, so the column settles rather than stops.
 */
export const MOTION_ROUTE_PRESENCE: MotionToken = { duration: 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/**
 * A routing-map row arriving: it fades in while drifting a few pixels from its own edge of the map,
 * on the console's decelerating curve. Longer than a transition because a row arriving is an event
 * the reader should notice, and never past its target: the console has no bounce (§7).
 */
export const MOTION_ROUTE_ENTER: MotionToken = { duration: 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/** A routing-map row leaving the minute: shorter than its arrival and accelerating away. */
export const MOTION_ROUTE_EXIT: MotionToken = { duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)' };

/** A live label repeats this glyph-only sweep; unlike a transition, its period lasts with the work. */
export const MOTION_LIVE_TEXT: MotionToken = { duration: 900, easing: 'linear' };

/** The ink at a share of opacity, as an eight-digit hex every consumer of a token can parse. */
function inkWash(ink: string, share: number): string {
  return `${ink}${Math.round((share / 100) * 255).toString(16).padStart(2, '0')}`;
}

export function createThemeConfig(resolved: Pick<ResolvedPalette, 'mode' | 'palette'>): ThemeConfig {
  const dark = resolved.mode === 'dark';
  const t = resolved.palette;

  // Static surfaces stay flat: a card is a fill and a hairline. The stylesheet gives the floating
  // layers their shadow from `--shadow-float` and `--shadow-overlay`, so the elevation follows the
  // palette's mode without the theme being rebuilt (design.md §4).
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
      // The custom properties rather than a family list: the operator's typeface choice is
      // written to them on the root element, so Ant Design's components follow it like the
      // stylesheet does without the theme being rebuilt.
      fontFamily: 'var(--font-ui)',
      fontFamilyCode: 'var(--font-mono)',
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
      // A filled field is a wash of the ink, not the surface colour: a field drawn in `--surface`
      // vanished on every card painted `--surface`, and a wash stands one step off whatever ground
      // it sits on. The shares are the conversation fields', so every field in the console is one.
      colorFillTertiary: inkWash(t.fg, THREAD_FILL_SHARES.field),
      colorFillSecondary: inkWash(t.fg, THREAD_FILL_SHARES.fieldHover),
      colorFillQuaternary: t.surface,
      colorBgSpotlight: t.tooltipBg,

      // design.md §4's corner scale: controls 6, menus and popovers 8, cards and dialogs 12.
      borderRadius: 6,
      borderRadiusSM: 6,
      borderRadiusLG: 12,
      borderRadiusXS: 2,
      borderRadiusOuter: 8,
      wireframe: false,
      motionDurationFast: '0.12s',
      motionDurationMid: '0.18s',
      motionDurationSlow: '0.24s',
      motionEaseOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
      motionEaseInOut: 'cubic-bezier(0.2, 0, 0, 1)',
    },
    components: {
      // The shell stands on the canvas; the page is drawn in the content panel at `bg`.
      Layout: {
        bodyBg: t.canvas,
        headerBg: t.bg,
        headerHeight: 52,
        headerPadding: '0 20px 0 12px',
        siderBg: t.canvas,
      },
      // The rail's entries are soft filled rows: the selected one is a fill a step off the
      // canvas, never a coloured bar, because the rail is chrome and the colour belongs to data.
      Menu: {
        itemBg: 'transparent',
        darkItemBg: 'transparent',
        subMenuItemBg: 'transparent',
        darkSubMenuItemBg: 'transparent',
        popupBg: t.elevated,
        itemHeight: 32,
        iconMarginInlineEnd: 10,
        itemBorderRadius: 8,
        itemColor: t.fg2,
        darkItemColor: t.fg2,
        itemHoverColor: t.fg,
        darkItemHoverBg: t.hover,
        darkItemHoverColor: t.fg,
        itemSelectedBg: t.hover,
        itemSelectedColor: t.fg,
        darkItemSelectedBg: t.hover,
        darkItemSelectedColor: t.fg,
        activeBarBorderWidth: 0,
      },
      Card: {
        ...noShadow,
        paddingLG: 20,
        borderRadiusLG: 12,
        colorBorderSecondary: t.border,
      },
      Table: {
        // No header band: the column names are captions over the rows, divided from them by the
        // same soft rule the rows use, as the request list draws its head.
        headerBg: t.bg,
        borderColor: t.borderSoft,
        rowHoverBg: t.rowHover,
        headerColor: t.muted,
        cellPaddingBlockSM: 8,
        cellPaddingInlineSM: 12,
        fontSize: 13.5,
        fontSizeSM: 13,
        headerSplitColor: 'transparent',
      },
      // Request rows supply their own padding. This token keeps Listy's initial
      // height estimate near their 72 px minimum instead of mounting extra rows.
      Listy: { itemPaddingBlock: 25 },
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
        // A secondary button is a soft fill rather than an outline: hairlines belong to the things
        // that enclose content, and a toolbar of outlined buttons drew a box around every verb.
        // The fills are the foreground washed over whatever the button stands on, so the same
        // button reads on the page, on a card and on the canvas. The label stays in the text
        // colour under the pointer - the fill deepening is the acknowledgement - because the
        // accent is a link and a selection, not a hover.
        defaultBg: 'color-mix(in srgb, var(--fg) 6%, transparent)',
        defaultBorderColor: 'transparent',
        defaultColor: t.fg,
        defaultHoverBg: 'color-mix(in srgb, var(--fg) 10%, transparent)',
        defaultHoverBorderColor: 'transparent',
        defaultHoverColor: t.fg,
        defaultActiveBg: 'color-mix(in srgb, var(--fg) 13%, transparent)',
        defaultActiveBorderColor: 'transparent',
        defaultActiveColor: t.fg,
        textHoverBg: 'color-mix(in srgb, var(--fg) 6%, transparent)',
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
      // A track filled one step off the page with a raised thumb: the choice reads as a physical
      // switch position rather than as a row of outlined buttons.
      Segmented: {
        controlHeight: 32,
        controlHeightSM: 28,
        fontSizeSM: 13,
        borderRadius: 8,
        borderRadiusSM: 6,
        trackPadding: 2,
        trackBg: t.surface,
        itemSelectedBg: dark ? t.border : t.elevated,
        itemColor: t.muted,
        itemSelectedColor: t.fg,
        itemHoverColor: t.fg,
        itemHoverBg: 'transparent',
        itemActiveBg: 'transparent',
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
      Modal: { ...noShadow, borderRadiusLG: 12, titleFontSize: 16 },
      Popover: { ...noShadow, colorBgElevated: t.elevated, borderRadiusLG: 10 },
      Dropdown: { ...noShadow, colorBgElevated: t.elevated, borderRadiusLG: 10, borderRadiusSM: 6, paddingBlock: 6, controlPaddingHorizontal: 10 },
      Select: { optionSelectedBg: t.hover, optionSelectedColor: t.fg, optionSelectedFontWeight: 500, colorBgElevated: t.elevated, borderRadiusLG: 10, borderRadiusSM: 6 },
      Tooltip: { colorBgSpotlight: t.tooltipBg, borderRadius: 8 },
      Tag: { borderRadiusSM: 6, defaultBg: t.bg },
      // `--radius-check`: the control step would round a 16px box into a dot.
      Checkbox: { borderRadiusSM: 4 },
      Progress: { remainingColor: t.border },
      Descriptions: { itemPaddingBottom: 10 },
      Statistic: { contentFontSize: 26 },
      // Every toast is one width - a report with file names and reasons included - because antd
      // lays toasts out in a column of this width, and a wider notice would overhang it.
      Notification: { width: 420, borderRadiusLG: 12, colorBgElevated: t.elevated },
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
    '--canvas': palette.canvas,
    '--elevated': palette.elevated,
    '--fg': palette.fg,
    '--fg-2': palette.fg2,
    '--muted': palette.muted,
    '--meta': palette.meta,
    '--border': palette.border,
    '--border-soft': palette.borderSoft,
    '--hover': palette.hover,
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
    '--motion-live-text': `${MOTION_LIVE_TEXT.duration}ms`,
    '--radius-document': `${THREAD_RADII.document}px`,
    '--radius-control': `${THREAD_RADII.control}px`,
    '--radius-surface': `${THREAD_RADII.surface}px`,
    '--radius-thread': `${THREAD_RADII.thread}px`,
    '--thread-field': `color-mix(in srgb, var(--fg) ${THREAD_FILL_SHARES.field}%, transparent)`,
    '--thread-field-hover': `color-mix(in srgb, var(--fg) ${THREAD_FILL_SHARES.fieldHover}%, transparent)`,
    '--thread-hairline': `color-mix(in srgb, var(--fg) ${THREAD_FILL_SHARES.hairline}%, transparent)`,
  };
  palette.series.forEach((color, index) => {
    variables[`--series-${index + 1}`] = color;
  });
  palette.route.forEach((color, index) => {
    variables[`--route-${index + 1}`] = color;
  });
  palette.effort.forEach((color, index) => {
    variables[`--effort-${index + 1}`] = color;
  });
  return variables;
}
