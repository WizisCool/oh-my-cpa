/**
 * The theme preference: what the operator chose, how it is stored, and how a stored document
 * that predates this shape is read.
 *
 * Three things live in one document because they are one decision:
 *
 * - **mode** - light, dark, or following the operating system. This is what the header's single
 *   control cycles and what a reader means by "switch to dark".
 * - **palettes** - one selection per mode. A palette belongs to a mode, so an operator who prefers
 *   Porcelain by day and Midnight at night sets both once and then only flips the mode.
 * - **custom** - the palettes they authored, each with the built-in it started from (which is what
 *   "reset" means) and an optional name.
 *
 * The document is stored twice on purpose: in `localStorage` under `omc-theme` so the console is
 * painted correctly in the first frame and on the sign-in screen where there is no session to read
 * a preference with, and in the deployment's `ui_preferences` so the choice outlives a browser.
 * `dirty` is the bridge between them - see `docs/adr/0011-theme-modes-and-derived-palettes.md`.
 */

import {
  CORE_TOKEN_KEYS,
  isBuiltInPaletteId,
  isPaletteRefForMode,
  type CustomPalette,
  type PaletteRef,
  type ThemeCore,
  type ThemeMode,
} from './palette';
import { isHexColor, normalizeHex } from './colorMath';

/** The mode the operator asked for, which may be "whatever the operating system says". */
export type ThemeModePreference = ThemeMode | 'system';

export const THEME_MODE_PREFERENCES: readonly ThemeModePreference[] = ['light', 'dark', 'system'];

/** The server-stored preference key, mirrored in `internal/repository/preferences.go`. */
export const THEME_PREFERENCE_KEY = 'omc_theme';

/** The browser-stored key. Kept from the preset-only era so an existing choice is not lost. */
export const THEME_STORAGE_KEY = 'omc-theme';

export interface ThemePreferences {
  mode: ThemeModePreference;
  palettes: Record<ThemeMode, PaletteRef>;
  custom: Partial<Record<ThemeMode, CustomPalette>>;
}

/**
 * The console's defaults: OMC Dark, its own light counterpart, and an explicit choice rather than
 * following the system.
 *
 * Explicit rather than `system` because the console's shipped look is OMC Dark, and a first visit
 * that inherited the operating system would show a different product to two operators reading the
 * same documentation. Following the system is offered, not assumed.
 */
export const DEFAULT_THEME_PREFERENCES: ThemePreferences = {
  mode: 'dark',
  palettes: { dark: 'omc-dark', light: 'omc-light' },
  custom: {},
};

function isThemeModePreference(value: unknown): value is ThemeModePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** A complete, valid nine-token core, or undefined. Partial palettes would fail at derivation. */
function parseCore(value: unknown): ThemeCore | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const core = {} as ThemeCore;
  for (const key of CORE_TOKEN_KEYS) {
    const token = candidate[key];
    if (typeof token !== 'string' || !isHexColor(token)) return undefined;
    core[key] = normalizeHex(token) ?? token;
  }
  return core;
}

function parseCustomPalette(mode: ThemeMode, value: unknown): CustomPalette | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const core = parseCore(candidate.core);
  // An unreadable palette is dropped rather than repaired: inventing nine tokens would put a
  // palette the operator never authored in front of them. The starting palette has to belong to this
  // mode for the same reason a reference does - it is what reset returns to.
  if (!core || !isBuiltInPaletteId(candidate.base) || !isPaletteRefForMode(mode, candidate.base)) return undefined;
  return { base: candidate.base, core };
}

/**
 * parseThemePreferences reads a stored document, filling gaps from the defaults.
 *
 * Liberal by field and strict by value: a stored document is the console's own, so a missing field
 * is a build that predates it and inherits the default, while a field that is present but wrong
 * (`mode: "purple"`, a core with eight tokens) is dropped rather than coerced into something the
 * operator did not choose.
 */
export function parseThemePreferences(value: unknown): ThemePreferences | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const palettes = { ...DEFAULT_THEME_PREFERENCES.palettes };
  if (typeof candidate.palettes === 'object' && candidate.palettes !== null) {
    const stored = candidate.palettes as Record<string, unknown>;
    for (const mode of ['dark', 'light'] as const) {
      if (isPaletteRefForMode(mode, stored[mode])) palettes[mode] = stored[mode];
    }
  }
  const custom: Partial<Record<ThemeMode, CustomPalette>> = {};
  if (typeof candidate.custom === 'object' && candidate.custom !== null) {
    const stored = candidate.custom as Record<string, unknown>;
    for (const mode of ['dark', 'light'] as const) {
      const palette = parseCustomPalette(mode, stored[mode]);
      if (palette) custom[mode] = palette;
    }
  }
  return {
    mode: isThemeModePreference(candidate.mode) ? candidate.mode : DEFAULT_THEME_PREFERENCES.mode,
    palettes,
    custom,
  };
}

