import { parseLogLine } from '../web/src/types/logs.ts';
import assert from 'node:assert/strict';
import dayjs, { configureTimeZone, formatGatewayTimestamp, getTimeZone, parseTimeZone, formatTimeZoneOffset, timeZoneOptions } from '../web/src/utils/time.ts';
import { dayKey } from '../web/src/types/audit.ts';
import { localDayOf } from '../web/src/types/tokenHeatmap.ts';
import { formatGmtOffsetLabel, formatShortDateTime } from '../web/src/pages/quota/quotaFormat.ts';

const instant = Date.parse('2026-01-01T18:45:00Z');
configureTimeZone('', 'Asia/Kathmandu');
assert.equal(getTimeZone(), 'Asia/Kathmandu');
assert.equal(dayjs(instant).format('YYYY-MM-DD HH:mm Z'), '2026-01-02 00:30 +05:45');
assert.equal(dayKey(instant), '2026-01-02');
assert.equal(localDayOf(instant), '2026-01-02');
assert.equal(formatShortDateTime(instant), '01/02 00:30');
assert.equal(formatGmtOffsetLabel(new Date(instant)), 'GMT+5:45');
assert.equal(dayjs(instant).valueOf(), instant);
assert.equal(dayjs.unix(instant / 1000).valueOf(), instant);
configureTimeZone('America/New_York', 'Asia/Shanghai');
assert.equal(dayjs(instant).format('HH:mm Z'), '13:45 -05:00');
assert.equal(formatGatewayTimestamp('2026-01-02 02:45:00'), '2026-01-01 13:45:00');
assert.equal(formatGatewayTimestamp('2026-01-01T18:45:00Z'), '2026-01-01 13:45:00');
assert.equal(formatGatewayTimestamp('not a timestamp'), 'not a timestamp');
assert.equal(dayjs('2026-03-08').endOf('day').valueOf() - dayjs('2026-03-08').startOf('day').valueOf() + 1, 23 * 3600000);
assert.equal(dayjs('2026-11-01').endOf('day').valueOf() - dayjs('2026-11-01').startOf('day').valueOf() + 1, 25 * 3600000);
assert.equal(dayjs('15:30', 'HH:mm').format('HH:mm'), '15:30');
assert.equal(parseTimeZone('Invalid/Timezone'), undefined);
assert.throws(() => configureTimeZone('Invalid/Timezone'));
assert.equal(getTimeZone(), 'America/New_York');
configureTimeZone('', 'UTC');
assert.equal(getTimeZone(), 'UTC');
console.log('timezone: passed');

assert.equal(formatTimeZoneOffset('Asia/Kuala_Lumpur', instant), 'UTC+8');
assert.equal(formatTimeZoneOffset('Asia/Kathmandu', instant), 'UTC+5:45');
assert.equal(formatTimeZoneOffset('America/New_York', instant), 'UTC-5');
assert.equal(formatTimeZoneOffset('America/New_York', Date.parse('2026-07-01T00:00:00Z')), 'UTC-4');
const options = timeZoneOptions('Asia/Kuala_Lumpur', '', '服务器时区', instant);
assert.equal(options[0].value, 'Asia/Kuala_Lumpur');
assert.equal(options[0].label, 'Asia/Kuala_Lumpur (UTC+8) (服务器时区)');
assert.equal(options.filter((option) => option.value === 'Asia/Kuala_Lumpur').length, 1);
assert.ok(options.every((option) => option.label.includes('(UTC')));

const unsupportedZone = 'Invalid/Timezone';
assert.equal(formatTimeZoneOffset(unsupportedZone, instant), '', 'an unreadable offset is unknown, not UTC');
const unsupportedOptions = timeZoneOptions('UTC', unsupportedZone, 'Console time zone', instant);
assert.deepEqual(unsupportedOptions.find((option) => option.value === unsupportedZone), {
  value: unsupportedZone,
  label: unsupportedZone,
  offset: '',
  searchText: 'invalid/timezone',
}, 'a stored zone remains selectable with its original value and no fabricated offset');
assert.equal(unsupportedOptions.filter((option) => option.value === unsupportedZone).length, 1);
assert.equal(unsupportedOptions.find((option) => option.value === 'UTC')?.offset, 'UTC+0');
const unsupportedServerOptions = timeZoneOptions(unsupportedZone, unsupportedZone, 'Server time zone', instant);
assert.equal(unsupportedServerOptions[0].label, `${unsupportedZone} (Server time zone)`);
assert.equal(unsupportedServerOptions.filter((option) => option.value === unsupportedZone).length, 1);

const originalFormatter = Intl.DateTimeFormat;
let formatterCalls = 0;
const unsupportedBrowserZone = 'Asia/Manila';
Intl.DateTimeFormat = new Proxy(originalFormatter, {
  construct(target, argumentsList) {
    formatterCalls += 1;
    if (argumentsList[1]?.timeZone === unsupportedBrowserZone) {
      throw new RangeError('The browser does not support this stored zone');
    }
    return Reflect.construct(target, argumentsList);
  },
});
try {
  const nextMinute = instant + 60000;
  const first = timeZoneOptions('Asia/Kuala_Lumpur', '', 'Server time zone', nextMinute);
  assert.ok(formatterCalls > 100);
  assert.equal(first.find((option) => option.value === unsupportedBrowserZone)?.offset, '');
  formatterCalls = 0;
  const second = timeZoneOptions('Asia/Kuala_Lumpur', unsupportedBrowserZone, 'Server time zone', nextMinute);
  assert.equal(formatterCalls, 0, 'reopening or changing selection reuses cached offsets, including unreadable zones');
  assert.equal(second.find((option) => option.value === unsupportedBrowserZone)?.label, unsupportedBrowserZone);
  assert.equal(second.find((option) => option.value === 'America/New_York')?.offset, 'UTC-5');
  assert.equal(first[0].label, second[0].label);
} finally { Intl.DateTimeFormat = originalFormatter; }

const isoLog = '2026-01-01T18:45:00Z INFO request complete';
assert.equal(parseLogLine(isoLog).timestamp, '2026-01-01T18:45:00Z');
assert.equal(parseLogLine(isoLog).raw, isoLog);
const offsetLog = '[2026-01-02 02:45:00+08:00] [req] [INFO] [app] complete';
assert.equal(parseLogLine(offsetLog).timestamp, '2026-01-02 02:45:00+08:00');
