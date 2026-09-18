/**
 * The theme's contracts: the palette derivation, the preference document, and the two places the
 * palette is mirrored outside TypeScript.
 *
 * The old suite asserted that six hand-tuned palettes were internally consistent. That question is
 * gone: palettes are now computed, so what has to be pinned is the *derivation* - that it holds the
 * relationships the console depends on for any input an operator can type, not just for the six the
 * authors happened to write.
 *
 * Three groups matter most:
 *
 * 1. **The guaranteed relationships.** A tooltip sits on the surface, the heatmap's floor is the
 *    border-soft step, and a filled accent control's label clears 4.5:1. These are now true by
 *    construction, and a test that only checked the six built-ins would pass while the construction
 *    was broken - so the accent ladder is checked over a sweep of accents, including the dead zone
 *    where neither white nor near-black can carry a label on the resting colour.
 * 2. **The stored document.** `omc-theme` held a bare palette id before this change, and a browser
 *    that still holds one has to keep working. The migration is asserted case by case rather than
 *    through one happy path.
 * 3. **The mirrors.** `index.css` carries the fallback palette for the first frame and the sign-in
 *    screen, and `docs/design.md` prints the derived values. A mirror that drifts is a console that
 *    paints one palette and documents another, which is exactly what the CSS pin catches.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACCENT_LABEL_CONTRAST_FLOOR,
  BUILT_IN_PALETTES,
  BUILT_IN_PALETTE_IDS,
  CONTRAST_FLOORS,
  CORE_TOKEN_CONTRAST_ROLES,
  CORE_TOKEN_KEYS,
  builtInPalettesForMode,
  customPaletteId,
  derivePalette,
  emptyCustomPalette,
  getBuiltInPalette,
  isPaletteRef,
  resolvePalette,
  resolvedBuiltInPalette,
  type ThemeCore,
} from '../web/src/theme/palette.ts';
import { contrastRatio, normalizeHex } from '../web/src/theme/colorMath.ts';
import {
  DEFAULT_THEME_PREFERENCES,
  migrateLegacyThemeValue,
  nextModePreference,
  parseThemePreferences,
  readStoredThemePreferences,
  resolveModePreference,
  sameThemePreferences,
  writeStoredThemePreferences,
} from '../web/src/theme/themePreference.ts';
import { createThemeConfig, themePaletteCssVariables } from '../web/src/theme/themeConfig.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'web', 'src', 'index.css'), 'utf8');

// ── the registry ─────────────────────────────────────────────────────────────

assert.equal(BUILT_IN_PALETTES.length, 6, 'the registry keeps three palettes per mode');
assert.equal(new Set(BUILT_IN_PALETTE_IDS).size, BUILT_IN_PALETTE_IDS.length, 'palette ids must be unique');
assert.equal(new Set(BUILT_IN_PALETTES.map((definition) => definition.id)).size, BUILT_IN_PALETTES.length);
for (const mode of ['dark', 'light'] as const) {
  assert.equal(builtInPalettesForMode(mode).length, 3, `${mode} mode offers exactly three palettes`);
  for (const definition of builtInPalettesForMode(mode)) {
    assert.equal(definition.mode, mode, `${definition.id} belongs to ${mode}`);
  }
}
// A palette id is never also a mode name: `parseThemePreferences` would otherwise have to guess
// whether a stored `"dark"` meant the mode or a palette.
for (const id of BUILT_IN_PALETTE_IDS) assert.ok(!['dark', 'light', 'system'].includes(id), id);

// ── the derivation's guaranteed relationships ────────────────────────────────

for (const definition of BUILT_IN_PALETTES) {
  const palette = derivePalette(definition.mode, definition.core);
  const where = `${definition.id}:`;

  assert.equal(palette.series.length, 6, `${where} defines exactly six series slots`);
  assert.equal(palette.tooltipBg, definition.mode === 'light' ? palette.fg : palette.surface,
    `${where} a tooltip sits on the surface it floats over`);
  assert.equal(palette.heatmapQuiet, palette.borderSoft, `${where} the ramp's floor is the border-soft step`);
  assert.equal(palette.heatmapZeroUnrecorded, palette.borderSoft, `${where} an unrecorded day is the ramp's floor`);
  assert.equal(palette.heatmapZeroRecorded, palette.border, `${where} a recorded empty day is the border step`);
  assert.equal(palette.seriesTrack, palette.border, `${where} an empty plot floor is the border step`);
  assert.equal(palette.heatmapBusy, palette.accent, `${where} the ramp reaches the accent`);
  assert.equal(palette.heatmapTipLink, palette.accent, `${where} the tooltip link is the accent`);
  assert.equal(palette.cacheRateYellow, palette.warn, `${where} the cache scale's low end is the warning hue`);
  assert.equal(palette.cacheRateGreen, palette.success, `${where} the cache scale's high end is the success hue`);
  assert.equal(palette.hover, palette.rowHover, `${where} a hovered row and a hovered control lift by the same step`);
  assert.equal(palette.hoverInset, definition.mode === 'dark' ? palette.bg : palette.hoverInset,
    `${where} dark mode's inset step is the page itself`);

  // The accent ladder has to be a ladder: a filled control whose resting and hover fills are the
  // same colour has no hover state, and one whose hover and pressed fills match has no press.
  assert.notEqual(palette.accentHover, palette.accent, `${where} the filled control's hover differs from its accent`);
  assert.notEqual(palette.accentActive, palette.accentHover, `${where} the pressed fill differs from the hover fill`);

  // The label on that fill, which is the promise the solving loop exists to keep.
  const label = contrastRatio(palette.accentOn, palette.accentHover);
  assert.ok(
    label >= ACCENT_LABEL_CONTRAST_FLOOR,
    `${where} the primary button label (${palette.accentOn}) on its fill (${palette.accentHover}) reads ${label.toFixed(2)}:1, want >= ${ACCENT_LABEL_CONTRAST_FLOOR}:1`,
  );

  // Every authored token against the floor its own role carries.
  for (const key of CORE_TOKEN_KEYS) {
    const floor = CONTRAST_FLOORS[CORE_TOKEN_CONTRAST_ROLES[key]];
    if (floor === undefined) continue;
    const ratio = contrastRatio(palette[key], palette.bg);
    assert.ok(ratio >= floor, `${where} ${key} reads ${ratio.toFixed(2)}:1 on the page, want >= ${floor}:1`);
  }

  // Purity: the same nine tokens always produce the same palette, which is what lets the stylesheet
  // mirror, the derived hex tables in the docs and the runtime all be the same palette.
  assert.deepEqual(derivePalette(definition.mode, { ...definition.core }), palette, `${where} derivation is deterministic`);
  assert.equal(resolvedBuiltInPalette(definition.id).palette.bg, palette.bg, `${where} the resolution cache agrees`);
}

/**
 * The dead zone, and the loop that gets out of it.
 *
 * These are the accents where a fixed lightness step fails: measured against the six built-ins, a
 * −0.075 step put OMC Dark's label at 3.73:1 and Midnight's at 3.38:1, and neither white nor
 * near-black could carry the label. The sweep asserts the loop lands a legible pair for all of them,
 * and for the extremes - a near-black accent and a near-white one - that a proportional step alone
 * would carry off the end of the scale.
 */
