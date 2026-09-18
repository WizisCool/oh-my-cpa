/**
 * The palette model: nine authored tokens, seventeen derived ones, and the built-in
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
 * instead of thirty. See `docs/adr/0011-theme-modes-and-derived-palettes.md` for the
 * formula, its constants, and the named places where it deliberately differs from the old
 * hand-tuned values.
 */

import { bestInkOn, contrastRatio, mixOklch, oklchLightness, withLightness, type InkChoice } from './colorMath';

export type ThemeMode = 'dark' | 'light';

export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light'];

export type BuiltInPaletteId = 'omc-dark' | 'omc-light' | 'midnight' | 'porcelain' | 'forest' | 'sandstone';

export const BUILT_IN_PALETTE_IDS: readonly BuiltInPaletteId[] = [
  'omc-dark',
  'omc-light',
  'midnight',
  'porcelain',
  'forest',
  'sandstone',
];

/** What a mode's palette selection can point at: one registered palette, or the operator's own. */
export type PaletteRef = BuiltInPaletteId | 'custom';

/** The identity a resolved palette is known by, including the two synthetic custom ids. */
export type ResolvedPaletteId = BuiltInPaletteId | 'omc-custom-dark' | 'omc-custom-light';

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
 * re-derived per surface.
 */
export interface ThemePalette extends ThemeCore {
  borderSoft: string;
  hover: string;
  rowHover: string;
  selected: string;
  hoverInset: string;
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
 * Exported because it is a promise the console makes to itself rather than an implementation
 * detail: `scripts/test-theme-presets.ts` asserts it against every palette, built-in and authored
 * alike, and `docs/design.md` §2 states it as a rule.
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
 * The status hues and the categorical series palette are *semantics*, not palette: green
 * means healthy and never anything else, and a series slot is a fixed identity whose family
 * survives a theme switch (`docs/adr/0006-categorical-series-palette.md`). Deriving them
 * from an operator's accent would make "green" depend on a colour choice, which is the one
 * thing `docs/design.md` §1 forbids. They are constants here, and a custom palette inherits
 * its mode's set.
 */
const MODE_SEMANTICS: Record<ThemeMode, { success: string; warn: string; danger: string; series: readonly string[] }> = {
  dark: {
    success: '#10b981',
    warn: '#f59e0b',
    danger: '#ef4444',
    series: ['#3b82f6', '#10b981', '#8b5cf6', '#f43f5e', '#f59e0b', '#06b6d4'],
  },
  light: {
    success: '#059669',
    warn: '#b45309',
    danger: '#dc2626',
    series: ['#2563eb', '#059669', '#7c3aed', '#e11d48', '#b45309', '#0891b2'],
  },
};

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
 * accentLadderStep moves the accent one step and returns the fill plus the label it can carry.
 *
 * The loop is the contract. A fixed lightness step can land a fill in the dead zone where
 * neither white nor near-black clears 4.5:1 - measured on the six built-ins, a −0.075 step
 * puts OMC Dark's label at 3.73:1 and Midnight's at 3.38:1 - and no label choice can
 * rescue that pair. So the step is the *starting point*, and the fill keeps moving along its
 * direction until one of the two inks clears the target.
 *
 * `ACCENT_LABEL_CONTRAST_FLOOR` is the floor a caller may rely on; the loop aims at
 * `LABEL_CONTRAST_TARGET`, which is that floor plus the room hex rounding needs. Both are read
 * here so the pair cannot drift apart.
 */
function accentLadderStep(
  accent: string,
  lightness: number,
  factor: number,
  direction: LadderDirection,
): { color: string; ink: string } {
  // Mirror the proportional step for the lighter direction: the same fraction of the room that
  // remains, measured from the other end of the scale. That keeps the *size* of the step a property
  // of the palette's own contrast position rather than of which direction it happens to travel.
  let candidate = direction === 'deeper' ? lightness * factor : 1 - (1 - lightness) * factor;
  let best: InkChoice = { ink: ON_ACCENT_INKS[0], ratio: 0 };
  for (let step = 0; step < MAX_LADDER_STEPS; step += 1) {
    const color = withLightness(accent, Math.min(1, Math.max(0, candidate)));
    best = bestInkOn(color, ON_ACCENT_INKS);
    if (best.ratio >= LABEL_CONTRAST_TARGET) return { color, ink: best.ink };
    candidate += direction === 'deeper' ? -LADDER_STEP : LADDER_STEP;
  }
  // Unreachable: the scale's own end carries 21:1 against one of the two inks. The return keeps the
  // function total rather than trusting the loop to have converged.
  return { color: withLightness(accent, direction === 'deeper' ? 0 : 1), ink: best.ink };
}

/**
 * accentLadder derives all three filled-control states, in one direction.
 *
 * One direction for all three, chosen once: a ladder whose hover deepens and whose pressed state
 * lightens would make pressing a button look like releasing it.
 */
function accentLadder(mode: ThemeMode, accent: string): { hover: string; active: string; ink: string } {
  const step = ACCENT_LADDER[mode];
  const lightness = oklchLightness(accent);
  const direction: LadderDirection = lightness * step.hover > MIN_DEEPENING_ROOM ? 'deeper' : 'lighter';
  const hover = accentLadderStep(accent, lightness, step.hover, direction);
  const active = accentLadderStep(accent, lightness, step.active, direction);
  return { hover: hover.color, active: active.color, ink: hover.ink };
}

/**
 * derivePalette computes the seventeen tokens a palette does not author.
 *
 * Pure and total: the same nine tokens always produce the same palette, so the pre-hydration
 * fallback in `index.css`, the six built-ins and an operator's palette are one code path.
 */
export function derivePalette(mode: ThemeMode, core: ThemeCore): ThemePalette {
  const blend = NEUTRAL_BLEND[mode];
  const semantics = MODE_SEMANTICS[mode];
  const hover = mixOklch(core.bg, core.fg, blend.hover);
  const borderSoft = mixOklch(core.bg, core.border, blend.borderSoft);
  const ladder = accentLadder(mode, core.accent);
  return {
    ...core,
    borderSoft,
    hover,
    // The two hover fills are one value by construction: a row under the pointer and a
    // button under the pointer are the same lift off the page.
    rowHover: hover,
    // Dark mode's inset step is the page itself - a control on a panel has nowhere further
    // to go - while a light page has room for a step darker than the panel.
    hoverInset: blend.hoverInset === 0 ? core.bg : mixOklch(core.bg, core.fg, blend.hoverInset),
    selected: mixOklch(hover, core.accent, blend.selected),
    accentHover: ladder.hover,
    accentActive: ladder.active,
    accentOn: ladder.ink,
    success: semantics.success,
    warn: semantics.warn,
    danger: semantics.danger,
    cacheRateYellow: semantics.warn,
    cacheRateGreen: semantics.success,
    // A dark tooltip sits on the surface it floats over; a light page's tooltip is the
    // inverse block, which is its own foreground step.
    tooltipBg: mode === 'light' ? core.fg : core.surface,
    heatmapQuiet: borderSoft,
    heatmapBusy: core.accent,
    heatmapZeroUnrecorded: borderSoft,
    // The measured-but-empty day and the ring's empty track are the border step: both are
    // "there is a slot here and nothing in it".
    heatmapZeroRecorded: core.border,
    heatmapTipLink: core.accent,
    series: semantics.series,
    seriesTrack: core.border,
  };
}

/** One registered palette: nine authored tokens plus how it names itself in the console. */
export interface BuiltInPalette {
  id: BuiltInPaletteId;
  mode: ThemeMode;
  nameKey: string;
  descriptionKey: string;
  core: ThemeCore;
}

/**
 * The built-in palettes, three per mode.
 *
 * Grouped by mode rather than listed flat, because a palette belongs to a mode: its nine
 * authored values are chosen for that mode's surfaces, and offering a dark palette while
 * the console is light would be offering a palette whose text ladder points the wrong way.
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
      surface: '#f6f6f8',
      elevated: '#ffffff',
      fg: '#1c1c1e',
      fg2: '#505055',
      muted: '#787880',
      meta: '#98989f',
      border: '#e5e5ea',
      accent: '#005d8f',
    },
  },
  {
    id: 'midnight',
    mode: 'dark',
    nameKey: 'theme.midnight',
    descriptionKey: 'theme.midnight_desc',
    core: {
      bg: '#0d1117',
      surface: '#161b22',
      elevated: '#1f242c',
      fg: '#e6edf3',
      fg2: '#9da7b3',
      muted: '#6e7681',
      meta: '#484f58',
      border: '#30363d',
      accent: '#58a6ff',
    },
  },
  {
    id: 'porcelain',
    mode: 'light',
    nameKey: 'theme.porcelain',
    descriptionKey: 'theme.porcelain_desc',
    core: {
      bg: '#f7f8fa',
      surface: '#ffffff',
      elevated: '#ffffff',
      fg: '#17212b',
      fg2: '#4b5563',
      muted: '#6b7280',
      meta: '#9ca3af',
      border: '#d8dee7',
      accent: '#0b6e99',
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
      meta: '#4d5f53',
      border: '#293a2f',
      accent: '#6ee7a8',
    },
  },
  {
    id: 'sandstone',
    mode: 'light',
    nameKey: 'theme.sandstone',
    descriptionKey: 'theme.sandstone_desc',
    core: {
      bg: '#f8f3e8',
      surface: '#fffaf0',
      elevated: '#fffaf0',
      fg: '#2f2a22',
      fg2: '#5f574b',
      muted: '#7c7263',
      meta: '#a79b89',
      border: '#ded3c0',
      accent: '#0f766e',
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

export function isPaletteRef(value: unknown): value is PaletteRef {
  return value === 'custom' || isBuiltInPaletteId(value);
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
  /**
   * The i18n key naming the palette.
   *
   * Every palette has one, an operator's own included: `omc.palette_custom` is what a custom palette
   * is called in each catalogue, which is what keeps the header's tooltip and the card's label
   * readable in whichever language the console is set to.
   */
  nameKey: string;
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
  if (ref !== 'custom') return resolvedBuiltInPalette(ref);
  return resolvedBuiltInPalette(builtInPalettesForMode(mode)[0].id);
}

/**
 * The derived palette of each registered palette, computed once.
 *
 * The derivation is a search - the accent ladder deepens a fill until its label clears 4.5:1 - so
 * resolving all six on every settings render would run that search twelve times to draw six previews
 * that cannot have changed. A registered palette's nine tokens are constants, so its derivation is
 * one too, and this is where that is remembered.
 */
const RESOLVED_BUILT_IN = new Map<BuiltInPaletteId, ResolvedPalette>();

export function resolvedBuiltInPalette(id: BuiltInPaletteId): ResolvedPalette {
  const cached = RESOLVED_BUILT_IN.get(id);
  if (cached) return cached;
  const definition = getBuiltInPalette(id);
  const resolved: ResolvedPalette = {
    id,
    mode: definition.mode,
    palette: derivePalette(definition.mode, definition.core),
    isCustom: false,
    nameKey: definition.nameKey,
  };
  RESOLVED_BUILT_IN.set(id, resolved);
  return resolved;
}

/** The reference a freshly opened editor starts from, given the mode's current selection. */
function defaultCustomBase(mode: ThemeMode, ref: PaletteRef): BuiltInPaletteId {
  if (isBuiltInPaletteId(ref)) return ref;
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
