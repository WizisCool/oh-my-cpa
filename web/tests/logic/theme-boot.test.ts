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
import { test } from 'vitest';
import {
  ACCENT_LABEL_CONTRAST_FLOOR,
  BUILT_IN_PALETTES,
  BUILT_IN_PALETTE_IDS,
  CONTRAST_FLOORS,
  CORE_TOKEN_CONTRAST_ROLES,
  CORE_TOKEN_KEYS,
  contrastRatio,
  derivePalette,
  exportThemeManifest,
  getBuiltInPalette,
  listRegisteredThemes,
  registerTheme,
  resolvePalette,
  resolvedBuiltInPalette,
  unregisterTheme,
  validateThemeManifest,
} from '../../src/theme/index.ts';
import { migrateLegacyThemeValue, parseThemePreferences, THEME_STORAGE_KEY } from '../../src/theme/themePreference.ts';
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
  `^(?:0|50%|inherit|var\\(--radius-${STEP}\\)|calc\\(var\\(--radius-${STEP}\\) [+-] \\d+px\\)|min\\(var\\(--radius-${STEP}\\), \\d+%\\))$`,
);
const TAILWIND_ROUNDED_ON_SCALE = new RegExp(
  `^rounded(?:-(?:[tblr]|tl|tr|bl|br|s|e|ss|se|es|ee))?-(?:none|${STEP}|full|\\[(?:inherit|calc\\(var\\(--radius-${STEP}\\)_[+-]_\\d+px\\))\\])$`,
);

function stripCodeComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(css|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

test('the stylesheet declares the corner scale the theme module exports', () => {
  const css = readFileSync(path.join(sourceRoot, 'index.css'), 'utf8');
  const declared = Object.fromEntries(
    [...css.matchAll(/--radius-([a-z0-9]+):\s*(\d+)px;/g)].map(([, step, value]) => [step, Number(value)]),
  );
  assert.deepEqual(declared, RADIUS);
});

test('the first frame draws edges with the shares and shade the default palettes solve to', () => {
  const css = readFileSync(path.join(sourceRoot, 'index.css'), 'utf8');
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
});

test('every corner in the console sits on the scale', () => {
  const offScale: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const [, raw] of text.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;}"`]+)/g)) {
      const value = (raw ?? '').replace('!important', '').trim();
      const corners = value.match(/(?:[a-z]+\((?:[^()]|\([^()]*\))*\)|\S)+/g) ?? [];
      if (corners.some((corner) => !ON_SCALE.test(corner))) {
        offScale.push(`${path.relative(sourceRoot, file)}: ${value}`);
      }
    }
    if (/\.(tsx?)$/.test(file)) {
      const code = stripCodeComments(text);
      const isUiFile = file.includes(`${path.sep}components${path.sep}ui${path.sep}`);
      for (const [, literal] of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        for (const rawToken of (literal ?? '').split(/\s+/)) {
          const token = rawToken.split(':').at(-1) ?? '';
          if (token.startsWith('rounded-') || (isUiFile && token === 'rounded')) {
            if (!TAILWIND_ROUNDED_ON_SCALE.test(token)) {
              offScale.push(`${path.relative(sourceRoot, file)}: ${rawToken}`);
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
  for (const file of sourceFiles(sourceRoot).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(file, 'utf8');
    for (const [, prelude, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(?:^|[\s;])border:\s*1px solid var\(--(?:border|border-soft|thread-hairline)\)/.test(body ?? '')) continue;
      const selector = (prelude ?? '').split('*/').at(-1)!.trim().replace(/\s+/g, ' ');
      if (/border-radius:\s*50%/.test(body ?? '') || STROKED_GLYPHS.has(selector)) continue;
      enclosed.push(`${path.relative(sourceRoot, file)}: ${selector}`);
    }
  }
  for (const file of sourceFiles(sourceRoot).filter((name) => name.includes(`${path.sep}components${path.sep}ui${path.sep}`))) {
    const code = stripCodeComments(readFileSync(file, 'utf8'));
    for (const [, , literal] of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const tokens = (literal ?? '').trim().split(/\s+/).map((item) => item.split(':').at(-1) ?? '');
      if (!tokens.includes('border')) continue;
      if (tokens.includes('border-dashed') || tokens.includes('rounded-full') || tokens.includes('border-transparent')) continue;
      if (tokens.some((token) => /^border-(?:border|border-soft|hairline)$/.test(token)) || !tokens.some((token) => /^border-(?!0$)/.test(token))) {
        enclosed.push(`${path.relative(sourceRoot, file)}: ${literal}`);
      }
    }
  }
  assert.deepEqual(enclosed, []);
});
