import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.OMC_PROBE_PORT ?? '5180');
const owner = randomUUID();

export default defineConfig({
  testDir: join(ROOT, 'scripts/acceptance/tests'),
  testMatch: 'catalog.spec.ts',
  globalSetup: join(ROOT, 'scripts/testing/probe-warmup.ts'),
  webServer: {
    command: `"${process.execPath}" --import tsx "${join(ROOT, 'scripts/testing/vite-server.ts')}" ${port}`,
    cwd: join(ROOT, 'web'),
    // The probe catalog exercises the configurable sub-path mount, including its
    // canonical bare-prefix redirect. It therefore pins the development server to
    // that mount instead of relying on the product's root default.
    env: { OMC_PROBE_OWNER: owner, OMCPA_BASE_PATH: '/omc' },
    wait: { stdout: new RegExp(`^OMC_PROBE_READY:${owner}$`, 'm') },
    reuseExistingServer: false,
    timeout: 24_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 2000 },
  },
  fullyParallel: true,
  workers: Number(process.env.OMC_PROBE_WORKERS ?? '2'),
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: join(ROOT, 'tmp/probe-failure', String(port), process.env.OMC_PROBE_PHASE ?? 'shared'),
  reporter: 'list',
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
