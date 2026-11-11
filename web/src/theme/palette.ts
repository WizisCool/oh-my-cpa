/**
 * The palette model: nine authored tokens, twenty-two derived ones, and the built-in
 * palettes each mode offers.
 *
 * **The split is the design.** A palette used to be thirty hand-tuned hex values, which
 * meant every palette was right by construction and no palette could be checked for
 * anything. Now a palette declares nine authored tokens - the page, its three surfaces,
 * the four text steps and the accent - and everything else is computed. Two consequences
 * follow, and both are deliberate:
 *
 * 1. A user-authored palette is possible at all. Nine values is a form; thirty is not.
 * 2. The tokens that must hold a *relationship* now hold it by construction rather than by
 *    review: the heatmap's quiet stop is the border-soft step because it is computed from
 *    it, the tooltip sits on the surface because it is computed to, and a filled accent
 *    control's label clears 4.5:1 because the fill is deepened until it does.
 *
 * The six built-in palettes are authored as nine tokens too, and their derived values are
 * computed like any other palette's. They are still hand-authored, just at nine values
 * instead of thirty. Derivation and contrast bounds live here, alongside the authored values.
 */

import type { MessageKey } from '../i18n/catalog';
import { contrastRatio, mixOklch, mixSrgb, oklchLightness, withLightness, type InkChoice } from './colorMath';
import {
  isValidExternalThemeId,
  validateThemeManifest,
  type LocalizedThemeText,
  type OMCThemeManifest,
  type RegisteredTheme,
  type ThemePrimaryOverride,
  type ThemeSemanticOverrides,
} from './themeContract';

// Conversation objects use foreground transparency rather than authored colours, so every
// preset and custom palette keeps the same relationship to the conversation's ground.
// Live labels sweep this same foreground over secondary ink; motion adds no palette colour.
export const THREAD_FILL_SHARES = { field: 5, fieldHover: 8, hairline: 12 } as const;

export type ThemeMode = 'dark' | 'light';

export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light'];

export type BuiltInPaletteId = 'omc-dark' | 'omc-light' | 'pewter' | 'fog' | 'forest' | 'sandstone';

export const BUILT_IN_PALETTE_IDS: readonly BuiltInPaletteId[] = [
  'omc-dark',
  'omc-light',
  'pewter',
  'fog',
  'forest',
  'sandstone',
];

/**
 * Registered palettes that were withdrawn, and the palette of the same mode that took each one's place.
 *
 * A stored preference outlives a release: `omc-theme` and `ui_preferences` can still name a withdrawn
 * palette, and an operator's own palette records the one it started from. Reading such a document as
 * the successor keeps the operator on the nearest look - and keeps their authored palette - where
 * refusing the id would silently drop both.
 */
const RETIRED_PALETTE_IDS: Readonly<Record<string, BuiltInPaletteId>> = {
  midnight: 'pewter',
  porcelain: 'fog',
};

/** The registered palette a stored id means today, or the value unchanged when it is not a retired id. */
export function currentPaletteId(value: unknown): unknown {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_PALETTE_IDS, value) ? RETIRED_PALETTE_IDS[value] : value;
}

/** What a mode's palette selection can point at: one registered theme (built-in or external), or the operator's own. */
export type PaletteRef = BuiltInPaletteId | 'custom' | (string & {});

/** The identity a resolved palette is known by, including external themes and the two synthetic custom ids. */
export type ResolvedPaletteId = BuiltInPaletteId | 'omc-custom-dark' | 'omc-custom-light' | (string & {});

/**
 * The nine authored tokens. Everything a user can edit is in here, and nothing else.
 *
 * The set is not arbitrary: it is the smallest one that can describe a usable interface
 * without inventing relationships. A page and its surfaces are choices, the text ladder is
 * a choice, and the accent is a choice; a hover fill, a divider, a tooltip background and a
 * chart track are all consequences.
 */
export interface ThemeCore {
  bg: string;
  surface: string;
  elevated: string;
  fg: string;
  fg2: string;
  muted: string;
  meta: string;
  border: string;
  accent: string;
}

