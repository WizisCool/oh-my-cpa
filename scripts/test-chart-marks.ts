import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_ROLL, resolveChartAnimation } from '../web/src/charts/chartMotion.ts';
import { sparkColor, seriesColor, seriesDomainKey, seriesColorRange, SERIES_SLOTS } from '../web/src/charts/chartTheme.ts';
import { formatModelShare, formatModelTokens } from '../web/src/types/dashboardModels.ts';
import { BUILT_IN_PALETTES, resolvedBuiltInPalette } from '../web/src/theme/palette.ts';
import { MOTION_ROLL, themePaletteCssVariables } from '../web/src/theme/themeConfig.ts';

/**
 * The palettes the console ships, resolved, plus the two the stylesheet's fallback mirrors.
 *
 * The chart runtime reads a *resolved* palette - the same object Ant Design and the stylesheet are
 * given - so this suite resolves the registry rather than reaching for a hand-written table. What it
 * is pinning is unchanged: a tone and a series slot must come from the palette in force, in both
 * modes, and the tail of this file still checks the stylesheet against the same values.
 */
const RESOLVED_PALETTES = BUILT_IN_PALETTES.map((definition) => resolvedBuiltInPalette(definition.id));
const palette = {
  dark: resolvedBuiltInPalette('omc-dark').palette,
  light: resolvedBuiltInPalette('omc-light').palette,
};

/**
 * The dashboard mark is drawn by AntV, so there is no app-owned geometry left to
 * assert on. What stays app-owned - and therefore still worth pinning - is the
 * tone-to-token mapping: it is the contract that keeps a chart coloured from the
 * palette instead of from a literal, in both themes.
 */
const TONES = ['accent', 'success', 'warn', 'danger', 'neutral'] as const;

for (const tone of TONES) {
  for (const preset of RESOLVED_PALETTES) {
    const value = sparkColor(preset.palette, tone);
    assert.match(value, /^#[0-9a-f]{6}$|^rgba?\(/, `${tone}/${preset.id} resolves to a colour token`);
  }
}

// The same tone must resolve per theme, not to one frozen literal: a chart that
// ignores the active mode is the regression this guards.
const darkAccent = sparkColor(palette.dark, 'accent');
const lightAccent = sparkColor(palette.light, 'accent');
const darkMuted = sparkColor(palette.dark, 'neutral');

// Distinct tones stay distinguishable, so a tile's identity colour actually
// differs from its neighbour's and from the muted floor.
const resolved = new Set(TONES.map((tone) => sparkColor(palette.dark, tone)));
assert.equal(resolved.size, TONES.length, 'each tone resolves to a distinct token');

// Neutral is the muted token, not an accent: the cache-rate and cost tiles rely
// on it reading as "no verdict".
assert.notEqual(darkMuted, darkAccent, 'neutral must not resolve to the accent');

// The accent is NOT mode-invariant: the two themes use different steps of one hue, because the
// bright step is legible on the dark background and illegible on the light one (6.03:1 vs 2.71:1).
// See docs/design.md §2 for the measured ladder. This assertion used to require the opposite, which
// is what a single accent value forced.
assert.notEqual(lightAccent, darkAccent, 'the accent resolves per theme');
assert.equal(darkAccent, '#00a2fb', 'the dark theme uses the bright step');
assert.equal(lightAccent, '#005d8f', 'the light theme uses the legible step');

// ── categorical series palette ─────────────────────────────────────────────
//
// The model panels colour a *category*, which is the one decorative use of hue in the app, so the two
// things worth pinning are that the families are distinct enough to tell apart and that they cannot be
// mistaken for a verdict. Both are measured, and both are asserted against the palette rather than
// against literals so a token change that breaks either fails here.

/** Relative luminance and contrast ratio, WCAG 2.x. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

/**
 * CIE Lab distance between two colours.
 *
 * An ordinary perceptual distance, used here for one limited purpose: to require that two colours are
 * not near-identical. It rules out a palette whose neighbours read as the same swatch. It is **not** a
 * colour-vision-deficiency simulation and it is not evidence that these colours are distinguishable to
 * a reader with deuteranopia or protanopia, so no such claim is asserted - see
 * docs/adr/0006-categorical-series-palette.md.
 */
function labDistance(a: string, b: string): number {
  const toLab = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b2) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b2;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b2) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [left, right] = [toLab(a), toLab(b)];
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

