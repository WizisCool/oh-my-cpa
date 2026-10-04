import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureTimeZone } from '../web/src/utils/time.ts';
import {
  CALENDAR_CELLS,
  buildMonthGrid,
  clampEndTime,
  draftFromWindow,
  effectiveEndDay,
  formatClockInput,
  isPickingEnd,
  pickDay,
  resolveDraft,
  shiftDay,
  shiftMonth,
  type RangeDraft,
} from '../web/src/components/common/timeRange/rangeDraft.ts';

const EMPTY: RangeDraft = { startTime: '00:00', endTime: '23:59', isOpenEnded: false };
const at = (iso: string) => Date.parse(iso);

test('a month grid is six weeks, starts on the requested weekday and contains the month once', () => {
  // October 2026 starts on a Thursday.
  const mondayFirst = buildMonthGrid('2026-10', 1);
  assert.equal(mondayFirst.length, CALENDAR_CELLS);
  assert.equal(mondayFirst[0], '2026-09-28');
  assert.equal(mondayFirst[3], '2026-10-01');
  assert.equal(buildMonthGrid('2026-10', 0)[0], '2026-09-27');
  assert.equal(mondayFirst.filter((day) => day.startsWith('2026-10')).length, 31);
  // A month that begins on the first weekday has no leading days at all.
  assert.equal(buildMonthGrid('2026-06', 1)[0], '2026-06-01');
});

test('day and month arithmetic crosses month, year and leap boundaries', () => {
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2028-03-01', -1), '2028-02-29');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('two presses make a range in either order, and a third starts a new one', () => {
  const first = pickDay(EMPTY, '2026-10-03');
  assert.equal(isPickingEnd(first), true);
  assert.deepEqual([first.startDay, first.endDay], ['2026-10-03', undefined]);
  const forward = pickDay(first, '2026-10-05');
  assert.deepEqual([forward.startDay, forward.endDay], ['2026-10-03', '2026-10-05']);
  const backward = pickDay(first, '2026-10-01');
  assert.deepEqual([backward.startDay, backward.endDay], ['2026-10-01', '2026-10-03']);
  const restarted = pickDay(forward, '2026-10-04');
  assert.deepEqual([restarted.startDay, restarted.endDay], ['2026-10-04', undefined]);
});

test('an open-ended draft only ever moves its start', () => {
  const draft = pickDay(pickDay({ ...EMPTY, isOpenEnded: true }, '2026-10-01'), '2026-10-03');
  assert.deepEqual([draft.startDay, draft.endDay], ['2026-10-03', undefined]);
  assert.equal(isPickingEnd(draft), false);
  assert.equal(effectiveEndDay(draft), undefined);
});

test('a day range runs through its last day, in the console zone', () => {
  configureTimeZone('Asia/Shanghai');
  const now = at('2026-10-10T00:00:00Z');
  const resolved = resolveDraft({ ...EMPTY, startDay: '2026-10-01', endDay: '2026-10-03' }, 'day', now);
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.from, at('2026-09-30T16:00:00.000Z'));
  assert.equal(resolved.to, at('2026-10-03T15:59:59.999Z'));
});

test('a single press is that one day, and an open end resolves to null', () => {
  configureTimeZone('UTC');
  const now = at('2026-10-10T00:00:00Z');
  const single = resolveDraft({ ...EMPTY, startDay: '2026-10-02' }, 'day', now);
  assert.deepEqual([single.from, single.to], [at('2026-10-02T00:00:00Z'), at('2026-10-02T23:59:59.999Z')]);
  const open = resolveDraft({ ...EMPTY, startDay: '2026-10-02', isOpenEnded: true }, 'day', now);
  assert.deepEqual([open.from, open.to, open.error], [at('2026-10-02T00:00:00Z'), null, undefined]);
});

test('a day keeps the offset in force on that date across a DST change', () => {
  configureTimeZone('America/New_York');
  // Clocks go back on 2026-11-01, so that civil day is 25 hours long.
  const resolved = resolveDraft({ ...EMPTY, startDay: '2026-11-01', endDay: '2026-11-01' }, 'day', at('2026-12-01T00:00:00Z'));
  assert.equal(resolved.from, at('2026-11-01T04:00:00Z'));
  assert.equal(resolved.to, at('2026-11-02T04:59:59.999Z'));
});

