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
    fsModuleCache: true,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'tmp/frontend-tests/junit.xml' },
    // Heavy jsdom/antd renders compete for CPU before their assertions run. Bound
    // the pool even on an otherwise idle host, and yield when other gates share it.
    maxWorkers: process.env.OMC_SHARED_CPU ? 2 : Math.min(4, availableParallelism()),
    projects: [
      {
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
          },
        },
        test: {
          name: 'logic',
          include: ['web/tests/**/*.test.ts'],
          environment: 'node',
          isolate: false,
          setupFiles: ['./web/tests/setup.ts'],
        },
      },
      {
        plugins: [react()],
        // React belongs to web's workspace; plugin deduplication must not resolve
        // against the runner's repository root, which does not install React.
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            react: dirname(require.resolve('react/package.json')),
            'react-dom': dirname(require.resolve('react-dom/package.json')),
          },
        },
        test: {
          name: 'components',
          include: ['web/tests/**/*.component.test.tsx'],
          environment: 'jsdom',
          environmentOptions: { jsdom: { url: 'http://localhost/' } },
          isolate: false,
          setupFiles: ['./web/tests/setup.ts'],
        },
      },
    ],
  },
});
