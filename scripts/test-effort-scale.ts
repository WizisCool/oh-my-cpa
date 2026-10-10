import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORT_LEVELS, EFFORT_STEPS, effortColor, effortStep } from '../web/src/theme/effortScale.ts';
import { BUILT_IN_PALETTES, resolvedBuiltInPalette } from '../web/src/theme/palette.ts';
import { themePaletteCssVariables } from '../web/src/theme/themeConfig.ts';

/**
 * The reasoning-effort scale: which recorded values it ranks, and whether the
 * badge it colours is legible on every palette the console ships.
 */

// ── ranking ────────────────────────────────────────────────────────────────

assert.deepEqual(
  EFFORT_LEVELS.map((level) => effortStep(level)),
  [0, 1, 2, 3, 4, 5, 6],
  'the published levels rank in the order the vendors publish them',
);
assert.equal(EFFORT_STEPS, 6, 'every level above none carries a colour');
assert.equal(effortStep(' High '), 4, 'a recorded value is ranked whatever its case or padding');
for (const unranked of ['ultra', 'auto', '8192', '', undefined, null]) {
  assert.equal(effortStep(unranked), null, `${String(unranked)} is not placed on the scale`);
}

// `none` and an unranked level both stay neutral, for different reasons: one is
// the absence of reasoning and the other an order nobody published.
assert.equal(effortColor(effortStep('none')), null, 'none carries no scale colour');
assert.equal(effortColor(effortStep('ultra')), null, 'an unranked level carries no scale colour');
assert.equal(effortColor(effortStep('minimal')), 'var(--effort-1)');
assert.equal(effortColor(effortStep('max')), `var(--effort-${EFFORT_STEPS})`);
assert.equal(effortColor(EFFORT_STEPS + 1), null, 'a step past the scale has no token to name');

// ── legibility ─────────────────────────────────────────────────────────────

function channels(hex: string): number[] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
}

/** Relative luminance and contrast ratio, WCAG 2.x. */
function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

/** The badge's fill: the step at `share` over the ground it sits on, as `color-mix(in srgb)` paints it. */
function tintOver(step: string, ground: string, share: number): string {
  const mixed = channels(step).map((value, index) => value * share + channels(ground)[index] * (1 - share));
  return `#${mixed.map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;
}

const css = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web/src/index.css'),
  'utf8',
);
const lightStart = css.indexOf(":root[data-theme-mode='light']");
assert.ok(lightStart > 0, 'the stylesheet declares a light mode block');
const stylesheet = { dark: css.slice(0, lightStart), light: css.slice(lightStart) };
const declared = (block: string, token: string): string => {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block);
  assert.ok(match, `${token} is declared in the stylesheet`);
  return match[1].trim().toLowerCase();
};

for (const definition of BUILT_IN_PALETTES) {
  const { palette, mode } = resolvedBuiltInPalette(definition.id);
  assert.equal(palette.effort.length, EFFORT_STEPS, `${definition.id} defines one colour per reasoning step`);
  assert.equal(new Set(palette.effort).size, EFFORT_STEPS, `${definition.id}: every step is its own colour`);

  const share = Number.parseFloat(declared(stylesheet[mode], '--effort-tint')) / 100;
  // The badge sits on the page, and on the row's hover and selected fills.
  const grounds = [palette.bg, palette.surface, palette.hover];
  palette.effort.forEach((step, index) => {
    for (const ground of grounds) {
      const ratio = contrast(step, tintOver(step, ground, share));
      assert.ok(
        ratio >= 4.5,
        `${definition.id}: effort step ${index + 1} (${step}) reads ${ratio.toFixed(2)}:1 on its badge over ${ground}, want >= 4.5:1`,
      );
    }
    // The scale's whole point is that it cannot be read as a verdict.
    for (const verdict of [palette.success, palette.warn, palette.danger]) {
      assert.notEqual(step, verdict, `${definition.id}: effort step ${index + 1} is not a status hue`);
    }
  });

  // `none` and an unranked level (`instant`, `ultra`, a token budget) wear the
  // neutral step. It is plain, and it is held to the same floor as the scale.
  for (const ground of grounds) {
    const ratio = contrast(palette.fg2, tintOver(palette.fg2, ground, share));
    assert.ok(
      ratio >= 4.5,
      `${definition.id}: the neutral effort badge (${palette.fg2}) reads ${ratio.toFixed(2)}:1 over ${ground}, want >= 4.5:1`,
    );
  }

  const variables = themePaletteCssVariables(palette);
  palette.effort.forEach((step, index) => {
    assert.equal(variables[`--effort-${index + 1}`], step, `${definition.id}: --effort-${index + 1} is projected from the palette`);
  });
}

// The stylesheet carries the OMC pair as the pre-hydration fallback; it must be the pair the palette resolves.
for (const [mode, id] of [['dark', 'omc-dark'], ['light', 'omc-light']] as const) {
  resolvedBuiltInPalette(id).palette.effort.forEach((step, index) => {
    assert.equal(declared(stylesheet[mode], `--effort-${index + 1}`), step.toLowerCase(), `${mode} --effort-${index + 1} in index.css matches the palette`);
  });
}

// The neutral step the list paints must be the one measured above.
const listCss = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web/src/pages/UsageEventsPage.css'),
  'utf8',
);
assert.match(
  /\.req-effort-badge\s*\{[^}]*\}/.exec(listCss)?.[0] ?? '',
  /--effort-hue:\s*var\(--fg-2\);/,
  'the effort badge falls back to secondary text, not a tertiary grey',
);

console.log('effort scale: ok');
