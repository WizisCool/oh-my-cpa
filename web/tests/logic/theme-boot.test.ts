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
import { getBuiltInPalette } from '../../src/theme/palette.ts';
import { THEME_STORAGE_KEY } from '../../src/theme/themePreference.ts';

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
  // The preset-only form, still held by a browser that has not loaded the console since.
  assert.equal(groundedMode('light'), 'light');
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
