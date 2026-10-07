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
 * Seconds per scenario, as measured by a full `verify:probes` run. Only the balance
 * depends on these: a stale or missing weight moves a scenario to another shard, it
 * never drops one. A weight for a scenario that no longer exists fails the self-test.
 */
export const PROBE_WEIGHTS = {
  'mobile-console': 47,
  agent: 11,
  'agent-question': 5,
  'agent-live': 5,
  'agent-views': 4,
  'agent-failure': 4,
  'agent-stream': 4,
  'agent-narrow': 4,
  playground: 12,
  'playground-narrow': 5,
  'omc-settings': 23,
  'column-alignment': 2,
  'oauth-management': 46,
  'icon-picker-stacking': 4,
  'provider-icon-pick': 4,
  'provider-model-picker': 5,
  'dashboard-charts': 3,
  'provider-rate-marks': 6,
  'dashboard-chart-motion': 9,
  'dashboard-rolling-readouts': 6,
  'dashboard-model-panels': 6,
  'dashboard-model-panels-states': 6,
  'dashboard-model-panels-failure': 2,
  'dashboard-model-panels-empty': 2,
  'dashboard-heatmap': 13,
  'dashboard-heatmap-pruned': 2,
  'dashboard-heatmap-mobile': 3,
  'dashboard-heatmap-error': 7,
  'refresh-sequencing': 5,
  'search-dev-server': 2,
  'overlay-back': 22,
  'touch-ergonomics': 16,
  'phone-lists': 10,
  'pricing-book': 6,
  'pricing-request-list': 2,
  'request-list-interactions': 4,
  'request-export': 5,
  'request-list-touch': 10,
  'scroll-smoothing': 30,
  'plugin-management': 4,
  'plugin-management-narrow': 3,
  'logs-sources': 2,
  'audit-trail': 1,
  'audit-trail-narrow': 1,
  'system-information': 38,
  'system-information-narrow': 1,
};

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
