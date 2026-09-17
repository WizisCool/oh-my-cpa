import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEME_IDS,
  THEME_PRESETS,
  createThemeConfig,
  getThemePreset,
  parseThemeId,
  themePaletteCssVariables,
} from '../web/src/theme/themeConfig.ts';

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(match, `expected a six-digit hex colour, got ${hex}`);
  const [, red, green, blue] = match;
  return 0.2126 * channel(Number.parseInt(red, 16))
    + 0.7152 * channel(Number.parseInt(green, 16))
    + 0.0722 * channel(Number.parseInt(blue, 16));
}

function contrast(left: string, right: string): number {
  const a = luminance(left);
  const b = luminance(right);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

assert.equal(new Set(THEME_IDS).size, THEME_IDS.length, 'theme ids must be unique');
assert.ok(THEME_PRESETS.length >= 6, 'the registry keeps both originals and at least four presets');
assert.equal(new Set(THEME_PRESETS.map((preset) => preset.id)).size, THEME_PRESETS.length);
assert.equal(parseThemeId('dark'), 'omc-dark');
assert.equal(parseThemeId('light'), 'omc-light');
assert.equal(parseThemeId('midnight'), 'midnight');
assert.equal(parseThemeId('unknown'), undefined);

for (const preset of THEME_PRESETS) {
  const palette = preset.palette;
  assert.equal(preset.id, getThemePreset(preset.id).id);
  assert.equal(palette.series.length, 6, `${preset.id} defines exactly six series slots`);
  assert.ok(contrast(palette.fg, palette.bg) >= 7, `${preset.id} primary text contrast is too low`);
  assert.ok(contrast(palette.fg2, palette.bg) >= 4.5, `${preset.id} secondary text contrast is too low`);
  assert.ok(contrast(palette.accent, palette.bg) >= 4.5, `${preset.id} accent text contrast is too low`);
  assert.ok(contrast(palette.success, palette.bg) >= 3, `${preset.id} success contrast is too low`);
  assert.ok(contrast(palette.warn, palette.bg) >= 3, `${preset.id} warning contrast is too low`);
  assert.ok(contrast(palette.danger, palette.bg) >= 3, `${preset.id} danger contrast is too low`);
  const css = themePaletteCssVariables(preset);
  assert.equal(css['--bg'], palette.bg);
  assert.equal(css['--accent'], palette.accent);
  assert.deepEqual(
    palette.series.map((_, index) => css[`--series-${index + 1}`]),
    [...palette.series],
  );
  const antd = createThemeConfig(preset.id);
  assert.equal(antd.token?.colorBgBase, palette.bg);
  assert.equal(antd.token?.colorInfo, palette.accent);
}

// The label of a filled accent control. `accentHover` is what `colorPrimary` maps to, so it is the
// fill a primary button actually paints; Ant Design would otherwise draw that fill's label in
// `colorTextLightSolid` (white), which the accent ladder's own rule - "white label text sits on the
// filled-control step" - only allows where white is the legible choice. Testing the pair, not just
// the wiring, is what catches a preset whose fill is too light for any label.
for (const preset of THEME_PRESETS) {
  const { accentHover, accentOn } = preset.palette;
  assert.equal(
    createThemeConfig(preset.id).components?.Button?.primaryColor,
    accentOn,
    `${preset.id} draws the primary button label in its on-accent step`,
  );
  assert.ok(
    contrast(accentOn, accentHover) >= 4.5,
    `${preset.id} primary button label (${accentOn}) on the primary fill (${accentHover}) reads ${contrast(accentOn, accentHover).toFixed(2)}:1, want >= 4.5:1`,
  );
}

// The stylesheet's own accent fills draw their label from the projected variable, so a preset whose
// fill is light does not keep a hardcoded white label the palette cannot support.
const indexCss = readFileSync(new URL('../web/src/index.css', import.meta.url), 'utf8');
assert.match(
  indexCss,
  /::selection\s*\{[^}]*color:\s*var\(--accent-on\)/,
  'the selection label follows the preset rather than a literal white',
);

// ── the motion budget ──────────────────────────────────────────────────────
//
// §7 states one budget in three places - its token table, the Ant Design motion tokens in
// `themeConfig.ts`, and the two stylesheet variables every transition in the console reads - and
// nothing tied them together. They had drifted: the stylesheet carried 100ms/150ms against the
// table's 50ms/100ms, so the call sites written as `var(--motion-fast, 50ms)` - their own fallback
// naming the documented value - were paying 100ms, and a route transition documented at 100ms only
// happened to be right because the fast token was wrong by the same amount in its favour. Parsed
// rather than compared as strings, because the table states milliseconds and Ant Design takes
// seconds.
const toMilliseconds = (value: string | undefined, label: string): number => {
  const match = /^([\d.]+)(ms|s)$/.exec(value ?? '');
  assert.ok(match, `${label} is a duration (${String(value)})`);
  return match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1]);
};

const stylesheetToken = (name: string): number => {
  const match = new RegExp(`--motion-${name}:\\s*([\\d.]+(?:ms|s))`).exec(indexCss);
  assert.ok(match, `web/src/index.css defines --motion-${name}`);
  return toMilliseconds(match[1], `--motion-${name}`);
};

const antdTokens = createThemeConfig('omc-dark').token;
assert.equal(
  stylesheetToken('fast'),
  toMilliseconds(antdTokens?.motionDurationFast, 'motionDurationFast'),
  '--motion-fast is the fast token Ant Design animates with',
);
assert.equal(
  stylesheetToken('base'),
  toMilliseconds(antdTokens?.motionDurationMid, 'motionDurationMid'),
  '--motion-base is the mid token Ant Design animates with',
);
assert.equal(
  stylesheetToken('base'),
  toMilliseconds(antdTokens?.motionDurationSlow, 'motionDurationSlow'),
  'the slow token is pinned to the same budget, so a drawer cannot outlast the table',
);
assert.ok(stylesheetToken('fast') < stylesheetToken('base'), 'fast is the shorter of the two');
assert.ok(stylesheetToken('base') <= 100, `§7 caps the budget at 100ms (base=${stylesheetToken('base')}ms)`);

// The route transition is the one rule whose *documented* duration is not the fast token: §7's table
// states that a route change fades in over 100ms. Nothing observable changed while it read `fast`,
// because the two tokens held the same number - which is exactly why it needs pinning here.
assert.match(
  indexCss,
  /\.route-transition\s*\{[^}]*animation:[^;]*var\(--motion-base\)/,
  'the route transition spends the token its documented 100ms names',
);

console.log(`${THEME_PRESETS.length} theme presets passed contrast and registry checks.`);
