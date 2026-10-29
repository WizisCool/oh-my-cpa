import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);

// Tests do not load the product Vite config or stage its browser assets and services.
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  test: {
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'tmp/frontend-tests/junit.xml' },
    // Heavy jsdom/antd renders compete for CPU before their assertions run. Bound
    // the pool even on an otherwise idle host, and yield when other gates share it.
    maxWorkers: process.env.OMC_SHARED_CPU ? 1 : Math.min(2, availableParallelism()),
    projects: [
      {
        test: {
          name: 'logic',
          include: ['scripts/test-*.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        // React belongs to web's workspace; plugin deduplication must not resolve
        // against the runner's repository root, which does not install React.
        resolve: {
          alias: {
            react: dirname(require.resolve('react/package.json')),
            'react-dom': dirname(require.resolve('react-dom/package.json')),
          },
        },
        test: {
          name: 'components',
          include: ['web/tests/**/*.component.test.tsx', 'web/tests/**/*.contract.test.ts'],
          environment: 'jsdom',
          environmentOptions: { jsdom: { url: 'http://localhost/' } },
          setupFiles: ['./web/tests/setup.ts'],
        },
      },
    ],
  },
});