const ACCENT_SWEEP = [
  '#00a2fb', '#58a6ff', '#6ee7a8', '#005d8f', '#0b6e99', '#0f766e',
  '#f59e0b', '#ef4444', '#7c3aed', '#ffffff', '#000000', '#808080',
  '#ff0000', '#00ff00', '#0000ff', '#ffff00',
];
for (const mode of ['dark', 'light'] as const) {
  for (const accent of ACCENT_SWEEP) {
    const core: ThemeCore = { ...getBuiltInPalette(mode === 'dark' ? 'omc-dark' : 'omc-light').core, accent };
    const palette = derivePalette(mode, core);
    const hoverLabel = contrastRatio(palette.accentOn, palette.accentHover);
    assert.ok(
      hoverLabel >= ACCENT_LABEL_CONTRAST_FLOOR,
      `${mode} accent ${accent}: the solved hover fill ${palette.accentHover} carries ${palette.accentOn} at ${hoverLabel.toFixed(2)}:1`,
    );
    // The pressed step is deeper than the hover step, never equal or inverted, for every accent.
    assert.notEqual(palette.accentActive, palette.accentHover, `${mode} accent ${accent}: active differs from hover`);
    // A fill is a hex colour, not a clipped channel: the derivation reduces chroma rather than
    // clipping, so every output is a well-formed six-digit value.
    for (const key of CORE_TOKEN_KEYS) {
      assert.ok(normalizeHex(palette[key]), `${mode} accent ${accent}: ${key} is a hex colour`);
    }
  }
}

