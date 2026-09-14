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
 * Design tokens for both mode palettes. `docs/design.md` is the source of
 * truth; this object and the `:root` variables in `web/src/index.css` are the
 * only two places that may name a colour, so the app never falls back to
 * antd's default blue.
 */
export const palette = {
  dark: {
    bg: '#201d1d',
    surface: '#302c2c',
    fg: '#fdfcfc',
    fg2: '#c8c6c4',
    muted: '#9a9898',
    meta: '#6e6e73',
    border: '#464343',
    borderSoft: '#302c2c',
    /* Accent ladder, hue 201. The link step is the bright one because it sits on the dark
       background (6.03:1); the two deeper steps are what white text can sit on (4.85:1 and
       7.09:1). See docs/design.md §2 for the measured ratios. */
    accent: '#00a2fb',
    accentHover: '#0077b8',
    accentActive: '#005d8f',
    accentOn: '#ffffff',
    success: '#30d158',
    warn: '#ff9f0a',
    danger: '#ff3b30',
    /* Cache-rate scale (design.md §2): yellow → green, no red. */
    cacheRateYellow: '#ffd60a',
    cacheRateGreen: '#30d158',
  },
  light: {
    bg: '#fdfcfc',
    surface: '#f1eeee',
    fg: '#201d1d',
    fg2: '#424245',
    muted: '#6e6e73',
    meta: '#9a9898',
    border: 'rgba(15, 0, 0, 0.12)',
    borderSoft: 'rgba(15, 0, 0, 0.07)',
    /* The same hue one step darker, because the bright accent cannot be legible on a light page:
       #00a2fb reads 2.71:1 there, while this reads 6.92:1 as a link and 7.09:1 under white text.
       The dark theme's link step is therefore the light theme's filled-control step. */
    accent: '#005d8f',
    accentHover: '#004770',
    accentActive: '#00344f',
    accentOn: '#ffffff',
    success: '#30d158',
    warn: '#ff9f0a',
    danger: '#ff3b30',
    /* Darker steps of the same two hues so badge text stays legible on a light
       page; the low end is ochre because yellow cannot be both saturated and
       4.5:1 there. */
    cacheRateYellow: '#6e5b00',
    cacheRateGreen: '#00662a',
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
      colorBgElevated: dark ? t.surface : t.bg,
      colorBgLayout: t.bg,
      colorFillTertiary: t.surface,
      colorFillQuaternary: t.surface,
      colorBgSpotlight: dark ? t.surface : t.fg,

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
        popupBg: t.surface,
        itemHeight: 34,
        iconMarginInlineEnd: 10,
        itemBorderRadius: 4,
        itemColor: t.muted,
        darkItemColor: t.muted,
        itemHoverColor: t.fg,
        darkItemHoverBg: t.surface,
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
        rowHoverBg: t.surface,
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
      Popover: { ...noShadow, colorBgElevated: t.surface },
      Dropdown: { ...noShadow, colorBgElevated: t.surface },
      Select: { optionSelectedBg: t.surface, optionSelectedColor: t.fg, colorBgElevated: t.surface },
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
