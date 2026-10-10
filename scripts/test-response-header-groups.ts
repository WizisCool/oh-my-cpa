import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  groupResponseHeaders,
  responseHeaderGroupOf,
  responseHeadersText,
} from '../web/src/types/responseHeaderGroups.ts';

test('response headers are grouped by what a diagnosis reads them for', () => {
  const cases: Array<[string, string]> = [
    ['x-request-id', 'identifiers'],
    ['request-id', 'identifiers'],
    ['cf-ray', 'identifiers'],
    ['x-amzn-requestid', 'identifiers'],
    // A limit that happens to contain "request" is still a limit.
    ['x-ratelimit-remaining-requests', 'limits'],
    ['anthropic-ratelimit-unified-reset', 'limits'],
    ['retry-after', 'limits'],
    ['x-codex-primary-used-percent', 'limits'],
    ['server', 'routing'],
    ['cf-cache-status', 'routing'],
    ['openai-processing-ms', 'routing'],
    ['x-envoy-upstream-service-time', 'routing'],
    ['x-something-unknown', 'other'],
  ];
  for (const [name, group] of cases) assert.equal(responseHeaderGroupOf(name), group, name);
  assert.equal(responseHeaderGroupOf('CF-Ray'), 'identifiers');
});

test('groups keep display order, drop empty groups and survive an absent snapshot', () => {
  const groups = groupResponseHeaders([
    { name: 'server', value: 'cloudflare' },
    { name: 'retry-after', value: '30' },
    { name: 'cf-ray', value: 'abc-NRT' },
    { name: 'x-request-id', value: 'req_1' },
  ]);
  assert.deepEqual(groups.map((group) => group.id), ['identifiers', 'limits', 'routing']);
  assert.deepEqual(groups[0].headers.map((header) => header.name), ['cf-ray', 'x-request-id']);
  assert.deepEqual(groupResponseHeaders(undefined), []);
  assert.equal(responseHeadersText(groups[0].headers), 'cf-ray: abc-NRT\nx-request-id: req_1');
});