export const CORE_TOKEN_KEYS: readonly (keyof ThemeCore)[] = [
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

/**
 * The complete palette every consumer reads. Downstream surfaces - Ant Design's tokens,
 * the stylesheet's custom properties, the chart runtime, the Monaco editor and the brand
 * artwork - take this object and nothing else, so a palette is resolved once and never
 * re-derived per surface. Phone density changes layout, never this colour contract.
 */
export interface ThemePalette extends ThemeCore {
  /** The ground the navigation stands on, one step behind the content panel the page is drawn in. */
  canvas: string;
  borderSoft: string;
  hover: string;
  rowHover: string;
  selected: string;
  hoverInset: string;
  /** Filled primary action surface (`<Button variant="primary">`, Composer send, checked box). */
  primary: string;
  primaryHover: string;
  primaryActive: string;
  primaryOn: string;
  accentHover: string;
  accentActive: string;
  accentOn: string;
  success: string;
  warn: string;
  danger: string;
  /** The request duration ramp's low stop, green. Mixed toward `timingOrange` by CSS. */
  timingGreen: string;
  /** The request duration ramp's high stop, orange. */
  timingOrange: string;
  cacheRateYellow: string;
  cacheRateGreen: string;
  tooltipBg: string;
  heatmapQuiet: string;
  heatmapBusy: string;
  heatmapZeroUnrecorded: string;
  heatmapZeroRecorded: string;
  heatmapTipLink: string;
  /** Shares of the foreground, in percent, solved so each edge ring stands `EDGE_STEPS` off the page. */
  edgeShare: number;
  liftShare: number;
  fineShare: number;
  /** The ink drop shadows are cast in: the palette's own hue, near black. */
  shade: string;
  /** Categorical identities for multi-series charts, in legend order. */
  series: readonly string[];
  seriesTrack: string;
  /** The reasoning-effort scale, lowest reasoning step first (`effortScale.ts`). */
  effort: readonly string[];
}

/**
 * How much of the way from the page toward the foreground each neutral step travels, per
 * mode. Fitted against the six built-in palettes.
 *
 * Two constants per mode rather than one shared set, because the modes have different
 * room: a dark page's foreground is far brighter than it, so the same perceptual step is a
 * larger fraction there. This keeps the step *proportional* to a palette's own contrast,
 * which is what makes it survive an operator authoring a very low-contrast pair.
 */
const NEUTRAL_BLEND: Record<ThemeMode, { hover: number; hoverInset: number; borderSoft: number; selected: number }> = {
  dark: { hover: 0.116, hoverInset: 0, borderSoft: 0.583, selected: 0.075 },
  light: { hover: 0.045, hoverInset: 0.05, borderSoft: 0.541, selected: 0.038 },
};

/**
 * The least OKLCH lightness the soft rule must stand off the page.
 *
 * The blends above are fractions of a palette's own distances, and a light palette's distances are
 * short: its border sits a few points below white, so a soft rule and a chart's grid derived from it
 * came out at roughly half the perceptual step they take on a dark page, and the grid vanished.
 * OKLCH lightness is perceptual, so one floor gives both modes the same visible step; the dark
 * built-ins already clear it and are unchanged, and an operator's faint light palette is lifted to it
 * rather than inheriting the fade. Hover is left to its blend: it sits under the effort badges, whose
 * hues are fixed semantics tuned against it.
 */
const BORDER_SOFT_FLOOR = 0.06;

/** `color`, moved away from `ground` along its own direction until the two are `floor` apart. */
function standOff(ground: string, color: string, toward: string, floor: number): string {
  const groundLightness = oklchLightness(ground);
  const delta = oklchLightness(color) - groundLightness;
  if (Math.abs(delta) >= floor) return color;
  const direction = delta !== 0 ? Math.sign(delta) : Math.sign(oklchLightness(toward) - groundLightness) || -1;
  return withLightness(color, Math.min(1, Math.max(0, groundLightness + direction * floor)));
}

/**
 * How far the canvas recedes behind the content panel. A light canvas is a faint step toward the
 * foreground - the panel reads as the sheet of paper on the desk - while a dark canvas sinks
 * toward black, because a lighter frame around a dark page reads as a glow rather than as a desk.
 */
const CANVAS_BLEND: Record<ThemeMode, { toward: 'fg' | 'black'; share: number }> = {
  dark: { toward: 'black', share: 0.24 },
  light: { toward: 'fg', share: 0.04 },
};

/**
 * How far each edge stands off the ground it is drawn on, in OKLCH lightness.
 *
 * An edge is a one-pixel ring of the foreground ink laid over the ground, and a fixed share of
 * ink is not a fixed step: 8% of the ink moved OMC Dark's page by 0.078 but a light page by under
 * 0.04, about half the step its own authored border takes, and cards on Fog and Sandstone could not
 * be told from the page at a glance. So the share is solved per palette for the step, and every
 * palette - an operator's own included - draws its edges at the same perceptual weight.
 *
 *   edge  a surface resting on the page: cards, tables, settings groups, the composer
 *   lift  the same surface under the pointer, and a layer floating over the page
 *   fine  the faint ring a control stands in and a field or a track is set into
 *
 * The edge step sits between the derived soft rule (0.06) and the authored borders (0.09-0.15):
 * firm enough to read without the drop under it, quiet enough that it does not draw a line.
 */
export const EDGE_STEPS = { edge: 0.08, lift: 0.11, fine: 0.05 } as const;

/** The least share of `ink`, in half percents, that moves `ground` by `step` of OKLCH lightness. */
function inkShareFor(ground: string, ink: string, step: number): number {
  const groundLightness = oklchLightness(ground);
  for (let share = 0.5; share < 100; share += 0.5) {
    if (Math.abs(oklchLightness(mixSrgb(ground, ink, share / 100)) - groundLightness) >= step) return share;
  }
  return 100;
}

/**
 * The ink a palette's drop shadows are cast in: its own hue, near black. A neutral black shadow
 * on a warm or a cool page reads as a grey smudge on it; a shadow carrying the page's hue reads as
 * the same material in less light. A light palette's foreground is already a deep ink of its hue;
 * a dark page's own colour is taken most of the way to black.
 */
function shadeInk(mode: ThemeMode, core: ThemeCore): string {
  return mode === 'light' ? mixOklch(core.fg, '#000000', 0.3) : mixOklch(core.bg, '#000000', 0.8);
}

/**
 * The accent ladder's steps, as a fraction of the accent's own OKLCH lightness.
 *
 * Fitted, not chosen: solving the six built-ins' ladders as fractions of their accent's
 * lightness lands within ΔL ≤ 0.03 on five of them, while any fixed lightness step misses
 * by two to three times that. A proportional step also cannot run off the end of the scale
 * as an operator's accent gets lighter or darker.
 */
const ACCENT_LADDER: Record<ThemeMode, { hover: number; active: number }> = {
  dark: { hover: 0.831, active: 0.699 },
  light: { hover: 0.855, active: 0.737 },
};

/**
 * The two inks a filled accent control's label may use, and the floor it must clear.
 *
 * Two candidates, both extremes: a filled control's label is either the page's own light
 * ink or its dark ink, never a mid grey. The floor is the same 4.5:1 every other text pair
 * in the console is held to, and it is enforced by *moving the fill* rather than by
 * accepting a bad pair - see `accentLadderStep`.
 */
const ON_ACCENT_INKS = ['#ffffff', '#101014'] as const;

/**
 * The ratio the solving loop aims for, and the ratio the tests assert.
 *
 * The two are deliberately different by a margin. A solved fill is rounded to six hex digits, and
 * rounding can move the measured ratio by a hundredth or two: aiming at exactly 4.5 produced OMC
 * Dark's fill at a measured 4.50:1, which is a palette that passes or fails depending on which
 * direction the last channel rounded. Solving to 4.6 leaves the assertion at 4.5 the room it needs.
 */
const LABEL_CONTRAST_TARGET = 4.6;

/**
 * The floor every filled accent control's label is guaranteed to clear.
 *
 * Exported so palette consumers and contrast checks share one bound for built-in and
 * authored palettes alike.
 */
export const ACCENT_LABEL_CONTRAST_FLOOR = 4.5;

/**
 * How finely, and how far, the label-solving loop may move a fill.
 *
 * 0.005 of OKLCH lightness is below the threshold at which a filled button's colour can be told from
 * its neighbour, and 200 steps cross the whole scale from either end, so the loop is both
 * perceptually granular and guaranteed to terminate.
 */
const LADDER_STEP = 0.005;
const MAX_LADDER_STEPS = 200;

/**
 * The lightness below which a fill has no room left to deepen.
 *
 * Not zero: an accent at the very bottom of the scale has *no* room, and one just above it has so
 * little that the three states would be indistinguishable, which is the same defect as having none.
 */
const MIN_DEEPENING_ROOM = 0.03;

/**
 * Which way the accent ladder travels from the resting accent.
 *
 * Deepening is the direction every built-in palette uses and therefore the default. It is not the
 * only possible one: an operator is free to author an accent of near-black, and from there a deeper
 * fill does not exist - the hover and pressed states both solve down to the same black, leaving a
 * filled control whose hover and press are invisible. When there is no room to deepen, the ladder
 * mirrors and lightens instead, which is the direction that has room.
 */
type LadderDirection = 'deeper' | 'lighter';

/**
 * Per-mode values that are not derived from the nine authored tokens.
 *
 * Status hues, timing bands, category identities and reasoning effort have
 * their own colour roles. A category keeps its identity through a theme switch, and an effort
 * step keeps its place on an ordered sweep. Deriving those roles from an operator's accent
 * would make their meaning depend on a colour choice. A custom palette inherits its mode's
 * set, with contrast held by `holdSignal`.
 */
const MODE_SEMANTICS: Record<ThemeMode, { success: string; warn: string; danger: string; timingOrange: string; series: readonly string[]; effort: readonly string[] }> = {
  dark: {
    success: '#10b981',
    warn: '#f59e0b',
    danger: '#ef4444',
    timingOrange: '#fb923c',
    series: ['#6588f5', '#10b981', '#9b7bf7', '#f43f5e', '#f59e0b', '#14b8a6'],
    // Categorical identities for multi-series charts: the familiar dashboard set of blue, emerald,
    // violet, rose, amber and cyan, stepped lighter on dark and deeper on light.
    effort: ['#94bfce', '#4eccd3', '#91b7fe', '#bda7fe', '#f08dee', '#ff8cc1'],
  },
  light: {
    success: '#059669',
    warn: '#b45309',
    danger: '#dc2626',
    timingOrange: '#c2410c',
    series: ['#3d63cf', '#059669', '#6d47d9', '#e11d48', '#b45309', '#0d8a7e'],
    effort: ['#39626e', '#00686c', '#3057a3', '#6343a4', '#8a2b8a', '#9b2065'],
  },
};

/**
 * The most contrast a held colour is asked for. A mark or a label on the page is held up to body
 * text's floor. An effort badge prints its step on a 12-14% wash of the step itself, and on a lifted
 * dark ground that wash costs well over a ratio point - measured, 5.8:1 on the bare row hover became
 * 4.4:1 on the badge - so its steps are held to a ceiling that leaves the badge above the floor.
 */
const SIGNAL_CONTRAST_CEILING = { mark: 4.5, badge: 6 } as const;

/** The palette each mode's semantics were tuned on, whose page and surface set the contrast they keep. */
const SIGNAL_REFERENCE: Record<ThemeMode, BuiltInPaletteId> = { dark: 'omc-dark', light: 'omc-light' };

/**
 * holdSignal keeps a semantic colour as legible on this palette as on its mode's reference.
 *
 * A semantic hue is an identity, but its contrast belongs to the ground it was tuned on: the same
 * green that reads 3.3:1 on OMC Light's white falls to 3.1:1 on a grey page, and the same red that
 * reads 4.5:1 on OMC Dark falls below 4:1 on a lifted charcoal. So it moves in lightness alone, in the
 * step the accent ladder uses, until the colour clears what it measured on the reference again - never
 * beyond the ceiling, since chasing a pastel's 7:1 would bleach it for legibility nobody needs. The
 * hue stays, and chroma gives way only as far as the new lightness leaves the sRGB gamut. On the
 * reference itself, and on any palette whose ground already leaves the colour that legible, the
 * constant is returned unchanged.
 *
 * The direction is read from the grounds, not the mode: an operator may author a dark-mode palette on
 * a light page, and lightening a signal there walks it into the page. Both directions are tried a step
 * at a time and the smaller move that clears the target wins. Grounds that straddle the colour may
 * leave no move that clears it, and then the most legible candidate seen is kept.
 *
 * The contrast held is capped (`SIGNAL_CONTRAST_CEILING`): a pastel effort step reads 7:1 on OMC
 * Dark, and chasing that on a lighter ground would bleach it toward white for legibility nobody needs.
 */
function holdSignal(color: string, grounds: readonly string[], reference: readonly string[], ceiling: number, floor = 0): string {
  const weakest = (candidate: string, on: readonly string[]) => Math.min(...on.map((ground) => contrastRatio(candidate, ground)));
  const target = Math.max(floor, Math.min(weakest(color, reference), ceiling));
  return holdContrast((candidate) => weakest(candidate, grounds), color, target);
}

/**
 * The least contrast every readout on the request duration ramp must clear.
 *
 * Above the 4.5:1 text floor rather than at it, because the guarantee is about the *sweep* and not
 * its endpoints: the stops are searched in twenty-sample steps while the paint is a continuous
 * blend, so a stop solved to exactly 4.5 can leave a reading between samples a few hundredths below
 * it. Aiming at 4.6 and then measuring the ramp at a thousand points leaves the worst reading at
 * 4.60:1 on the built-ins and across the accent sweep.
 */
export const DURATION_RAMP_CONTRAST_FLOOR = 4.6;

/** How finely the ramp is sampled while its stops are solved: twenty points between them. */
const DURATION_RAMP_SAMPLES = 20;

/**
 * holdContrast moves a colour in lightness until `measure` reports the floor, and returns the most
 * legible candidate it saw otherwise.
 *
 * The step size is the accent ladder's - 0.005 of OKLCH lightness, below the threshold at which a
 * small coloured value can be told from its neighbour - and both directions are tried one step at a
 * time, so the smaller move wins and neither a dark page nor a light one is assumed. Chroma gives way
 * only as far as the new lightness leaves the gamut (`withLightness`), so the hue survives the move.
 */
function holdContrast(measure: (candidate: string) => number, color: string, floor: number): string {
  const start = measure(color);
  if (start >= floor) return color;
  let best = { color, ratio: start };
  const lightness = oklchLightness(color);
  for (let stepIndex = 1; stepIndex <= MAX_LADDER_STEPS; stepIndex += 1) {
    for (const travel of [LADDER_STEP, -LADDER_STEP]) {
      const moved = lightness + travel * stepIndex;
      if (moved < 0 || moved > 1) continue;
      const candidate = withLightness(color, moved);
      const ratio = measure(candidate);
      if (ratio >= floor) return candidate;
      if (ratio > best.ratio) best = { color: candidate, ratio };
    }
  }
  return best.color;
}

/**
 * durationRampStops solves the two ends of the request duration ramp.
 *
 * They are solved **together**, because the promise is about the ramp and not about its ends: a
 * reading anywhere between green and orange has to clear `DURATION_RAMP_CONTRAST_FLOOR` on every
 * surface it can sit on, and holding each stop in isolation leaves the mid-blend - where an
 * eight-bit OKLCH interpolation loses up to about three tenths of a ratio point - unmeasured.
 *
 * Both ends travel the same way, one step at a time, as the accent ladder's two fills do: which end
 * is short of the floor depends on the palette's own ground, so the direction is read from the
 * measurement rather than from the mode. A palette whose ramp already qualifies keeps its hues
 * untouched, which is the six built-ins' dark cases.
 *
 * The hues stay the mode's own success and orange steps, so a slow request never inherits the danger
 * hue that a failure uses.
 */
function durationRampStops(
  green: string,
  orange: string,
  grounds: readonly string[],
): { green: string; orange: string } {
  const sweepWorst = (from: string, to: string): number => {
    let weakest = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= DURATION_RAMP_SAMPLES; step += 1) {
      const blend = mixOklch(from, to, step / DURATION_RAMP_SAMPLES);
      weakest = Math.min(weakest, ...grounds.map((ground) => contrastRatio(blend, ground)));
    }
    return weakest;
  };
  const start = sweepWorst(green, orange);
  if (start >= DURATION_RAMP_CONTRAST_FLOOR) return { green, orange };
  const greenLightness = oklchLightness(green);
  const orangeLightness = oklchLightness(orange);
  let best = { green, orange, ratio: start };
  for (let stepIndex = 1; stepIndex <= MAX_LADDER_STEPS; stepIndex += 1) {
    for (const travel of [LADDER_STEP, -LADDER_STEP]) {
      const nextGreen = greenLightness + travel * stepIndex;
      const nextOrange = orangeLightness + travel * stepIndex;
      if (nextGreen < 0 || nextGreen > 1 || nextOrange < 0 || nextOrange > 1) continue;
      const candidateGreen = withLightness(green, nextGreen);
      const candidateOrange = withLightness(orange, nextOrange);
      const ratio = sweepWorst(candidateGreen, candidateOrange);
      if (ratio >= DURATION_RAMP_CONTRAST_FLOOR) return { green: candidateGreen, orange: candidateOrange };
      if (ratio > best.ratio) best = { green: candidateGreen, orange: candidateOrange, ratio };
    }
  }
  return { green: best.green, orange: best.orange };
}

