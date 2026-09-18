/**
 * Colour arithmetic for the theme's derivation, in one place.
 *
 * The palette is no longer a table of hand-picked hex values: a palette declares nine
 * authored tokens and the rest are computed from them (`palette.ts`). That makes this
 * module load-bearing rather than incidental - every derived token in every palette,
 * including the six built-ins and the pre-hydration fallback in `index.css`, is a
 * result of these functions.
 *
 * **Everything here works in OKLCH.** A blend of two neutrals and a lightness step of an
 * accent are both "how much ink", and OKLCH is the space where that question has a
 * perceptually even answer. The stylesheet already mixes in OKLCH for the two sequential
 * ramps (`cacheScale.ts`, `heatmapRamp.ts`), so this keeps one rule rather than two.
 *
 * Measured: fitting the six built-in palettes in OKLCH and in raw sRGB gives the same
 * residual (mean |ΔL| 0.011 for the hover step), so the space is not what limits fidelity
 * to the old hand-tuned values - the spread between those values is. See
 * `docs/adr/0011-theme-modes-and-derived-palettes.md`.
 */

export type Rgb = readonly [number, number, number];

const HEX_PATTERN = /^#(?:[0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

/** Normalise `#ABC`, `abc` or `#aabbcc` to the canonical six-digit lowercase form. */
export function normalizeHex(value: string): string | undefined {
  const trimmed = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(trimmed)) {
    return `#${trimmed.split('').map((digit) => digit + digit).join('')}`.toLowerCase();
  }
  return /^[0-9a-f]{6}$/i.test(trimmed) ? `#${trimmed.toLowerCase()}` : undefined;
}

export function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHex(hex);
  if (!normalized) throw new Error(`not a hex colour: ${hex}`);
  return [1, 3, 5].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255) as unknown as Rgb;
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

const srgbToLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (channel: number): number =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

/** WCAG relative luminance, on linear-light sRGB. */
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex);
  return 0.2126 * srgbToLinear(red) + 0.7152 * srgbToLinear(green) + 0.0722 * srgbToLinear(blue);
}

/**
 * WCAG contrast ratio, 1:1 to 21:1.
 *
 * The single authority for every contrast number in the console: the derivation's own
 * label-solving loop, the editor's live readouts, and the assertions in
 * `scripts/test-theme-presets.ts` all call it, so a ratio cannot be computed two ways.
 */
export function contrastRatio(left: string, right: string): number {
  const a = relativeLuminance(left);
  const b = relativeLuminance(right);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** A colour split into the three OKLCH channels, hue in radians. */
interface Oklch {
  lightness: number;
  chroma: number;
  hue: number;
}

function toOklch(hex: string): Oklch {
  const [red, green, blue] = hexToRgb(hex).map(srgbToLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, chroma: Math.hypot(labA, labB), hue: Math.atan2(labB, labA) };
}

function fromOklch({ lightness, chroma, hue }: Oklch): string {
  const a = Math.cos(hue) * chroma;
  const b = Math.sin(hue) * chroma;
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return rgbToHex([
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

/** OKLCH lightness, 0 (black) to 1 (white). The accent ladder is built from this. */
export function oklchLightness(hex: string): number {
  return toOklch(hex).lightness;
}

/**
 * Below this chroma a colour is a true neutral, and its hue is numerically meaningless.
 *
 * It has to be handled explicitly. `#ffffff` measures a chroma of 0 and an *arbitrary* hue -
 * 89.9 degrees on this conversion, because with a and b both zero the arctangent is decided by
 * floating-point noise. Interpolating that hue toward a cool border's sweeps the blend halfway
 * round the wheel and tints the result warm: measured, whites blended toward `#e5e5ea` came out
 * `#f3f0f1` instead of a cool `#f1f1f4`. A neutral endpoint therefore contributes no hue at all,
 * and the blend holds the coloured endpoint's hue while ramping only chroma - which is what CSS
 * `color-mix` does, and why a white page and a blue-grey divider produce a blue-grey step.
 */
const NEUTRAL_CHROMA = 0.0005;

/**
 * mixOklch blends `from` toward `to`, interpolating lightness and chroma linearly and hue
 * along the shorter arc.
 *
 * Shorter-arc hue interpolation is what keeps a blend between two unrelated hues (a warm
 * border and a cool page, say) from taking the long way round the wheel through magenta.
 */
export function mixOklch(from: string, to: string, amount: number): string {
  const start = toOklch(from);
  const end = toOklch(to);
  // A neutral endpoint borrows the other's hue, so the blend has nowhere to rotate to.
  const startHue = start.chroma <= NEUTRAL_CHROMA ? end.hue : start.hue;
  const endHue = end.chroma <= NEUTRAL_CHROMA ? start.hue : end.hue;
  let hueDelta = endHue - startHue;
  while (hueDelta > Math.PI) hueDelta -= 2 * Math.PI;
  while (hueDelta < -Math.PI) hueDelta += 2 * Math.PI;
  return fromOklch({
    lightness: start.lightness + (end.lightness - start.lightness) * amount,
    chroma: start.chroma + (end.chroma - start.chroma) * amount,
    hue: startHue + hueDelta * amount,
  });
}

/**
 * withLightness moves a colour to a target OKLCH lightness, holding hue and reducing
 * chroma only as far as the sRGB gamut requires.
 *
 * Reducing chroma rather than clipping channels is what keeps a darkening step from
 * shifting hue: a clipped channel bends the result toward the neighbouring primary, so a
 * blue accent would walk toward violet as it deepened, and the pressed state of a button
 * would no longer be the same colour as its resting one.
 */
export function withLightness(hex: string, targetLightness: number): string {
  const { chroma, hue } = toOklch(hex);
  for (let candidate = chroma; candidate >= 0; candidate -= 0.002) {
    const rgb = testGamut({ lightness: targetLightness, chroma: candidate, hue });
    if (rgb) return rgb;
  }
  return fromOklch({ lightness: targetLightness, chroma: 0, hue });
}

/** The colour as hex when it fits sRGB, or undefined when a channel had to be clipped. */
function testGamut(color: Oklch): string | undefined {
  const a = Math.cos(color.hue) * color.chroma;
  const b = Math.sin(color.hue) * color.chroma;
  const l = (color.lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  if (channels.some((channel) => channel < -0.001 || channel > 1.001)) return undefined;
  return rgbToHex(channels as unknown as Rgb);
}

export interface InkChoice {
  /** The candidate that reads best on the given background. */
  ink: string;
  ratio: number;
}

/**
 * bestInkOn picks the candidate with the higher contrast against `background`.
 *
 * Two candidates and no threshold: this answers "which of these reads better", and the
 * caller decides whether the answer is good enough. The theme's accent ladder needs that
 * split, because it has to keep darkening a fill until the answer clears the floor.
 */
export function bestInkOn(background: string, candidates: readonly string[]): InkChoice {
  let best: InkChoice = { ink: candidates[0], ratio: 0 };
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > best.ratio) best = { ink: candidate, ratio };
  }
  return best;
}
