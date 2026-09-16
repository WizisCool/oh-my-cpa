import { theme, type ThemeConfig } from 'antd';

export type ThemeMode = 'dark' | 'light';

export const THEME_IDS = [
  'omc-dark',
  'omc-light',
  'midnight',
  'porcelain',
  'forest',
  'sandstone',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemePalette {
  bg: string;
  surface: string;
  elevated: string;
  fg: string;
  fg2: string;
  muted: string;
  meta: string;
  border: string;
  borderSoft: string;
  hover: string;
  rowHover: string;
  selected: string;
  hoverInset: string;
  accent: string;
  accentHover: string;
  accentActive: string;
  accentOn: string;
  success: string;
  warn: string;
  danger: string;
  cacheRateYellow: string;
  cacheRateGreen: string;
  tooltipBg: string;
  heatmapQuiet: string;
  heatmapBusy: string;
  heatmapZeroUnrecorded: string;
  heatmapZeroRecorded: string;
  heatmapTipLink: string;
  series: readonly string[];
  seriesTrack: string;
}

export interface ThemePreset {
  id: ThemeId;
  mode: ThemeMode;
  nameKey: string;
  descriptionKey: string;
  palette: ThemePalette;
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

/**
 * The app's mono stack, exported for the chart runtime.
 *
 * A canvas cannot inherit a font: the axis and tooltip text a chart draws is measured and painted by
 * the library, so it needs the family as a string rather than through the cascade. Sharing this constant
 * is what keeps chart text in the same type scale as everything around it instead of falling back to
 * the library's own sans-serif default.
 */
export const MONO_FONT_STACK = monoFont;

export const palette = {
  dark: {
    bg: '#121214',
    surface: '#1c1c1f',
    elevated: '#222226',
    fg: '#f4f4f6',
    fg2: '#a1a1aa',
    muted: '#71717a',
    meta: '#52525b',
    border: '#2c2c30',
    borderSoft: '#222226',
    hover: '#242428',
    rowHover: '#222226',
    selected: '#242428',
    hoverInset: '#121214',
    accent: '#00a2fb',
    accentHover: '#0077b8',
    accentActive: '#005d8f',
    accentOn: '#ffffff',
    success: '#10b981',
    warn: '#f59e0b',
    danger: '#ef4444',
    cacheRateYellow: '#f59e0b',
    cacheRateGreen: '#10b981',
    tooltipBg: '#1c1c1f',
    heatmapQuiet: '#222226',
    heatmapBusy: '#00a2fb',
    heatmapZeroUnrecorded: '#222226',
    heatmapZeroRecorded: '#2a2a30',
    heatmapTipLink: '#00a2fb',
    series: ['#3b82f6', '#10b981', '#8b5cf6', '#f43f5e', '#f59e0b', '#06b6d4'],
    seriesTrack: '#2a2a30',
  },
  light: {
    bg: '#ffffff',
    surface: '#f6f6f8',
    elevated: '#ffffff',
    fg: '#1c1c1e',
    fg2: '#505055',
    muted: '#787880',
    meta: '#98989f',
    border: '#e5e5ea',
    borderSoft: '#ededf2',
    hover: '#ececf0',
    rowHover: '#ececf0',
    selected: '#ececf0',
    hoverInset: '#ededf2',
    accent: '#005d8f',
    accentHover: '#004770',
    accentActive: '#00344f',
    accentOn: '#ffffff',
    success: '#059669',
    warn: '#b45309',
    danger: '#dc2626',
    cacheRateYellow: '#b45309',
    cacheRateGreen: '#047857',
    tooltipBg: '#1c1c1e',
    heatmapQuiet: '#ececf0',
    heatmapBusy: '#005d8f',
    heatmapZeroUnrecorded: '#ececf0',
    heatmapZeroRecorded: '#e2e2e8',
    heatmapTipLink: '#005d8f',
    series: ['#2563eb', '#059669', '#7c3aed', '#e11d48', '#b45309', '#0891b2'],
    seriesTrack: '#e5e5ea',
  },
} as const satisfies Record<ThemeMode, ThemePalette>;

/**
 * Presets are the only place a palette is declared. The two original modes keep
 * their exact values; the additional presets change both surfaces and semantic
 * hues together so charts, statuses and controls never inherit a mismatched
 * palette from another theme.
 */
export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'omc-dark',
    mode: 'dark',
    nameKey: 'theme.omc_dark',
    descriptionKey: 'theme.omc_dark_desc',
    palette: palette.dark,
  },
  {
    id: 'omc-light',
    mode: 'light',
    nameKey: 'theme.omc_light',
    descriptionKey: 'theme.omc_light_desc',
    palette: palette.light,
  },
  {
    id: 'midnight',
    mode: 'dark',
    nameKey: 'theme.midnight',
    descriptionKey: 'theme.midnight_desc',
    palette: {
      bg: '#0d1117',
      surface: '#161b22',
      elevated: '#1f242c',
      fg: '#e6edf3',
      fg2: '#9da7b3',
      muted: '#6e7681',
      meta: '#484f58',
      border: '#30363d',
      borderSoft: '#21262d',
      hover: '#21262d',
      rowHover: '#21262d',
      selected: '#253041',
      hoverInset: '#0d1117',
      accent: '#58a6ff',
      accentHover: '#388bfd',
      accentActive: '#1f6feb',
      accentOn: '#ffffff',
      success: '#3fb950',
      warn: '#d29922',
      danger: '#f85149',
      cacheRateYellow: '#d29922',
      cacheRateGreen: '#3fb950',
      tooltipBg: '#161b22',
      heatmapQuiet: '#21262d',
      heatmapBusy: '#58a6ff',
      heatmapZeroUnrecorded: '#21262d',
      heatmapZeroRecorded: '#30363d',
      heatmapTipLink: '#58a6ff',
      series: ['#58a6ff', '#3fb950', '#bc8cff', '#ff7b72', '#d29922', '#39c5cf'],
      seriesTrack: '#21262d',
    },
  },
  {
    id: 'porcelain',
    mode: 'light',
    nameKey: 'theme.porcelain',
    descriptionKey: 'theme.porcelain_desc',
    palette: {
      bg: '#f7f8fa',
      surface: '#ffffff',
      elevated: '#ffffff',
      fg: '#17212b',
      fg2: '#4b5563',
      muted: '#6b7280',
      meta: '#9ca3af',
      border: '#d8dee7',
      borderSoft: '#e6eaf0',
      hover: '#eef2f7',
      rowHover: '#eef2f7',
      selected: '#e4edf8',
      hoverInset: '#eef2f7',
      accent: '#0b6e99',
      accentHover: '#075985',
      accentActive: '#0c4a6e',
      accentOn: '#ffffff',
      success: '#157a4b',
      warn: '#a15c00',
      danger: '#c62828',
      cacheRateYellow: '#a15c00',
      cacheRateGreen: '#157a4b',
      tooltipBg: '#17212b',
      heatmapQuiet: '#e6eaf0',
      heatmapBusy: '#0b6e99',
      heatmapZeroUnrecorded: '#e6eaf0',
      heatmapZeroRecorded: '#d8dee7',
      heatmapTipLink: '#0b6e99',
      series: ['#0b6e99', '#157a4b', '#6d4aff', '#c62863', '#a15c00', '#0e7c86'],
      seriesTrack: '#d8dee7',
    },
  },
  {
    id: 'forest',
    mode: 'dark',
    nameKey: 'theme.forest',
    descriptionKey: 'theme.forest_desc',
    palette: {
      bg: '#0e1411',
      surface: '#162019',
      elevated: '#1d2a21',
      fg: '#edf5ef',
      fg2: '#a8b8ad',
      muted: '#74887b',
      meta: '#4d5f53',
      border: '#293a2f',
      borderSoft: '#1d2a21',
      hover: '#213127',
      rowHover: '#213127',
      selected: '#263d2e',
      hoverInset: '#0e1411',
      accent: '#6ee7a8',
      accentHover: '#34c978',
      accentActive: '#1f9d5a',
      accentOn: '#07140c',
      success: '#4ade80',
      warn: '#fbbf24',
      danger: '#f87171',
      cacheRateYellow: '#fbbf24',
      cacheRateGreen: '#4ade80',
      tooltipBg: '#162019',
      heatmapQuiet: '#1d2a21',
      heatmapBusy: '#6ee7a8',
      heatmapZeroUnrecorded: '#1d2a21',
      heatmapZeroRecorded: '#293a2f',
      heatmapTipLink: '#6ee7a8',
      series: ['#60a5fa', '#4ade80', '#a78bfa', '#fb7185', '#fbbf24', '#2dd4bf'],
      seriesTrack: '#293a2f',
    },
  },
  {
    id: 'sandstone',
    mode: 'light',
    nameKey: 'theme.sandstone',
    descriptionKey: 'theme.sandstone_desc',
    palette: {
      bg: '#f8f3e8',
      surface: '#fffaf0',
      elevated: '#fffaf0',
      fg: '#2f2a22',
      fg2: '#5f574b',
      muted: '#7c7263',
      meta: '#a79b89',
      border: '#ded3c0',
      borderSoft: '#ece4d6',
      hover: '#f1e8d8',
      rowHover: '#f1e8d8',
      selected: '#eadcc5',
      hoverInset: '#f1e8d8',
      accent: '#0f766e',
      accentHover: '#115e59',
      accentActive: '#134e4a',
      accentOn: '#ffffff',
      success: '#2f7d4d',
      warn: '#a16207',
      danger: '#c2410c',
      cacheRateYellow: '#a16207',
      cacheRateGreen: '#2f7d4d',
      tooltipBg: '#2f2a22',
      heatmapQuiet: '#ece4d6',
      heatmapBusy: '#0f766e',
      heatmapZeroUnrecorded: '#ece4d6',
      heatmapZeroRecorded: '#ded3c0',
      heatmapTipLink: '#0f766e',
      series: ['#0f766e', '#2f7d4d', '#7c3aed', '#c2410c', '#a16207', '#0369a1'],
      seriesTrack: '#ded3c0',
    },
  },
];

export function parseThemeId(value: unknown): ThemeId | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if ((THEME_IDS as readonly string[]).includes(normalized)) return normalized as ThemeId;
  if (normalized === 'dark') return 'omc-dark';
  if (normalized === 'light') return 'omc-light';
  return undefined;
}

export function resolveThemeId(value: unknown): ThemeId {
  return parseThemeId(value) ?? 'omc-dark';
}

export function getThemePreset(value: ThemeId | ThemeMode | string | undefined): ThemePreset {
  const id = parseThemeId(value) ?? (value === 'dark' ? 'omc-dark' : value === 'light' ? 'omc-light' : 'omc-dark');
  return THEME_PRESETS.find((preset) => preset.id === id) ?? THEME_PRESETS[0];
}

export function createThemeConfig(themeId: ThemeId | ThemeMode | string = 'omc-dark'): ThemeConfig {
  const preset = getThemePreset(themeId);
  const dark = preset.mode === 'dark';
  const t = preset.palette;

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

export function themePaletteCssVariables(preset: ThemePreset): Record<string, string> {
  const palette = preset.palette;
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

export const themeConfig = createThemeConfig('omc-dark');