/**
 * The editor's contrast readout, per authored token.
 *
 * Roles rather than one threshold, because the tokens do different jobs. `fg` and `fg2` are body
 * text and must clear 4.5:1; `accent` carries link text and answers to the same floor. `muted` is
 * the hint step and `meta` the footnote step below it - a footnote is allowed to be quieter than a
 * hint, and holding both to one floor would either pass the footnotes or fail the hints. The
 * surface and border steps have no text floor at all: they are *layers*, and a divider that cleared
 * 4.5:1 against its page would be a black rule.
 *
 * The three floors were measured against all six built-in palettes before being set, and each one is
 * the step the console actually uses: `muted` reads 3.87-4.93:1 and `meta` 2.28-2.87:1. A single 4.5:1
 * floor would leave every one of the six permanently flagged - `muted` never reaches it and `meta`
 * never reaches 3 - and a warning that is always on is how a real one gets ignored.
 */
export type ContrastRole = 'text' | 'hint' | 'quiet' | 'layer';

export const CORE_TOKEN_CONTRAST_ROLES: Record<keyof ThemeCore, ContrastRole> = {
  bg: 'layer',
  surface: 'layer',
  elevated: 'layer',
  border: 'layer',
  fg: 'text',
  fg2: 'text',
  muted: 'hint',
  meta: 'quiet',
  accent: 'text',
};

