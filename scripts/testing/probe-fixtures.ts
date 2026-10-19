import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { guardBrowserContext } from '../acceptance/browser-guard.mjs';
import { installRoutes } from '../acceptance/probe.mjs';

type Ledger = Awaited<ReturnType<typeof guardBrowserContext>>;
export type Probe = {
  base: string;
  page: Page;
  context: BrowserContext;
  errors: string[];
  failures: string[];
  check: (name: string, condition: unknown, detail?: string) => boolean;
  step: <T>(name: string, task: () => Promise<T>) => Promise<T>;
  ledger: Ledger;
  expectProblem: Ledger['expect'];
};

export const test = base.extend<{ probe: Probe }>({
  probe: async ({ context, page, baseURL }, use, testInfo) => {
    if (!baseURL) throw new Error('A probe must own its server URL');
    const ledger = await guardBrowserContext(context, [baseURL]);
    const errors: string[] = [];
    const trail: string[] = [];
    await context.addInitScript(() => {
      if (!/^https?:$/.test(location.protocol)) return;
      if (!localStorage.getItem('omc-theme')) localStorage.setItem('omc-theme', 'omc-light');
      if (!localStorage.getItem('omc-lang')) localStorage.setItem('omc-lang', 'en');
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') trail.push(`${message.type()}: ${message.text()}`);
    });
    const failures: string[] = [];
    const probe: Probe = {
      base: baseURL, page, context, errors, failures, ledger,
      check(name, condition, detail = '') {
        const hasPassed = Boolean(condition);
        if (!hasPassed) failures.push(name);
        expect.soft(hasPassed, `${name}${detail ? ` — ${detail}` : ''}`).toBe(true);
        return hasPassed;
      },
      step: (name, task) => test.step(name, task),
      expectProblem: rule => ledger.expect(rule),
    };
    try {
      await use(probe);
    } finally {
      // Keep the domain fault boundary after context teardown as well: pending
      // request/console events must not disappear behind a green test body.
      if (testInfo.status !== testInfo.expectedStatus || ledger.unexpected().length) {
        await testInfo.attach('browser-state', { body: JSON.stringify({ url: page.url(), errors, trail, faults: ledger.unexpected() }, null, 2), contentType: 'application/json' });
        if (!page.isClosed()) {
          await testInfo.attach('page-dom', { body: await page.content(), contentType: 'text/html' });
          await testInfo.attach('page-screenshot', { body: await page.screenshot({ fullPage: true, timeout: 2000 }), contentType: 'image/png' });
        }
      }
      await context.close();
      expect(ledger.unexpected(), 'no unexpected browser, fixture, outbound or late teardown faults').toEqual([]);
    }
  },
});

export async function prepareScenario(probe: Probe, routes: Parameters<typeof installRoutes>[1]) {
  await installRoutes(probe.context, routes, probe.ledger);
}
