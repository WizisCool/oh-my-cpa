/**
 * The header's star count: exact below a thousand, thousands with two decimals above.
 *
 * The boundary and the truncation are the decisions worth pinning. A rounded count
 * would show "2.00k" for a repository with 1,999 stars, which is a claim about a star
 * that does not exist.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStarCount } from '../web/src/utils/format.ts';

test('a count below a thousand is shown exactly', () => {
  assert.equal(formatStarCount(0), '0');
  assert.equal(formatStarCount(7), '7');
  assert.equal(formatStarCount(999), '999');
});

test('a thousand and above is shown in thousands with two decimals', () => {
  assert.equal(formatStarCount(1000), '1.00k');
  assert.equal(formatStarCount(1234), '1.23k');
  assert.equal(formatStarCount(12345), '12.34k');
  assert.equal(formatStarCount(123456), '123.45k');
});

test('the abbreviation truncates and never rounds up', () => {
  assert.equal(formatStarCount(1009), '1.00k');
  assert.equal(formatStarCount(1999), '1.99k');
  assert.equal(formatStarCount(9999), '9.99k');
});