/** The minimum contrast each role must clear against the page. `layer` has none. */
export const CONTRAST_FLOORS: Record<ContrastRole, number | undefined> = {
  text: 4.5,
  hint: 3,
  quiet: 2,
  layer: undefined,
};

/**
 * The ink that reads best across *both* fills, and how well it reads on the weaker of the two.
 *
 * One ink sits on all three filled-control states, so a label is only as legible as its worst pair.
 * Scoring each candidate by the minimum of its two contrasts is what makes that the quantity being
 * solved for, rather than the hover pair that happens to be the resting state.
 */
function bestInkAcross(fills: readonly string[]): InkChoice {
  let best: InkChoice = { ink: ON_ACCENT_INKS[0], ratio: 0 };
  for (const ink of ON_ACCENT_INKS) {
    const ratio = Math.min(...fills.map((fill) => contrastRatio(ink, fill)));
    if (ratio > best.ratio) best = { ink, ratio };
  }
  return best;
}

/**
 * accentLadder derives the filled control's three states and the one label they share.
 *
 * The loop is the contract. A fixed lightness step can land a fill in the dead zone where neither
 * white nor near-black clears 4.5:1 - measured on the built-ins of the time, a −0.075 step puts OMC Dark's
 * label at 3.73:1 and a `#58a6ff` accent's at 3.38:1 - and no label choice rescues that pair. So the step is the
 * *starting point*, and both fills keep moving along one direction until a single ink clears the target
 * on *both* of them.
 *
 * Solving the two fills together, rather than each on its own, is what this owes the operator: the
 * pressed state is a state the same label is read in, and solving only the hover fill left a `#58a6ff` accent's
 * near-black label at 3.14:1 the moment the button was pressed. Because both moves are in one
 * direction, the ink that wins on the deeper fill is the one being tested on the lighter one.
 *
 * `ACCENT_LABEL_CONTRAST_FLOOR` is the floor a caller may rely on; the loop aims at
 * `LABEL_CONTRAST_TARGET`, which is that floor plus the room hex rounding needs.
 */
