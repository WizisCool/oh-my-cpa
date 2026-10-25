import assert from 'node:assert/strict';
import { formatMessage, messagePlaceholders } from '../web/src/i18n/format.ts';

// Plain placeholders are filled as given; one the caller did not pass stays visible.
assert.equal(formatMessage('Page {page} of {total}', { page: 2, total: 9 }, 'en'), 'Page 2 of 9');
assert.equal(formatMessage('Hello {name}', {}, 'en'), 'Hello {name}');
assert.equal(formatMessage('{ "json": 1 }', { json: 'x' }, 'en'), '{ "json": 1 }');

// The plural form follows the reading language's rules and groups the count it prints.
const requests = '{n, plural, one {# request} other {# requests}} in {zone}';
assert.equal(formatMessage(requests, { n: 1, zone: 'UTC' }, 'en'), '1 request in UTC');
assert.equal(formatMessage(requests, { n: 0, zone: 'UTC' }, 'en'), '0 requests in UTC');
assert.equal(formatMessage(requests, { n: 1234, zone: 'UTC' }, 'en'), '1,234 requests in UTC');
// A caller that pre-formatted the count keeps its text; the branch still follows the value.
assert.equal(formatMessage(requests, { n: '1', zone: 'UTC' }, 'en'), '1 request in UTC');
assert.equal(formatMessage(requests, { n: '1.2M', zone: 'UTC' }, 'en'), '1.2M requests in UTC');
// A language with no `one` category reads `other`.
assert.equal(formatMessage('{n, plural, other {# 次请求}}', { n: 1 }, 'zh-CN'), '1 次请求');
assert.equal(formatMessage('{n, plural, =0 {none} other {# left}}', { n: 0 }, 'en'), 'none');

// Placeholders are compared as a set, including the ones a plural branch reads.
assert.deepEqual(messagePlaceholders('{b} {a, plural, one {# x {c}} other {# xs}}'), ['a', 'b', 'c']);
assert.deepEqual(messagePlaceholders('{ "json": 1 }'), []);
