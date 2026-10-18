/**
 * The live routing panel's model: how a rolling minute of request records, one
 * per attempt, becomes models, credentials, lanes and routes, which arrivals the
 * map replays, and how rows enter and leave.
 *
 * The server's half (which records are inside the minute, what `after` returns,
 * which cooldowns are still running) is pinned in
 * `internal/api/usage_routing_test.go`; this pins what the panel draws from it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_DRAWN_MODELS,
  MAX_DRAWN_TARGETS,
  ROUTE_SLOTS,
  allocateSlots,
  arrivedRoutes,
  routesFinishedSince,
  buildRoutingModel,
  finishedAt,
  groupRoutes,
  liveRecords,
  mergeRoutingRecords,
  newestRecordIdOf,
  pruneRoutingRecords,
  reconcilePresence,
  type Presence,
} from '../web/src/types/usageRouting.ts';
import type { UsageEvent } from '../web/src/types/usageEvents.ts';

const NOW = 1_000_000;
const MINUTE = 60_000;

function event(id: number, fields: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id,
    timestamp_ms: NOW - 10_000 + id,
    provider: 'codex',
    model: 'gpt-5',
    failed: false,
    latency_ms: 100,
    auth_index: 'auth-1',
    ...fields,
  } as UsageEvent;
}

test('an attempt belongs to the minute it finished in, however long ago it started', () => {
  const long = event(1, { timestamp_ms: NOW - 3 * MINUTE, latency_ms: 2.5 * MINUTE });
  const old = event(2, { timestamp_ms: NOW - 2 * MINUTE, latency_ms: 1_000 });
  assert.equal(finishedAt(long), NOW - 0.5 * MINUTE);
  const records = new Map([[1, long], [2, old]]);
  assert.deepEqual(liveRecords(records, NOW, MINUTE).map((record) => record.id), [1]);
  assert.deepEqual([...pruneRoutingRecords(records, NOW, MINUTE).keys()], [1]);
});

test('a full read replaces the window; an incremental read adds to it', () => {
  const held = mergeRoutingRecords(undefined, [event(2), event(1)], false);
  assert.deepEqual([...held.keys()].sort(), [1, 2]);
  const added = mergeRoutingRecords(held, [event(3)], true);
  assert.deepEqual([...added.keys()].sort(), [1, 2, 3]);
  assert.equal(newestRecordIdOf(added), 3);
  const replaced = mergeRoutingRecords(added, [event(4)], false);
  assert.deepEqual([...replaced.keys()], [4]);
  assert.equal(newestRecordIdOf(new Map()), undefined);
});

test('attempts sharing a request id are one request, in the order CPA made them', () => {
  const routes = groupRoutes([
    event(3, { request_id: 'req-a', auth_index: 'auth-2' }),
    event(2, { request_id: 'req-a', failed: true, fail_status_code: 429 }),
    event(1),
  ]);
  assert.equal(routes.length, 2);
  const [rerouted, single] = routes;
  assert.deepEqual(rerouted.attempts.map((attempt) => attempt.targetId), ['auth:auth-1', 'auth:auth-2']);
  assert.equal(rerouted.isRerouted, true);
  assert.equal(rerouted.isFailed, false, 'a request CPA recovered by rerouting is not an error the caller saw');
  assert.equal(single.isRerouted, false);
});

test('the left column is the model a caller named, and the right the credential that answered', () => {
  const model = buildRoutingModel([
    event(4, { model: 'claude-sonnet-5', provider: 'claude', auth_index: 'auth-c' }),
    event(3, { model_alias: 'fast', model: 'gpt-5-mini' }),
    event(2, { request_id: 'req-r', auth_index: '', provider: 'openai-compat' }),
    event(1, { request_id: 'req-r', failed: true }),
  ], [], NOW);
  assert.deepEqual(model.models.map((row) => row.name), ['claude-sonnet-5', 'fast', 'gpt-5']);
  assert.deepEqual(model.models.map((row) => row.requests), [1, 1, 1]);
  assert.deepEqual(model.targets.map((target) => target.id).sort(), ['auth:auth-1', 'auth:auth-c', 'provider:openai-compat']);
  assert.equal(model.attempts, 4, 'the rerouted request counts once per model and once per attempt');
  const gpt = model.routes.filter((route) => route.modelId === 'model:gpt-5');
  assert.deepEqual(gpt.flatMap((route) => route.attempts.map((attempt) => attempt.targetId)), ['auth:auth-1', 'provider:openai-compat']);
});

test('rows keep their order by name while volume decides only which are drawn', () => {
  const records: UsageEvent[] = [];
  let id = 0;
  for (let index = 0; index <= MAX_DRAWN_MODELS; index++) {
    // model-0 is called once, model-7 eight times: the least called one is folded away.
    for (let call = 0; call <= index; call++) records.push(event(++id, { model: `model-${index}` }));
  }
  const model = buildRoutingModel(records, [], NOW);
  assert.equal(model.models.length, MAX_DRAWN_MODELS);
  assert.equal(model.hiddenModels, 1);
  assert.ok(!model.models.some((row) => row.name === 'model-0'));
  assert.deepEqual(model.models.map((row) => row.name), [...model.models.map((row) => row.name)].sort());
});

test('a resting credential is always drawn, and its cooldown ends on the clock', () => {
  const records: UsageEvent[] = [];
  for (let index = 0; index <= MAX_DRAWN_TARGETS; index++) {
    records.push(event(index * 2 + 1, { auth_index: `busy-${index}` }), event(index * 2 + 2, { auth_index: `busy-${index}` }));
  }
  records.push(event(100, { auth_index: 'resting', failed: true, fail_status_code: 429 }));
  const cooldown = { auth_index: 'resting', provider: 'codex', status_code: 429, quota_exceeded: false, until_at_ms: NOW + 5_000 };
  const resting = buildRoutingModel(records, [cooldown], NOW).targets.find((target) => target.id === 'auth:resting');
  assert.equal(resting?.cooldown?.until_at_ms, NOW + 5_000);
  const later = buildRoutingModel(records, [cooldown], NOW + 6_000);
  assert.equal(later.targets.find((target) => target.id === 'auth:resting')?.cooldown, undefined);
});

test('a model keeps its colour while it stays, and a newcomer takes a free one', () => {
  const first = allocateSlots(new Map(), ['model:a', 'model:b']);
  assert.notEqual(first.get('model:a'), first.get('model:b'));
  const next = allocateSlots(first, ['model:b', 'model:c']);
  assert.equal(next.get('model:b'), first.get('model:b'));
  assert.notEqual(next.get('model:c'), next.get('model:b'));
  assert.equal(next.has('model:a'), false);
  const many = allocateSlots(new Map(), Array.from({ length: ROUTE_SLOTS }, (_, index) => `model:${index}`));
  assert.equal(new Set(many.values()).size, ROUTE_SLOTS, 'six drawn models never share a lane colour');
});

test('only requests past the newest one already seen replay, oldest first, and never on opening', () => {
  const routes = groupRoutes([event(5, { request_id: 'b' }), event(4, { request_id: 'b' }), event(3, { request_id: 'a' }), event(1)]);
  assert.deepEqual(arrivedRoutes(routes, undefined), []);
  assert.deepEqual(arrivedRoutes(routes, 3).map((route) => route.key), ['req:b']);
  assert.deepEqual(arrivedRoutes(routes, 0).map((route) => route.lastId), [1, 3, 5]);
});

test('a request that finished while the page was hidden does not replay on return', () => {
  // Finished at NOW - 10_000 + id + 100: the return at NOW - 9_850 falls between the two requests.
  const routes = groupRoutes([event(60, { request_id: 'after' }), event(40, { request_id: 'away' })]);
  const shownAt = NOW - 10_000 + 150;
  assert.deepEqual(routesFinishedSince(routes, shownAt).map((route) => route.key), ['req:after']);
  // A retry that ends after the return is a request the reader sees finish, so it plays.
  const retried = groupRoutes([event(70, { request_id: 'retry' }), event(30, { request_id: 'retry', failed: true })]);
  assert.deepEqual(routesFinishedSince(retried, shownAt).map((route) => route.key), ['req:retry']);
  assert.deepEqual(routesFinishedSince(routes, Infinity), [], 'nothing replays while the page is hidden');
});

test('a row that left the window exits from where it was, and one that returns is simply present', () => {
  const keyOf = (item: string) => item;
  const start: Presence<string>[] = ['a', 'b', 'c'].map((key) => ({ key, item: key, phase: 'present' }));
  const next = reconcilePresence(start, ['a', 'c', 'd'], keyOf);
  assert.deepEqual(next.map((entry) => `${entry.key}:${entry.phase}`), ['a:present', 'b:exiting', 'c:present', 'd:entering']);
  const back = reconcilePresence(next, ['a', 'b', 'c', 'd'], keyOf);
  assert.deepEqual(back.map((entry) => `${entry.key}:${entry.phase}`), ['a:present', 'b:present', 'c:present', 'd:present']);
  const first = reconcilePresence(start, ['b', 'c'], keyOf);
  assert.deepEqual(first.map((entry) => `${entry.key}:${entry.phase}`), ['a:exiting', 'b:present', 'c:present']);
});