function accentLadder(mode: ThemeMode, accent: string): { hover: string; active: string; ink: string } {
  const step = ACCENT_LADDER[mode];
  const lightness = oklchLightness(accent);
  const direction: LadderDirection = lightness * step.hover > MIN_DEEPENING_ROOM ? 'deeper' : 'lighter';
  // Mirror the proportional step for the lighter direction: the same fraction of the room that remains,
  // measured from the other end of the scale. That keeps the *size* of a step a property of the palette's
  // own contrast position rather than of which direction it happens to travel.
  const startOf = (factor: number) => (direction === 'deeper' ? lightness * factor : 1 - (1 - lightness) * factor);
  let hoverLightness = startOf(step.hover);
  let activeLightness = startOf(step.active);
  const travel = direction === 'deeper' ? -LADDER_STEP : LADDER_STEP;
  let best: InkChoice = { ink: ON_ACCENT_INKS[0], ratio: 0 };

  for (let stepIndex = 0; stepIndex < MAX_LADDER_STEPS; stepIndex += 1) {
    const at = (lightness: number) => withLightness(accent, Math.min(1, Math.max(0, lightness)));
    const hover = at(hoverLightness);
    const active = at(activeLightness);
    best = bestInkAcross([hover, active]);
    if (best.ratio >= LABEL_CONTRAST_TARGET) return { hover, active, ink: best.ink };
    hoverLightness += travel;
    activeLightness += travel;
  }
  // Unreachable: the scale's own end carries 21:1 against one of the two inks. The return keeps the
  // function total rather than trusting the loop to have converged.
  const end = direction === 'deeper' ? 0 : 1;
  return { hover: withLightness(accent, end), active: withLightness(accent, end), ink: best.ink };
}

function resolvePrimarySurface(
  mode: ThemeMode,
  defaultLadder: { hover: string; active: string; ink: string },
  override: string | ThemePrimaryOverride | undefined,
): { primary: string; primaryHover: string; primaryActive: string; primaryOn: string } {
  if (!override) {
    // Default for 9-token custom palettes: primary buttons use the solved accent ladder.
    const further = accentLadder(mode, defaultLadder.hover);
    return {
      primary: defaultLadder.hover,
      primaryHover: defaultLadder.active,
      primaryActive: further.active,
      primaryOn: defaultLadder.ink,
    };
  }
  if (typeof override === 'string') {
    const solved = accentLadder(mode, override);
    const further = accentLadder(mode, solved.hover);
    // If the supplied hex itself clears 4.6:1 with one ink alongside its stepped hover/active, keep it as the resting fill.
    const directStep = oklchLightness(override) > 0.5
      ? { hover: withLightness(override, Math.max(0, oklchLightness(override) - 0.06)), active: withLightness(override, Math.max(0, oklchLightness(override) - 0.12)) }
      : { hover: withLightness(override, Math.min(1, oklchLightness(override) + 0.06)), active: withLightness(override, Math.min(1, oklchLightness(override) + 0.12)) };
    const directInk = bestInkAcross([override, directStep.hover, directStep.active]);
    if (directInk.ratio >= LABEL_CONTRAST_TARGET) {
      return {
        primary: override,
        primaryHover: directStep.hover,
        primaryActive: directStep.active,
        primaryOn: directInk.ink,
      };
    }
    return {
      primary: solved.hover,
      primaryHover: solved.active,
      primaryActive: further.active,
      primaryOn: solved.ink,
    };
  }
  const fillL = oklchLightness(override.fill);
  const hover = override.hover ?? withLightness(override.fill, fillL > 0.5 ? Math.max(0, fillL - 0.06) : Math.min(1, fillL + 0.06));
  const active = override.active ?? withLightness(override.fill, fillL > 0.5 ? Math.max(0, fillL - 0.12) : Math.min(1, fillL + 0.12));
  if (
    override.ink &&
    contrastRatio(override.ink, override.fill) >= ACCENT_LABEL_CONTRAST_FLOOR &&
    contrastRatio(override.ink, hover) >= ACCENT_LABEL_CONTRAST_FLOOR &&
    contrastRatio(override.ink, active) >= ACCENT_LABEL_CONTRAST_FLOOR
  ) {
    return {
      primary: override.fill,
      primaryHover: hover,
      primaryActive: active,
      primaryOn: override.ink,
    };
  }
  const solvedInk = bestInkAcross([override.fill, hover, active]);
  if (solvedInk.ratio >= ACCENT_LABEL_CONTRAST_FLOOR) {
    return {
      primary: override.fill,
      primaryHover: hover,
      primaryActive: active,
      primaryOn: solvedInk.ink,
    };
  }
  const fallback = accentLadder(mode, override.fill);
  return {
    primary: fallback.hover,
    primaryHover: fallback.active,
    primaryActive: fallback.active,
    primaryOn: fallback.ink,
  };
}

