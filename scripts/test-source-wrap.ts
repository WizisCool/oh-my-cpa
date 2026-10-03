import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSourceWrap } from '../web/src/components/config/sourceWrap.ts';

test('automatic wrapping follows the phone breakpoint', () => {
  assert.equal(resolveSourceWrap(true, null), 'on');
  assert.equal(resolveSourceWrap(false, null), 'off');
});

test('a manual source-session choice survives viewport changes', () => {
  for (const choice of ['on', 'off'] as const) {
    assert.equal(resolveSourceWrap(true, choice), choice);
    assert.equal(resolveSourceWrap(false, choice), choice);
  }
});
