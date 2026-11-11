/**
 * Public Oh My CPA Theme SDK & Extension Surface.
 *
 * Exposes the 9-token `ThemeCore` + optional `ThemeSemanticOverrides` model, OKLCH derivation,
 * WCAG contrast helpers, declarative `OMCThemeManifest` validation/export, and the live runtime
 * theme registry (`registerTheme` / `unregisterTheme` / `listRegisteredThemes`) for custom
 * theme packs and plugins.
 */
export {
  ACCENT_LABEL_CONTRAST_FLOOR,
  BUILT_IN_PALETTES,
  BUILT_IN_PALETTE_IDS,
  CONTRAST_FLOORS,
  CORE_TOKEN_CONTRAST_ROLES,
  CORE_TOKEN_KEYS,
  EDGE_STEPS,
  THEME_MODES,
  builtInPalettesForMode,
  contrastRatio,
  currentPaletteId,
  customPaletteId,
  derivePalette,
  emptyCustomPalette,
  exportThemeManifest,
  getBuiltInPalette,
  getRegisteredTheme,
  getThemeRegistryRevision,
  isBuiltInPaletteId,
  isPaletteRef,
  isPaletteRefForMode,
  listRegisteredThemes,
  registerTheme,
  resolvePalette,
  resolvedBuiltInPalette,
  resolvedRegisteredTheme,
  subscribeThemeRegistry,
  unregisterTheme,
} from './palette';
export type {
  BuiltInPalette,
  BuiltInPaletteId,
  ContrastRole,
  CustomPalette,
  PaletteRef,
  ResolvedPalette,
  ResolvedPaletteId,
  ThemeCore,
  ThemeMode,
  ThemePalette,
} from './palette';
export {
  THEME_ID_PATTERN,
  isValidExternalThemeId,
  resolveThemeText,
  validateThemeManifest,
} from './themeContract';
export type {
  LocalizedThemeText,
  OMCThemeManifest,
  RegisteredTheme,
  ThemePrimaryOverride,
  ThemeSemanticOverrides,
  ThemeValidationResult,
} from './themeContract';
export { RADIUS, type RadiusStep } from './radius';
export { themePaletteCssVariables } from './themeConfig';
export { useTheme, ThemeProvider, ThemeServerSync, type ThemeContextValue } from './ThemeContext';