/**
 * derivePalette computes all derived surface, contrast, primary, heatmap and telemetry tokens.
 *
 * Pure and total: the same nine tokens (plus optional semantic overrides) always produce the same
 * palette, so the pre-hydration fallback in `index.css`, the six built-ins, operator custom
 * palettes and third-party open themes share one code path.
 */
export function derivePalette(
  mode: ThemeMode,
  core: ThemeCore,
  overrides?: ThemeSemanticOverrides,
): ThemePalette {
  const blend = NEUTRAL_BLEND[mode];
  const semantics = MODE_SEMANTICS[mode];
  const hover = mixOklch(core.bg, core.fg, blend.hover);
  const selected = mixOklch(hover, core.accent, blend.selected);
  const borderSoft = standOff(core.bg, mixOklch(core.bg, core.border, blend.borderSoft), core.fg, BORDER_SOFT_FLOOR);
  const ladder = accentLadder(mode, core.accent);
  const primarySurface = resolvePrimarySurface(mode, ladder, overrides?.primary);
  const canvasBlend = CANVAS_BLEND[mode];
  const reference = getBuiltInPalette(SIGNAL_REFERENCE[mode]).core;
  const referenceHover = mixOklch(reference.bg, reference.fg, blend.hover);
  const hold = (color: string) => holdSignal(color, [core.bg, core.surface], [reference.bg, reference.surface], SIGNAL_CONTRAST_CEILING.mark);
  // An effort badge also sits on a hovered row, so the hover fill is one of its grounds.
  const holdBadge = (color: string) =>
    holdSignal(color, [core.bg, core.surface, hover], [reference.bg, reference.surface, referenceHover], SIGNAL_CONTRAST_CEILING.badge);
  const baseSuccess = overrides?.success ?? semantics.success;
  const baseWarn = overrides?.warn ?? semantics.warn;
  const baseDanger = overrides?.danger ?? semantics.danger;
  const baseSeries = overrides?.series ?? semantics.series;
  const success = hold(baseSuccess);
  const warn = hold(baseWarn);
  const timingGrounds = [core.bg, core.surface, core.elevated, hover, selected];
  const timingRamp = durationRampStops(baseSuccess, semantics.timingOrange, timingGrounds);
  return {
    ...core,
    canvas: mixOklch(core.bg, canvasBlend.toward === 'fg' ? core.fg : '#000000', canvasBlend.share),
    borderSoft,
    hover,
    rowHover: hover,
    hoverInset: blend.hoverInset === 0 ? core.bg : mixOklch(core.bg, core.fg, blend.hoverInset),
    selected,
    ...primarySurface,
    accentHover: ladder.hover,
    accentActive: ladder.active,
    accentOn: ladder.ink,
    success,
    warn,
    danger: hold(baseDanger),
    timingGreen: timingRamp.green,
    timingOrange: timingRamp.orange,
    cacheRateYellow: warn,
    cacheRateGreen: success,
    tooltipBg: mode === 'light' ? core.fg : core.surface,
    heatmapQuiet: borderSoft,
    heatmapBusy: core.accent,
    heatmapZeroUnrecorded: borderSoft,
    heatmapZeroRecorded: core.border,
    heatmapTipLink: core.accent,
    edgeShare: inkShareFor(core.bg, core.fg, EDGE_STEPS.edge),
    liftShare: inkShareFor(core.bg, core.fg, EDGE_STEPS.lift),
    fineShare: inkShareFor(core.bg, core.fg, EDGE_STEPS.fine),
    shade: shadeInk(mode, core),
    series: baseSeries.map(hold),
    seriesTrack: core.border,
    effort: semantics.effort.map(holdBadge),
  };
}

/** One registered palette: nine authored tokens plus how it names itself in the console. */
export interface BuiltInPalette {
  id: BuiltInPaletteId;
  mode: ThemeMode;
  nameKey: MessageKey;
  descriptionKey: MessageKey;
  core: ThemeCore;
  overrides?: ThemeSemanticOverrides;
}

/**
 * The built-in palettes, three per mode.
 *
 * OMC Dark and OMC Light pair high-contrast graphite/paper primary action buttons with a low-glare
 * mineral slate-iris accent matching the zinc-graphite neutral undertone (OKLCH ~280°), retiring
 * Ant Design's electric sky-blue. Pewter, Fog, Forest and Sandstone each hold composed, contrast-safe
 * primary surfaces tailored to their own substrate.
 */
