/**
 * Splits the probe catalog into balanced, disjoint shards.
 *
 * Each catalog partition runs serially in one browser, so its wall clock is the sum of its
 * scenarios, dominated by a handful of long ones. CI runs each
 * shard as its own job on its own runner, which keeps the scenarios' timing-sensitive
 * assertions free of the CPU contention that running them side by side in one
 * process would add.
 *
 * The split is longest-first onto the lightest shard, from measured weights. It is
 * deterministic, so a failure names the same shard on a rerun, and it is a partition:
 * every scenario runs in exactly one shard, including one added without a weight.
 */

/**
 * Historical scenario medians and provisional split weights are recorded with their
 * provenance in the snapshot. They affect balance only: stale or missing weights
 * never drop a scenario. A weight for a retired scenario fails the self-test.
 */
import snapshot from './probe-weights.json' with { type: 'json' };
export const PROBE_WEIGHTS = snapshot.weights;

/** What an unmeasured scenario is assumed to cost: about the catalog's median. */
const DEFAULT_WEIGHT = 5;

/** More shards than this would pay more in runner setup than the catalog saves. */
const MAX_SHARDS = 8;

/** Parses `i/n` (1-based), rejecting anything that could select nothing. */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(text ?? '');
  if (!match) throw new Error(`--shard expects i/n, got ${JSON.stringify(text)}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || count > MAX_SHARDS || index < 1 || index > count) {
    throw new Error(`--shard ${text} is out of range (1 <= i <= n <= ${MAX_SHARDS})`);
  }
  return { index, count };
}

/**
 * Assigns every id to one of `count` shards. Each shard keeps registry order, so a
 * shard runs its scenarios in the same relative order as the full catalog.
 */
export function assignShards(ids, count, weights = PROBE_WEIGHTS) {
  const weightOf = (id) => weights[id] ?? DEFAULT_WEIGHT;
  const loads = Array.from({ length: count }, () => 0);
  const shardOf = new Map();
  const byWeight = [...ids].sort((left, right) => weightOf(right) - weightOf(left) || left.localeCompare(right));
  for (const id of byWeight) {
    let lightest = 0;
    for (let shard = 1; shard < count; shard += 1) {
      if (loads[shard] < loads[lightest]) lightest = shard;
    }
    loads[lightest] += weightOf(id);
    shardOf.set(id, lightest);
  }
  return Array.from({ length: count }, (_, shard) => ids.filter((id) => shardOf.get(id) === shard));
}

/** The ids one shard runs. */
export function selectShard(ids, { index, count }, weights = PROBE_WEIGHTS) {
  return assignShards(ids, count, weights)[index - 1];
}
