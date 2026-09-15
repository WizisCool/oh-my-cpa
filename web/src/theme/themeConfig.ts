import { theme, type ThemeConfig } from 'antd';

export type ThemeMode = 'dark' | 'light';

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
 * Design tokens for both mode palettes. `docs/design.md` is the source of
 * truth; this object and the `:root` variables in `web/src/index.css` are the
 * only two places that may name a colour, so the app never falls back to
 * antd's default blue.
 */
export const palette = {
  dark: {
    bg: '#121214',
    surface: '#1c1c1f',
    fg: '#f4f4f6',
    fg2: '#a1a1aa',
    muted: '#71717a',
    meta: '#52525b',
    border: '#2c2c30',
    borderSoft: '#222226',
    /* Accent ladder, hue 201. The link step is the bright one because it sits on the dark
       background (6.12:1); the two deeper steps are what white label text can sit on (4.85:1 and
       7.09:1). See docs/design.md §2 for the measured ratios. */
    accent: '#00a2fb',
    accentHover: '#0077b8',
    accentActive: '#005d8f',
    accentOn: '#ffffff',
    success: '#10b981',
    warn: '#f59e0b',
    danger: '#ef4444',
    /* Cache-rate scale (design.md §2): yellow → green, no red. */
    cacheRateYellow: '#f59e0b',
    cacheRateGreen: '#10b981',
    /* Categorical series palette (design.md §2, ADR 0006): ZCode & CodeX inspired developer
       console palette matching AntV and Tremor. Alternates vibrant primary hues
       (Blue -> Emerald -> Purple -> Coral -> Amber -> Cyan) ensuring immediate visual hierarchy,
       warm-cool harmony, and rich, lively telemetry. */
    series: ['#3b82f6', '#10b981', '#8b5cf6', '#f43f5e', '#f59e0b', '#06b6d4'],
    /* The trend's plot floor and the ring's unfilled track. */
    seriesTrack: '#2a2a30',
  },
  light: {
    bg: '#ffffff',
    surface: '#f6f6f8',
    fg: '#1c1c1e',
    fg2: '#505055',
    muted: '#787880',
    meta: '#98989f',
    border: '#e5e5ea',
    borderSoft: '#ededf2',
    /* The same hue one step darker, because the bright accent cannot be legible on a light page:
       #00a2fb reads 2.71:1 there, while this reads 6.57:1 as a link and 7.09:1 under white text.
       The dark theme's link step is therefore the light theme's filled-control step. */
    accent: '#005d8f',
    accentHover: '#004770',
    accentActive: '#00344f',
    accentOn: '#ffffff',
    success: '#059669',
    warn: '#b45309',
    danger: '#dc2626',
    /* Darker steps of the same two hues so badge text stays legible on a light
       page; the low end is ochre because yellow cannot be both saturated and
       4.5:1 there. */
    cacheRateYellow: '#b45309',
    cacheRateGreen: '#047857',
    /* Deep saturated counterparts for light card surfaces clearing >= 3.0 graphical contrast. */
    series: ['#2563eb', '#059669', '#7c3aed', '#e11d48', '#b45309', '#0891b2'],
    seriesTrack: '#e5e5ea',
  },
} as const;

export function createThemeConfig(mode: ThemeMode = 'dark'): ThemeConfig {
  const dark = mode === 'dark';
  const t = dark ? palette.dark : palette.light;

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
      // Terminal-flat elevation: borders + background shifts, zero shadows.
      ...noShadow,

      // Brand accent — filled controls use the deeper accent-hover step; the
      // bright accent is reserved for links and info (docs/design.md §6).
      colorPrimary: t.accentHover,
      colorPrimaryHover: t.accentActive,
      colorPrimaryActive: t.accentActive,
      colorInfo: t.accent,
      colorLink: t.accent,
      colorLinkHover: t.accent,
      colorSuccess: t.success,
      colorWarning: t.warn,
      colorError: t.danger,

      // Text and background mapping from the palette above.
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
      colorBgElevated: dark ? '#222226' : '#ffffff',
      colorBgLayout: t.bg,
      colorFillTertiary: dark ? t.surface : '#ffffff',
      colorFillQuaternary: dark ? t.surface : '#ffffff',
      // antd paints a popup's text as `colorTextLightSolid` - white - so the spotlight stays dark
      // in both themes. It is deliberately NOT `t.surface` in light: that is near-white, and white
      // text on it measures 1.15:1. A panel whose own content sets its text colours overrides this
      // for its own popper instead of moving the global token, which every other tooltip shares.
      colorBgSpotlight: dark ? '#222226' : t.fg,

      borderRadius: 4,
      borderRadiusLG: 6,
      borderRadiusSM: 4,
      wireframe: false,

      motionDurationFast: '0.05s',
      motionDurationMid: '0.1s',
      // antd hangs the things that hurt off Slow: menu item hover, submenu
      // expand, sider collapse. Its default is 0.3s, which is why a nav hover
      // reads as drag. design.md §7 rule 6: feedback is immediate.
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
      // OpenCode-inspired nav: active item is marked by the left inset rule and
      // fg text rather than a filled block; hover uses surface.
      Menu: {
        itemBg: t.bg,
        darkItemBg: t.bg,
        subMenuItemBg: t.bg,
        darkSubMenuItemBg: t.bg,
        popupBg: dark ? '#222226' : '#ffffff',
        itemHeight: 34,
        iconMarginInlineEnd: 10,
        itemBorderRadius: 4,
        itemColor: t.muted,
        darkItemColor: t.muted,
        itemHoverColor: t.fg,
        darkItemHoverBg: '#242428',
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
        rowHoverBg: dark ? '#222226' : '#ececf0',
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
        // The picker's two surfaces have to differ from each other *and* from the card it sits on,
        // and each palette needs its own pairing to get that. antd's defaults are `colorBgElevated`
        // on `colorBgLayout`, which this palette maps to the same white in light - so the control
        // drew its selection as nothing there, while the dark theme got away with it only because
        // its track happened to be darker than its thumb.
        //
        // The pairing follows the heatmap ramp's ordered-against-the-card rule (docs/design.md
        // "Token activity heatmap"): the track recedes below the card's surface and the thumb is
        // raised above it. So the track is the
        // deepest neutral each palette has (the page background on dark, the border step on light,
        // where the page background is white and would vanish into the thumb) and the thumb is a step
        // above the card. Naming them per theme rather than reusing `bg`/`surface` is what makes the
        // selected option legible in both: on light, `surface` *is* the card's colour, so a thumb
        // painted with it disappeared into the card while the track stood out in its place.
        trackBg: dark ? t.bg : t.border,
        itemSelectedBg: dark ? t.border : '#ffffff',
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
      // Floating menus get the surface step in both modes. In light mode the
      // default elevated colour is `bg`, which is the page colour itself: a
      // menu opened over the page had no fill difference at all, only the
      // border. Dark already uses surface, so this is a no-op there.
      Popover: { ...noShadow, colorBgElevated: dark ? '#222226' : '#ffffff' },
      Dropdown: { ...noShadow, colorBgElevated: dark ? '#222226' : '#ffffff' },
      Select: { optionSelectedBg: dark ? '#242428' : '#ececf0', optionSelectedColor: t.fg, colorBgElevated: dark ? '#222226' : '#ffffff' },
      // Matches the global spotlight token above.
      Tooltip: { colorBgSpotlight: dark ? t.surface : t.fg },
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

export const themeConfig = createThemeConfig('dark');
