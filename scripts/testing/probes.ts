import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '../acceptance/scenarios.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');
export type ProbeOptions = { port: number; workers: number; ids: string[]; shard?: string };

function runPlaywright(env: NodeJS.ProcessEnv, args: string[]) {
  return new Promise<number>((settle, reject) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', 'scripts/testing/probe-config.ts', '--pass-with-no-tests', ...args], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit',
    });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInterrupt = forward('SIGINT');
    const onTerminate = forward('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const release = () => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    child.once('error', error => { release(); reject(error); });
    child.once('close', code => { release(); settle(code ?? 1); });
  });
}

export async function runProbeCatalog({ port, workers, ids, shard }: ProbeOptions) {
  const unknown = ids.filter(id => !SCENARIOS.some(scenario => scenario.id === id));
  if (unknown.length) throw new Error(`Unknown probe scenarios: ${unknown.join(', ')}`);
  let hasPassed = true;
  // Frame-timing claims need an uncontended browser, so those scenarios run after
  // the shared phase, one at a time.
  for (const phase of ['shared', 'exclusive'] as const) {
    const selected = SCENARIOS.filter(scenario => ids.includes(scenario.id) && Boolean(scenario.shouldRunAlone) === (phase === 'exclusive'));
    if (!selected.length) continue;
    const code = await runPlaywright({
      OMC_PROBE_PHASE: phase,
      OMC_PROBE_PORT: String(port),
      OMC_PROBE_WORKERS: String(phase === 'exclusive' ? 1 : workers),
      OMC_PROBE_IDS: JSON.stringify(selected.map(scenario => scenario.id)),
    }, shard ? [`--shard=${shard}`] : []);
    if (code !== 0) hasPassed = false;
  }
  return hasPassed;
}

export function parseProbeArguments(argv: string[]) {
  const options: { port: number; workers: number; shard?: string } = { port: 5180, workers: 2 };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, value] = [argv[index], argv[++index]];
    if (flag === '--port' && /^\d+$/.test(value)) options.port = Number(value);
    else if (flag === '--workers' && /^[1-9]$/.test(value)) options.workers = Number(value);
    else if (flag === '--shard' && /^\d+\/\d+$/.test(value)) options.shard = value;
    else throw new Error(`Expected --port PORT, --workers N or --shard i/n, got ${flag} ${value ?? ''}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, workers, shard } = parseProbeArguments(process.argv.slice(2));
  const ids = SCENARIOS.map(scenario => scenario.id);
  console.log(`Running ${ids.length} probes${shard ? `, shard ${shard}` : ''} (${workers} workers, zero retries)`);
  if (!await runProbeCatalog({ port, workers, ids, shard })) process.exitCode = 1;
}