export const BUILT_IN_PALETTES: readonly BuiltInPalette[] = [
  {
    id: 'omc-dark',
    mode: 'dark',
    nameKey: 'theme.omc_dark',
    descriptionKey: 'theme.omc_dark_desc',
    core: {
      bg: '#121214',
      surface: '#1c1c1f',
      elevated: '#222226',
      fg: '#f4f4f6',
      fg2: '#a1a1aa',
      muted: '#71717a',
      meta: '#52525b',
      border: '#2c2c30',
      accent: '#00a2fb',
    },
  },
  {
    id: 'omc-light',
    mode: 'light',
    nameKey: 'theme.omc_light',
    descriptionKey: 'theme.omc_light_desc',
    core: {
      bg: '#ffffff',
      surface: '#f1f1f3',
      elevated: '#ffffff',
      fg: '#1c1c1e',
      fg2: '#505055',
      muted: '#787880',
      meta: '#98989f',
      border: '#dcdce1',
      accent: '#005d8f',
    },
    overrides: {
      primary: { fill: '#005d8f', hover: '#004a73', active: '#023b5d', ink: '#ffffff' },
    },
  },
  {
    id: 'pewter',
    mode: 'dark',
    nameKey: 'theme.pewter',
    descriptionKey: 'theme.pewter_desc',
    core: {
      bg: '#1c2127',
      surface: '#242a32',
      elevated: '#2b323b',
      fg: '#e8ecf2',
      fg2: '#b8c0cc',
      muted: '#8992a0',
      meta: '#666f7d',
      border: '#363d49',
      accent: '#6ea3f0',
    },
    overrides: {
      primary: { fill: '#355f99', hover: '#3f6fb0', active: '#2b4d7d', ink: '#f5f8fc' },
    },
  },
  {
    id: 'fog',
    mode: 'light',
    nameKey: 'theme.fog',
    descriptionKey: 'theme.fog_desc',
    core: {
      bg: '#f4f7fa',
      surface: '#ebf0f5',
      elevated: '#fcfdff',
      fg: '#192028',
      fg2: '#47505a',
      muted: '#6a7480',
      meta: '#88929e',
      border: '#d3dbe3',
      accent: '#245399',
    },
    overrides: {
      primary: { fill: '#245399', hover: '#1c427a', active: '#15325e', ink: '#ffffff' },
    },
  },
  {
    id: 'forest',
    mode: 'dark',
    nameKey: 'theme.forest',
    descriptionKey: 'theme.forest_desc',
    core: {
      bg: '#0e1411',
      surface: '#162019',
      elevated: '#1d2a21',
      fg: '#edf5ef',
      fg2: '#a8b8ad',
      muted: '#74887b',
      meta: '#526558',
      border: '#293a2f',
      accent: '#7bd4a4',
    },
    overrides: {
      primary: { fill: '#23593e', hover: '#2b6b4b', active: '#1c4731', ink: '#edf5ef' },
    },
  },
  {
    id: 'sandstone',
    mode: 'light',
    nameKey: 'theme.sandstone',
    descriptionKey: 'theme.sandstone_desc',
    core: {
      bg: '#f8f3e8',
      surface: '#efe8d8',
      elevated: '#fffcf5',
      fg: '#2f2a22',
      fg2: '#5f574b',
      muted: '#786e5f',
      meta: '#9b8f7d',
      border: '#ded3c0',
      accent: '#0f6d66',
    },
    overrides: {
      primary: { fill: '#135953', hover: '#0e4742', active: '#0a3834', ink: '#fffcf5' },
    },
  },
];

/** The palettes one mode offers, in the order the settings page lists them. */
export function builtInPalettesForMode(mode: ThemeMode): readonly BuiltInPalette[] {
  return BUILT_IN_PALETTES.filter((palette) => palette.mode === mode);
}

export function isBuiltInPaletteId(value: unknown): value is BuiltInPaletteId {
  return typeof value === 'string' && (BUILT_IN_PALETTE_IDS as readonly string[]).includes(value);
}

const BUILT_IN_ID_SET: ReadonlySet<string> = new Set(BUILT_IN_PALETTE_IDS);
const EXTERNAL_THEMES = new Map<string, OMCThemeManifest>();
const RESOLVED_EXTERNAL = new Map<string, ResolvedPalette>();
const REGISTRY_LISTENERS = new Set<() => void>();
let registryRevision = 0;

function notifyThemeRegistry() {
  registryRevision += 1;
  for (const listener of REGISTRY_LISTENERS) listener();
}

export function subscribeThemeRegistry(listener: () => void): () => void {
  REGISTRY_LISTENERS.add(listener);
  return () => {
    REGISTRY_LISTENERS.delete(listener);
  };
}

export function getThemeRegistryRevision(): number {
  return registryRevision;
}

/**
 * Registers an external or plugin-contributed theme manifest into the active runtime registry.
 * Returns an `unregister` disposer. Throws with validation details if the manifest is malformed.
 */
export function registerTheme(manifestInput: OMCThemeManifest | unknown): () => void {
  const result = validateThemeManifest(manifestInput, BUILT_IN_ID_SET);
  if (!result.ok) {
    throw new Error(`Invalid OMCThemeManifest: ${result.errors.join('; ')}`);
  }
  const { manifest } = result;
  EXTERNAL_THEMES.set(manifest.id, manifest);
  RESOLVED_EXTERNAL.set(manifest.id, {
    id: manifest.id,
    mode: manifest.mode,
    palette: derivePalette(manifest.mode, manifest.core, manifest.overrides),
    isCustom: false,
    nameKey: manifest.mode === 'light' ? 'theme.omc_light' : 'theme.omc_dark',
    label: manifest.label,
    description: manifest.description,
  });
  notifyThemeRegistry();
  return () => {
    unregisterTheme(manifest.id);
  };
}

export function unregisterTheme(id: string): boolean {
  if (BUILT_IN_ID_SET.has(id) || !EXTERNAL_THEMES.has(id)) return false;
  EXTERNAL_THEMES.delete(id);
  RESOLVED_EXTERNAL.delete(id);
  notifyThemeRegistry();
  return true;
}

export function getRegisteredTheme(id: string): RegisteredTheme | undefined {
  if (isBuiltInPaletteId(id)) {
    const b = getBuiltInPalette(id);
    return {
      id: b.id,
      mode: b.mode,
      builtIn: true,
      nameKey: b.nameKey,
      descriptionKey: b.descriptionKey,
      core: b.core,
      overrides: b.overrides,
    };
  }
  const ext = EXTERNAL_THEMES.get(id);
  if (!ext) return undefined;
  return {
    id: ext.id,
    mode: ext.mode,
    builtIn: false,
    label: ext.label,
    description: ext.description,
    author: ext.author,
    version: ext.version,
    core: ext.core,
    overrides: ext.overrides,
  };
}

export function listRegisteredThemes(mode?: ThemeMode): readonly RegisteredTheme[] {
  const builtIns: RegisteredTheme[] = BUILT_IN_PALETTES
    .filter((b) => !mode || b.mode === mode)
    .map((b) => ({
      id: b.id,
      mode: b.mode,
      builtIn: true,
      nameKey: b.nameKey,
      descriptionKey: b.descriptionKey,
      core: b.core,
      overrides: b.overrides,
    }));
  const externals: RegisteredTheme[] = [...EXTERNAL_THEMES.values()]
    .filter((ext) => !mode || ext.mode === mode)
    .map((ext) => ({
      id: ext.id,
      mode: ext.mode,
      builtIn: false,
      label: ext.label,
      description: ext.description,
      author: ext.author,
      version: ext.version,
      core: ext.core,
      overrides: ext.overrides,
    }));
  return [...builtIns, ...externals];
}