for (const preset of RESOLVED_PALETTES) {
  assert.equal(
    preset.palette.series.length,
    SERIES_SLOTS,
    `${preset.id} defines exactly ${SERIES_SLOTS} series slots`,
  );
  const slots = [...Array(SERIES_SLOTS).keys()].map((index) => seriesColor(preset.palette, index));
  const card = preset.palette.surface;

  assert.equal(new Set(slots).size, SERIES_SLOTS, `${preset.id}: every series slot resolves to its own colour`);

  // Legibility. These are drawn as 1.6px lines and 8px swatches on the card, so the bar is the 3:1
  // WCAG sets for a graphical object rather than the 4.5:1 body-text bar. It is the requirement that
  // actually applies: the tightest slot here - the light theme's amber - measures 3.41:1.
  for (const [index, colour] of slots.entries()) {
    assert.ok(
      contrast(colour, card) >= 3,
      `${preset.id}: series ${index} (${colour}) reads ${contrast(colour, card).toFixed(2)}:1 on the card, want >= 3:1`,
    );
  }

  // Adjacent legend entries are the pair a reader compares, so they must not be near-identical: a
  // distance this large is well past "the same colour", which is the ordering defect this catches. It
  // is a lower bound on *not being the same colour*, not a claim about any specific reader's
  // discrimination - see the note on `labDistance`.
  for (let index = 0; index < slots.length - 1; index += 1) {
    const distance = labDistance(slots[index], slots[index + 1]);
    assert.ok(
      distance >= 25,
      `${preset.id}: series ${index} and ${index + 1} are only ΔE ${distance.toFixed(1)} apart; adjacent legend entries must be clearly different colours`,
    );
  }
}

// ── CSS and TypeScript token synchronization ──────────────────────────────
//
// The palette is defined in `web/src/theme/palette.ts` (nine authored tokens, seventeen derived) and
// projected by `themeConfig.ts` for Ant Design, React components and
// chart runtime options, and in `web/src/index.css` for stylesheet consumers. Assert that every series
// token matches character for character so the two copies cannot drift.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexCss = fs.readFileSync(path.join(rootDir, 'web/src/index.css'), 'utf8');
const darkRootBlock = indexCss.slice(indexCss.indexOf(':root {'), indexCss.indexOf(":root[data-theme-mode='light']"));
const lightRootBlock = indexCss.slice(indexCss.indexOf(":root[data-theme-mode='light']"));

for (let index = 0; index < SERIES_SLOTS; index += 1) {
  const tokenName = `--series-${index + 1}`;
  const darkMatch = new RegExp(`${tokenName}:\\s*([#0-9a-fA-F]+);`).exec(darkRootBlock);
  const lightMatch = new RegExp(`${tokenName}:\\s*([#0-9a-fA-F]+);`).exec(lightRootBlock);
  assert.ok(darkMatch, `web/src/index.css defines ${tokenName} in dark mode`);
  assert.ok(lightMatch, `web/src/index.css defines ${tokenName} in light mode`);
  assert.equal(
    darkMatch[1].toLowerCase(),
    palette.dark.series[index].toLowerCase(),
    `dark ${tokenName} in index.css (${darkMatch[1]}) matches themeConfig (${palette.dark.series[index]})`,
  );
  assert.equal(
    lightMatch[1].toLowerCase(),
    palette.light.series[index].toLowerCase(),
    `light ${tokenName} in index.css (${lightMatch[1]}) matches themeConfig (${palette.light.series[index]})`,
  );
}

// The identity is the slot, and the *family* has to survive a theme switch: series 2 is the same hue
// family in both themes even though the value differs, because the bright steps are illegible on a
// light card (the vivid blue reads 2.7:1 there).
for (let index = 0; index < SERIES_SLOTS; index += 1) {
  assert.notEqual(
    seriesColor(palette.dark, index),
    seriesColor(palette.light, index),
    `series ${index} resolves per theme`,
  );
}

// The slot is taken modulo the palette size rather than clamped, so a seventh series folds back to the
// first identity. Nothing asks for more than six today, but a colour function that returns `undefined`
// past its end is a chart drawn in the wrong colour, which is worse than one drawn in a repeated one.
assert.equal(seriesColor(palette.dark, SERIES_SLOTS), seriesColor(palette.dark, 0), 'the slot wraps');
assert.equal(seriesColor(palette.dark, -1), seriesColor(palette.dark, SERIES_SLOTS - 1), 'a negative slot wraps backwards');

