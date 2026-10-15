/**
 * Applies the chosen typefaces to the document.
 *
 * The two roles are custom properties on the root element - `--font-ui` and
 * `--font-mono` - which the stylesheet and Ant Design's tokens read, so a change repaints
 * the whole console without any component knowing fonts can change. A library family is
 * declared with `FontFace` objects whose files are this origin's face endpoint, each with
 * the `unicode-range` it was stored with: a browser downloads only the slices a page
 * actually draws, exactly as it does for the bundled typeface.
 *
 * The resolved choice is also kept in localStorage, the way the theme is, so the first
 * frame of the next visit - and the sign-in screen, which has no session to read the
 * preference with - is painted in the chosen face rather than switching after a request.
 */
import { getAppConfig } from '../types/config';
import {
  DEFAULT_FONT_ROLES,
  FONT_ROLES,
  cssWeight,
  fontStackFor,
  libraryFamilyName,
  libraryIdOf,
  parseFontRoles,
  type FontRoles,
  type InstalledFont,
} from '../types/fonts';

const STORAGE_KEY = 'omc-fonts';

const ROLE_PROPERTIES = { ui: '--font-ui', mono: '--font-mono' } as const;

interface StoredFonts {
  roles: FontRoles;
  /** Only the library families the roles use, with their face declarations. */
  fonts: InstalledFont[];
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function fontFaceURL(fontId: string, faceId: string): string {
  return `${getAppConfig().apiBaseUrl}/fonts/${encodeURIComponent(fontId)}/faces/${encodeURIComponent(faceId)}`;
}

const registered = new Map<string, FontFace[]>();

/**
 * Declares a library family's faces. Nothing is downloaded here: a face is fetched when
 * text that falls in its range is drawn in its family.
 */
export function registerLibraryFont(font: InstalledFont, fonts: FontFaceSet = document.fonts): void {
  if (registered.has(font.id) || typeof FontFace === 'undefined') return;
  const faces = font.faces.map((face) => new FontFace(
    libraryFamilyName(font.id),
    `url("${fontFaceURL(font.id, face.id)}") format("${face.format}")`,
    {
      weight: cssWeight(face),
      style: face.style,
      display: 'swap',
      ...(face.unicode_range ? { unicodeRange: face.unicode_range } : {}),
    },
  ));
  faces.forEach((face) => fonts.add(face));
  registered.set(font.id, faces);
}

/** Withdraws a deleted family, so no later text asks for files that no longer exist. */
export function forgetLibraryFont(id: string, fonts: FontFaceSet = document.fonts): void {
  registered.get(id)?.forEach((face) => fonts.delete(face));
  registered.delete(id);
}

/**
 * Points both roles at their resolved stacks. `fonts` is the library as last read; when it
 * is unknown (the first frame), a library reference is trusted, and corrected once the
 * library arrives.
 */
export function applyFonts(roles: FontRoles, fonts: readonly InstalledFont[] | undefined, root: HTMLElement = document.documentElement): void {
  const used: InstalledFont[] = [];
  for (const role of FONT_ROLES) {
    const libraryId = libraryIdOf(roles[role]);
    const font = libraryId ? fonts?.find((candidate) => candidate.id === libraryId) : undefined;
    if (font) {
      registerLibraryFont(font);
      if (!used.includes(font)) used.push(font);
    }
    root.style.setProperty(ROLE_PROPERTIES[role], fontStackFor(roles[role], fonts));
  }
  if (fonts) writeStoredFonts({ roles, fonts: used });
}

function writeStoredFonts(value: StoredFonts): void {
  try {
    const isDefault = FONT_ROLES.every((role) => value.roles[role] === DEFAULT_FONT_ROLES[role]);
    if (isDefault) storage()?.removeItem(STORAGE_KEY);
    else storage()?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A browser that cannot store this still paints the right face once the preference loads.
  }
}

function isStoredFont(value: unknown): value is InstalledFont {
  if (!value || typeof value !== 'object') return false;
  const font = value as Partial<InstalledFont>;
  return typeof font.id === 'string' && /^[0-9a-f]{32}$/.test(font.id) && Array.isArray(font.faces)
    && font.faces.every((face) => face && typeof face.id === 'string' && /^[0-9a-f]{32}$/.test(face.id)
      && Number.isInteger(face.weight_min) && Number.isInteger(face.weight_max)
      && (face.style === 'normal' || face.style === 'italic')
      && ['woff2', 'woff', 'truetype', 'opentype'].includes(face.format)
      && (face.unicode_range === undefined || /^[Uu+0-9A-Fa-f?,\- ]*$/.test(face.unicode_range)));
}

/** Paints the stored choice before the console renders; see the module comment. */
export function applyStoredFonts(): void {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredFonts>;
    const roles = parseFontRoles(parsed.roles);
    if (!roles) return;
    const fonts = Array.isArray(parsed.fonts) ? parsed.fonts.filter(isStoredFont) : [];
    for (const font of fonts) registerLibraryFont(font);
    // The stored library is partial by construction, so the stacks are resolved without
    // it: a role is trusted here and corrected once the deployment's library is read.
    for (const role of FONT_ROLES) {
      document.documentElement.style.setProperty(ROLE_PROPERTIES[role], fontStackFor(roles[role], undefined));
    }
  } catch {
    storage()?.removeItem(STORAGE_KEY);
  }
}

/** The family a role currently paints, for surfaces that cannot use the cascade (canvas, Monaco). */
export function currentFontStack(role: keyof typeof ROLE_PROPERTIES): string {
  if (typeof document === 'undefined') return fontStackFor(DEFAULT_FONT_ROLES[role], undefined);
  return getComputedStyle(document.documentElement).getPropertyValue(ROLE_PROPERTIES[role]).trim() || fontStackFor(DEFAULT_FONT_ROLES[role], undefined);
}
