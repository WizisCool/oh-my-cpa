import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Do not load the product Vite config: component tests neither stage assets nor
// start the dev proxy, browser, editor workers or any upstream service.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.component.test.tsx', 'tests/**/*.contract.test.ts'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    setupFiles: ['./tests/setup.ts'],
    // Every file gets its own environment, so files run in parallel; within a file
    // tests stay sequential and share nothing but what setup.ts resets.
    isolate: true,
    // A worker per core when the suite has the machine to itself. Beside other gates
    // (`pnpm verify` runs three at once) a heavy antd render per core pushes tests
    // past their five-second budget, so scripts/parallel-checks.mjs asks for one
    // worker through OMC_SHARED_CPU.
    maxWorkers: process.env.OMC_SHARED_CPU ? 1 : undefined,
  },
});