test('a minute range is inclusive of its last minute and never reaches past now', () => {
  configureTimeZone('UTC');
  const now = at('2026-10-04T09:20:30Z');
  const past = resolveDraft({ startDay: '2026-10-03', endDay: '2026-10-03', startTime: '14:05', endTime: '14:10', isOpenEnded: false }, 'minute', now);
  assert.deepEqual([past.from, past.to], [at('2026-10-03T14:05:00Z'), at('2026-10-03T14:10:59.999Z')]);
  // The current minute is in progress, so the window stops at now rather than at :59.
  const current = resolveDraft({ startDay: '2026-10-04', endDay: '2026-10-04', startTime: '09:00', endTime: '09:20', isOpenEnded: false }, 'minute', now);
  assert.equal(current.to, now);
  // One minute is a positive window, so equal ends are valid at this granularity.
  const oneMinute = resolveDraft({ startDay: '2026-10-03', startTime: '14:05', endTime: '14:05', isOpenEnded: false }, 'minute', now);
  assert.equal(oneMinute.error, undefined);
});

test('unfinished, reversed and future drafts are refused, each for its own reason', () => {
  configureTimeZone('UTC');
  const now = at('2026-10-04T09:20:30Z');
  assert.equal(resolveDraft(EMPTY, 'day', now).error, 'incomplete');
  assert.equal(resolveDraft({ ...EMPTY, startDay: '2026-10-03', startTime: '9' }, 'minute', now).error, 'incomplete');
  assert.equal(resolveDraft({ ...EMPTY, startDay: '2026-10-03', startTime: '24:00' }, 'minute', now).error, 'incomplete');
  assert.equal(
    resolveDraft({ startDay: '2026-10-03', endDay: '2026-10-03', startTime: '14:10', endTime: '14:05', isOpenEnded: false }, 'minute', now).error,
    'reversed',
  );
  assert.equal(resolveDraft({ ...EMPTY, startDay: '2026-10-05' }, 'day', now).error, 'future');
  assert.equal(
    resolveDraft({ startDay: '2026-10-04', endDay: '2026-10-04', startTime: '09:00', endTime: '09:21', isOpenEnded: false }, 'minute', now).error,
    'future',
  );
});

test('an end on today is clamped to the current minute, and only today', () => {
  configureTimeZone('UTC');
  const now = at('2026-10-04T09:20:30Z');
  assert.equal(clampEndTime({ ...EMPTY, startDay: '2026-10-03', endDay: '2026-10-04' }, now).endTime, '09:20');
  assert.equal(clampEndTime({ ...EMPTY, startDay: '2026-10-02', endDay: '2026-10-03' }, now).endTime, '23:59');
  assert.equal(clampEndTime({ ...EMPTY, startDay: '2026-10-04', endTime: '08:00' }, now).endTime, '08:00');
});

test('a committed window reopens as the draft that produced it', () => {
  configureTimeZone('Asia/Shanghai');
  const now = at('2026-10-10T00:00:00Z');
  const picked: RangeDraft = { startDay: '2026-10-01', endDay: '2026-10-03', startTime: '08:15', endTime: '21:40', isOpenEnded: false };
  const committed = resolveDraft(picked, 'minute', now);
  assert.deepEqual(draftFromWindow(committed), picked);
  const open = draftFromWindow({ from: committed.from, to: null });
  assert.deepEqual([open.startDay, open.endDay, open.isOpenEnded], ['2026-10-01', undefined, true]);
  assert.deepEqual(draftFromWindow({}), EMPTY);
});

test('typed digits become a clock without the reader placing the colon', () => {
  assert.equal(formatClockInput('1'), '1');
  assert.equal(formatClockInput('14'), '14');
  assert.equal(formatClockInput('140'), '14:0');
  assert.equal(formatClockInput('1405'), '14:05');
  assert.equal(formatClockInput('14:05'), '14:05');
  assert.equal(formatClockInput('14:0599x'), '14:05');
});
