/**
 * The console's typefaces: two roles, each a built-in typeface or a family from the
 * deployment's font library.
 *
 * `ui` is the interface - labels, tables, prose. `mono` is code, keys, identifiers and
 * figures that have to line up. They are separate because the reason to change one is
 * rarely a reason to change the other: an operator who finds a monospaced interface
 * tiring to read still wants a request id to stay monospaced.
 *
 * Every family the console can draw is served from its own origin. A built-in is either
 * bundled (Sarasa Mono SC, the default) or the platform's own fonts; a library family was
 * uploaded or installed from Google Fonts by the server, which stores the files. Nothing
 * here ever names a URL on another host. This module is pure, so the settings page, the
 * first-frame bootstrap and the tests all read the same rules.
 */

export type FontRole = 'ui' | 'mono';
export const FONT_ROLES: readonly FontRole[] = ['ui', 'mono'];

/** `builtin:<id>` or `font:<library id>`. */
export type FontRef = string;
export type FontRoles = Record<FontRole, FontRef>;

export const FONT_PREFERENCE_KEY = 'omc_fonts';
export const FONTS_QUERY_KEY = ['fonts'] as const;

export interface FontFaceInfo {
  id: string;
  weight_min: number;
  weight_max: number;
  style: 'normal' | 'italic';
  unicode_range?: string;
  format: 'woff2' | 'woff' | 'truetype' | 'opentype';
}

export interface InstalledFont {
  id: string;
  family: string;
  source: 'google' | 'upload';
  created_at_ms: number;
  byte_size: number;
  faces: FontFaceInfo[];
}

export type BuiltInFontId = 'sarasa-mono' | 'system-sans' | 'system-serif' | 'system-mono';

export interface BuiltInFont {
  id: BuiltInFontId;
  nameKey: string;
  descriptionKey: string;
  stack: string;
}

/** The bundled typeface, in the order its installed copies and fallbacks are tried. */
export const SARASA_STACK = '"Sarasa Mono SC", "Sarasa UI SC", "Sarasa Term SC", "更纱黑体 SC", "Berkeley Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/** Each platform's interface face, then each platform's Chinese face before the generic. */
const SYSTEM_SANS_STACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_SERIF_STACK = 'ui-serif, "Iowan Old Style", "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", Georgia, "Times New Roman", serif';
const SYSTEM_MONO_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", "Liberation Mono", "Noto Sans Mono CJK SC", monospace';

export const BUILT_IN_FONTS: readonly BuiltInFont[] = [
  { id: 'sarasa-mono', nameKey: 'omc.font_sarasa', descriptionKey: 'omc.font_sarasa_desc', stack: SARASA_STACK },
  { id: 'system-sans', nameKey: 'omc.font_system_sans', descriptionKey: 'omc.font_system_sans_desc', stack: SYSTEM_SANS_STACK },
  { id: 'system-serif', nameKey: 'omc.font_system_serif', descriptionKey: 'omc.font_system_serif_desc', stack: SYSTEM_SERIF_STACK },
  { id: 'system-mono', nameKey: 'omc.font_system_mono', descriptionKey: 'omc.font_system_mono_desc', stack: SYSTEM_MONO_STACK },
];

export const DEFAULT_FONT_REF: FontRef = 'builtin:sarasa-mono';
export const DEFAULT_FONT_ROLES: FontRoles = { ui: DEFAULT_FONT_REF, mono: DEFAULT_FONT_REF };

const REF_FORM = /^(builtin:[a-z0-9-]{1,32}|font:[0-9a-f]{32})$/;

/** A stored document with any unusable role left at its default, so one bad role never costs the other. */
export function parseFontRoles(raw: unknown): FontRoles | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const roles = { ...DEFAULT_FONT_ROLES };
  for (const role of FONT_ROLES) {
    const value = record[role];
    if (typeof value === 'string' && REF_FORM.test(value)) roles[role] = value;
  }
  return roles;
}

