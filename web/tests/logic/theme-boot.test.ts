/**
 * The entry document's pre-hydration paint.
 *
 * A phone discards a backgrounded tab's page, and the tab returns as a fresh navigation: while the
 * bundle downloads, the document stands on screen alone. It has to be painted in the mode this
 * browser last chose, or a resumed dark console flashes white. `web/index.html` therefore carries
 * the two shipped page grounds and a script that reads the stored theme before anything else loads.
 * This holds both to the theme module, so the document cannot drift into a copy of it. The same
 * holds for the stylesheet's corner scale and its edges, at the end of this file.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';
import {
  ACCENT_LABEL_CONTRAST_FLOOR,
  BUILT_IN_PALETTES,
  BUILT_IN_PALETTE_IDS,
  CONTRAST_FLOORS,
  CORE_TOKEN_CONTRAST_ROLES,
  CORE_TOKEN_KEYS,
  STATUS_INK_SHARE,
  STATUS_TINT_SHARE,
  contrastRatio,
  derivePalette,
  exportThemeManifest,
  getBuiltInPalette,
  listRegisteredThemes,
  registerTheme,
  resolvePalette,
  resolvedBuiltInPalette,
  unregisterTheme,
} from '../../src/theme/palette.ts';
import { validateThemeManifest } from '../../src/theme/themeContract.ts';
import { migrateLegacyThemeValue, parseThemePreferences, THEME_STORAGE_KEY } from '../../src/theme/themePreference.ts';
import { mixSrgb, oklchLightness } from '../../src/theme/colorMath.ts';
import { RADIUS } from '../../src/theme/radius.ts';

const indexHTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function bootScript(): string {
  const match = /<script id="omc-theme-boot">([\s\S]*?)<\/script>/.exec(indexHTML);
  assert.ok(match, 'index.html carries no omc-theme-boot script');
  const code = match[1];
  assert.ok(code);
  return code;
}

function bootStyle(): string {
  const match = /<style>([\s\S]*?)<\/style>/.exec(indexHTML);
  assert.ok(match, 'index.html carries no boot style');
  const css = match[1];
  assert.ok(css);
  return css;
}

/**
 * Runs the document's own boot script against the two globals it reads, the way the parser runs it
 * before the stylesheet and the bundle. It returns the mode the document was grounded in.
 */
function groundedMode(
  stored: string | null,
  options: { prefersLight?: boolean; hasMatchMedia?: boolean; storageThrows?: boolean } = {},
): string | undefined {
  const documentElement = { dataset: {} as Record<string, string> };
  const window = {
    localStorage: {
      getItem(key: string): string | null {
        assert.equal(key, THEME_STORAGE_KEY, 'the boot script reads the key the theme module stores');
        if (options.storageThrows) throw new Error('storage is blocked by policy');
        return stored;
      },
    },
    matchMedia: options.hasMatchMedia === false
      ? undefined
      : (query: string) => ({ matches: Boolean(options.prefersLight) && query === '(prefers-color-scheme: light)' }),
  };
  new Function('window', 'document', bootScript())(window, { documentElement });
  return documentElement.dataset.themeMode;
}

test('the document grounds each shipped mode in its own page colour, before the bundle', () => {
  const style = bootStyle();
  const dark = getBuiltInPalette('omc-dark').core.bg;
  const light = getBuiltInPalette('omc-light').core.bg;
  assert.match(style, new RegExp(`html \\{[^}]*background-color: ${dark};[^}]*color-scheme: dark;`));
  assert.match(style, new RegExp(`html\\[data-theme-mode='light'\\] \\{[^}]*background-color: ${light};[^}]*color-scheme: light;`));
  assert.ok(indexHTML.indexOf('<style>') < indexHTML.indexOf('<script type="module"'));
});

test('the mode this browser chose is restored before the first paint', () => {
  assert.equal(groundedMode(JSON.stringify({ mode: 'dark', palettes: {}, custom: {} })), 'dark');
  assert.equal(groundedMode(JSON.stringify({ mode: 'light', dirty: true })), 'light');
});

/**
 * A preset-only document predates the JSON shape, and `themePreference.ts` still migrates it: a bare
 * mode, or a bare palette id whose own mode is the answer. The document has to reach the same mode,
 * or the console it paints first is the wrong one. The theme module supplies the expected answer for
 * every id the registry carries, so a new palette that the boot script misses fails here.
 */
test('every legacy form the theme module migrates grounds the page in the same mode', () => {
  const legacy = [
    ...BUILT_IN_PALETTES.map((palette) => palette.id),
    // The withdrawn ids, whose successor palettes decide the mode.
    'midnight',
    'porcelain',
    // The reader trims and lowercases a preset-only value, and so does the document.
    ' Fog ',
    'OMC-DARK',
    'light',
    'dark',
  ];
  for (const stored of legacy) {
    const expected = migrateLegacyThemeValue(stored)?.mode;
    assert.ok(expected, `themePreference.ts no longer migrates ${JSON.stringify(stored)}`);
    assert.equal(groundedMode(stored), expected, `legacy ${JSON.stringify(stored)}`);
  }
});

test('following the system resolves against what the system reports', () => {
  const stored = JSON.stringify({ mode: 'system' });
  assert.equal(groundedMode(stored, { prefersLight: true }), 'light');
  assert.equal(groundedMode(stored, { prefersLight: false }), 'dark');
  // Without the query there is nothing to follow, and dark is the console's shipped look.
  assert.equal(groundedMode(stored, { hasMatchMedia: false }), 'dark');
});

test('an unreadable preference leaves the shipped ground rather than taking the page down', () => {
  assert.equal(groundedMode(null), undefined);
  assert.equal(groundedMode('{'), undefined);
  assert.equal(groundedMode(JSON.stringify({ mode: 'purple' })), undefined);
  assert.equal(groundedMode(JSON.stringify({ mode: 'light' }), { storageThrows: true }), undefined);
});

/*
 * The corner scale. The stylesheet declares it for CSS and `RADIUS` carries it to the component
 * theme, the canvas painters and exported conversations; the two copies must be one scale. A
 * stylesheet names a step, never a length, so the family cannot grow a sixth radius by accident.
 */
