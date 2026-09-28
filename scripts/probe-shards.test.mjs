/**
 * The probe shards must partition the catalog: a scenario in no shard would be a
 * green CI run that never exercised it, and one in two shards would be paid twice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCENARIOS } from './acceptance/scenarios.mjs';
import { PROBE_WEIGHTS, assignShards, parseShard, selectShard } from './acceptance/probe-shards.mjs';

const ids = SCENARIOS.map((scenario) => scenario.id);

test('every shard count partitions the whole catalog', () => {
  for (let count = 1; count <= 8; count += 1) {
    const shards = assignShards(ids, count);
    const flattened = shards.flat();
    assert.equal(flattened.length, ids.length, `${count} shards`);
    assert.deepEqual([...flattened].sort(), [...ids].sort(), `${count} shards`);
  }
});

test('a scenario without a measured weight still runs', () => {
  const withNew = [...ids, 'a-scenario-added-later'];
  assert.ok(assignShards(withNew, 3).flat().includes('a-scenario-added-later'));
});

test('shards keep registry order and are deterministic', () => {
  for (const shard of assignShards(ids, 3)) {
    assert.deepEqual(shard, ids.filter((id) => shard.includes(id)));
  }
  assert.deepEqual(selectShard(ids, { index: 2, count: 3 }), selectShard(ids, { index: 2, count: 3 }));
});

test('shards are balanced to within the heaviest scenario', () => {
  const weightOf = (id) => PROBE_WEIGHTS[id] ?? 5;
  const total = ids.reduce((sum, id) => sum + weightOf(id), 0);
  const heaviest = Math.max(...ids.map(weightOf));
  for (const count of [2, 3, 4]) {
    for (const shard of assignShards(ids, count)) {
      const load = shard.reduce((sum, id) => sum + weightOf(id), 0);
      assert.ok(load <= total / count + heaviest, `${count} shards: load ${load} of ${total}`);
    }
  }
});

test('every weight names a scenario that exists', () => {
  for (const id of Object.keys(PROBE_WEIGHTS)) assert.ok(ids.includes(id), `stale probe weight: ${id}`);
});

test('the shard flag rejects anything that could select nothing', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, count: 3 });
  for (const text of [undefined, '', '0/3', '4/3', '1/0', '1/9', 'one/two', '1/3/5']) {
    assert.throws(() => parseShard(text), undefined, String(text));
  }
});
