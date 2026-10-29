import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter';
import { SCENARIOS } from '../acceptance/scenarios.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');
export type ProbeOptions = { port?: number; workers: number; ids: string[]; shard?: string };

function runPlaywright(env: NodeJS.ProcessEnv, args: string[], shouldCapture = false) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((settle, reject) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', 'scripts/testing/probe-config.ts', ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); if (!shouldCapture) process.stdout.write(chunk); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); process.stderr.write(chunk); });
    let interruptedCode: number | undefined;
    const forward = (code: number) => () => {
      interruptedCode = code;
      // Playwright's SIGINT handler owns fixture and webServer teardown. SIGTERM
      // would terminate the CLI before it could stop its separate server group.
      child.kill('SIGINT');
    };
    const onInterrupt = forward(130);
    const onTerminate = forward(143);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const release = () => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    child.once('error', error => { release(); reject(error); });
    child.once('close', code => { release(); settle({ code: interruptedCode ?? code ?? 1, stdout, stderr }); });
  });
}

function discoveredScenarios(suites: JSONReportSuite[]): string[] {
  return suites.flatMap(suite => [
    ...suite.specs.flatMap(spec => spec.tests.flatMap(test => test.annotations
      .filter(annotation => annotation.type === 'scenario').map(annotation => annotation.description ?? ''))),
    ...discoveredScenarios(suite.suites ?? []),
  ]);
}

export async function runProbeCatalog({ port = 0, workers, ids, shard }: ProbeOptions) {
  // The programmatic and CLI paths enforce the same bounds.
  parseProbeArguments(['--port', String(port), '--workers', String(workers), ...(shard ? ['--shard', shard] : [])]);
  const unknown = ids.filter(id => !SCENARIOS.some(scenario => scenario.id === id));
  if (unknown.length) throw new Error(`Unknown probe scenarios: ${unknown.join(', ')}`);
  if (!ids.length) { console.log('No probe scenarios selected. Nothing to check.'); return true; }
  const runId = randomUUID();
  const outputDir = resolve(ROOT, 'tmp/probe-failure', runId);
  const cacheDir = resolve(ROOT, 'web/node_modules/.vite-probes', runId);
  const env = { OMC_PROBE_RUN_ID: runId, OMC_PROBE_CACHE_DIR: cacheDir, OMC_PROBE_PORT: String(port), OMC_PROBE_WORKERS: String(workers), OMC_PROBE_BASE_URL: '' };
  console.log(`Probe artifacts: ${outputDir}`);
  await mkdir(outputDir, { recursive: true });
  const phases: { phase: string; ids: string[]; code: number; hasTests?: boolean }[] = [];
  let hasPassed = false;
  try {
    // Native sharding permits empty suites. First validate unsharded discovery,
    // so an empty shard is legitimate but a missing catalog/spec never is.
    const discovery = await runPlaywright({ ...env, OMC_PROBE_IDS: JSON.stringify(ids) }, ['--list', '--reporter=json'], true);
    await writeFile(resolve(outputDir, 'discovery.json'), discovery.stdout);
    if (discovery.code !== 0) {
      console.error(`Probe discovery failed; see ${resolve(outputDir, 'discovery.json')}`);
      if (discovery.code === 130 || discovery.code === 143) process.exitCode = discovery.code;
      return false;
    }
    const report: JSONReport = JSON.parse(discovery.stdout);
    const found = discoveredScenarios(report.suites).sort();
    if (report.errors.length || JSON.stringify(found) !== JSON.stringify([...ids].sort())) {
      throw new Error(`Probe discovery does not match selection: expected ${ids.join(', ')}, discovered ${found.join(', ')}`);
    }
    hasPassed = true;
    // Frame-timing claims need an uncontended browser, so those scenarios run after
    // the shared phase, one at a time. Playwright owns scheduling within each phase.
    for (const phase of ['shared', 'exclusive'] as const) {
      const selected = SCENARIOS.filter(scenario => ids.includes(scenario.id) && Boolean(scenario.shouldRunAlone) === (phase === 'exclusive'));
      if (!selected.length) continue;
      const phaseEnv = {
        ...env,
        OMC_PROBE_PHASE: phase,
        OMC_PROBE_WORKERS: String(phase === 'exclusive' ? 1 : workers),
        OMC_PROBE_IDS: JSON.stringify(selected.map(scenario => scenario.id)),
      };
      const shardArgs = shard ? [`--shard=${shard}`] : [];
      if (shard) {
        const discovery = await runPlaywright(phaseEnv, ['--list', '--reporter=json', ...shardArgs], true);
        await writeFile(resolve(outputDir, `${phase}-discovery.json`), discovery.stdout);
        if (discovery.code !== 0) {
          phases.push({ phase, ids: selected.map(scenario => scenario.id), code: discovery.code });
          hasPassed = false;
          if (discovery.code === 130 || discovery.code === 143) { process.exitCode = discovery.code; break; }
          continue;
        }
        const shardReport: JSONReport = JSON.parse(discovery.stdout);
        if (shardReport.errors.length) throw new Error(`Native shard discovery failed (${phase})`);
        if (!discoveredScenarios(shardReport.suites).length) {
          console.log(`No scenarios assigned to native shard ${shard} (${phase}). Nothing to check.`);
          phases.push({ phase, ids: selected.map(scenario => scenario.id), code: 0, hasTests: false });
          continue;
        }
      }
      const { code, stdout, stderr } = await runPlaywright(phaseEnv, shardArgs);
      await writeFile(resolve(outputDir, `${phase}.log`), stdout + stderr);
      phases.push({ phase, ids: selected.map(scenario => scenario.id), code, hasTests: true });
      if (code !== 0) hasPassed = false;
      if (code === 130 || code === 143) { process.exitCode = code; break; }
    }
    return hasPassed;
  } catch (error) {
    hasPassed = false;
    throw error;
  } finally {
    try { await writeFile(resolve(outputDir, 'run.json'), JSON.stringify({ runId, ids, shard, workers, port, hasPassed, phases }, null, 2)); }
    finally { await rm(cacheDir, { recursive: true, force: true }); }
  }
}

export function parseProbeArguments(argv: string[]) {
  const options: { port: number; workers: number; shard?: string } = { port: 0, workers: 2 };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, value] = [argv[index], argv[++index]];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--port' && /^\d+$/.test(value ?? '') && Number(value) <= 65535) options.port = Number(value);
    else if (flag === '--workers' && /^[1-4]$/.test(value ?? '')) options.workers = Number(value);
    else if (flag === '--shard' && /^[1-9]\d*\/[1-9]\d*$/.test(value ?? '') && value.split('/').every(part => Number.isSafeInteger(Number(part))) && Number(value.split('/')[0]) <= Number(value.split('/')[1])) options.shard = value;
    else throw new Error(`Expected --port 0..65535, --workers 1..4 or --shard i/n, got ${flag} ${value ?? ''}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, workers, shard } = parseProbeArguments(process.argv.slice(2));
  const ids = SCENARIOS.map(scenario => scenario.id);
  console.log(`Running ${ids.length} probes${shard ? `, shard ${shard}` : ''} (${workers} workers, zero retries)`);
  if (!await runProbeCatalog({ port, workers, ids, shard })) process.exitCode ??= 1;
}