// ── custom palettes ──────────────────────────────────────────────────────────

for (const mode of ['dark', 'light'] as const) {
  const seeded = emptyCustomPalette(mode, mode === 'dark' ? 'forest' : 'porcelain');
  assert.equal(seeded.base, mode === 'dark' ? 'forest' : 'porcelain', 'a custom palette starts from a palette of its own mode');
  assert.deepEqual(seeded.core, getBuiltInPalette(seeded.base).core, 'a fresh custom palette borrows its base verbatim');
  // A custom palette carries no name: it is labelled by a dictionary entry like every other control,
  // which is what keeps the card and the header tooltip translatable.
  assert.deepEqual(Object.keys(seeded).sort(), ['base', 'core'], 'a custom palette is a starting point and nine tokens');

  // Untouched, a seeded custom palette is its base's palette - the derivation is the only difference
  // between "a copy" and "the original", and there is none.
  const seededPalette = derivePalette(mode, seeded.core);
  const basePalette = resolvedBuiltInPalette(seeded.base).palette;
  assert.equal(seededPalette.accentHover, basePalette.accentHover, 'a seeded palette derives its base exactly');

  const resolved = resolvePalette(mode, 'custom', seeded);
  assert.equal(resolved.id, customPaletteId(mode), 'a custom palette resolves to the mode-specific synthetic id');
  assert.equal(resolved.isCustom, true);
  assert.equal(resolved.nameKey, 'omc.palette_custom', "a custom palette is named by the dictionary, so its label is translated");

  // The fallback that keeps a half-saved preference renderable.
  const missing = resolvePalette(mode, 'custom', undefined);
  assert.equal(missing.isCustom, false, 'custom with no stored palette falls back to a built-in');
  assert.equal(missing.mode, mode, 'and falls back within its own mode');
}

// Every resolved palette has a label the dictionary owns - the two custom ones included - so no
// palette can reach the header's tooltip or a settings card as an untranslated string.
for (const definition of BUILT_IN_PALETTES) {
  assert.match(resolvedBuiltInPalette(definition.id).nameKey, /^theme\./, `${definition.id} names itself from the dictionary`);
}
for (const mode of ['dark', 'light'] as const) {
  assert.equal(resolvePalette(mode, 'custom', emptyCustomPalette(mode, 'omc-dark')).nameKey, 'omc.palette_custom');
}

// ── the stored preference document ───────────────────────────────────────────

const stored = {
  mode: 'system',
  palettes: { dark: 'midnight', light: 'custom' },
  custom: { light: { base: 'porcelain', core: getBuiltInPalette('porcelain').core } },
};
const parsed = parseThemePreferences(stored);
assert.ok(parsed, 'a well-formed document parses');
assert.equal(parsed.mode, 'system');
assert.equal(parsed.palettes.dark, 'midnight');
assert.equal(parsed.palettes.light, 'custom');
assert.equal(parsed.custom.light?.base, 'porcelain');

