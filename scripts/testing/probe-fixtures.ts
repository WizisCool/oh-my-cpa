import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createProblemLedger, guardBrowserContext } from '../acceptance/browser-guard.mjs';
import { withinBudget } from '../acceptance/lifecycle.mjs';
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

type BrowserAudit = { ledger: Ledger; page?: Page; errors: string[]; trail: string[] };

export const test = base.extend<{ probe: Probe; browserAudit: BrowserAudit }>({
  // Automatic fixtures start before the native page/context and finish after
  // their teardown, even if a test or a diagnostic read throws.
  browserAudit: [async ({}, use, testInfo) => {
    const audit: BrowserAudit = { ledger: createProblemLedger(), errors: [], trail: [] };
    try { await use(audit); }
    finally {
      const faults = audit.ledger.unexpected();
      if (testInfo.status !== testInfo.expectedStatus || faults.length) {
        await testInfo.attach('browser-state', {
          body: JSON.stringify({ url: audit.page?.url(), errors: audit.errors, trail: audit.trail, faults }, null, 2),
          contentType: 'application/json',
        });
      }
      expect(faults, 'no unexpected browser, fixture, outbound or late teardown faults').toEqual([]);
    }
  }, { auto: true }],
  baseURL: async ({}, use) => {
    const url = process.env.OMC_PROBE_BASE_URL;
    if (!url) throw new Error('Playwright did not receive an owned probe server URL');
    await use(url);
  },
  probe: async ({ context, page, baseURL, browserAudit }, use, testInfo) => {
    if (!baseURL) throw new Error('A probe must own its server URL');
    const { ledger, errors, trail } = browserAudit;
    browserAudit.page = page;
    await guardBrowserContext(context, [baseURL], { ledger });
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
      if ((testInfo.status !== testInfo.expectedStatus || ledger.unexpected().length) && !page.isClosed()) {
        try {
          await testInfo.attach('page-dom', { body: await withinBudget(page.content(), 2000, 'failure DOM capture'), contentType: 'text/html' });
        } catch (error) {
          trail.push(`DOM capture: ${String(error)}`);
        }
        // Native screenshots cover body failures. A ledger-only failure becomes
        // a test failure after context teardown, so capture its page now.
        if (testInfo.status === testInfo.expectedStatus) {
          try {
            await testInfo.attach('page-screenshot', { body: await page.screenshot({ fullPage: true, timeout: 2000 }), contentType: 'image/png' });
          } catch (error) {
            trail.push(`Screenshot capture: ${String(error)}`);
          }
        }
      }
    }
  },
});

export async function prepareScenario(probe: Probe, routes: Parameters<typeof installRoutes>[1]) {
  await installRoutes(probe.context, routes, probe.ledger);
}