/** The stored form: a role at its default is left out, which is what the server's delete cascade also produces. */
export function serializeFontRoles(roles: FontRoles): Partial<FontRoles> {
  const stored: Partial<FontRoles> = {};
  for (const role of FONT_ROLES) {
    if (roles[role] !== DEFAULT_FONT_REF) stored[role] = roles[role];
  }
  return stored;
}

export function builtInRef(id: BuiltInFontId): FontRef {
  return `builtin:${id}`;
}

export function libraryRef(id: string): FontRef {
  return `font:${id}`;
}

export function libraryIdOf(ref: FontRef): string | undefined {
  return ref.startsWith('font:') ? ref.slice(5) : undefined;
}

/**
 * The name a library family is declared under. It is the library id rather than the
 * family's own name, so a copy of the same family installed on the reader's machine -
 * possibly another version, with other metrics - can never stand in for the stored one.
 */
export function libraryFamilyName(id: string): string {
  return `omc-font-${id}`;
}

/**
 * The CSS `font-family` value a role resolves to. A library family is followed by the
 * default typeface, which is what draws any character the family does not have - a
 * Latin-only interface font still shows Chinese labels in the bundled face rather than
 * in whatever the platform falls back to. A reference that no longer resolves - a
 * family deleted on another device - falls back to the default outright.
 */
export function fontStackFor(ref: FontRef, fonts: readonly InstalledFont[] | undefined): string {
  const libraryId = libraryIdOf(ref);
  if (libraryId) {
    if (fonts && !fonts.some((font) => font.id === libraryId)) return SARASA_STACK;
    return `"${libraryFamilyName(libraryId)}", ${SARASA_STACK}`;
  }
  const builtIn = BUILT_IN_FONTS.find((font) => builtInRef(font.id) === ref);
  return builtIn?.stack ?? SARASA_STACK;
}

/** Weight range as CSS writes it: `400`, or `100 900` for a variable face. */
export function cssWeight(face: Pick<FontFaceInfo, 'weight_min' | 'weight_max'>): string {
  return face.weight_min === face.weight_max ? String(face.weight_min) : `${face.weight_min} ${face.weight_max}`;
}

/** Accepted upload containers; the server decides by signature, this only filters the picker. */
export const FONT_UPLOAD_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';

/**
 * Families offered as suggestions when installing from Google Fonts. The installer takes
 * any family Google publishes; this list exists so an operator need not know the exact
 * spelling of the common ones, and it leads with families that cover Chinese, because a
 * Latin-only family leaves every Chinese label to the fallback face.
 */
export const GOOGLE_FONT_SUGGESTIONS: readonly { family: string; category: 'sans' | 'serif' | 'mono' | 'handwriting'; isCjk?: boolean }[] = [
  { family: 'Noto Sans SC', category: 'sans', isCjk: true },
  { family: 'Noto Serif SC', category: 'serif', isCjk: true },
  { family: 'Noto Sans TC', category: 'sans', isCjk: true },
  { family: 'LXGW WenKai TC', category: 'handwriting', isCjk: true },
  { family: 'ZCOOL XiaoWei', category: 'serif', isCjk: true },
  { family: 'Inter', category: 'sans' },
  { family: 'Roboto', category: 'sans' },
  { family: 'IBM Plex Sans', category: 'sans' },
  { family: 'Source Sans 3', category: 'sans' },
  { family: 'Geist', category: 'sans' },
  { family: 'Manrope', category: 'sans' },
  { family: 'Lora', category: 'serif' },
  { family: 'JetBrains Mono', category: 'mono' },
  { family: 'Fira Code', category: 'mono' },
  { family: 'IBM Plex Mono', category: 'mono' },
  { family: 'Source Code Pro', category: 'mono' },
  { family: 'Geist Mono', category: 'mono' },
  { family: 'Roboto Mono', category: 'mono' },
  { family: 'Noto Sans Mono', category: 'mono' },
];
