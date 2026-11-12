import type { MessageKey } from '../i18n/catalog';
import { isHexColor, normalizeHex } from './colorMath';
import type { ThemeCore, ThemeMode } from './palette';

export type LocalizedThemeText = string | Readonly<Record<string, string>>;

/**
 * Optional override for filled primary action surfaces (`--primary*`).
 *
 * When omitted, `derivePalette` derives `primary` from the accent ladder. When provided as a
 * single hex string, `derivePalette` solves hover, active and contrast-safe label ink (>= 4.5:1)
 * from that fill. When provided as an object, explicit states are used and missing states/ink are
 * solved with the same 4.5:1 floor.
 */
export interface ThemePrimaryOverride {
  fill: string;
  hover?: string;
  active?: string;
  ink?: string;
}

/**
 * Optional semantic overrides on top of the 9-token `ThemeCore`.
 *
 * Every colour supplied here still passes through OKLCH contrast holding (`holdSignal` / label
 * contrast solving) so external themes cannot accidentally ship unreadable status marks or buttons.
 */
export interface ThemeSemanticOverrides {
  primary?: string | ThemePrimaryOverride;
  success?: string;
  warn?: string;
  danger?: string;
  series?: readonly [string, string, string, string, string, string];
}

/**
 * Portable, declarative JSON manifest for third-party, community or plugin-contributed themes.
 *
 * Designed so external authors never touch OMC internals or locale catalogues: nine `core` hex
 * tokens guarantee a complete 35-token derived palette, while `overrides` lets a theme separate
 * its primary action surface (for example shadcn-style graphite ink buttons) from its signal accent.
 */
export interface OMCThemeManifest {
  schemaVersion: 1;
  /** Lowercase identifier (`a-z0-9` plus `-`, `_`, `.`, `:`), e.g. `nord-dark` or `plugin:acme/ember`. */
  id: string;
  mode: ThemeMode;
  label: LocalizedThemeText;
  description?: LocalizedThemeText;
  author?: string;
  version?: string;
  core: ThemeCore;
  overrides?: ThemeSemanticOverrides;
}

export interface RegisteredTheme {
  id: string;
  mode: ThemeMode;
  builtIn: boolean;
  nameKey?: MessageKey;
  descriptionKey?: MessageKey;
  label?: LocalizedThemeText;
  description?: LocalizedThemeText;
  author?: string;
  version?: string;
  core: ThemeCore;
  overrides?: ThemeSemanticOverrides;
}

export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9:_.-]{0,63}$/;

const RESERVED_THEME_IDS = new Set([
  'custom',
  'dark',
  'light',
  'system',
  'omc-custom-dark',
  'omc-custom-light',
  'midnight',
  'porcelain',
]);

const CORE_KEYS: readonly (keyof ThemeCore)[] = [
  'bg',
  'surface',
  'elevated',
  'fg',
  'fg2',
  'muted',
  'meta',
  'border',
  'accent',
];

export function isValidExternalThemeId(id: unknown, builtInIds: ReadonlySet<string>): id is string {
  return (
    typeof id === 'string' &&
    THEME_ID_PATTERN.test(id) &&
    !RESERVED_THEME_IDS.has(id) &&
    !builtInIds.has(id)
  );
}

function parseLocalizedText(value: unknown): LocalizedThemeText | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries: Record<string, string> = {};
    for (const [locale, text] of Object.entries(value as Record<string, unknown>)) {
      if (typeof text === 'string' && text.trim().length > 0) {
        entries[locale] = text.trim();
      }
    }
    return Object.keys(entries).length > 0 ? entries : undefined;
  }
  return undefined;
}

function parseHexField(value: unknown, label: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || !isHexColor(value)) {
    errors.push(`${label} must be a 6-digit hex colour (#rrggbb)`);
    return undefined;
  }
  return normalizeHex(value) ?? value.toLowerCase();
}

