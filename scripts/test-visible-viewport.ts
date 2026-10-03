import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVisibleViewport } from '../web/src/types/visibleViewport.ts';

test('a keyboard resize and caret pan bound the usable workspace', () => {
  assert.deepEqual(resolveVisibleViewport(844, { height: 420, offsetTop: 40, scale: 1 }), { top: 40, height: 420, bottom: 384 });
  assert.deepEqual(resolveVisibleViewport(844, { height: 844, offsetTop: 0, scale: 1 }), { top: 0, height: 844, bottom: 0 });
});

test('pinch zoom and absent or invalid readings retain the layout viewport', () => {
  for (const reading of [undefined, null, { height: 422, offsetTop: 0, scale: 2 }, { height: 0, offsetTop: 0, scale: 1 }, { height: NaN, offsetTop: 0, scale: 1 }, { height: 420, offsetTop: NaN, scale: 1 }]) {
    assert.deepEqual(resolveVisibleViewport(844, reading), { top: 0, height: 844, bottom: 0 });
  }
});

test('browser overscroll never introduces negative top or bottom insets', () => {
  assert.deepEqual(resolveVisibleViewport(844, { height: 900, offsetTop: -5, scale: 1 }), { top: 0, height: 900, bottom: 0 });
});