const sourceRoot = fileURLToPath(new URL('../../src', import.meta.url));
const STEP = '(?:xs|sm|md|lg|xl)';
const ON_SCALE = new RegExp(
  `^(?:0|50%|9999px|inherit|var\\(--radius-${STEP}\\)|calc\\(var\\(--radius-${STEP}\\) [+-] \\d+px\\)|min\\(var\\(--radius-${STEP}\\), \\d+%\\))$`,
);
const TAILWIND_ROUNDED_ON_SCALE = new RegExp(
  `^rounded(?:-(?:[tblr]|tl|tr|bl|br|s|e|ss|se|es|ee))?-(?:none|${STEP}|full|\\[(?:inherit|calc\\(var\\(--radius-${STEP}\\)_[+-]_\\d+px\\))\\])$`,
);

function stripCodeComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

interface SourceEntry {
  file: string;
  relative: string;
  raw: string;
  isCss: boolean;
  isTs: boolean;
  isTsx: boolean;
  isUiFile: boolean;
  stripped?: string;
}

const uiSegment = `${path.sep}components${path.sep}ui${path.sep}`;
let cachedSourceEntries: readonly SourceEntry[] | undefined;
let cachedSourcesByRelative: Map<string, SourceEntry> | undefined;

function walkSourceFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(css|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Walks and reads `web/src` once per test-file run so every source check shares one snapshot. */
function getSourceEntries(): readonly SourceEntry[] {
  if (cachedSourceEntries) return cachedSourceEntries;
  const entries: SourceEntry[] = [];
  const byRelative = new Map<string, SourceEntry>();
  for (const file of walkSourceFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, file);
    const entry: SourceEntry = {
      file,
      relative,
      raw: readFileSync(file, 'utf8'),
      isCss: file.endsWith('.css'),
      isTs: /\.(tsx?)$/.test(file),
      isTsx: file.endsWith('.tsx'),
      isUiFile: file.includes(uiSegment),
    };
    entries.push(entry);
    byRelative.set(relative.split(path.sep).join('/'), entry);
  }
  cachedSourceEntries = entries;
  cachedSourcesByRelative = byRelative;
  return entries;
}

function strippedSource(entry: SourceEntry): string {
  entry.stripped ??= stripCodeComments(entry.raw);
  return entry.stripped;
}

function readSource(relativePosixPath: string): string {
  getSourceEntries();
  const entry = cachedSourcesByRelative?.get(relativePosixPath);
  if (entry) return entry.raw;
  return readFileSync(path.join(sourceRoot, relativePosixPath), 'utf8');
}

function readStrippedSource(relativePosixPath: string): string {
  getSourceEntries();
  const entry = cachedSourcesByRelative?.get(relativePosixPath);
  if (entry) return strippedSource(entry);
  return stripCodeComments(readFileSync(path.join(sourceRoot, relativePosixPath), 'utf8'));
}

test('the stylesheet declares the corner scale the theme module exports', () => {
  const css = readSource('index.css');
  const declared = Object.fromEntries(
    [...css.matchAll(/--radius-([a-z0-9]+):\s*(\d+)px;/g)].map(([, step, value]) => [step, Number(value)]),
  );
  assert.deepEqual(declared, RADIUS);
});

