import assert from 'node:assert/strict';
import { test } from 'vitest';
import { keepsSomething } from '../../src/motion/filterMove';

test('a change that keeps a key is the same list narrowing', () => {
  assert.equal(keepsSomething(['a', 'b', 'c'], ['b']), true);
  // Clearing a search widens the list; the rows that were drawn are still drawn.
  assert.equal(keepsSomething(['b'], ['a', 'b', 'c']), true);
  // A sort draws the same rows in another order.
  assert.equal(keepsSomething(['a', 'b'], ['b', 'a']), true);
});

test('a change that keeps nothing replaces the list', () => {
  // The next page, another provider's rows, another source's plugins.
  assert.equal(keepsSomething(['a', 'b'], ['c', 'd']), false);
  // A filter that matches nothing leaves no row to move from.
  assert.equal(keepsSomething(['a', 'b'], []), false);
  // The first read has nothing to have been narrowed from.
  assert.equal(keepsSomething([], ['a', 'b']), false);
  assert.equal(keepsSomething([], []), false);
});