export function exportThemeManifest(
  source: { mode: ThemeMode; core: ThemeCore; overrides?: ThemeSemanticOverrides },
  metadata: { id: string; label: LocalizedThemeText; description?: LocalizedThemeText; author?: string; version?: string },
): OMCThemeManifest {
  return {
    schemaVersion: 1,
    id: metadata.id,
    mode: source.mode,
    label: metadata.label,
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(metadata.author ? { author: metadata.author } : {}),
    ...(metadata.version ? { version: metadata.version } : {}),
    core: { ...source.core },
    ...(source.overrides ? { overrides: source.overrides } : {}),
  };
}

export function isPaletteRef(value: unknown): value is PaletteRef {
  return value === 'custom' || isBuiltInPaletteId(value) || isValidExternalThemeId(value, BUILT_IN_ID_SET);
}

/**
 * Whether a reference may be used *by this mode*.
 *
 * Built-in palettes are strictly bound to their own mode (`palettes.dark = 'omc-light'` is
 * rejected). Syntactically valid external theme ids are accepted if either not yet loaded (so async
 * plugin themes survive preference boot) or registered for the matching mode.
 */
export function isPaletteRefForMode(mode: ThemeMode, value: unknown): value is PaletteRef {
  if (value === 'custom') return true;
  if (isBuiltInPaletteId(value)) return getBuiltInPalette(value).mode === mode;
  if (!isValidExternalThemeId(value, BUILT_IN_ID_SET)) return false;
  const registered = EXTERNAL_THEMES.get(value);
  return !registered || registered.mode === mode;
}

export function getBuiltInPalette(id: BuiltInPaletteId): BuiltInPalette {
  const palette = BUILT_IN_PALETTES.find((candidate) => candidate.id === id);
  if (!palette) throw new Error(`unknown palette id: ${id}`);
  return palette;
}

/**
 * A palette the operator authored.
 *
 * `base` is the registered palette the editor started from, and it is stored because it is what
 * "reset" means: the nine tokens go back to the values the operator originally picked, not to a
 * hardcoded default they never saw.
 *
 * It carries no name. The console calls it "custom" in the reading language - one dictionary entry,
 * four catalogues - because a palette is identified by what it looks like, and the swatch beside the
 * label already says that. A name would be a second label for one thing, and the one label in the
 * console that could not be translated.
 */
export interface CustomPalette {
  base: BuiltInPaletteId;
  core: ThemeCore;
}

/** The palette in force, with the identity the DOM and the tests read. */
export interface ResolvedPalette {
  id: ResolvedPaletteId;
  mode: ThemeMode;
  palette: ThemePalette;
  isCustom: boolean;
  nameKey: string;
  label?: LocalizedThemeText;
  description?: LocalizedThemeText;
}

export function customPaletteId(mode: ThemeMode): ResolvedPaletteId {
  return mode === 'light' ? 'omc-custom-light' : 'omc-custom-dark';
}

/**
 * resolvePalette turns a mode's selection into the palette every surface reads.
 *
 * A custom palette with no stored entry falls back to the mode's first built-in rather than
 * failing: the stored preference and the stored palette are separate values, so a client
 * that saves one without the other must still render.
 */
export function resolvePalette(mode: ThemeMode, ref: PaletteRef, custom: CustomPalette | undefined): ResolvedPalette {
  if (ref === 'custom' && custom) {
    return {
      id: customPaletteId(mode),
      mode,
      palette: derivePalette(mode, custom.core),
      isCustom: true,
      nameKey: 'omc.palette_custom',
    };
  }
  if (isBuiltInPaletteId(ref) && getBuiltInPalette(ref).mode === mode) {
    return resolvedBuiltInPalette(ref);
  }
  if (ref !== 'custom') {
    const ext = RESOLVED_EXTERNAL.get(ref);
    if (ext && ext.mode === mode) return ext;
  }
  return resolvedBuiltInPalette(builtInPalettesForMode(mode)[0].id);
}

const RESOLVED_BUILT_IN = new Map<BuiltInPaletteId, ResolvedPalette>();

export function resolvedBuiltInPalette(id: BuiltInPaletteId): ResolvedPalette {
  const cached = RESOLVED_BUILT_IN.get(id);
  if (cached) return cached;
  const definition = getBuiltInPalette(id);
  const resolved: ResolvedPalette = {
    id,
    mode: definition.mode,
    palette: derivePalette(definition.mode, definition.core, definition.overrides),
    isCustom: false,
    nameKey: definition.nameKey,
  };
  RESOLVED_BUILT_IN.set(id, resolved);
  return resolved;
}

export function resolvedRegisteredTheme(id: string): ResolvedPalette | undefined {
  if (isBuiltInPaletteId(id)) return resolvedBuiltInPalette(id);
  return RESOLVED_EXTERNAL.get(id);
}

/** The reference a freshly opened editor starts from, given the mode's current selection. */
function defaultCustomBase(mode: ThemeMode, ref: PaletteRef): BuiltInPaletteId {
  if (isBuiltInPaletteId(ref) && getBuiltInPalette(ref).mode === mode) return ref;
  return builtInPalettesForMode(mode)[0].id;
}

/**
 * emptyCustomPalette seeds a custom palette from a built-in.
 *
 * Pre-filled rather than blank on purpose: an operator opening the editor wants their
 * current console with one thing changed, and nine empty swatches would ask them to author
 * a text ladder from nothing before they could see anything at all.
 */
export function emptyCustomPalette(mode: ThemeMode, ref: PaletteRef): CustomPalette {
  const base = defaultCustomBase(mode, ref);
  return { base, core: { ...getBuiltInPalette(base).core } };
}

/** contrastRatio re-exported so the editor and the derivation measure contrast the same way. */
export { contrastRatio };
