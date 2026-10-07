import assert from 'node:assert/strict';
import test from 'node:test';
import { runProbes } from './probe.mjs';
import { fulfillFixture } from './browser-guard.mjs';

// These tests launch Chromium deliberately; they do not belong to test:fast/test:self.
test('the runner rejects real runtime, fixture and outbound faults despite passing assertions', async () => {
  const observedChecks = [];
  const check = (name, condition) => observedChecks.push({ name, condition });
  const faults = [
    ['pageerror', page => page.evaluate(() => { setTimeout(() => { throw new Error('harness injected pageerror'); }, 0); })],
    ['console', page => page.evaluate(() => console.error('harness injected console error'))],
    ['fixture', page => page.evaluate(() => fetch('/omc/api/v1/undeclared-fixture'))],
    ['method', page => page.evaluate(() => fetch('/omc/api/auth/session', { method: 'POST' }))],
    ['outbound', page => page.evaluate(() => fetch('https://undeclared.example.test/probe').catch(() => {}))],
    ['fulfilled-outbound', async page => {
      await page.route('https://undeclared.example.test/mock', route => route.fulfill({ body: 'fixture' }));
      await page.evaluate(() => fetch('https://undeclared.example.test/mock').catch(() => {}));
    }],
    ['socket', page => page.evaluate(() => new Promise(resolve => {
      const socket = new WebSocket('wss://undeclared.example.test/probe');
      socket.onclose = () => resolve();
      socket.onerror = () => resolve();
    }))],
  ];
  const scenarios = faults.map(([id, inject]) => ({
    id: `harness-${id}`, name: `harness-${id}`, check,
    async run({ base, page, context, check }) {
      await context.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: '<h1>Harness fixture</h1>' }));
      await page.goto(`${base}/harness`);
      await inject(page);
      // A browser task barrier observes queued exceptions without a guessed sleep.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
      check('unrelated assertion passes', await page.locator('h1').innerText() === 'Harness fixture');
    },
  }));
  scenarios.push({
    id: 'harness-explicit-error', name: 'harness-explicit-error', check,
    async run({ base, page, context, check }) {
      await context.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: '<h1>Harness fixture</h1>' }));
      await context.route('**/expected-error', route => fulfillFixture(route, { status: 503, body: 'unavailable' }));
      await page.goto(`${base}/harness`);
      check('explicit error preserves its status', await page.evaluate(async () => (await fetch('/expected-error')).status) === 503);
    },
  });
  scenarios.push({
    id: 'harness-declared-popup', name: 'harness-declared-popup', check,
    async run({ base, page, context, check, expectProblem }) {
      const destination = 'https://synthetic-popup.example.test/';
      expectProblem({ kind: 'outbound', url: /^https:\/\/synthetic-popup\.example\.test\/$/, method: 'GET', count: 1 });
      await context.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<h1>Local popup fixture</h1>' }));
      await context.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: `<a href="${destination}" target="_blank" rel="noopener noreferrer">Open</a>` }));
      await page.goto(`${base}/harness`);
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link').click()]);
      await popup.getByRole('heading').waitFor();
      check('declared popup is synthetic and isolated', await popup.evaluate(() => window.opener === null));
      await popup.close();
    },
  });
  const outcome = await runProbes({ port: 5182, scenarios, artifactLabel: 'browser-harness' });
  assert.deepEqual(outcome.failures, faults.map(([id]) => `harness-${id}`));
  assert.equal(outcome.passed, 2);
  assert.equal(observedChecks.filter(entry => entry.name === 'unrelated assertion passes' && entry.condition).length, faults.length);
});
