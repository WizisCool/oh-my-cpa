import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '../acceptance/scenarios.mjs';
import { parseProbeOptions } from '../acceptance/probe-options.mjs';
import { assignShards, selectShard } from '../acceptance/probe-shards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');
export type ProbeOptions = { port: number; workers: number; ids: string[] };

export function runPlaywright(env: NodeJS.ProcessEnv) {
  return new Promise<number>((settle, reject) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', 'scripts/testing/probe-config.ts'], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit',
    });
    let isInterrupted = false;
    const interrupt = () => { isInterrupted = true; child.kill('SIGINT'); };
    const terminate = () => { isInterrupted = true; child.kill('SIGTERM'); };
    const release = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', error => { release(); reject(error); });
    child.once('close', code => { release(); settle(isInterrupted ? 130 : code ?? 1); });
  });
}

export function validateProbeEvidence(ids: string[], value: unknown) {
  if (!Array.isArray(value) || value.length !== ids.length) throw new Error('Probe timing evidence must include every selected scenario');
  const seen = new Set<string>();
  for (const record of value) {
    if (!record || typeof record.id !== 'string' || !ids.includes(record.id) || seen.has(record.id)
      || !Number.isFinite(record.durationMs) || record.durationMs < 0 || !['passed', 'failed'].includes(record.status)) {
      throw new Error('Invalid or duplicate probe timing evidence');
    }
    seen.add(record.id);
  }
  return value.every(record => record.status === 'passed');
}

export async function runProbeCatalog({ port, workers, ids }: ProbeOptions, execute = runPlaywright, artifactRoot = ROOT, now = () => performance.now()) {
  if (workers !== 1 && workers !== 2) throw new Error('Probe workers must be one or two');
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !SCENARIOS.some(scenario => scenario.id === id))) {
    throw new Error('Probe selection must contain known, unique scenario IDs');
  }
  const timingDirectory = join(artifactRoot, 'tmp/probe-timings');
  mkdirSync(timingDirectory, { recursive: true });
  rmSync(join(artifactRoot, 'tmp/probe-failure', String(port)), { force: true, recursive: true });
  writeFileSync(join(timingDirectory, `${port}.json`), '[]\n');
  let hasPassed = true;
  // Frame-by-frame claims need an uncontended browser. Separate native runs keep
  // those claims exclusive and still collect their verdict if a shared test failed.
  const batches = ids.length === SCENARIOS.length ? assignShards(ids, 3) : [ids];
  for (const [batch, batchIds] of batches.entries()) {
    const deadline = now() + 480_000;
    for (const phase of ['shared', 'exclusive']) {
      const selected = SCENARIOS.filter(scenario => batchIds.includes(scenario.id) && Boolean(scenario.shouldRunAlone) === (phase === 'exclusive'));
      if (!selected.length) continue;
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) {
        console.error(`Probe batch ${batch + 1} exhausted its 480-second deadline`);
        return false;
      }
      const code = await execute({
        OMC_PROBE_PORT: String(port), OMC_PROBE_WORKERS: String(workers),
        OMC_PROBE_BATCH: String(batch + 1), OMC_PROBE_BUDGET_MS: String(remaining), OMC_PROBE_PHASE: phase, OMC_PROBE_IDS: JSON.stringify(batchIds), OMC_PROBE_CATALOG: 'probes',
      });
      if (code !== 0) hasPassed = false;
      if (code > 1) return false;
    }
  }
  const hasPassedEvidence = validateProbeEvidence(ids, JSON.parse(readFileSync(join(timingDirectory, `${port}.json`), 'utf8')));
  return hasPassed && hasPassedEvidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, workers, shard }: { port: number; workers: number; shard?: { index: number; count: number } } = parseProbeOptions(process.argv.slice(2));
  const allIds = SCENARIOS.map(scenario => scenario.id);
  const ids = shard ? selectShard(allIds, shard) : allIds;
  console.log(`Running ${ids.length}/${SCENARIOS.length} probes with Playwright Test (${workers} workers, zero retries)`);
  if (!await runProbeCatalog({ port, workers, ids })) process.exitCode = 1;
}