test('the first frame draws edges with the shares and shade the default palettes solve to', () => {
  const css = readSource('index.css');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf('\n}', start));
  };
  const edges = (body: string) => ({
    edgeShare: Number(/--edge-share:\s*([\d.]+)%;/.exec(body)?.[1]),
    liftShare: Number(/--lift-share:\s*([\d.]+)%;/.exec(body)?.[1]),
    fineShare: Number(/--fine-share:\s*([\d.]+)%;/.exec(body)?.[1]),
    shade: /--shade:\s*(#[0-9a-f]{6});/.exec(body)?.[1],
  });
  for (const [selector, id] of [[':root', 'omc-dark'], [":root[data-theme-mode='light']", 'omc-light']] as const) {
    const def = getBuiltInPalette(id);
    const palette = derivePalette(def.mode, def.core, def.overrides);
    const { edgeShare, liftShare, fineShare, shade } = palette;
    const body = block(selector);
    assert.deepEqual(edges(body), { edgeShare, liftShare, fineShare, shade }, id);
    assert.equal(/--primary:\s*(#[0-9a-f]{6});/.exec(body)?.[1], palette.primary, `${id} --primary`);
    assert.equal(/--primary-hover:\s*(#[0-9a-f]{6});/.exec(body)?.[1], palette.primaryHover, `${id} --primary-hover`);
    assert.equal(/--primary-active:\s*(#[0-9a-f]{6});/.exec(body)?.[1], palette.primaryActive, `${id} --primary-active`);
    assert.equal(/--primary-on:\s*(#[0-9a-f]{6});/.exec(body)?.[1], palette.primaryOn, `${id} --primary-on`);
    assert.equal(/--accent:\s*(#[0-9a-f]{6});/.exec(body)?.[1], palette.accent, `${id} --accent`);
    assert.equal(/--thumb-bg:\s*(#[0-9a-f]{6});/.exec(body)?.[1], palette.thumbBg, `${id} --thumb-bg`);
    assert.equal(/--selected-inset:\s*(#[0-9a-f]{6});/.exec(body)?.[1], palette.selected, `${id} --selected-inset`);
  }
});

test('every built-in and custom palette keeps segmented thumbs and selected rows visible on every surface', () => {
  const cases = [
    ...BUILT_IN_PALETTES.map((definition) => ({
      name: definition.id,
      mode: definition.mode,
      palette: resolvedBuiltInPalette(definition.id).palette,
    })),
    {
      name: 'custom-dark-high-elevated',
      mode: 'dark' as const,
      palette: derivePalette('dark', {
        bg: '#101216',
        surface: '#191d24',
        elevated: '#262c36',
        fg: '#f0f4f8',
        fg2: '#b0bac5',
        muted: '#7a8490',
        meta: '#57606a',
        border: '#2d333b',
        accent: '#58a6ff',
      }),
    },
    {
      name: 'custom-dark-bright-elevated',
      mode: 'dark' as const,
      palette: derivePalette('dark', {
        bg: '#121214',
        surface: '#1c1c1f',
        elevated: '#707070',
        fg: '#ffffff',
        fg2: '#e2e2e6',
        muted: '#a1a1aa',
        meta: '#82828c',
        border: '#2c2c30',
        accent: '#58a6ff',
      }),
    },
    {
      name: 'custom-light-flat-elevated',
      mode: 'light' as const,
      palette: derivePalette('light', {
        bg: '#f5f6f8',
        surface: '#eceef2',
        elevated: '#f0f2f5',
        fg: '#1a1d21',
        fg2: '#4c525c',
        muted: '#727882',
        meta: '#959ba5',
        border: '#d6dae0',
        accent: '#1f5bbf',
      }),
    },
  ];
  for (const { name, mode, palette } of cases) {
    const wells = [palette.bg, palette.surface, palette.elevated].map((ground) => mixSrgb(ground, palette.fg, 0.05));
    const maxWellL = Math.max(...wells.map(oklchLightness));
    const thumbL = oklchLightness(palette.thumbBg);
    const minStep = mode === 'dark' ? 0.07 : 0.025;
    assert.ok(Math.abs(thumbL - maxWellL) >= minStep, `${name} thumbBg (${palette.thumbBg}) too close to field well`);
    assert.ok(contrastRatio(palette.fg, palette.thumbBg) >= 4.5, `${name} fg contrast on thumbBg < 4.5`);
    const selectedDelta = Math.abs(oklchLightness(palette.selected) - oklchLightness(palette.elevated));
    assert.ok(selectedDelta >= 0.045, `${name} selected (${palette.selected}) too close to elevated (${palette.elevated})`);
    assert.ok(contrastRatio(palette.fg, palette.selected) >= 4.5, `${name} fg contrast on selected < 4.5`);
  }
});

test('every built-in palette clears all text, hint, quiet, primary and accent contrast floors', () => {
  for (const definition of BUILT_IN_PALETTES) {
    const { palette } = resolvedBuiltInPalette(definition.id);
    for (const key of CORE_TOKEN_KEYS) {
      const floor = CONTRAST_FLOORS[CORE_TOKEN_CONTRAST_ROLES[key]];
      if (floor !== undefined) {
        const ratio = contrastRatio(palette[key], palette.bg);
        assert.ok(ratio >= floor, `${definition.id}.${key} (${ratio.toFixed(2)}) < ${floor}`);
      }
    }
    for (const fill of [palette.primary, palette.primaryHover, palette.primaryActive]) {
      const ratio = contrastRatio(palette.primaryOn, fill);
      assert.ok(ratio >= ACCENT_LABEL_CONTRAST_FLOOR, `${definition.id} primary contrast (${ratio.toFixed(2)}) < ${ACCENT_LABEL_CONTRAST_FLOOR}`);
    }
    for (const fill of [palette.accentHover, palette.accentActive]) {
      const ratio = contrastRatio(palette.accentOn, fill);
      assert.ok(ratio >= ACCENT_LABEL_CONTRAST_FLOOR, `${definition.id} accent contrast (${ratio.toFixed(2)}) < ${ACCENT_LABEL_CONTRAST_FLOOR}`);
    }
  }
});

test('status label chips clear WCAG AA contrast on bg and surface in every built-in palette and match CSS shares', () => {
  const css = readSource('index.css');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf('\n}', start));
  };
  assert.equal(Number(/--status-ink-share:\s*(\d+)%;/.exec(block(':root'))?.[1]), STATUS_INK_SHARE.dark);
  assert.equal(Number(/--status-ink-share:\s*(\d+)%;/.exec(block(":root[data-theme-mode='light']"))?.[1]), STATUS_INK_SHARE.light);

  const floor = CONTRAST_FLOORS.text ?? 4.5;
  for (const definition of BUILT_IN_PALETTES) {
    const { palette } = resolvedBuiltInPalette(definition.id);
    const inkMix = (100 - STATUS_INK_SHARE[definition.mode]) / 100;
    const tintMix = STATUS_TINT_SHARE / 100;
    for (const [groundName, ground] of [['bg', palette.bg], ['surface', palette.surface]] as const) {
      for (const [toneName, hue] of [
        ['success', palette.success],
        ['warn', palette.warn],
        ['danger', palette.danger],
        ['accent', palette.accent],
      ] as const) {
        const ink = mixSrgb(hue, palette.fg, inkMix);
        const wash = mixSrgb(ground, hue, tintMix);
        const ratio = contrastRatio(ink, wash);
        assert.ok(ratio >= floor, `${definition.id} ${toneName} on ${groundName} (${ratio.toFixed(2)}) < ${floor}`);
      }
      const neutralWash = mixSrgb(ground, palette.fg, 0.06);
      const neutralRatio = contrastRatio(palette.fg2, neutralWash);
      assert.ok(neutralRatio >= floor, `${definition.id} neutral on ${groundName} (${neutralRatio.toFixed(2)}) < ${floor}`);
    }
  }
});

test('open theme SDK validates manifests, registers external themes, and falls back cleanly on removal', () => {
  const builtInSet = new Set(BUILT_IN_PALETTE_IDS);
  assert.equal(validateThemeManifest({ schemaVersion: 1, id: 'omc-dark', mode: 'dark', label: 'Clash', core: {} }, builtInSet).ok, false);

  const nordManifest = exportThemeManifest(
    {
      mode: 'dark',
      core: {
        bg: '#1c2028',
        surface: '#242933',
        elevated: '#2e3440',
        fg: '#eceff4',
        fg2: '#d8dee9',
        muted: '#9aa5b8',
        meta: '#6d788d',
        border: '#3b4252',
        accent: '#88c0d0',
      },
      overrides: {
        primary: '#81a1c1',
      },
    },
    {
      id: 'plugin:community.nord',
      label: { en: 'Nord Frost', zh: '极地冰蓝' },
      description: { en: 'Arctic slate with frost primary', zh: '极地蓝灰与冰霜主色' },
      author: 'OMC Studio',
      version: '1.0.0',
    },
  );

  const check = validateThemeManifest(nordManifest, builtInSet);
  assert.equal(check.ok, true);

  const preBootPrefs = parseThemePreferences({
    mode: 'dark',
    palettes: { dark: 'plugin:community.nord', light: 'omc-dark' },
    custom: {},
  });
  assert.equal(preBootPrefs?.palettes.dark, 'plugin:community.nord');
  assert.equal(preBootPrefs?.palettes.light, 'omc-light');
  assert.equal(resolvePalette('dark', 'plugin:community.nord', undefined).id, 'omc-dark');

  const dispose = registerTheme(nordManifest);
  try {
    assert.ok(listRegisteredThemes('dark').some((entry) => entry.id === 'plugin:community.nord'));
    const resolved = resolvePalette('dark', 'plugin:community.nord', undefined);
    assert.equal(resolved.id, 'plugin:community.nord');
    assert.ok(contrastRatio(resolved.palette.primaryOn, resolved.palette.primary) >= ACCENT_LABEL_CONTRAST_FLOOR);
  } finally {
    dispose();
  }
  assert.equal(unregisterTheme('omc-dark'), false);
  assert.equal(resolvePalette('dark', 'plugin:community.nord', undefined).id, 'omc-dark');

  // Explicit primary ink is rejected if it fails contrast against hover or active fills.
  const mismatchedPrimary = derivePalette('dark', getBuiltInPalette('omc-dark').core, {
    primary: { fill: '#000000', hover: '#ffffff', active: '#ffffff', ink: '#ffffff' },
  });
  assert.ok(contrastRatio(mismatchedPrimary.primaryOn, mismatchedPrimary.primary) >= ACCENT_LABEL_CONTRAST_FLOOR);
  assert.ok(contrastRatio(mismatchedPrimary.primaryOn, mismatchedPrimary.primaryHover) >= ACCENT_LABEL_CONTRAST_FLOOR);
  assert.ok(contrastRatio(mismatchedPrimary.primaryOn, mismatchedPrimary.primaryActive) >= ACCENT_LABEL_CONTRAST_FLOOR);

  // The default ink fill keeps its label legible on hover and press even when the theme's ink only
  // just clears the floor against its page.
  const faintInk = derivePalette('light', { ...getBuiltInPalette('omc-light').core, bg: '#ffffff', fg: '#767676' });
  for (const fill of [faintInk.primary, faintInk.primaryHover, faintInk.primaryActive]) {
    assert.ok(contrastRatio(faintInk.primaryOn, fill) >= ACCENT_LABEL_CONTRAST_FLOOR, `faint ink ${fill}`);
  }
});

test('every corner in the console sits on the scale', () => {
  const offScale: string[] = [];
  for (const entry of getSourceEntries()) {
    if (entry.raw.includes('radius')) {
      for (const [, raw] of entry.raw.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}"`]+)/g)) {
        const value = (raw ?? '').replace('!important', '').trim();
        const corners = value.match(/(?:[a-z]+\((?:[^()]|\([^()]*\))*\)|\S)+/g) ?? [];
        if (corners.some((corner) => !ON_SCALE.test(corner))) {
          offScale.push(`${entry.relative}: ${value}`);
        }
      }
    }
    if (entry.isTs) {
      const code = strippedSource(entry);
      if (!code.includes('rounded')) continue;
      for (const [, literal] of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        for (const rawToken of (literal ?? '').split(/\s+/)) {
          const token = rawToken.split(':').at(-1) ?? '';
          if (token.startsWith('rounded-') || (entry.isUiFile && token === 'rounded')) {
            if (!TAILWIND_ROUNDED_ON_SCALE.test(token)) {
              offScale.push(`${entry.relative}: ${rawToken}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(offScale, []);
});

/*
 * Edges are shadows. A neutral 1px stroke that encloses content is the edge shadow's job, so the
 * only ones left are glyphs: a ring drawn as a circle, a colour sample's outline, a table's grid.
 */
const STROKED_GLYPHS = new Set(['.theme-swatch', '.country-flag', '.markdown-body th, .markdown-body td']);

test('nothing encloses content with a neutral border', () => {
  const enclosed: string[] = [];
  for (const entry of getSourceEntries()) {
    if (entry.isCss && entry.raw.includes('border:')) {
      for (const [, prelude, body] of entry.raw.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/(?:^|[\s;])border:\s*1px solid var\(--(?:border|border-soft|thread-hairline)\)/.test(body ?? '')) continue;
        const selector = (prelude ?? '').split('*/').at(-1)!.trim().replace(/\s+/g, ' ');
        if (/border-radius:\s*50%/.test(body ?? '') || STROKED_GLYPHS.has(selector)) continue;
        enclosed.push(`${entry.relative}: ${selector}`);
      }
    }
    if (entry.isUiFile) {
      const code = strippedSource(entry);
      if (!code.includes('border')) continue;
      for (const [, , literal] of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        const tokens = (literal ?? '').trim().split(/\s+/).map((item) => item.split(':').at(-1) ?? '');
        if (!tokens.includes('border')) continue;
        if (tokens.includes('border-dashed') || tokens.includes('rounded-full') || tokens.includes('border-transparent')) continue;
        if (tokens.some((token) => /^border-(?:border|border-soft|hairline)$/.test(token)) || !tokens.some((token) => /^border-(?!0$)/.test(token))) {
          enclosed.push(`${entry.relative}: ${literal}`);
        }
      }
    }
  }
  assert.deepEqual(enclosed, []);
});

/*
 * A custom property nobody declares resolves to nothing, silently: a focus ring that never draws, a
 * hover with no fill. Every `var(--name)` must name a property the console declares - in a
 * stylesheet, or as a `'--name'` the theme projection or a component writes - or one Base UI sets on
 * its own parts. A reference that carries a fallback still counts: the fallback hides a misspelt
 * token in one palette and paints the wrong colour in every other.
 */
const LIBRARY_PROPERTIES = new Set([
  '--anchor-width', '--available-height', '--transform-origin', '--accordion-panel-height', '--collapsible-panel-height',
]);

test('every custom property the console reads is one it declares', () => {
  const declared = new Set(LIBRARY_PROPERTIES);
  const entries = getSourceEntries();
  for (const entry of entries) {
    if (!entry.raw.includes('--')) continue;
    for (const [, name] of entry.raw.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) declared.add(name!);
    for (const [, name] of entry.raw.matchAll(/['"`](--[a-zA-Z][\w-]*)['"`]/g)) declared.add(name!);
  }
  const unresolved: string[] = [];
  for (const entry of entries) {
    const text = strippedSource(entry);
    if (!text.includes('var(--')) continue;
    for (const [, name] of text.matchAll(/var\((--[a-zA-Z][\w-]*)/g)) {
      // A name built at run time (`var(--effort-${step})`) is checked by the palette tests instead.
      if (name!.endsWith('-') || declared.has(name!)) continue;
      unresolved.push(`${entry.relative}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(unresolved)], []);
});

/*
 * Reduced motion is one console policy (OMC Settings → Appearance, defaulting to the system), which
 * `motionPreference.ts` publishes as `data-reduced-motion` on the root. A stylesheet that asks the
 * operating system directly keeps animating after the operator turned motion off in the console.
 */
test('stylesheets follow the console reduced-motion policy, not the system query', () => {
  const direct = getSourceEntries()
    .filter((entry) => entry.isCss && /@media[^{]*prefers-reduced-motion/.test(entry.raw))
    .map((entry) => entry.relative);
  assert.deepEqual(direct, []);
});

const DOM_FORWARDING_PRIMITIVES = new Set([
  'Button', 'Input', 'Textarea', 'Checkbox', 'Switch', 'Tag',
  'Select', 'SelectTrigger', 'Combobox', 'AutoComplete', 'NumberInput',
  'TimePicker', 'ColorPicker', 'Slider', 'Segmented', 'ToggleGroup', 'ToggleGroupItem',
  'DropdownMenuTrigger', 'PopoverTrigger', 'DialogTrigger', 'SheetTrigger', 'TabsTrigger',
  'ToolButton', 'HeaderAction', 'RefreshButton', 'CopyButton', 'SecretInput', 'SearchInput',
]);

function isJsxAttrIdentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 36 || // $
    code === 45 // -
  );
}

function isJsxDataTipBoundaryChar(code: number): boolean {
  return isJsxAttrIdentChar(code) || code === 58 || code === 46; // : or .
}

function hasAnotherSlashOnLine(src: string, index: number): boolean {
  for (let i = index + 1; i < src.length; i += 1) {
    const ch = src.charCodeAt(i);
    if (ch === 10 || ch === 13 || ch === 0x2028 || ch === 0x2029) return false;
    if (ch === 47) return true;
  }
  return false;
}

/**
 * Conservative JSX opening-tag pre-filter. Returns `false` only when a file is proven to have
 * neither a `title` attribute on a checked tag nor an orphan `data-tip-overflow`; any candidate
 * match or lexically ambiguous construct (regex literal inside an expression, comment after `<`,
 * unclosed delimiter) returns `true` so TypeScript's TSX parser decides with full AST fidelity.
 */
function needsJsxAstCheck(src: string): boolean {
  const hasTipOverflow = src.includes('data-tip-overflow');
  const hasTitle = /\btitle\b/.test(src);
  if (!hasTipOverflow && !hasTitle) return false;
  if (/<\s*\/[/*]/.test(src)) return true;

  const tagRe = /<\s*([\p{ID_Start}_$][\p{ID_Continue}$.:-]*)(?=[\s</{])/gu;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(src)) !== null) {
    const tag = match[1]!;
    const afterTag = match.index + match[0].length;
    if (src.charCodeAt(afterTag) === 47 && src.charCodeAt(afterTag + 1) === 62) continue;

    const isTargetForTitle =
      hasTitle && ((/^[a-z]/.test(tag) && tag !== 'iframe') || DOM_FORWARDING_PRIMITIVES.has(tag));
    if (!isTargetForTitle && !hasTipOverflow) continue;

    let i = afterTag;
    const len = src.length;

    // Optional TypeScript generic type arguments immediately after the tag name (`<Select<T> ...>`).
    if (src.charCodeAt(i) === 60) {
      let angleDepth = 1;
      i += 1;
      while (i < len && angleDepth > 0) {
        const ch = src.charCodeAt(i);
        if (ch === 34 || ch === 39) {
          const quote = ch;
          i += 1;
          let closed = false;
          while (i < len) {
            const c = src.charCodeAt(i);
            if (c === 92) { i += 2; continue; }
            if (c === quote) { i += 1; closed = true; break; }
            i += 1;
          }
          if (!closed) return true;
          continue;
        }
        if (ch === 47 && src.charCodeAt(i + 1) === 47) {
          const nl = src.indexOf('\n', i + 2);
          i = nl === -1 ? len : nl + 1;
          continue;
        }
        if (ch === 47 && src.charCodeAt(i + 1) === 42) {
          const end = src.indexOf('*/', i + 2);
          if (end === -1) return true;
          i = end + 2;
          continue;
        }
        if (ch === 96) return true;
        if (ch === 60) { angleDepth += 1; i += 1; continue; }
        if (ch === 62) {
          if (src.charCodeAt(i - 1) === 61) { i += 1; continue; } // arrow type `=>`
          angleDepth -= 1;
          i += 1;
          continue;
        }
        i += 1;
      }
      if (angleDepth !== 0) return true;
    }

    const braceStack: Array<'expr' | 'tpl'> = [];
    let sawTitleAttr = false;
    let sawTipOverflow = false;
    let sawTip = false;

    while (i < len) {
      const ch = src.charCodeAt(i);
      if (ch === 47 && src.charCodeAt(i + 1) === 47) {
        const nl = src.indexOf('\n', i + 2);
        i = nl === -1 ? len : nl + 1;
        continue;
      }
      if (ch === 47 && src.charCodeAt(i + 1) === 42) {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) return true;
        i = end + 2;
        continue;
      }
      // Inside `{...}`, any regex literal must close on the same line (ECMAScript grammar).
      // Bail to the TS AST if another `/` exists on this line so regexes containing quotes or
      // braces can never desynchronize scanning; plain single-slash divisions stay fast.
      if (
        ch === 47 &&
        braceStack.length > 0 &&
        src.charCodeAt(i + 1) !== 62 &&
        src.charCodeAt(i - 1) !== 60 &&
        hasAnotherSlashOnLine(src, i)
      ) {
        return true;
      }
      if (ch === 34 || ch === 39) {
        const quote = ch;
        i += 1;
        let closed = false;
        while (i < len) {
          const c = src.charCodeAt(i);
          if (c === 92) { i += 2; continue; }
          if (c === quote) { i += 1; closed = true; break; }
          i += 1;
        }
        if (!closed) return true;
        continue;
      }
      if (ch === 96) {
        i += 1;
        let ended = false;
        while (i < len) {
          const c = src.charCodeAt(i);
          if (c === 92) { i += 2; continue; }
          if (c === 36 && src.charCodeAt(i + 1) === 123) {
            braceStack.push('tpl');
            i += 2;
            ended = true;
            break;
          }
          if (c === 96) { i += 1; ended = true; break; }
          i += 1;
        }
        if (!ended) return true;
        continue;
      }
      if (ch === 123) {
        braceStack.push('expr');
        i += 1;
        continue;
      }
      if (ch === 125) {
        if (braceStack.length === 0) break;
        const top = braceStack.pop();
        i += 1;
        if (top === 'tpl') {
          let ended = false;
          while (i < len) {
            const c = src.charCodeAt(i);
            if (c === 92) { i += 2; continue; }
            if (c === 36 && src.charCodeAt(i + 1) === 123) {
              braceStack.push('tpl');
              i += 2;
              ended = true;
              break;
            }
            if (c === 96) { i += 1; ended = true; break; }
            i += 1;
          }
          if (!ended) return true;
        }
        continue;
      }
      if (braceStack.length === 0) {
        // `;`, `,`, `)`, `]` cannot appear at top-level JSX attribute position;
        // seeing one means `<name` was a JS comparison (`a < b`) rather than a JSX tag.
        if (ch === 59 || ch === 44 || ch === 41 || ch === 93) break;
        if (ch === 60) return true;
        if (ch === 62) break;
        if (isTargetForTitle && ch === 116 && src.startsWith('title', i)) {
          const prev = i > 0 ? src.charCodeAt(i - 1) : 0;
          const next = i + 5 < len ? src.charCodeAt(i + 5) : 0;
          if (prev >= 128 || next >= 128) return true;
          if (!isJsxAttrIdentChar(prev) && !isJsxAttrIdentChar(next)) sawTitleAttr = true;
        } else if (hasTipOverflow && ch === 100 && src.startsWith('data-tip', i)) {
          const prev = i > 0 ? src.charCodeAt(i - 1) : 0;
          if (prev >= 128) return true;
          if (!isJsxDataTipBoundaryChar(prev)) {
            if (src.startsWith('data-tip-overflow', i)) {
              const next = i + 17 < len ? src.charCodeAt(i + 17) : 0;
              if (next >= 128) return true;
              if (!isJsxDataTipBoundaryChar(next)) sawTipOverflow = true;
            } else {
              const next = i + 8 < len ? src.charCodeAt(i + 8) : 0;
              if (next >= 128) return true;
              if (!isJsxDataTipBoundaryChar(next)) sawTip = true;
            }
          }
        }
      }
      i += 1;
    }
    if (sawTitleAttr || (sawTipOverflow && !sawTip)) return true;
  }
  return false;
}

function inspectJsxTitleAndTipViolations(file: string, relative: string, src: string): {
  rawTitles: string[];
  orphanOverflowTips: string[];
} {
  if (!needsJsxAstCheck(src)) return { rawTitles: [], orphanOverflowTips: [] };

  const rawTitles: string[] = [];
  const orphanOverflowTips: string[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isIdentifier(node.tagName) ? node.tagName.text : node.tagName.getText(sf);
      const isIntrinsic = /^[a-z]/.test(tag) && tag !== 'iframe';
      const attrNames = new Set<string>();
      for (const prop of node.attributes.properties) {
        if (!ts.isJsxAttribute(prop)) continue;
        const attrName = ts.isIdentifier(prop.name) ? prop.name.text : prop.name.getText(sf);
        attrNames.add(attrName);
        if (attrName === 'title' && (isIntrinsic || DOM_FORWARDING_PRIMITIVES.has(tag))) {
          const { line } = sf.getLineAndCharacterOfPosition(prop.getStart(sf));
          rawTitles.push(`${relative}:${line + 1} <${tag} title=...>`);
        }
      }
      if (attrNames.has('data-tip-overflow') && !attrNames.has('data-tip')) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        orphanOverflowTips.push(`${relative}:${line + 1} <${tag} data-tip-overflow>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { rawTitles, orphanOverflowTips };
}

test('no JSX intrinsic or DOM-forwarding primitive uses a raw browser title attribute or orphan data-tip-overflow', () => {
  const rawTitles: string[] = [];
  const orphanOverflowTips: string[] = [];
  for (const entry of getSourceEntries()) {
    if (!entry.isTsx) continue;
    const found = inspectJsxTitleAndTipViolations(entry.file, entry.relative, entry.raw);
    rawTitles.push(...found.rawTitles);
    orphanOverflowTips.push(...found.orphanOverflowTips);
  }
  assert.deepEqual(rawTitles, []);
  assert.deepEqual(orphanOverflowTips, []);
});

test('JSX title and overflow-tip pre-filter preserves exact AST detection on edge cases', () => {
  const badSamples: Array<{ name: string; src: string; expectedTitles: number; expectedOrphans: number }> = [
    { name: 'intrinsic string title', src: 'export const A = () => <div title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'boolean title attribute', src: 'export const A = () => <span title />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'whitespace after lt', src: 'export const A = () => < div title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'whitespace and comment after lt', src: 'export const A = () => < /*c*/div title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'comment after tag', src: 'export const A = () => <div/*c*/title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'adjacent spread before title', src: 'export const A = (p: Record<string, unknown>) => <div{...p} title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'primitive generic arrow', src: 'export const A = () => <Select<(v: string) => void> title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'template expr before title', src: 'export const A = ({ b }: { b: number }) => <div className={`a ${b > 1 ? "c" : "d"}`} title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'regex with quote before title', src: 'export const A = () => <Button onClick={() => /"/.test("x")} title="raw" />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'nested intrinsic inside prop', src: 'export const A = () => <AppModal title="ok" header={<div title="raw" />} />;', expectedTitles: 1, expectedOrphans: 0 },
    { name: 'orphan data-tip-overflow', src: 'export const A = () => <span data-tip-overflow />;', expectedTitles: 0, expectedOrphans: 1 },
    { name: 'adjacent spread before orphan tip', src: 'export const A = (p: Record<string, unknown>) => <span{...p} data-tip-overflow />;', expectedTitles: 0, expectedOrphans: 1 },
    { name: 'underscore-prefixed component orphan tip', src: 'export const A = () => <_Button data-tip-overflow />;', expectedTitles: 0, expectedOrphans: 1 },
    { name: 'dollar-prefixed component orphan tip', src: 'export const A = () => <$Slot data-tip-overflow />;', expectedTitles: 0, expectedOrphans: 1 },
    { name: 'similar data-tip prefix does not satisfy data-tip', src: 'export const A = () => <span data-tip-overflow data-tip-extra="x" />;', expectedTitles: 0, expectedOrphans: 1 },
    { name: 'unicode continuation does not satisfy data-tip', src: 'export const A = () => <span data-tip-overflow data-tipé="label" />;', expectedTitles: 0, expectedOrphans: 1 },
  ];
  for (const sample of badSamples) {
    const found = inspectJsxTitleAndTipViolations('sample.tsx', 'sample.tsx', sample.src);
    assert.equal(found.rawTitles.length, sample.expectedTitles, `${sample.name} titles`);
    assert.equal(found.orphanOverflowTips.length, sample.expectedOrphans, `${sample.name} orphans`);
  }

  const okSamples = [
    'export const A = () => <iframe title="allowed" />;',
    'export const A = () => <AppModal title="allowed" />;',
    'export const A = () => <span data-tip="label" data-tip-overflow />;',
  ];
  for (const src of okSamples) {
    const found = inspectJsxTitleAndTipViolations('ok.tsx', 'ok.tsx', src);
    assert.deepEqual(found, { rawTitles: [], orphanOverflowTips: [] }, src);
  }
});

test('no retired Ant Design, rc-component, dayjs or ECharts packages or selectors remain', () => {
  const repoRoot = path.resolve(sourceRoot, '../..');
  const retiredPkg = /^(?:antd|@ant-design\/.+|@rc-component\/.+|rc-.+|dayjs|echarts)$/;
  const foundPackages: string[] = [];
  for (const manifestPath of ['package.json', 'web/package.json']) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, manifestPath), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]) {
      if (retiredPkg.test(name)) foundPackages.push(`${manifestPath}: ${name}`);
    }
  }
  assert.deepEqual(foundPackages, []);

  const legacySelectors: string[] = [];
  for (const entry of getSourceEntries()) {
    const text = strippedSource(entry);
    if (/(?:\.ant-[a-z]|\banticon\b|--rc-virtual-list|\.rc-virtual-list)/.test(text)) {
      legacySelectors.push(entry.relative);
    }
  }
  assert.deepEqual(legacySelectors, []);
});

test('foldable panels, Collapse variants, and payload builder do not clip edge shadows or focus rings', () => {
  const indexCss = readStrippedSource('index.css');
  const configCss = readStrippedSource('components/config/config.css');
  const agentCss = readStrippedSource('pages/agent/AgentPage.module.css');
  const accordionTsx = readStrippedSource('components/ui/accordion.tsx');
  const payloadEditorTsx = readStrippedSource('components/config/PayloadRulesEditor.tsx');
  const configRenderersTsx = readStrippedSource('components/config/configSectionRenderers.tsx');

  assert.match(indexCss, /\.omc-fold-panel\[data-open\]:not\(\[data-starting-style\]\):not\(\[data-ending-style\]\)\s*\{[^}]*overflow:\s*visible\s*;/);
  assert.match(agentCss, /\.fold\[data-open\]\s*>\s*\.fold-inner\s*\{[^}]*overflow:\s*visible\s*;/);
  assert.match(configCss, /\.settings-tls-body\.is-open\s*>\s*\.settings-tls-inner\s*\{[^}]*overflow:\s*visible\s*;/);
  assert.match(configCss, /\.payload-collapse\s*\{[^}]*overflow:\s*visible\s*;/);
  assert.match(configCss, /\.payload-collapse\s*>\s*\[data-slot="accordion-item"\]\s*\{[^}]*overflow:\s*visible\s*;/);

  // Collapse never applies overflow-hidden to the outer shadow-bearing accordion root or card items.
  assert.equal(/\boverflow-hidden\b/.test(accordionTsx), false);
  assert.match(accordionTsx, /isCards\s*&&\s*'rounded-xl bg-surface shadow-edge'/);
  assert.match(payloadEditorTsx, /<Collapse[\s\S]*?\bvariant="cards"/);

  // The payload-builder wrapper does not nest inside a clipping .settings-group shell.
  const payloadBranch = configRenderersTsx.match(/grp\.variant === 'payload-builder'[\s\S]*?return\s*\([\s\S]*?\);\s*\}/)?.[0] ?? '';
  assert.ok(payloadBranch.length > 0);
  assert.match(payloadBranch, /className="payload-builder-group"/);
  assert.equal(/settings-group(?!-head)/.test(payloadBranch), false);
  assert.equal(/settings-group-body/.test(payloadBranch), false);

  // Toast item lists sit inside the toast's scrollable body on an elevated surface, so they use an
  // inset well on a recessed surface fill rather than an outset edge shadow that scroll clipping cuts off.
  const toastReportRule = indexCss.match(/\.omc-toast-report\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(toastReportRule.length > 0);
  assert.doesNotMatch(toastReportRule, /\boverflow(?:-y)?:\s*(?:auto|scroll|hidden)\b/);

  const toastItemsRule = indexCss.match(/\.omc-toast-items\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(toastItemsRule.length > 0);
  assert.match(toastItemsRule, /\bbackground:\s*var\(--surface\)\s*;/);
  assert.match(toastItemsRule, /\bbox-shadow:\s*var\(--shadow-well\)\s*;/);
  assert.doesNotMatch(toastItemsRule, /\b--shadow-edge\b/);
});

test('no retired input-wrapper slot selectors remain and alignment invariants hold', () => {
  const retiredInputWrapper: string[] = [];
  for (const entry of getSourceEntries()) {
    const text = strippedSource(entry);
    if (/\[\s*data-slot\s*[~|^$*]?=\s*(?:['"`]input-wrapper['"`]|input-wrapper)(?:\s+[is])?\s*\]/i.test(text)) {
      retiredInputWrapper.push(entry.relative);
    }
  }
  assert.deepEqual(retiredInputWrapper, []);

  const indexCss = readStrippedSource('index.css');
  const configCss = readStrippedSource('components/config/config.css');
  const dashboardCss = readStrippedSource('components/dashboard/dashboard.css');

  assert.match(
    indexCss,
    /\.settings-field-control\.is-string_list\s+:is\(\[data-slot="combobox-trigger"\],\s*\[data-slot="combobox-inline-tags"\]\)/,
  );
  assert.match(
    indexCss,
    /\[data-slot="panel"\]:has\(>\s*\[data-slot="panel-body"\]\s*>\s*\.empty-state:only-child\)\s*>\s*\[data-slot="panel-body"\]/,
  );
  assert.match(configCss, /\.settings-field-control\.is-switch\s*\{[^}]*margin-top:\s*0;/);
  assert.equal(/\.settings-field-switch-header\s*\{[^}]*min-height:/.test(configCss), false);
  assert.match(dashboardCss, /\.model-trend-legend\s*\{\s*margin:\s*0 0 8px;/);
  assert.match(dashboardCss, /\.heatmap-head,\s*\.quota-head\s*\{\s*min-height:\s*28px;/);
  assert.match(
    dashboardCss,
    /\.model-trend-card:has\(\.model-view-toggle\)\s*\[data-slot="panel-head"\]\s*\{[^}]*padding-block:\s*8px;/,
  );
});

test('chip primitives keep unified breathing room, centered icons, and unclipped status labels', () => {
  const indexCss = readStrippedSource('index.css');
  const glyphCss = readStrippedSource('components/common/GlyphBadge.module.css');
  const prefixCss = readStrippedSource('components/providers/ProviderTable.module.css');
  const requestListCss = readStrippedSource('components/usage/RequestList.css');

  // Small chips share a 20px box with 7px inline padding so 12px UI/CJK text and icons have room.
  assert.match(indexCss, /\.tag\.is-small\s*\{[^}]*height:\s*20px;[^}]*padding:\s*0 7px;/);
  assert.match(indexCss, /\.status-label\.is-small\s*\{[^}]*height:\s*20px;/);
  assert.match(indexCss, /\.status-label\.is-chip\.is-small\s*\{[^}]*padding-inline:\s*7px;/);
  assert.match(indexCss, /\.omc-notice-label\s*\{[^}]*height:\s*20px;[^}]*padding:\s*0 7px;/);
  assert.match(indexCss, /\.demo-chip\s*\{[^}]*height:\s*20px;[^}]*padding:\s*0 7px;/);
  assert.match(glyphCss, /\.badge\s*\{[^}]*height:\s*20px;[^}]*padding:\s*0 7px;/);
  assert.match(prefixCss, /\.prefix-chip\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*height:\s*20px;/);
  assert.match(requestListCss, /\.req-result-pill\s*\{[^}]*height:\s*20px;[^}]*padding:\s*calc\(\(20px - 1\.25em\) \/ 2\) 7px;/);

  // Chip icons center inside the flex container and stay capped inside the chip's inner height.
  assert.match(indexCss, /\.tag-icon\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/);
  assert.match(indexCss, /\.tag-icon\s*>\s*:is\(img,\s*svg,\s*\[data-remote-image\]\)\s*\{[^}]*max-height:\s*14px;/);
  assert.match(indexCss, /\.tag\.is-small\s+\.tag-icon\s*>\s*:is\(img,\s*svg,\s*\[data-remote-image\]\)\s*\{[^}]*max-height:\s*12px;/);

  // StatusLabel's ellipsizing text span and Combobox's chip LineSlot keep descender headroom inside overflow: hidden.
  assert.match(indexCss, /\.status-label-text\s*\{[^}]*overflow:\s*hidden;[^}]*line-height:\s*1\.25;/);
  const comboboxTsx = readStrippedSource('components/ui/combobox.tsx');
  assert.equal((comboboxTsx.match(/<LineSlot className="leading-\[1\.25\]">\{renderChipLabel\(val\)\}<\/LineSlot>/g) ?? []).length, 2);

  // Secondary destructive buttons share the calm `--shadow-control` secondary material at rest and
  // reveal the WCAG-AA danger wash/ink when approached or open, never a bespoke red outline ring.
  const buttonTsx = readStrippedSource('components/ui/button.tsx');
  const destructiveSecondary = buttonTsx.match(/'destructive-secondary':\s*\n?\s*'([^']+)'/)?.[1] ?? '';
  assert.ok(destructiveSecondary.length > 0);
  assert.match(destructiveSecondary, /\bbg-secondary\b/);
  assert.match(destructiveSecondary, /\bshadow-control\b/);
  assert.match(destructiveSecondary, /\bhover:enabled:bg-danger-wash\b/);
  assert.match(destructiveSecondary, /\bhover:enabled:text-danger-ink\b/);
  assert.match(destructiveSecondary, /\bdata-\[popup-open\]:bg-danger-wash\b/);
  assert.doesNotMatch(destructiveSecondary, /shadow-\[/);

  // `--color-danger-ink` over `--color-danger-wash` and `--color-danger-wash-active` clears WCAG AA
  // (>= 4.5:1) on bg, surface, and elevated grounds across every built-in palette.
  const dangerInkShare = Number(/--color-danger-ink:\s*color-mix\(in srgb,\s*var\(--danger\)\s*(\d+)%,\s*var\(--fg\)\);/.exec(indexCss)?.[1]);
  const dangerWashPct = Number(/--color-danger-wash:\s*color-mix\(in srgb,\s*var\(--danger\)\s*(\d+)%,\s*transparent\);/.exec(indexCss)?.[1]);
  const dangerActivePct = Number(/--color-danger-wash-active:\s*color-mix\(in srgb,\s*var\(--danger\)\s*(\d+)%,\s*transparent\);/.exec(indexCss)?.[1]);
  assert.ok(dangerInkShare > 0 && dangerWashPct > 0 && dangerActivePct > 0);
  const contrastFloor = CONTRAST_FLOORS.text ?? 4.5;
  for (const definition of BUILT_IN_PALETTES) {
    const { palette } = resolvedBuiltInPalette(definition.id);
    const ink = mixSrgb(palette.danger, palette.fg, (100 - dangerInkShare) / 100);
    for (const [groundName, ground] of [['bg', palette.bg], ['surface', palette.surface], ['elevated', palette.elevated]] as const) {
      for (const pct of [dangerWashPct, dangerActivePct]) {
        const wash = mixSrgb(ground, palette.danger, pct / 100);
        const ratio = contrastRatio(ink, wash);
        assert.ok(ratio >= contrastFloor, `${definition.id} danger button on ${groundName} @${pct}% (${ratio.toFixed(2)}) < ${contrastFloor}`);
      }
    }
  }

  // Code elements follow the operator-configured `--font-mono` role rather than the browser UA fallback.
  assert.match(indexCss, /code,\s*kbd,\s*samp,\s*pre\s*\{\s*font-family:\s*var\(--font-mono\);\s*\}/);
});

