import assert from 'node:assert/strict';
import test from 'node:test';
import { clockOffset, observeServerClock, toBrowserTime } from '../web/src/types/serverClock.ts';

const HEADER = 'Thu, 08 Oct 2026 12:00:00 GMT';
const HEADER_MS = Date.parse(HEADER);

function responseWith(date: string | null): Response {
  return new Response(null, { headers: date === null ? {} : { date } });
}

test('clocks that agree within the header\'s own rounding are not corrected', () => {
  for (const drift of [-1500, -500, 0, 400, 1500]) assert.equal(clockOffset(HEADER, HEADER_MS + 500 - drift), 0, `drift ${drift}`);
});

test('a server ahead of or behind the browser is measured from the middle of its second', () => {
  assert.equal(clockOffset(HEADER, HEADER_MS - 90_000), 90_500);
  assert.equal(clockOffset(HEADER, HEADER_MS + 60_000), -59_500);
});

test('a response without a readable date is no reading at all', () => {
  assert.equal(clockOffset(null, HEADER_MS), undefined);
  assert.equal(clockOffset('not a date', HEADER_MS), undefined);
});

test('the last readable offset stands until another response carries a date', () => {
  observeServerClock(responseWith(HEADER), HEADER_MS - 90_000);
  const corrected = toBrowserTime(HEADER_MS);
  observeServerClock(responseWith(null), HEADER_MS + 3_600_000);
  observeServerClock(responseWith('not a date'), HEADER_MS + 7_200_000);
  assert.equal(toBrowserTime(HEADER_MS), corrected);
});