// A document written by a build that still held a name parses without it: the field is ignored, so a
// browser carrying one is not asked to re-author its palette.
const withLegacyName = parseThemePreferences({
  custom: { dark: { name: 'Studio', base: 'forest', core: getBuiltInPalette('forest').core } },
});
assert.equal(withLegacyName?.custom.dark?.base, 'forest', 'a stored name does not invalidate the palette');
assert.ok(!('name' in (withLegacyName?.custom.dark ?? {})), 'and it is dropped rather than carried forward');

// Liberal by field, strict by value: a missing field inherits the default while a wrong one is
// dropped rather than coerced into something the operator did not choose.
const partial = parseThemePreferences({ mode: 'purple', palettes: { dark: 'nope' } });
assert.equal(partial?.mode, DEFAULT_THEME_PREFERENCES.mode, 'an unknown mode falls back to the default');
assert.equal(partial?.palettes.dark, DEFAULT_THEME_PREFERENCES.palettes.dark, 'an unknown palette falls back');

const brokenCore = parseThemePreferences({
  custom: { dark: { base: 'forest', core: { ...getBuiltInPalette('forest').core, accent: 'blue' } } },
});
assert.equal(brokenCore?.custom.dark, undefined, 'a palette with an unreadable token is dropped, not repaired');

assert.equal(parseThemePreferences('nonsense'), undefined, 'a non-object document does not parse');
assert.equal(parseThemePreferences(null), undefined);
assert.equal(parseThemePreferences([]), undefined, 'an array is not a preference document');

// The migration. `omc-theme` held a bare palette id before this change, and a bare mode name before
// that; both have to arrive as a usable document rather than as a default.
assert.equal(migrateLegacyThemeValue('omc-dark')?.mode, 'dark');
assert.equal(migrateLegacyThemeValue('omc-light')?.mode, 'light');
assert.equal(migrateLegacyThemeValue('midnight')?.mode, 'dark');
assert.equal(migrateLegacyThemeValue('midnight')?.palettes.dark, 'midnight', 'a legacy palette becomes that mode\'s choice');
assert.equal(migrateLegacyThemeValue('sandstone')?.mode, 'light');
assert.equal(migrateLegacyThemeValue('sandstone')?.palettes.light, 'sandstone');
assert.equal(migrateLegacyThemeValue('dark')?.mode, 'dark', 'the pre-palette bare mode still reads');
assert.equal(migrateLegacyThemeValue('light')?.mode, 'light');
assert.equal(migrateLegacyThemeValue('OMC-Theme-1.0'), undefined, 'an unrelated value is not migrated');
assert.equal(migrateLegacyThemeValue(null), undefined);

/** A minimal localStorage stand-in: the reads and writes the preference path performs. */
function fakeStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    read: (key: string) => values.get(key) ?? null,
  };
}

const v2 = fakeStorage({ 'omc-theme': JSON.stringify({ ...stored, dirty: true }) });
const readV2 = readStoredThemePreferences(v2);
assert.equal(readV2?.preferences.mode, 'system');
assert.equal(readV2?.isDirty, true, 'an unsaved local change is remembered as such');

const legacy = fakeStorage({ 'omc-theme': 'forest' });
assert.equal(readStoredThemePreferences(legacy)?.preferences.palettes.dark, 'forest', 'a legacy bare id is migrated on read');
assert.equal(readStoredThemePreferences(legacy)?.isDirty, false, 'a migrated value is not a pending write');

assert.equal(readStoredThemePreferences(fakeStorage({ 'omc-theme': '{ not json' })), undefined, 'unreadable storage yields no preference');
assert.equal(readStoredThemePreferences(fakeStorage({})), undefined, 'a first visit has no stored preference');

const written = fakeStorage({});
writeStoredThemePreferences(parsed, true, written as unknown as Storage);
const roundTripped = readStoredThemePreferences(written);
assert.ok(roundTripped && sameThemePreferences(roundTripped.preferences, parsed), 'what is written can be read back');
assert.equal(roundTripped?.isDirty, true, 'the dirty flag survives the round trip');

