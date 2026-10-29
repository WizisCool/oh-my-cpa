import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.OMC_PROBE_PORT ?? '0');
const owner = process.env.OMC_PROBE_RUN_ID ??= randomUUID();
const phase = process.env.OMC_PROBE_PHASE ?? 'shared';
const outputDir = join(ROOT, 'tmp/probe-failure', owner, phase);
const workers = Number(process.env.OMC_PROBE_WORKERS ?? '2');
if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('Probe workers must be between 1 and 4');

export default defineConfig({
  testDir: join(ROOT, 'scripts/acceptance/tests'),
  testMatch: 'catalog.spec.ts',
  projects: [
    { name: 'warmup', testDir: join(ROOT, 'scripts/testing'), testMatch: 'probe-warmup.ts', workers: 1 },
    { name: 'probes', dependencies: ['warmup'] },
  ],
  webServer: {
    command: `"${process.execPath}" --import tsx "${join(ROOT, 'scripts/testing/vite-server.ts')}" ${port}`,
    cwd: join(ROOT, 'web'),
    // The probe catalog exercises the configurable sub-path mount, including its
    // canonical bare-prefix redirect. It therefore pins the development server to
    // that mount instead of relying on the product's root default.
    env: { OMC_PROBE_OWNER: owner, OMCPA_BASE_PATH: '/omc', OMC_PROBE_CACHE_DIR: process.env.OMC_PROBE_CACHE_DIR ?? join(ROOT, 'web/node_modules/.vite-probes', owner) },
    wait: { stdout: new RegExp(`^OMC_PROBE_READY:${owner} (?<omc_probe_base_url>http://127\\.0\\.0\\.1:\\d+/omc)$`, 'm') },
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 24_000,
    // Native teardown kills the whole owned process group. A graceful group
    // SIGTERM also kills esbuild mid-optimization before Vite can close it.
  },
  fullyParallel: true,
  workers,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir,
  reporter: [['list'], ['json', { outputFile: join(outputDir, 'report.json') }]],
  use: {
    browserName: 'chromium',
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
