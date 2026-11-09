/**
 * The entry document's pre-hydration paint.
 *
 * A phone discards a backgrounded tab's page, and the tab returns as a fresh navigation: while the
 * bundle downloads, the document stands on screen alone. It has to be painted in the mode this
 * browser last chose, or a resumed dark console flashes white. `web/index.html` therefore carries
 * the two shipped page grounds and a script that reads the stored theme before anything else loads.
 * This holds both to the theme module, so the document cannot drift into a copy of it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { BUILT_IN_PALETTES, getBuiltInPalette } from '../../src/theme/palette.ts';
import { migrateLegacyThemeValue, THEME_STORAGE_KEY } from '../../src/theme/themePreference.ts';

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
