import assert from 'node:assert/strict';
import { test } from 'node:test';
import dayjs, { configureTimeZone } from '../web/src/utils/time.ts';
import { formatRequestTimestamp } from '../web/src/components/usage/requestTimestamp.ts';

test('request timestamp labels preserve milliseconds, date rollovers and DST without a zoned date per row', () => {
  const datePrototype = Object.getPrototypeOf(dayjs(0));
  const originalTz = datePrototype.tz;
  const instants = [
    0, -1,
    Date.parse('2026-01-01T18:45:00.123Z'),
    Date.parse('2026-03-08T06:59:59.999Z'),
    Date.parse('2026-03-08T07:00:00Z'),
    Date.parse('2026-11-01T05:30:00Z'),
    Date.parse('2026-11-01T06:30:00Z'),
  ];
  try {
    for (const zone of ['UTC', 'Asia/Kathmandu', 'America/New_York', 'Pacific/Apia']) {
      configureTimeZone(zone);
      for (const timestamp of instants) {
        const expected = {
          shortTime: dayjs(timestamp).format('MM-DD HH:mm:ss'),
          fullTime: dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss.SSS'),
        };
        let conversions = 0;
        datePrototype.tz = function (...parameters) {
          conversions += 1;
          return originalTz.apply(this, parameters);
        };
        try {
          assert.deepEqual(formatRequestTimestamp(timestamp), expected, `${zone}: ${timestamp}`);
          assert.equal(conversions, 0, 'rows format through the shared zone formatter');
        } finally { datePrototype.tz = originalTz; }
      }
    }
  } finally { configureTimeZone('UTC'); }
});

test('request timestamp formatting reflects a changed display zone for the same instant', () => {
  const timestamp = Date.parse('2026-01-01T18:45:00.123Z');
  try {
    configureTimeZone('UTC');
    assert.deepEqual(formatRequestTimestamp(timestamp), { shortTime: '01-01 18:45:00', fullTime: '2026-01-01 18:45:00.123' });
    configureTimeZone('Asia/Kathmandu');
    assert.deepEqual(formatRequestTimestamp(timestamp), { shortTime: '01-02 00:30:00', fullTime: '2026-01-02 00:30:00.123' });
  } finally { configureTimeZone('UTC'); }
});
