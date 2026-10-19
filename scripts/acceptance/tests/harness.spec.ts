import type { Page } from '@playwright/test';
import { test, prepareScenario } from '../../testing/probe-fixtures.ts';
import { fulfillFixture } from '../browser-guard.mjs';

const FAULTS: [string, (page: Page) => Promise<unknown>][] = [
  ['pageerror', page => page.evaluate(() => { queueMicrotask(() => { throw new Error('injected pageerror'); }); })],
  ['console', page => page.evaluate(() => console.error('injected console error'))],
  ['fixture', page => page.evaluate(() => fetch('/omc/api/v1/undeclared-fixture'))],
  ['method', page => page.evaluate(() => fetch('/omc/api/auth/session', { method: 'POST' }))],
  ['outbound', page => page.evaluate(() => fetch('https://undeclared.example.test/probe').catch(() => {}))],
  ['fulfilled-outbound', async page => {
    await page.route('https://undeclared.example.test/mock', route => route.fulfill({ body: 'fixture' }));
    await page.evaluate(() => fetch('https://undeclared.example.test/mock').catch(() => {}));
  }],
  ['socket', page => page.evaluate(() => new Promise<void>(resolve => {
    const socket = new WebSocket('wss://undeclared.example.test/probe');
    socket.onclose = () => resolve();
    socket.onerror = () => resolve();
  }))],
];

for (const [id, inject] of FAULTS) {
  test(`rejects ${id}`, async ({ probe }) => {
    await prepareScenario(probe, []);
    await probe.context.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: '<h1>Harness fixture</h1>' }));
    await probe.page.goto(`${probe.base}/harness`);
    await inject(probe.page);
    await probe.page.evaluate(() => new Promise(requestAnimationFrame));
    probe.check('unrelated assertion passes', await probe.page.locator('h1').innerText() === 'Harness fixture');
  });
}

test('rejects assertion', async ({ probe }) => { probe.check('injected failed assertion', false); });
test('rejects setup', async ({ probe }) => {
  await prepareScenario(probe, []);
  throw new Error('injected setup failure');
});

test('accepts explicit HTTP failure', async ({ probe }) => {
  await probe.context.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: '<h1>Harness</h1>' }));
  await probe.context.route('**/expected-error', route => fulfillFixture(route, { status: 503, body: 'unavailable' }));
  await probe.page.goto(`${probe.base}/harness`);
  probe.check('expected status is preserved', await probe.page.evaluate(async () => (await fetch('/expected-error')).status) === 503);
});

test('accepts declared isolated popup', async ({ probe }) => {
  const destination = 'https://synthetic-popup.example.test/';
  probe.expectProblem({ kind: 'outbound', url: /^https:\/\/synthetic-popup\.example\.test\/$/, method: 'GET', count: 1 });
  await probe.context.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<h1>Local popup fixture</h1>' }));
  await probe.context.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: `<a href="${destination}" target="_blank" rel="noopener noreferrer">Open</a>` }));
  await probe.page.goto(`${probe.base}/harness`);
  const [popup] = await Promise.all([probe.page.waitForEvent('popup'), probe.page.getByRole('link').click()]);
  await popup.getByRole('heading').waitFor();
  probe.check('popup has no opener', await popup.evaluate(() => window.opener === null));
  await popup.close();
});

for (const identity of ['alpha', 'beta']) {
  test(`isolates ${identity} state`, async ({ probe }) => {
    await prepareScenario(probe, []);
    await probe.context.route('**/harness', route => route.fulfill({ contentType: 'text/html', body: '<h1>Isolated state</h1>' }));
    await probe.page.goto(`${probe.base}/harness`);
    probe.check('no inherited cookie', (await probe.context.cookies()).every(cookie => cookie.name !== 'identity'));
    probe.check('no inherited local storage', await probe.page.evaluate(() => localStorage.getItem('identity')) === null);
    await probe.context.addCookies([{ name: 'identity', value: identity, url: probe.base }]);
    await probe.page.evaluate(value => localStorage.setItem('identity', value), identity);
    const response = await probe.page.evaluate(async value => {
      const before = (await (await fetch('/omc/api/v1/preferences')).json()).preferences.provider_names;
      await fetch('/omc/api/v1/preferences/provider_names', { method: 'PUT', body: JSON.stringify({ identity: value }) });
      const after = (await (await fetch('/omc/api/v1/preferences')).json()).preferences.provider_names;
      return before === undefined ? after.identity : null;
    }, identity);
    probe.check('preference store belongs to this context', response === identity);
    probe.check('storage belongs to this context', await probe.page.evaluate(() => localStorage.getItem('identity')) === identity);
    probe.check('cookie belongs to this context', (await probe.context.cookies()).find(cookie => cookie.name === 'identity')?.value === identity);
  });
}