/**
 * migrateLegacyThemeValue reads the preset-only form of the stored theme.
 *
 * Before this change `omc-theme` held a bare palette id, and before that a bare `dark` or `light`.
 * The mapping is the only one available - a palette carries its own mode - so an operator's stored
 * choice arrives as "this mode, using this palette" and keeps working.
 */
export function migrateLegacyThemeValue(raw: string | null | undefined): ThemePreferences | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'dark') return { ...DEFAULT_THEME_PREFERENCES, mode: 'dark' };
  if (normalized === 'light') return { ...DEFAULT_THEME_PREFERENCES, mode: 'light' };
  if (!isBuiltInPaletteId(normalized)) return undefined;
  const mode: ThemeMode = normalized.startsWith('omc-light') || normalized === 'porcelain' || normalized === 'sandstone' ? 'light' : 'dark';
  return {
    mode,
    palettes: { ...DEFAULT_THEME_PREFERENCES.palettes, [mode]: normalized },
    custom: {},
  };
}

export interface StoredThemePreferences {
  preferences: ThemePreferences;
  /**
   * True when this browser holds a change the deployment has not accepted yet.
   *
   * It is what makes a toggle on the sign-in screen survive the sign-in: the preference endpoint
   * needs a session, so a change made before one exists can only be recorded locally and pushed
   * once the stored preference arrives.
   */
  isDirty: boolean;
}

interface ReadableStorage {
  getItem: (key: string) => string | null;
}

/** localStorage when there is one, so callers in tests and on the server need no guard. */
function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // Access itself throws when storage is blocked by policy; a console that cannot remember the
    // theme must still render one, so this is a normal outcome rather than an error.
    return undefined;
  }
}

export function readStoredThemePreferences(storage: ReadableStorage | undefined = browserStorage()): StoredThemePreferences | undefined {
  if (!storage) return undefined;
  let raw: string | null = null;
  try {
    raw = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const preferences = parseThemePreferences(parsed);
    if (preferences) {
      const isDirty = typeof parsed === 'object' && parsed !== null && (parsed as { dirty?: unknown }).dirty === true;
      return { preferences, isDirty };
    }
  } catch {
    // Not JSON: the legacy bare-id form, handled below.
  }
  const migrated = migrateLegacyThemeValue(raw);
  return migrated ? { preferences: migrated, isDirty: false } : undefined;
}

export function writeStoredThemePreferences(
  preferences: ThemePreferences,
  isDirty: boolean,
  storage: Storage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, JSON.stringify({ ...preferences, dirty: isDirty }));
  } catch {
    // A full or blocked storage means the console forgets this choice on reload. Nothing else in
    // the session depends on that succeeding, so it must not take the page down.
  }
}

/** Whether two preference documents say the same thing, field for field. */
export function sameThemePreferences(left: ThemePreferences, right: ThemePreferences): boolean {
  return JSON.stringify(sortPreferences(left)) === JSON.stringify(sortPreferences(right));
}

/** A stable field order, so a comparison of two documents is a comparison of their contents. */
function sortPreferences(preferences: ThemePreferences): unknown {
  return {
    mode: preferences.mode,
    palettes: { dark: preferences.palettes.dark, light: preferences.palettes.light },
    custom: {
      dark: sortCustomPalette(preferences.custom.dark),
      light: sortCustomPalette(preferences.custom.light),
    },
  };
}

function sortCustomPalette(palette: CustomPalette | undefined): unknown {
  if (!palette) return null;
  return {
    base: palette.base,
    core: CORE_TOKEN_KEYS.map((key) => palette.core[key]),
  };
}

/**
 * resolveModePreference turns "whatever the system says" into one of the two modes.
 *
 * The stored preference keeps `system` as its own value rather than being flattened at write time,
 * so a console set to follow the system keeps following it after the operating system flips.
 */
export function resolveModePreference(preference: ThemeModePreference, systemMode: ThemeMode): ThemeMode {
  return preference === 'system' ? systemMode : preference;
}

/**
 * The mode one step on from the current preference, for the header's single control.
 *
 * The order is light, dark, system. Light and dark lead because they are the two states an operator
 * reaches for daily and the first click should answer the common case; system is the considered
 * choice and costs the extra click. `docs/design.md` §5 records why a cycling control is acceptable
 * here when the language control is a menu - the mode has three states and one visible consequence,
 * so the cycle is readable from the icon, where a list of six palettes was not.
 */
export function nextModePreference(preference: ThemeModePreference): ThemeModePreference {
  const index = THEME_MODE_PREFERENCES.indexOf(preference);
  return THEME_MODE_PREFERENCES[(index + 1) % THEME_MODE_PREFERENCES.length];
}
