/**
 * The focused browser probes, as the release gate's entry point.
 *
 * Each of these used to be a standalone script with its own Vite server and its own
 * Chromium, and three of them sat outside `pnpm verify:full` entirely: the
 * icon-picker stacking, the column geometry and the dashboard chart marks were only
 * run if someone remembered the command. A probe that guards a real invariant but
 * never runs in the gate is a comment with a `pnpm` script attached.
 *
 * Each batch now shares one server and one browser through `acceptance/probe.mjs`, and the
 * scenarios themselves live in `acceptance/scenarios.mjs` as data. That split is
 * what lets `pnpm check:ui` run the relevant subset against the dev server during
 * development without this file's release-gate framing getting in the way.
 *
 * Run it with `pnpm verify:probes`; it is also part of `pnpm verify:full`. CI runs
 * it as `pnpm verify:probes --shard i/n`, one disjoint, weight-balanced part of the
 * catalog per job (see `acceptance/probe-shards.mjs`). Complete local catalogs execute those
 * partitions sequentially, keeping the same watchdog and retaining every scenario verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProbeChecker } from './acceptance/probe.mjs';
import { runProbeBatches } from './acceptance/probe-batches.mjs';
import { SCENARIOS } from './acceptance/scenarios.mjs';
import { parseShard, selectShard } from './acceptance/probe-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The dev server port is pinned and `strictPort` is on, so a collision fails loudly
// instead of silently binding elsewhere and testing an unrelated app.
const PORT = 5180;

const { check, failures } = createProbeChecker();

// Every scenario, or one shard of them, in registry order. The registry supplies the
// fixtures and the assertions; this file supplies the runner's reporting, so a scenario
// does not have to know whether it is being run by the release gate or by the fast path.
const shardFlag = process.argv.indexOf('--shard');
const shard = shardFlag >= 0 ? parseShard(process.argv[shardFlag + 1]) : undefined;
const shardIds = shard ? new Set(selectShard(SCENARIOS.map((scenario) => scenario.id), shard)) : undefined;
const scenarios = SCENARIOS
  .filter((scenario) => !shardIds || shardIds.has(scenario.id))
  .map((scenario) => ({ ...scenario, check }));
if (shard) {
  console.log(`probe shard ${shard.index}/${shard.count}: ${scenarios.map((scenario) => scenario.id).join(', ')}\n`);
}

const FAILURE_DIR = path.join(root, 'tmp', 'probe-failure');
const startedAt = Date.now();
const { passed, failures: runFailures } = await runProbeBatches({ port: PORT, scenarios, batchCount: shard ? 1 : 3 });

// A scenario that threw rather than asserted is reported through the same channel as
// a failed check, so the exit code reflects it either way.
for (const failure of runFailures) check(`scenario ${failure} completed`, false);

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`\n${failures.length} probe check(s) failed across ${passed}/${scenarios.length} scenario(s) in ${seconds}s.`);
  if (fs.existsSync(FAILURE_DIR)) {
    console.error(`Diagnostics (screenshot, DOM, page errors) are in ${path.relative(root, FAILURE_DIR)}.`);
  }
  process.exit(1);
}
console.log(`\nprobe run complete: ${scenarios.length} scenario(s) passed in ${seconds}s.`);
