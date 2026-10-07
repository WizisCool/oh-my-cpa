import assert from 'node:assert/strict';

export const ARRIVAL_REQUEST_ID = 'fixture-future-arrival';

// Only fixture availability is controlled. Sorting, row IDs and the arrival count
// still come from the real API; after release even the response envelope is untouched.
export function withholdFixtureArrival(payload, limit, sinceID = 0) {
  const arrival = payload.items.filter(item => item.request_id === ARRIVAL_REQUEST_ID);
  assert.ok(arrival.length <= 1, 'Arrival fixture must be unique');
  if (!arrival.length) return payload;
  assert.equal(payload.has_more, false, 'Arrival fixture gate requires the complete small seeded page');
  const items = payload.items.filter(item => item.request_id !== ARRIVAL_REQUEST_ID);
  assert.ok(items.length <= limit, 'Arrival gate must not truncate ordinary records');
  const withheldCount = sinceID > 0 && arrival[0].id > sinceID ? 1 : 0;
  assert.ok(payload.arrived_count >= withheldCount, 'Backend arrival count must include the withheld fixture');
  return { ...payload, items, limit, arrived_count: payload.arrived_count - withheldCount };
}

export async function installArrivalFixture(context, appURL) {
  const endpoint = `${appURL}/api/v1/usage/events`;
  const matcher = url => url.origin === new URL(endpoint).origin && url.pathname === new URL(endpoint).pathname;
  let isReleased = false;
  let withheldReads = 0;
  const handler = async route => {
    if (isReleased || route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const payload = await response.json();
    if (!payload.items.some(item => item.request_id === ARRIVAL_REQUEST_ID)) return route.fulfill({ response });
    // Read one extra real record so removing the arrival never shrinks the 50-row
    // baseline. The seed is intentionally small; unexpected pagination fails here.
    url.searchParams.set('limit', String(payload.limit + 1));
    const expanded = await route.fetch({ url: url.href });
    assert.ok(expanded.ok(), 'Expanded real fixture read must succeed');
    const projected = withholdFixtureArrival(await expanded.json(), payload.limit, Number(url.searchParams.get('since') ?? 0));
    withheldReads += 1;
    await route.fulfill({ response: expanded, json: projected });
  };
  await context.route(matcher, handler);
  return {
    release() {
      assert.ok(withheldReads > 0, 'Initial real API reads must observe the withheld arrival');
      isReleased = true;
    },
    async dispose() { await context.unroute(matcher, handler); },
  };
}
