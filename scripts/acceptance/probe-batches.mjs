import { runProbes } from './probe.mjs';
import { assignShards } from './probe-shards.mjs';

/** Keep complete local catalogs bounded without changing the watchdog or overlapping separate browsers. */
export async function runProbeBatches({ batchCount = 1, scenarios, ...options }, execute = runProbes) {
  const ids = scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) throw new Error('Probe batches require unique scenario IDs');
  const batches = batchCount === 1
    ? [scenarios]
    : assignShards(ids, batchCount).map((batch) => scenarios.filter((scenario) => batch.includes(scenario.id)))
      .filter((batch) => batch.length > 0);
  let passed = 0;
  const failures = [];
  for (const [index, batch] of batches.entries()) {
    if (batch.length === 0) continue;
    if (batches.length > 1) console.log(`Probe batch ${index + 1}/${batches.length}: ${batch.length} scenario(s)`);
    const result = await execute({ ...options, scenarios: batch, shouldResetDiagnostics: index === 0 });
    passed += result.passed;
    failures.push(...result.failures);
  }
  return { passed, failures };
}
