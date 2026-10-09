import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Do not load the product Vite config: component tests neither stage assets nor
// start the dev proxy, browser, editor workers or any upstream service.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.component.test.tsx', 'tests/**/*.contract.test.ts'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/omc/' } },
    setupFiles: ['./tests/setup.ts'],
    isolate: true,
    maxWorkers: 1,
  },
});