// The domain key is a *key*, not the display label and not the array position. The ranking changes
// between polls and the remainder is always last, so a colour bound to a position would follow a model
// around the legend.
assert.equal(seriesDomainKey({ folded: false, model: 'gpt-5-codex' }), 'model:gpt-5-codex');
assert.equal(seriesDomainKey({ folded: true, model: '' }), 'folded');
// A real model whose name equals the remainder's translated label must not take the remainder's key,
// which is why the discriminator and not the name decides.
assert.notEqual(
  seriesDomainKey({ folded: false, model: '其他模型' }),
  seriesDomainKey({ folded: true, model: '其他模型' }),
  'a model named like the remainder stays distinct',
);
assert.deepEqual(
  seriesColorRange(palette.dark, [{ folded: false, model: 'a' }, { folded: true, model: '' }]),
  [seriesColor(palette.dark, 0), seriesColor(palette.dark, 1)],
  'the range is generated in the domain order',
);

for (const preset of RESOLVED_PALETTES) {
  const css = themePaletteCssVariables(preset.palette);
  for (let index = 0; index < SERIES_SLOTS; index += 1) {
    assert.equal(typeof css[`--series-${index + 1}`], 'string', `${preset.id} exports series ${index + 1}`);
    assert.equal(css[`--series-${index + 1}`], preset.palette.series[index]);
  }
}

// ── share formatting ──────────────────────────────────────────────────────
//
// The legend prints a share beside every model, and a rounding that reports a real, small share as "0%"
// would state that a model carried nothing - a different claim from "very little", and one a reader
// would act on.
assert.equal(formatModelShare(73, 100), '73%');
assert.equal(formatModelShare(5.9, 100), '5.9%');
// A share below the smallest step the format can print is reported as under it. Reporting it as "0%"
// would state that a model carried nothing.
assert.equal(formatModelShare(1, 100_000), '<0.1%');
assert.notEqual(formatModelShare(1, 100_000), '0%');
assert.equal(formatModelShare(0.4, 100), '0.4%');
assert.equal(formatModelShare(0, 100), '0.0%');
assert.equal(formatModelShare(5, 0), '—', 'no window total means no share rather than a division');
assert.equal(formatModelTokens(271_700), '271.7K');
assert.equal(formatModelTokens(0), '0');

console.log('PASS chart marks: tones resolve to distinct palette tokens per theme');
console.log('PASS series palette: slots legible on the card, distinct from their neighbours, and identical in CSS and TS');
console.log('PASS model shares: a small share is under-reported, never as zero');

// ── the chart motion ───────────────────────────────────────────────────────
//
// A mark's animation is not visible to any per-component test, so what is pinned here is the rule that
// decides it: the dashboard's charts move on the `roll` token, and a reader who asked for reduced
// motion gets a spec that is *absent* rather than empty. That distinction is the one that can regress
// silently - the library reads a missing spec as "use your own defaults", and its default update
// animation is a 900ms spring, so a chart that passed `undefined` would satisfy a reduced-motion
// reader's setting on paper while animating twice as hard as the motion-allowed path.
assert.equal(resolveChartAnimation(true), false, 'reduced motion disables the chart animation');
assert.equal(resolveChartAnimation(false), CHART_ROLL, 'the default is the roll spec');

// The sweep is the update, and it is the one the poll triggers: the panels re-render on a revision the
// reader did not ask for, and the wrapper hands the new spec to the same chart instance, so a morph is
// what makes that read as movement rather than as a hard cut.
assert.equal(CHART_ROLL.update.type, 'morphing');
// Enter and exit are fades: content appears, it does not fly, and a mark that grew in from an axis
// would claim a direction the data does not have.
assert.equal(CHART_ROLL.enter.type, 'fadeIn');
assert.equal(CHART_ROLL.exit.type, 'fadeOut');

// One tempo for the whole card: the digits in the tile and the mark beneath them share §7's token, so
// they cannot drift apart in review.
for (const phase of ['enter', 'update', 'exit'] as const) {
  assert.equal(CHART_ROLL[phase].duration, MOTION_ROLL.duration, `${phase} uses the roll duration`);
  assert.equal(CHART_ROLL[phase].easing, MOTION_ROLL.easing, `${phase} uses the shared ease`);
}
// Nothing in budget: `roll` is §7's one exception, and a chart animation longer than the token the
// documentation names is how an exception becomes a habit.
assert.ok(MOTION_ROLL.duration <= 240, `the roll token stays at or under 240ms (${MOTION_ROLL.duration})`);

console.log('chart marks: motion assertions passed');
