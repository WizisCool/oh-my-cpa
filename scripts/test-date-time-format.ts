import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDateTimeFormatter, formatCalendarDay } from '../web/src/utils/dateTimeFormat.ts';
import dayjs, { configureTimeZone } from '../web/src/utils/time.ts';
import { createHeatmapCellClassifier, heatmapCellState, type DashboardTokenHeatmapDay } from '../web/src/types/tokenHeatmap.ts';
import { formatClock } from '../web/src/pages/agent/state.ts';

function createDay(day: string, requests = 1): DashboardTokenHeatmapDay {
  return { day, requests, tokens: 0, from_ms: 0, to_ms: 0, failures: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_creation: 0 };
}

test('formatter cache reuses equivalent options and separates locales, fields and zones', () => {
  const first = getDateTimeFormatter('en-US', { hour: '2-digit', timeZone: 'UTC' });
  assert.equal(getDateTimeFormatter('en-US', { timeZone: 'UTC', hour: '2-digit' }), first);
  assert.notEqual(getDateTimeFormatter('zh-CN', { hour: '2-digit', timeZone: 'UTC' }), first);
  assert.notEqual(getDateTimeFormatter('en-US', { minute: '2-digit', timeZone: 'UTC' }), first);
  assert.notEqual(getDateTimeFormatter('en-US', { hour: '2-digit', timeZone: 'Asia/Kathmandu' }), first);
  assert.throws(() => getDateTimeFormatter('en-US', { timeZone: 'Invalid/Zone' }), RangeError);
  assert.equal(getDateTimeFormatter('en-US', { hour: '2-digit', timeZone: 'UTC' }), first);
});

test('formatter retention is bounded across timezone choices', () => {
  const options = { year: 'numeric', timeZone: 'UTC' } as const;
  const first = getDateTimeFormatter('en-GB', options);
  const zones = (Intl as typeof Intl & { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone');
  for (const zone of zones.slice(0, 40)) getDateTimeFormatter('en-GB', { ...options, timeZone: zone });
  assert.notEqual(getDateTimeFormatter('en-GB', options), first, 'the oldest entry is evicted');
});

test('civil dates stay unchanged across browser zones and skipped midnights', () => {
  const originalZone = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Apia']) {
      process.env.TZ = zone;
      assert.equal(formatCalendarDay('2011-12-30', 'en-US', { year: 'numeric', month: 'short', day: 'numeric' }), 'Dec 30, 2011');
      assert.equal(formatCalendarDay('2026-03-08', 'en-US', { weekday: 'long' }), 'Sunday');
    }
  } finally {
    if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone;
  }
});

test('grid observation converts just two instants and keeps DST and non-UTC states', () => {
  const datePrototype = Object.getPrototypeOf(dayjs(0));
  const originalTz = datePrototype.tz;
  for (const zone of ['UTC', 'Asia/Kathmandu', 'America/New_York', 'America/Santiago']) {
    configureTimeZone(zone);
    const from = Date.parse('2026-03-08T04:30:00Z');
    const to = Date.parse('2026-03-09T03:30:00Z');
    const days = ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'].map((key) => createDay(key));
    const expected = days.map((day) => heatmapCellState(day, from, to));
    let conversions = 0;
    datePrototype.tz = function (...parameters) { conversions += 1; return originalTz.apply(this, parameters); };
    try {
      const classifyCell = createHeatmapCellClassifier(from, to);
      for (let i = 0; i < 100; i += 1) assert.deepEqual(days.map(classifyCell), expected);
      assert.equal(conversions, 2, 'the observation markers are independent of grid size');
      assert.equal(classifyCell(undefined), 'empty');
    } finally { datePrototype.tz = originalTz; }
  }
  const classifyCell = createHeatmapCellClassifier(null, null);
  assert.equal(classifyCell(createDay('2026-03-08', 0)), 'empty');
  assert.equal(classifyCell(createDay('2026-03-08')), 'measured');
  configureTimeZone('UTC');
});

test('Agent clock follows the effective zone and locale at each instant', () => {
  for (const zone of ['UTC', 'Asia/Kathmandu', 'America/New_York']) {
    configureTimeZone(zone);
    for (const instant of [Date.parse('2026-01-01T00:15:00Z'), Date.parse('2026-07-01T00:15:00Z')]) {
      assert.equal(formatClock(instant, 'en'), new Date(instant).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: zone }));
    }
  }
  configureTimeZone('UTC');
});
