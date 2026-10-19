import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseProbePort, parseProbeWorkers } from '../acceptance/probe-options.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const isHarness = process.env.OMC_PROBE_CATALOG === 'harness';
const port = parseProbePort(process.env.OMC_PROBE_PORT ?? '5180');
const phase = process.env.OMC_PROBE_PHASE ?? 'shared';
const owner = randomUUID();
const batch = process.env.OMC_PROBE_BATCH ?? '1';
const budget = Number(process.env.OMC_PROBE_BUDGET_MS ?? '480000');
if (!Number.isSafeInteger(budget) || budget < 1 || budget > 480_000) throw new Error('Invalid probe deadline');
if (!/^[1-3]$/.test(batch)) throw new Error('Invalid probe batch');
const output = isHarness ? 'browser-harness' : 'probe';

export default defineConfig({
  testDir: join(ROOT, 'scripts/acceptance/tests'),
  testMatch: isHarness ? 'harness.spec.ts' : 'catalog.spec.ts',
  webServer: {
    command: `"${process.execPath}" --import tsx "${join(ROOT, 'scripts/testing/vite-server.ts')}" ${port}`,
    cwd: join(ROOT, 'web'),
    env: { OMC_PROBE_OWNER: owner },
    wait: { stdout: new RegExp(`^OMC_PROBE_READY:${owner}$`, 'm') },
    reuseExistingServer: false,
    timeout: 24_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
  },
  fullyParallel: true,
  workers: phase === 'exclusive' ? 1 : parseProbeWorkers(process.env.OMC_PROBE_WORKERS ?? '2'),
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  globalTimeout: budget,
  expect: { timeout: 10_000 },
  outputDir: join(ROOT, `tmp/${output}-failure`, String(port), `${batch}-${phase}`),
  reporter: [
    ['list'],
    ...(isHarness
      ? [['json', { outputFile: join(ROOT, 'tmp/browser-harness-report.json') }] as const]
      : [['./probe-reporter.ts', { file: join(ROOT, 'tmp/probe-timings', `${port}.json`) }] as const]),
  ],
  use: {
    browserName: 'chromium',
    baseURL: `http://127.0.0.1:${port}/omc`,
    viewport: { width: 1440, height: 1000 },
    contextOptions: { reducedMotion: 'reduce', serviceWorkers: 'block' },
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    // Tracing every intercepted dev-module request distorts route/frame timing.
    // Native reports plus failure-only DOM, screenshots and the fault ledger keep
    // diagnostics outside the measured success path.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