// Comparison has to ignore the key order JSON.stringify would otherwise preserve, or a document that
// changed only in field order would look like a change and be pushed to the deployment again.
assert.ok(
  sameThemePreferences(
    { mode: 'dark', palettes: { dark: 'omc-dark', light: 'omc-light' }, custom: {} },
    { palettes: { light: 'omc-light', dark: 'omc-dark' }, custom: {}, mode: 'dark' } as never,
  ),
  'field order does not make two documents different',
);
assert.ok(!sameThemePreferences(parsed, DEFAULT_THEME_PREFERENCES), 'a real difference is still a difference');

// The header's cycle and the system follow.
assert.equal(nextModePreference('light'), 'dark');
assert.equal(nextModePreference('dark'), 'system');
assert.equal(nextModePreference('system'), 'light', 'the cycle closes');
assert.equal(resolveModePreference('system', 'light'), 'light', 'following the system resolves to it');
assert.equal(resolveModePreference('system', 'dark'), 'dark');
assert.equal(resolveModePreference('light', 'dark'), 'light', 'an explicit choice ignores the system');

assert.ok(isPaletteRef('custom') && isPaletteRef('forest') && !isPaletteRef('tree'), 'palette references are validated');

// ── the mirrors ──────────────────────────────────────────────────────────────

/** The custom properties of one rule block in the stylesheet, as written. */
function cssBlockVariables(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `index.css declares ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const variables: Record<string, string> = {};
  for (const match of css.slice(open, close).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    variables[`--${match[1]}`] = match[2].trim();
  }
  return variables;
}

// The light block inherits every variable it does not redeclare from `:root`, so the fallback a
// light visitor actually gets is the two blocks merged - which is also how an alias inherited from
// `:root` still lands on the right token.
const rootVariables = cssBlockVariables(':root {');
const lightVariables = { ...rootVariables, ...cssBlockVariables(":root[data-theme-mode='light'] {") };

for (const [selector, paletteId, declared] of [
  [':root {', 'omc-dark', rootVariables],
  [":root[data-theme-mode='light'] {", 'omc-light', lightVariables],
] as const) {
  const expected = themePaletteCssVariables(resolvedBuiltInPalette(paletteId).palette);
  for (const [name, value] of Object.entries(expected)) {
    const written = declared[name];
    // Two values are written as aliases rather than literals, because in that palette they *are*
    // another token: the pre-hydration surface alias and the dark mode's inset step, which is the
    // page itself. An alias is checked by resolving it, so it cannot quietly point at the wrong token.
    const alias = /^var\((--[a-z0-9-]+)\)$/.exec(written ?? '');
    const resolvedValue = alias ? declared[alias[1]] : written;
    assert.equal(
      resolvedValue,
      value,
      `${selector} ${name} is ${written}, resolving to ${resolvedValue}, but ${paletteId} derives ${value} - the pre-hydration fallback has drifted from the palette`,
    );
  }
}

// The Ant Design projection takes its values from the resolved palette rather than from the id.
for (const definition of BUILT_IN_PALETTES) {
  const resolved = resolvedBuiltInPalette(definition.id);
  const antd = createThemeConfig(resolved);
  assert.equal(antd.token?.colorBgBase, resolved.palette.bg, `${definition.id} paints the page from its palette`);
  assert.equal(antd.token?.colorInfo, resolved.palette.accent, `${definition.id} paints links from its accent`);
  assert.equal(antd.token?.colorBorderSecondary, resolved.palette.borderSoft, `${definition.id} paints dividers from its border-soft step`);
  assert.equal(antd.components?.Table?.rowHoverBg, resolved.palette.rowHover, `${definition.id} paints row hover from its palette`);
  assert.equal(antd.components?.Button?.primaryColor, resolved.palette.accentOn, `${definition.id} draws the primary label in its on-accent step`);
  assert.equal(antd.components?.Tooltip?.colorBgSpotlight, resolved.palette.tooltipBg, `${definition.id} paints the spotlight from its palette`);
}

console.log('theme contracts hold: derivation, preference document and both mirrors');