function parseSemanticOverrides(value: unknown, errors: string[]): ThemeSemanticOverrides | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('overrides must be an object');
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const overrides: ThemeSemanticOverrides = {};

  if (raw.primary !== undefined) {
    if (typeof raw.primary === 'string') {
      const hex = parseHexField(raw.primary, 'overrides.primary', errors);
      if (hex) overrides.primary = hex;
    } else if (typeof raw.primary === 'object' && raw.primary !== null && !Array.isArray(raw.primary)) {
      const p = raw.primary as Record<string, unknown>;
      const fill = parseHexField(p.fill, 'overrides.primary.fill', errors);
      const hover = p.hover !== undefined ? parseHexField(p.hover, 'overrides.primary.hover', errors) : undefined;
      const active = p.active !== undefined ? parseHexField(p.active, 'overrides.primary.active', errors) : undefined;
      const ink = p.ink !== undefined ? parseHexField(p.ink, 'overrides.primary.ink', errors) : undefined;
      if (fill) {
        overrides.primary = {
          fill,
          ...(hover ? { hover } : {}),
          ...(active ? { active } : {}),
          ...(ink ? { ink } : {}),
        };
      }
    } else {
      errors.push('overrides.primary must be a hex colour or { fill, hover?, active?, ink? }');
    }
  }

  if (raw.success !== undefined) {
    const hex = parseHexField(raw.success, 'overrides.success', errors);
    if (hex) overrides.success = hex;
  }
  if (raw.warn !== undefined) {
    const hex = parseHexField(raw.warn, 'overrides.warn', errors);
    if (hex) overrides.warn = hex;
  }
  if (raw.danger !== undefined) {
    const hex = parseHexField(raw.danger, 'overrides.danger', errors);
    if (hex) overrides.danger = hex;
  }
  if (raw.series !== undefined) {
    if (!Array.isArray(raw.series) || raw.series.length !== 6) {
      errors.push('overrides.series must be an array of exactly 6 hex colours');
    } else {
      const parsedSeries = raw.series.map((item, idx) => parseHexField(item, `overrides.series[${idx}]`, errors));
      if (parsedSeries.every((item): item is string => typeof item === 'string')) {
        overrides.series = [
          parsedSeries[0],
          parsedSeries[1],
          parsedSeries[2],
          parsedSeries[3],
          parsedSeries[4],
          parsedSeries[5],
        ];
      }
    }
  }

  return overrides;
}

export type ThemeValidationResult =
  | { ok: true; manifest: OMCThemeManifest }
  | { ok: false; errors: string[] };

export function validateThemeManifest(
  input: unknown,
  builtInIds: ReadonlySet<string>,
): ThemeValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['theme manifest must be an object'] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  if (raw.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1');
  }
  if (!isValidExternalThemeId(raw.id, builtInIds)) {
    errors.push('id must match /^[a-z0-9][a-z0-9:_.-]{0,63}$/ and not collide with built-in or reserved ids');
  }
  if (raw.mode !== 'dark' && raw.mode !== 'light') {
    errors.push('mode must be "dark" or "light"');
  }
  const label = parseLocalizedText(raw.label);
  if (!label) {
    errors.push('label must be a non-empty string or locale map');
  }
  const description = raw.description !== undefined ? parseLocalizedText(raw.description) : undefined;
  if (raw.description !== undefined && !description) {
    errors.push('description must be a non-empty string or locale map when provided');
  }

  const core = {} as ThemeCore;
  if (typeof raw.core !== 'object' || raw.core === null || Array.isArray(raw.core)) {
    errors.push('core must be an object with all 9 ThemeCore tokens');
  } else {
    const rawCore = raw.core as Record<string, unknown>;
    for (const key of CORE_KEYS) {
      const hex = parseHexField(rawCore[key], `core.${key}`, errors);
      if (hex) core[key] = hex;
    }
  }

  const overrides = parseSemanticOverrides(raw.overrides, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      id: raw.id as string,
      mode: raw.mode as ThemeMode,
      label: label!,
      ...(description ? { description } : {}),
      ...(typeof raw.author === 'string' && raw.author.trim() ? { author: raw.author.trim() } : {}),
      ...(typeof raw.version === 'string' && raw.version.trim() ? { version: raw.version.trim() } : {}),
      core,
      ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    },
  };
}

export function resolveThemeText(
  text: LocalizedThemeText | undefined,
  lang: string,
  fallback = '',
): string {
  if (!text) return fallback;
  if (typeof text === 'string') return text;
  return text[lang] ?? text.en ?? text.zh ?? Object.values(text)[0] ?? fallback;
}
