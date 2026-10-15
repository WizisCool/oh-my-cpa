/**
 * Logic-level tests for the console's typeface roles.
 *
 * What is decided without a DOM is asserted here: which stored documents are accepted, what is
 * written back, and the `font-family` value each reference resolves to. That a chosen family
 * actually paints the console is the `font-library` browser probe's claim; that the server
 * refuses a reference to a family it does not hold is `internal/api/fonts_test.go`'s.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_FONT_ROLES,
  SARASA_STACK,
  cssWeight,
  fontStackFor,
  libraryFamilyName,
  parseFontRoles,
  serializeFontRoles,
  type InstalledFont,
} from '../web/src/types/fonts.ts';

const id = '0123456789abcdef0123456789abcdef';
const font: InstalledFont = { id, family: 'Inter', source: 'google', created_at_ms: 0, byte_size: 1, faces: [] };

// One unusable role costs only itself; a document that is not an object is no document.
assert.deepEqual(parseFontRoles({ ui: `font:${id}`, mono: 'https://example.com/x.woff2' }), { ui: `font:${id}`, mono: DEFAULT_FONT_ROLES.mono });
assert.equal(parseFontRoles(['builtin:system-sans']), undefined);
assert.equal(parseFontRoles(null), undefined);

// A role at its default is not stored, which is the same shape the server's delete cascade leaves.
assert.deepEqual(serializeFontRoles({ ui: 'builtin:system-sans', mono: DEFAULT_FONT_ROLES.mono }), { ui: 'builtin:system-sans' });

// A library family is declared under its id, never its own name, and falls back to the bundled face.
assert.equal(fontStackFor(`font:${id}`, [font]), `"${libraryFamilyName(id)}", ${SARASA_STACK}`);
assert.ok(!fontStackFor(`font:${id}`, [font]).includes('Inter'));
// A family deleted elsewhere resolves to the default rather than to a name nothing declares;
// an unknown library (the first frame) trusts the reference.
assert.equal(fontStackFor(`font:${id}`, []), SARASA_STACK);
assert.ok(fontStackFor(`font:${id}`, undefined).startsWith(`"${libraryFamilyName(id)}"`));
assert.ok(fontStackFor('builtin:system-sans', undefined).startsWith('system-ui'));
assert.equal(fontStackFor('builtin:retired', undefined), SARASA_STACK);

assert.equal(cssWeight({ weight_min: 400, weight_max: 400 }), '400');
assert.equal(cssWeight({ weight_min: 100, weight_max: 900 }), '100 900');

console.log('fonts: ok');
