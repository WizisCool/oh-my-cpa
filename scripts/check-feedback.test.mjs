/** The feedback gate's rules that are not import boundaries. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { findSeparatorViolations, findViolations } from './check-feedback.mjs';

test('a middle dot that strings facts together is refused, in code, catalogs and styles alike', () => {
  assert.deepEqual(findSeparatorViolations("const line = `${size} \u00b7 ${lines}`;").map((violation) => violation.rule), ['middle-dot-separator']);
  assert.equal(findSeparatorViolations("  'events.page_loaded': 'Page {page} \u00b7 {n} records',").length, 1);
  assert.equal(findSeparatorViolations(".meta > * + *::before { content: '\u00b7'; }").length, 1);
  assert.equal(findSeparatorViolations('const line = `${size}, ${lines}`;').length, 0);
});

test('a line that parses data stored with the dot says so and passes', () => {
  assert.equal(findSeparatorViolations("label.split(' \u00b7 '); // separator-ok: parses a stored provider label").length, 0);
  // The escape spelling is how such a line is normally written; it carries no literal dot at all.
  assert.equal(findSeparatorViolations("export const SEPARATOR = ' \\u00b7 ';").length, 0);
});

test('a direct tooltip primitive import outside the shared wrappers is still refused', () => {
  const violations = findViolations("import { TooltipReadout } from '@/components/ui/tooltip';", 'web/src/pages/Example.tsx');
  assert.deepEqual(violations.map((violation) => violation.rule), ['shared-primitive-bypass']);
});
