/**
 * The CJK side of the console's typeface, loaded from Google Fonts.
 *
 * Sarasa Mono SC draws its CJK characters with Source Han Sans's glyphs, which Google Fonts
 * serves as Noto Sans SC; the bundle ships only Sarasa's Latin side and the ideographs the
 * console's own copy uses (`scripts/font-shards.mjs`). The rest come from Google's sliced
 * files, which a browser fetches only for the characters a page draws.
 *
 * Google's stylesheet is fetched and its faces registered here rather than linked: each face
 * is narrowed to the ideograph and Hangul ranges the bundle leaves out - Google's Noto also
 * declares Latin, symbols and monochrome emoji, which would otherwise draw over Sarasa's own
 * glyphs and the platform's colour emoji - and declared under a private family name, so an
 * installed Noto Sans SC is not shadowed. When Google cannot be reached, nothing is
 * registered and the stacks fall through to the platform's CJK fonts.
 */
import { shardsForText } from './fontShards';

/** The family the stacks name right after Sarasa Mono SC. */
export const CJK_FAMILY = 'OMC Noto Sans SC';

/**
 * How long a request to Google Fonts may take. A firewall that drops rather than refuses the
 * connection would otherwise hold a conversation export for the browser's own connect timeout.
 */
const FETCH_TIMEOUT_MS = 8000;

export const CJK_STYLESHEET_URL = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700&display=swap';

/**
 * CJK ideographs (unified, extension A, compatibility, the supplementary planes) and Hangul
 * syllables: the code points the bundle leaves to this family. `scripts/font-shards.mjs`
 * holds the same list; `scripts/test-font-shards.ts` keeps them equal.
 */
export const SERVED_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xac00, 0xd7af], [0xf900, 0xfaff], [0x20000, 0x3ffff],
];

export interface CJKFace {
  weight: number;
  url: string;
  unicodeRange: string;
}

function hex(codePoint: number): string {
  return codePoint.toString(16).toUpperCase();
}

/** `value` - a CSS `unicode-range` - narrowed to `SERVED_RANGES`, or '' when nothing is left. */
export function narrowUnicodeRange(value: string): string {
  const parts: string[] = [];
  for (const part of value.split(',')) {
    const [startText, endText = startText] = part.trim().replace(/^U\+/i, '').split('-');
    const start = Number.parseInt(startText, 16);
    const end = Number.parseInt(endText, 16);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (const [servedStart, servedEnd] of SERVED_RANGES) {
      const low = Math.max(start, servedStart);
      const high = Math.min(end, servedEnd);
      if (low <= high) parts.push(low === high ? `U+${hex(low)}` : `U+${hex(low)}-${hex(high)}`);
    }
  }
  return parts.join(',');
}

/** The faces of a Google Fonts stylesheet that draw a served character, each narrowed to them. */
export function parseCJKFaces(css: string): CJKFace[] {
  const faces: CJKFace[] = [];
  for (const [, body] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1]);
    const url = /src:\s*url\(\s*['"]?(https:\/\/fonts\.gstatic\.com\/[^'")\s]+)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+)/.exec(body)?.[1];
    if (/font-style:\s*italic/.test(body) || !Number.isInteger(weight) || !url || !range) continue;
    const unicodeRange = narrowUnicodeRange(range);
    if (unicodeRange) faces.push({ weight, url, unicodeRange });
  }
  return faces;
}

const FETCH_OPTIONS = { credentials: 'omit', referrerPolicy: 'no-referrer' } as const;

let loading: Promise<CJKFace[]> | undefined;

/**
 * Registers the CJK faces. Resolves to the faces registered - none when Google Fonts cannot
 * be reached, which leaves CJK text to the platform's fonts. A failed load is not kept, so
 * the next export tries again once the network is back.
 */
export function registerCJKFont(fonts: FontFaceSet = document.fonts): Promise<CJKFace[]> {
  loading ??= (async () => {
    try {
      const response = await fetch(CJK_STYLESHEET_URL, { ...FETCH_OPTIONS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        loading = undefined;
        return [];
      }
      const faces = parseCJKFaces(await response.text());
      for (const face of faces) {
        fonts.add(new FontFace(CJK_FAMILY, `url("${face.url}") format("woff2")`, {
          weight: String(face.weight), style: 'normal', display: 'swap', unicodeRange: face.unicodeRange,
        }));
      }
      return faces;
    } catch {
      loading = undefined;
      return [];
    }
  })();
  return loading;
}

/** The faces that draw at least one character of `text`, chosen within each weight. */
export function facesForText(text: string, faces: readonly CJKFace[]): CJKFace[] {
  // Every weight covers the same characters, so the choice is made per weight: across all of
  // them, a character would pick one weight's face and leave the others out.
  const weights = [...new Set(faces.map((face) => face.weight))];
  return weights.flatMap((weight) => {
    const ofWeight = faces.filter((face) => face.weight === weight);
    const shards = ofWeight.map((face, index) => ({ name: String(index), unicodeRange: face.unicodeRange }));
    return shardsForText(text, shards).map((shard) => ofWeight[Number(shard.name)]);
  });
}

function readDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Self-contained `@font-face` rules for the CJK characters of `text`, for a document that
 * leaves the console. A face that cannot be fetched is left out, as it is in the console:
 * the reader's own CJK font draws those characters.
 */
export async function embeddedCJKFontCSS(text: string, family: string): Promise<string> {
  const needed = facesForText(text, await registerCJKFont());
  const rules = await Promise.all(needed.map(async (face) => {
    try {
      const response = await fetch(face.url, { ...FETCH_OPTIONS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return '';
      const data = await readDataURL(new Blob([await response.arrayBuffer()], { type: 'font/woff2' }));
      return `@font-face{font-family:"${family}";src:url("${data}") format("woff2");font-weight:${face.weight};font-style:normal;unicode-range:${face.unicodeRange}}`;
    } catch {
      return '';
    }
  }));
  return rules.join('');
}
