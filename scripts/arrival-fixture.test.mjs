import assert from 'node:assert/strict';
import test from 'node:test';
import { ARRIVAL_REQUEST_ID, installArrivalFixture, withholdFixtureArrival } from './acceptance/usage-events/arrival-fixture.mjs';

const ordinary = { id: 3, request_id: 'ordinary' };
const arrival = { id: 4, request_id: ARRIVAL_REQUEST_ID };
const payload = { items: [arrival, ordinary], limit: 2, has_more: false, next_cursor: '', arrived_count: 1, window: { end: 123 } };

test('availability preserves real rows and envelope, subtracting only a matching ingestion ID', () => {
  assert.deepEqual(withholdFixtureArrival(payload, 1, 3), { ...payload, items: [ordinary], limit: 1, arrived_count: 0 });
  assert.equal(withholdFixtureArrival(payload, 1, 4).arrived_count, 1);
  assert.equal(withholdFixtureArrival(payload, 1).arrived_count, 1);
  const filtered = { ...payload, items: [ordinary] };
  assert.equal(withholdFixtureArrival(filtered, 1, 3), filtered);
  assert.equal(payload.items.length, 2);
  assert.throws(() => withholdFixtureArrival({ ...payload, has_more: true }, 1), /complete small seeded page/);
  assert.throws(() => withholdFixtureArrival({ ...payload, arrived_count: 0 }, 1, 3), /Backend arrival count/);
  assert.throws(() => withholdFixtureArrival({ ...payload, items: [arrival, arrival] }, 1), /unique/);
});

test('gate expands actual reads, is exact-origin/path, and forwards released reads without synthesis', async () => {
  let matcher, handler, continued = 0;
  const context = {
    async route(match, handle) { matcher = match; handler = handle; },
    async unroute(match, handle) { assert.equal(match, matcher); assert.equal(handle, handler); },
  };
  const gate = await installArrivalFixture(context, 'http://127.0.0.1:1234/omc');
  assert.throws(() => gate.release(), /Initial real API reads/);
  assert.ok(matcher(new URL('http://127.0.0.1:1234/omc/api/v1/usage/events?limit=1')));
  assert.equal(matcher(new URL('http://elsewhere.test/omc/api/v1/usage/events')), false);
  assert.equal(matcher(new URL('http://127.0.0.1:1234/omc/api/v1/usage/events/export')), false);
  let fulfilled;
  const route = {
    request: () => ({ method: () => 'GET', url: () => 'http://127.0.0.1:1234/omc/api/v1/usage/events?limit=1&since=3&model=fixture' }),
    async fetch(options) {
      if (options) {
        const url = new URL(options.url);
        assert.equal(url.searchParams.get('limit'), '2');
        assert.equal(url.searchParams.get('model'), 'fixture');
        assert.equal(url.searchParams.get('since'), '3');
      }
      return { ok: () => true, json: async () => options ? payload : { ...payload, items: [arrival], limit: 1 } };
    },
    async fulfill(options) { fulfilled = options; },
    async continue() { continued += 1; },
  };
  await handler(route);
  assert.deepEqual(fulfilled.json.items, [ordinary]);
  assert.equal(fulfilled.json.arrived_count, 0);
  gate.release();
  fulfilled = undefined;
  await handler(route);
  assert.equal(continued, 1);
  assert.equal(fulfilled, undefined);
  await gate.dispose();
});
