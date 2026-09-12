// Deterministic browser acceptance against an isolated fake CPA by default.
// Set OMCPA_LIVE_CPA=1 to run the separately maintained live-system smoke.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  createFakeCpaServer,
  FAKE_ACCOUNT_SECRET,
  FAKE_CPA_MANAGEMENT_KEY,
  FAKE_PROVIDER_SECRET,
} from './fake-cpa.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.OMCPA_LIVE_CPA === '1') {
  await import('./browser-live-smoke.mjs');
  process.exit();
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-e2e-'));
const executable = path.join(temporary, process.platform === 'win32' ? 'oh-my-cpa.exe' : 'oh-my-cpa');
const appLog = [];
const failures = [];
const checks = [];
let appProcess;
let browser;
let fakeCpa;
let appURL;

function check(name, condition, detail = '') {
  checks.push({ name, condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(name);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status > 0) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? 'no response'}`);
}

async function browserStorage(page) {
  return await page.evaluate(async () => {
    const local = Object.fromEntries(Object.entries(localStorage));
    const session = Object.fromEntries(Object.entries(sessionStorage));
    const cacheNames = 'caches' in window ? await caches.keys() : [];
    const indexedDBNames = 'databases' in indexedDB ? (await indexedDB.databases()).map((item) => item.name) : [];
    return JSON.stringify({ local, session, cacheNames, indexedDBNames });
  });
}

async function auditPage(page, responseBodies, route, selector, { pageSecrets = [] } = {}) {
  await page.goto(`${appURL}${route}`, { waitUntil: 'networkidle' });
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 });
  const bodyText = await page.locator('body').innerText();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${route} renders`, bodyText.length > 0, selector);
  check(`${route} has no document overflow`, overflow <= 1, `overflow=${overflow}`);
  const stored = await browserStorage(page);
  // Secret policy follows the current product contract: the management key
  // and OAuth credential material must never appear in DOM, browser
  // storage, or ordinary page responses. Downstream client/provider API
  // keys are intentionally returned in plaintext (see
  // `refactor(providers): show keys unmasked ...`), so they are asserted
  // per-page instead: pages whose contract includes plaintext key
  // management opt back in through `pageSecrets`.
  const strictSecrets = [FAKE_CPA_MANAGEMENT_KEY, FAKE_ACCOUNT_SECRET];
  for (const value of strictSecrets) {
    check(`${route} excludes management and OAuth credentials`, !bodyText.includes(value) && !stored.includes(value) && !responseBodies.some((body) => body.includes(value)));
  }
  if (pageSecrets.length > 0) {
    for (const value of pageSecrets) {
      check(`${route} excludes fixture credentials`, !bodyText.includes(value) && !stored.includes(value) && !responseBodies.some((body) => body.includes(value)));
    }
  }
  responseBodies.length = 0;
}

try {
  fakeCpa = createFakeCpaServer();
  await new Promise((resolve, reject) => {
    fakeCpa.server.once('error', reject);
    fakeCpa.server.listen(0, '127.0.0.1', resolve);
  });
  const cpaPort = fakeCpa.server.address().port;
  const appPort = await freePort();
  appURL = `http://127.0.0.1:${appPort}/omc`;

  execFileSync('go', ['build', '-trimpath', '-o', executable, './cmd/oh-my-cpa'], { cwd: root, stdio: 'inherit' });
  // Acceptance runs with ingestion disabled, so the request list would be empty
  // and every list behaviour untestable. Seed a deterministic window through the
  // repository itself (see the fixture's own doc comment) before the app opens
  // the database.
  const seeder = path.join(temporary, process.platform === 'win32' ? 'seed-usage.exe' : 'seed-usage');
  execFileSync('go', ['build', '-trimpath', '-o', seeder, './scripts/fixture/seed-usage'], { cwd: root, stdio: 'inherit' });
  const seedScenario = (name) => {
    const output = execFileSync(seeder, ['-db', path.join(temporary, 'data', 'oh-my-cpa.db'), '-scenario', name], {
      cwd: root,
      encoding: 'utf8',
    });
    if (!output.includes('SEED_USAGE_OK')) throw new Error(`seed ${name} failed: ${output}`);
  };
  seedScenario('list');
  appProcess = spawn(executable, [], {
    cwd: root,
    env: {
      ...process.env,
      OMCPA_LISTEN_ADDR: `127.0.0.1:${appPort}`,
      OMCPA_BASE_PATH: '/omc',
      OMCPA_DATA_DIR: path.join(temporary, 'data'),
      OMCPA_MASTER_KEY: ['fixture', 'master', 'key', 'for', 'browser', 'acceptance', 'only'].join('-'),
      OMCPA_CPA_BASE_URL: `http://127.0.0.1:${cpaPort}`,
      OMCPA_CPA_MANAGEMENT_KEY: FAKE_CPA_MANAGEMENT_KEY,
      OMCPA_CPA_USAGE_ADDR: '',
      OMCPA_USAGE_INGEST_ENABLED: 'false',
      OMCPA_PUBLIC_URL: '',
      OMCPA_VERSION: 'v0.1.0-e2e',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProcess.stdout.on('data', (chunk) => appLog.push(chunk.toString()));
  appProcess.stderr.on('data', (chunk) => appLog.push(chunk.toString()));
  appProcess.once('exit', (code) => {
    if (code !== null && code !== 0) appLog.push(`app exited with ${code}`);
  });

  const redirect = await waitFor(appURL);
  check('/omc redirects to /omc/', redirect.status === 308 && redirect.headers.get('location') === '/omc/', `status=${redirect.status}`);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const responseBodies = [];
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/status of 401 \(Unauthorized\)/i.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
  page.on('response', async (response) => {
    if (!response.url().startsWith(appURL)) return;
    const type = response.headers()['content-type'] ?? '';
    if (!/(json|text|html|yaml|javascript)/i.test(type)) return;
    try { responseBodies.push(await response.text()); } catch { /* navigation may dispose a response */ }
  });

  await page.goto(`${appURL}/dashboard`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').waitFor({ state: 'visible' });
  check('unauthenticated route shows sign-in', await page.locator('input[type="password"]').isVisible());
  await page.locator('input[type="password"]').fill('wrong-fixture-key');
  await page.locator('button[type="submit"]').click();
  await page.locator('.auth-alert').waitFor({ state: 'visible' });
  check('invalid sign-in is rejected', await page.locator('.auth-alert').isVisible());
  await page.locator('input[type="password"]').fill(FAKE_CPA_MANAGEMENT_KEY);
  await page.locator('button[type="submit"]').click();
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 15000 });
  check('valid sign-in creates an administrator session', await page.locator('.app-shell').isVisible());

  await auditPage(page, responseBodies, '/dashboard', '.dashboard-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // Success-rate verdict: the seeded window carries 1 failure in 50 (2%), which
  // is routine upstream noise. The pip must not paint it as a warning — the
  // reported bug was exactly this, at 98% success.
  const verdictPip = page.locator('.dashboard-page .legend-dot').first();
  await verdictPip.waitFor({ state: 'visible', timeout: 10000 });
  const verdictClasses = (await verdictPip.getAttribute('class')) ?? '';
  check(
    'a 98%-success window is not painted as a warning',
    /neutral/.test(verdictClasses) && !/warn|danger/.test(verdictClasses),
    `class="${verdictClasses}"`,
  );
  await auditPage(page, responseBodies, '/usage/events', '.usage-events-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // ---- request list: verdict colours, ordering, and the live tail ----
  // These four behaviours were each reported as a bug, so each gets a browser
  // check rather than only a unit test.
  // Find the scroll holder by behaviour rather than by class: the list is
  // virtualized and the scrolling element is Listy's own holder nested inside
  // the wrapper, so naming it by class couples the check to component internals.
  const listScroller = async () => {
    const handle = await page.evaluateHandle(() => {
      const root = document.querySelector('.request-list-host');
      if (!root) return null;
      const candidates = [root, ...root.querySelectorAll('*')];
      // A virtualized holder reports `overflow: hidden` yet still carries the
      // full content height and accepts programmatic scrolling, so the test is
      // geometry, not the overflow property.
      return (
        candidates.find((node) => {
          const style = getComputedStyle(node);
          return (
            /auto|scroll|hidden/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 20
          );
        }) ?? null
      );
    });
    return handle.asElement();
  };
  const describeListTree = async () =>
    page.evaluate(() => {
      const root = document.querySelector('.request-list-host');
      if (!root) return 'no .request-list-host';
      return [root, ...root.querySelectorAll('*')]
        .slice(0, 6)
        .map((node) => {
          const style = getComputedStyle(node);
          return `${node.className || node.tagName}|overflowY=${style.overflowY}|h=${node.clientHeight}/${node.scrollHeight}`;
        })
        .join(' :: ');
    });
  const rowTimestamps = async () => {
    const values = await page.locator('.request-row .req-col-time time').evaluateAll((nodes) =>
      nodes.map((node) => Date.parse(node.getAttribute('datetime') ?? '')),
    );
    return values.filter((value) => Number.isFinite(value));
  };

  await page.goto(`${appURL}/usage/events`, { waitUntil: 'networkidle' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // The list is virtualized, so only the visible window of rows is in the DOM;
  // the footer reports the real page size.
  const visibleRows = await page.locator('.request-row').count();
  const footerText = await page.locator('.request-pagination span').first().innerText();
  check('request list renders seeded records', visibleRows >= 2, `visibleRows=${visibleRows}`);
  check('the whole seeded page is loaded', /50/.test(footerText), `footer="${footerText}"`);

  // Latency carries no verdict colour: the fixture's first row is a nine-minute
  // agent request, and an absolute threshold used to paint it amber.
  const latencyColours = await page
    .locator('.request-row .req-latency-val')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
  const warnColour = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--warn)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  const slowRowText = await page.locator('.request-row').first().locator('.req-latency-val').innerText();
  check('long agent latency is rendered without a warning colour', !latencyColours.includes(warnColour), `slow=${slowRowText}`);
  // Anchored so the assertion above cannot pass vacuously on an empty list.
  check('the slow request really is long', /9\.00 s|m /.test(slowRowText) || Number.parseFloat(slowRowText) > 60, `slow=${slowRowText}`);

  check('the order is stated next to the window', await page.locator('.request-order-hint').first().isVisible());
  // The summary strip is gone, so the request page states no verdict of its own.
  check('no KPI summary strip remains', (await page.locator('.request-summary, .req-kpi-item').count()) === 0);
  check('the removed strip left no dead column of totals', (await page.locator('.req-kpi-val').count()) === 0);

  // ---- the filter panel ----
  // These assertions run before the live-tail section, which toggles
  // auto-refresh on; a filter change here would redefine the view the poll
  // compares against.
  const filterSuffix = () => new URL(page.url()).search;
  const initialFilterQuery = filterSuffix();

  // Multi-select is the point of the rewrite: two values in one dimension mean
  // "either of these", and both must survive into the URL as repeated keys.
  const modelFacet = page.locator('.request-filters .req-facet-select').first();
  const providerFacet = page.locator('.request-filters .req-facet-select').nth(1);
  await modelFacet.click();
  const firstModelOption = page.locator('.ant-select-dropdown:visible .ant-select-item-option').first();
  const firstModel = (await firstModelOption.innerText()).replace(/\s*\(\d+\)\s*$/, '').trim();
  await firstModelOption.click();
  await page.keyboard.press('Escape');
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  check(
    'selecting a facet writes the committed filter to the URL',
    filterSuffix().includes(`model=${encodeURIComponent(firstModel)}`),
    `url=${filterSuffix()}`,
  );
  check('a committed filter appears as a removable chip', (await page.locator('.req-filter-chip').count()) >= 1);

  // Removing the chip must clear the filter. This is the regression guard for
  // the persistence bug where a cleared filter was written straight back from
  // the stale query and reappeared on the next navigation.
  await page.locator('.req-filter-chip-remove').first().click();
  await page.waitForTimeout(400);
  check('removing the chip clears the filter from the URL', !filterSuffix().includes('model='), `url=${filterSuffix()}`);
  check('removing the only filter hides the chip strip', (await page.locator('.req-filter-chip').count()) === 0);

  // The advanced drawer is a draft: Apply commits once, Cancel discards.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  const drawerGroups = await page.locator('.req-filter-group-title').allInnerTexts();
  check('the advanced panel groups its fields', drawerGroups.length >= 4, `groups=${drawerGroups.join('|')}`);
  const latencyMin = page.locator('#req-range-latency-min');
  await latencyMin.fill('30000');
  await page.waitForTimeout(300);
  check('editing a draft field does not change the URL', !filterSuffix().includes('latency_min'), `url=${filterSuffix()}`);
  const drawerFooterText = await page.locator('.req-filter-drawer-footer').innerText().catch(() => '<no footer>');
  check(
    'the drawer exposes reset, cancel and apply',
    /重置筛选|Reset/.test(drawerFooterText) && /取\s*消|Cancel/.test(drawerFooterText) && /应用筛选|Apply/.test(drawerFooterText),
    `footer=${JSON.stringify(drawerFooterText)}`,
  );
  // Addressed by test id, not by position: the footer carries three buttons and
  // \"the first one\" is Reset, which deliberately leaves the panel open.
  await page.locator('[data-testid="req-filter-cancel"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  check('cancelling the drawer discards the draft', !filterSuffix().includes('latency_min'), `url=${filterSuffix()}`);

  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#req-range-latency-min').fill('30000');
  await page.locator('[data-testid="req-filter-apply"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  await page.waitForTimeout(400);
  check('applying the drawer commits the range once', filterSuffix().includes('latency_min=30000'), `url=${filterSuffix()}`);
  check(
    'an applied range is reported as a chip',
    (await page.locator('.req-filter-chip').allInnerTexts()).some((text) => /30000/.test(text)),
  );

  // A reversed range is a validation error, not a silently empty list.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#req-range-latency-min').fill('500');
  await page.locator('#req-range-latency-max').fill('100');
  await page.waitForTimeout(200);
  check('a reversed range is explained inline', (await page.locator('.req-filter-error').count()) >= 1);
  check(
    'a reversed range blocks Apply',
    await page.locator('[data-testid="req-filter-apply"]').isDisabled(),
  );
  await page.locator('[data-testid="req-filter-cancel"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 5000 });

  // Clear-all returns the list to the bare window and leaves nothing behind.
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(400);
  check('clear-all removes every filter', new URL(page.url()).searchParams.toString().split('&').every((pair) => /^(preset|limit)=/.test(pair) || pair === ''), `url=${filterSuffix()}`);
  check('clear-all hides the chip strip', (await page.locator('.req-filter-chip').count()) === 0);
  check(
    'the list is back to the unfiltered page',
    /50/.test(await page.locator('.request-pagination span').first().innerText()),
  );

  // The result verdict is a filter with no URL parameter of its own, so the
  // reset affordance must still appear when it is the only thing narrowing the
  // list.
  await page.locator('.request-filters .req-result-segmented .ant-segmented-item').filter({ hasText: /失败|Failed/ }).click();
  await page.waitForTimeout(400);
  check('the result verdict is committed to the URL', filterSuffix().includes('result=failed'), `url=${filterSuffix()}`);
  check('a result-only filter still offers Reset', await page.locator('.req-reset-filters').isVisible());
  // Clear-all must reset the filters without silently moving the reader to a
  // different hour. The window is chosen explicitly here, because the default
  // window is implicit in the URL and so cannot prove it was preserved.
  await page.locator('.req-time-button').click();
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /24h/ })
    .first()
    .click();
  await page.waitForTimeout(400);
  check('the time menu sets an explicit window', filterSuffix().includes('preset=24h'), `url=${filterSuffix()}`);
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('a filter and a window coexist in the URL', filterSuffix().includes('preset=24h') && filterSuffix().includes('model='), `url=${filterSuffix()}`);
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(400);
  check('clear-all removes the filter', !filterSuffix().includes('model='), `url=${filterSuffix()}`);
  check('clear-all keeps the chosen window', filterSuffix().includes('preset=24h'), `url=${filterSuffix()}`);

  // A pending debounce must not resurrect a filter that was just cleared. A
  // committed facet is seeded first: without one the chip strip is absent, so
  // clicking "clear all" would have no target and the check could pass vacuously
  // while the debounce wrote `q` back afterwards.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('a facet is committed before the debounce race', filterSuffix().includes('model='), `url=${filterSuffix()}`);
  await page.locator('.request-search input').type('gpt', { delay: 20 });
  // Deliberately shorter than the debounce, so the timer is still pending when
  // the clear lands.
  await page.waitForTimeout(120);
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(900);
  check('a pending search debounce cannot revive a cleared filter', !filterSuffix().includes('q='), `url=${filterSuffix()}`);
  check('the clear also removed the committed facet', !filterSuffix().includes('model='), `url=${filterSuffix()}`);
  check('the search box is emptied by the clear', (await page.locator('.request-search input').inputValue()) === '');

  // A filter change must drop the pagination position rather than reusing a
  // cursor that was minted against a different result set.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('a filter change drops the cursor', !filterSuffix().includes('cursor='), `url=${filterSuffix()}`);
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(400);
  // Return to the window the rest of the audit expects before it continues.
  await page.locator('.req-time-button').click();
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /1h/ })
    .first()
    .click();
  await page.waitForTimeout(400);
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'networkidle' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  check('the audit resumed on the default window', filterSuffix() === initialFilterQuery, `before=${initialFilterQuery} after=${filterSuffix()}`);

  // Ordering: the first row was recorded last but started earliest, so its
  // timestamp is older than the row below it. That is recording order, and it is
  // the only way a just-finished long request can reach the top.
  const ordered = await rowTimestamps();
  check(
    'the list is ordered by recording order, not request time',
    ordered.length >= 2 && ordered[0] < ordered[1],
    `first=${new Date(ordered[0]).toISOString()} second=${new Date(ordered[1]).toISOString()}`,
  );

  // Live tail: scroll away from the top, let a poll land with a new record, and
  // require that nothing the reader is looking at moves.
  //
  // Auto-refresh is a plain on/off switch with a fixed 10-second cadence, so the
  // test drives the switch rather than picking an interval out of a menu.
  const autoRefreshSwitch = page.locator('#req-auto-refresh');
  check('auto-refresh is an on/off switch, not an interval picker', (await page.locator('.req-auto-refresh-select').count()) === 0);
  check('auto-refresh starts off', !(await autoRefreshSwitch.isChecked()));
  await autoRefreshSwitch.click();
  check('auto-refresh turns on', await autoRefreshSwitch.isChecked());
  check(
    'the enabled switch states its cadence',
    /10\s*秒|every 10s/i.test(await page.locator('.req-auto-refresh-cadence').innerText()),
  );

  const scroller = await listScroller();
  check('the request list has a scroll holder, so the scroll checks are meaningful', scroller !== null, await describeListTree());
  if (!scroller) throw new Error(`no scrollable element in the request list: ${await describeListTree()}`);

  // Facets are nine grouped scans of the window, so they must follow the window -
  // not the ten-second list tick. Counting the requests is the only way to prove
  // the poll does not re-issue them.
  const facetRequests = [];
  const countFacet = (request) => {
    if (request.url().includes('/usage/facets')) facetRequests.push(request.url());
  };
  page.on('request', countFacet);
  await scroller.evaluate((node) => {
    node.scrollTop = Math.round(node.scrollHeight / 2);
  });
  await page.waitForTimeout(400);
  const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
  check('the list actually scrolled away from the top', scrollBefore > 100, `scrollTop=${scrollBefore}`);
  const rowsBefore = await page.locator('.request-row').count();
  const pageLabelBefore = await page.locator('.request-pagination span').first().innerText();

  seedScenario('append');
  // The cadence is 10s, so the wait has to clear one full interval plus the
  // request itself. It was 20s against the old 5s option.
  await page.locator('.req-back-to-top-btn.is-live').waitFor({ state: 'visible', timeout: 30000 });

  const scrollAfterPoll = await scroller.evaluate((node) => node.scrollTop);
  const rowsAfterPoll = await page.locator('.request-row').count();
  const pageLabelAfter = await page.locator('.request-pagination span').first().innerText();
  check('a poll does not scroll the reader back to the top', Math.abs(scrollAfterPoll - scrollBefore) <= 4, `before=${scrollBefore} after=${scrollAfterPoll}`);
  check('a poll does not reorder the rows under the cursor', rowsAfterPoll === rowsBefore, `before=${rowsBefore} after=${rowsAfterPoll}`);
  check('a poll does not reset pagination or relabel the page', pageLabelAfter === pageLabelBefore, `before="${pageLabelBefore}" after="${pageLabelAfter}"`);
  const pillText = await page.locator('.req-back-to-top-btn.is-live').innerText();
  check('the pill reports the records that arrived', /1/.test(pillText), `pill="${pillText}"`);

  // The evidence for the facet freshness policy: at least one poll landed above
  // (the pill proves it), and none of them spent the facet budget.
  page.off('request', countFacet);
  check(
    'a poll does not re-read the facets',
    facetRequests.length === 0,
    `facetRequests=${facetRequests.length}`,
  );

  await page.locator('.req-back-to-top-btn.is-live').click();
  await page.waitForTimeout(600);
  const newestFirst = await rowTimestamps();
  const scrollAfterApply = await scroller.evaluate((node) => node.scrollTop);
  check('applying the backlog returns to the top', scrollAfterApply <= 4, `scrollTop=${scrollAfterApply}`);
  check(
    'the new record is the first row',
    newestFirst.length > 0 && newestFirst[0] >= Math.max(...newestFirst),
    `first=${newestFirst.length ? new Date(newestFirst[0]).toISOString() : 'none'}`,
  );
  // The window survives a reload. Facets and filters were reloaded repeatedly by
  // the checks above, so this is the one place the saved view is exercised end to
  // end: choose an explicit window, a page size and a cost filter, clear the
  // filters, then reopen the bare route.
  await page.locator('.req-time-button').click();
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /24h/ })
    .first()
    .click();
  await page.waitForTimeout(300);
  await page.locator('.request-pagination .ant-select').click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: /250/ })
    .first()
    .click();
  await page.waitForTimeout(500);
  check('the page size is committed', filterSuffix().includes('limit=250'), `url=${filterSuffix()}`);

  // Every preset stays selectable exactly once, including whichever is selected,
  // for a quick preset and a slow one. A menu that omits the current choice is how
  // the operator loses the ability to see or return to the window they are on.
  for (const selected of ['1h', '7d']) {
    await page.goto(`${appURL}/usage/events?preset=${selected}`, { waitUntil: 'networkidle' });
    await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.req-time-button').click();
    const presetItems = await page.locator('.ant-dropdown-menu-item').allInnerTexts();
    await page.keyboard.press('Escape');
    await page
      .locator('.ant-dropdown:visible')
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => {});
    for (const preset of ['15m', '1h', '6h', '24h', '7d', '30d', '90d']) {
      const occurrences = presetItems.filter((text) => text.includes(preset)).length;
      check(
        `with ${selected} selected, ${preset} appears exactly once`,
        occurrences === 1,
        `items=${presetItems.join('|')}`,
      );
    }
  }

  // A cost filter is carried as exactly one parameter, and clearing filters must
  // keep the window and page size - in the URL and in what is saved for next time.
  await page.goto(`${appURL}/usage/events?preset=24h&limit=250&cost=unpriced&model=gpt-5-codex`, {
    waitUntil: 'networkidle',
  });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);
  check(
    'a cost filter travels as exactly one parameter',
    (filterSuffix().match(/(^|[&?])cost=/g) ?? []).length === 1,
    `url=${filterSuffix()}`,
  );
  check('the second dimension is present alongside it', filterSuffix().includes('model=gpt-5-codex'), `url=${filterSuffix()}`);
  check(
    'the cost state is reported as a chip',
    (await page.locator('.req-filter-chip').allInnerTexts()).some((text) => /未定价|Unpriced/.test(text)),
    `chips=${(await page.locator('.req-filter-chip').allInnerTexts()).join('|')}`,
  );
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(600);
  check('clear-all drops the filters', !filterSuffix().includes('cost=') && !filterSuffix().includes('model='), `url=${filterSuffix()}`);
  check(
    'clear-all keeps the window and the page size',
    filterSuffix().includes('preset=24h') && filterSuffix().includes('limit=250'),
    `url=${filterSuffix()}`,
  );
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'networkidle' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600);
  check('the saved window is restored on the bare route', filterSuffix().includes('preset=24h'), `url=${filterSuffix()}`);
  check('the saved page size is restored on the bare route', filterSuffix().includes('limit=250'), `url=${filterSuffix()}`);
  check(
    'the cleared filters stay cleared on the bare route',
    !filterSuffix().includes('cost=') && !filterSuffix().includes('model='),
    `url=${filterSuffix()}`,
  );
  check(
    'no cost parameter is duplicated in the restored URL',
    (filterSuffix().match(/(^|[&?])cost=/g) ?? []).length <= 1,
    `url=${filterSuffix()}`,
  );
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'networkidle' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });

  // The alias is an exact-match dimension with manual entry. It is the one filter
  // whose control has to accept a value the window does not report - an operator
  // looks up an alias precisely when it has stopped appearing - so it is exercised
  // through the whole cycle: type, apply, reopen, remove.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  const aliasInput = page.locator('#req-multi-model_alias');
  await aliasInput.click();
  // Typed key by key rather than filled: a tag is created by the Select's own
  // keyboard handling, so setting the input value directly does not commit it.
  await page.keyboard.type('retired-alias', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check(
    'typing an alias the window does not report creates a tag',
    (await page.locator('.req-filter-drawer').innerText()).includes('retired-alias'),
  );
  check(
    'a typed alias marks the draft as changed',
    !(await page.locator('[data-testid="req-filter-apply"]').isDisabled()),
  );
  await page.locator('[data-testid="req-filter-apply"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  await page.waitForTimeout(400);
  check(
    'a typed alias reaches the URL',
    filterSuffix().includes('model_alias=retired-alias'),
    `url=${filterSuffix()}`,
  );
  check(
    'the alias is reported as a chip',
    (await page.locator('.req-filter-chip').allInnerTexts()).some((text) => text.includes('retired-alias')),
  );
  // Reopening must show the value it committed, not an empty control. The row is
  // located by the select it contains, because antd renders the tag in a sibling
  // node rather than inside the input's parent.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  const aliasRowText = await page
    .locator('.req-filter-row')
    .filter({ has: page.locator('#req-multi-model_alias') })
    .innerText();
  check(
    'the committed alias is shown when the drawer reopens',
    aliasRowText.includes('retired-alias'),
    `row=${JSON.stringify(aliasRowText)}`,
  );
  await page.locator('[data-testid="req-filter-cancel"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(400);
  check('the alias filter can be cleared', !filterSuffix().includes('model_alias'), `url=${filterSuffix()}`);

  // A filter changed while a keystroke is still queued must survive: the queued
  // commit has to patch the newest URL rather than restore the snapshot captured
  // when it was scheduled.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const committedModel = new URL(page.url()).searchParams.get('model');
  await page.locator('.request-search input').type('gpt', { delay: 20 });
  await page.waitForTimeout(80);
  // Change an unrelated dimension inside the debounce window.
  await providerFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const afterRace = new URL(page.url()).searchParams;
  check('a queued search does not erase a filter chosen during the debounce', afterRace.get('model') === committedModel, `url=${filterSuffix()}`);
  check('the queued search still lands', afterRace.get('q') === 'gpt', `url=${filterSuffix()}`);
  check('the provider chosen during the debounce survives', afterRace.get('provider') !== null, `url=${filterSuffix()}`);
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(500);
  check('the race left the view clearable', (await page.locator('.req-filter-chip').count()) === 0, `url=${filterSuffix()}`);

  // Search text must follow the URL when the operator navigates between two saved
  // search views. A debounce that only listens for its own commits would let the
  // loaded value be overwritten by the one it replaced.
  for (const term of ['alpha-search', 'beta-search']) {
    await page.goto(`${appURL}/usage/events?preset=24h&q=${term}`, { waitUntil: 'networkidle' });
    await page.locator('.request-row, .ant-empty').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(200);
    check(
      `the search box shows the navigated term (${term})`,
      (await page.locator('.request-search input').inputValue()) === term,
      `input=${await page.locator('.request-search input').inputValue()}`,
    );
    // Past the debounce window: a stale timer would rewrite the URL here.
    await page.waitForTimeout(600);
    check(
      `the navigated term survives the debounce window (${term})`,
      filterSuffix().includes(`q=${term}`) &&
        (await page.locator('.request-search input').inputValue()) === term,
      `url=${filterSuffix()} input=${await page.locator('.request-search input').inputValue()}`,
    );
  }
  await page.locator('.req-clear-all-chips').click();
  await page.waitForTimeout(500);

  // A malformed parameter must be reported, not silently dropped: dropping it would
  // show a wider result set than the link asked for while the panel still looked
  // narrowed, which is the failure mode this notice exists to prevent.
  await page.goto(`${appURL}/usage/events?preset=24h&latency_min=abc&cost=maybe`, {
    waitUntil: 'networkidle',
  });
  await page.locator('.usage-events-page .ant-alert').first().waitFor({ state: 'visible', timeout: 10000 });
  const rejectedNotice = await page.locator('.usage-events-page .ant-alert').first().innerText();
  check('an unusable filter parameter is reported', /latency_min/.test(rejectedNotice) && /cost/.test(rejectedNotice), `notice=${JSON.stringify(rejectedNotice)}`);
  check('the list still runs on the usable filters', (await page.locator('.request-row').count()) > 0);
  await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'networkidle' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  check('a clean URL shows no notice', (await page.locator('.usage-events-page .ant-alert').count()) === 0);

  // Same-component navigation with a pending keystroke. `page.goto` remounts the
  // page, so it cannot exercise this: the two URLs below share a committed `q`, so
  // only history navigation (not the committed value) distinguishes them.
  await page.goto(`${appURL}/usage/events?preset=24h&q=keep-me&provider=openai`, { waitUntil: 'networkidle' });
  await page.locator('.request-row, .ant-empty').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(300);
  // Client-side navigation to the same view with a different unrelated dimension.
  await page.evaluate(() => history.pushState({}, '', '/omc/usage/events?preset=24h&q=keep-me&provider=claude'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await page.locator('.request-search input').click();
  await page.keyboard.type('stale-typing', { delay: 20 });
  // Navigate again before the debounce commits.
  await page.evaluate(() => history.pushState({}, '', '/omc/usage/events?preset=24h&q=keep-me&provider=gemini'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await page.waitForTimeout(900);
  check(
    'history navigation discards a pending keystroke',
    !filterSuffix().includes('stale-typing'),
    `url=${filterSuffix()}`,
  );
  check(
    'the navigated view keeps its own committed search',
    filterSuffix().includes('q=keep-me') && filterSuffix().includes('provider=gemini'),
    `url=${filterSuffix()}`,
  );
  await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'networkidle' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });

  // Switching the poll off again keeps the rest of the audit deterministic.
  await autoRefreshSwitch.click();
  check('auto-refresh turns off again', !(await autoRefreshSwitch.isChecked()));
  check('the cadence label is hidden while the poll is off', (await page.locator('.req-auto-refresh-cadence').count()) === 0);

  // A manual refresh is the other event that re-reads the facets: the operator
  // asked for current data, and stale dropdown counts are on screen too.
  const manualFacets = [];
  const countManualFacet = (request) => {
    if (request.url().includes('/usage/facets')) manualFacets.push(request.url());
  };
  page.on('request', countManualFacet);
  await page.locator('.terminal-page-head .request-actions button').last().click();
  await page.waitForTimeout(1200);
  page.off('request', countManualFacet);
  check('a manual refresh re-reads the facets', manualFacets.length >= 1, `requests=${manualFacets.length}`);
  await page.screenshot({ path: path.join(root, 'tmp', 'req-page-desktop.png') });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(
      () => Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    );
    check(`request records ${width}px viewport has no overflow`, overflow === 0, `overflow=${overflow}`);
    const actionsFit = await page.evaluate(() => {
      const actions = document.querySelector('.usage-events-page .terminal-page-head .request-actions');
      if (!actions) return -1;
      const box = actions.getBoundingClientRect();
      // The action group must stay inside the viewport it sits in.
      return Math.round(box.right - window.innerWidth);
    });
    check(`request records ${width}px header actions stay in view`, actionsFit <= 1, `rightOverhang=${actionsFit}`);

    // The panel and the time dialog are the two surfaces that only exist while
    // open, so the closed-page overflow check above cannot see them.
    await page.locator('.req-more-filters').click();
    await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(250);
    const drawerOverflow = await page.evaluate(() => {
      const panel = document.querySelector('.req-filter-drawer .ant-drawer-body');
      if (!panel) return -1;
      // Content wider than the panel is the failure mode a narrow viewport exposes:
      // a range pair whose inputs cannot shrink pushes the dialog off screen.
      return Math.round(panel.scrollWidth - panel.clientWidth);
    });
    check(`filter drawer fits at ${width}px`, drawerOverflow <= 1, `drawerOverflow=${drawerOverflow}`);
    const drawerOnScreen = await page.evaluate(() => {
      const root = document.querySelector('.req-filter-drawer');
      if (!root) return 'no root';
      // The positioning element is not guaranteed to be a fixed class name in
      // antd v6, so the check walks the drawer's own elements and requires that at
      // least one sizing box sits inside the viewport.
      const boxes = [root, ...root.querySelectorAll('*')]
        .map((node) => ({ node, box: node.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 100 && box.height > 100);
      if (boxes.length === 0) {
        return `no sized element; classes=${root.className} inner=${root.innerHTML.slice(0, 200)}`;
      }
      const offender = boxes.find(({ box }) => box.left < -1 || box.right > window.innerWidth + 1);
      if (offender) {
        return `${offender.node.className} left=${Math.round(offender.box.left)} right=${Math.round(offender.box.right)} viewport=${window.innerWidth}`;
      }
      return true;
    });
    check(`filter drawer stays on screen at ${width}px`, drawerOnScreen === true, String(drawerOnScreen));
    await page.locator('[data-testid="req-filter-cancel"]').click();
    await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });

    await page.locator('.req-time-button').click();
    // The trigger opens the preset menu; the absolute dialog is a menu item, so a
    // click on the trigger alone never opens it.
    await page
      .locator('.ant-dropdown-menu-item')
      .filter({ hasText: /自定义时间|Custom range/ })
      .first()
      .click();
    await page.locator('.req-time-modal').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(250);
    const modalOnScreen = await page.evaluate(() => {
      const dialog = document.querySelector('.req-time-modal');
      if (!dialog) return 'no dialog';
      const box = dialog.getBoundingClientRect();
      if (box.left < -1 || box.right > window.innerWidth + 1) {
        return `left=${Math.round(box.left)} right=${Math.round(box.right)} viewport=${window.innerWidth}`;
      }
      return true;
    });
    check(`custom time dialog stays on screen at ${width}px`, modalOnScreen === true, String(modalOnScreen));
    await page.keyboard.press('Escape');
    await page.locator('.req-time-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  responseBodies.length = 0;
  await auditPage(page, responseBodies, '/pricing', '[data-testid="pricing-page"]', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // The pricing page must open fast: a full table render is the budget, not a
  // spinner wait. This is the regression guard for the old 5s page freeze.
  const pricingOpenStart = Date.now();
  await page.goto(`${appURL}/pricing`);
  await page.locator('[data-testid="pricing-page"]').first().waitFor({ state: 'visible', timeout: 3000 });
  const pricingOpenMS = Date.now() - pricingOpenStart;
  check('pricing page opens under 3s', pricingOpenMS < 3000, `${pricingOpenMS}ms`);

  // The manual price editor must be a real form: labeled fields with units, not
  // bare number inputs. This guards the redesigned modal structure.
  await page.getByRole('button', { name: /添加价格|Add price/ }).first().click();
  await page.locator('.ant-modal .ant-form .ant-form-item').first().waitFor({ state: 'visible', timeout: 5000 });
  const editorLabels = await page.locator('.ant-modal .ant-form .ant-form-item-label label').allInnerTexts();
  check('price editor shows labeled fields', editorLabels.length >= 6, `labels=${editorLabels.length}`);
  const rateUnits = await page.locator('.ant-modal .ant-form .ant-input-number-suffix').allInnerTexts();
  check('price editor shows $/1M units', rateUnits.filter((u) => u.includes('/ 1M')).length === 4, `units=${rateUnits.length}`);
  await page.keyboard.press('Escape');
  // forceRender keeps the form mounted, so closing hides it instead of detaching.
  await page.locator('.ant-modal .ant-form').first().waitFor({ state: 'hidden', timeout: 5000 });
  check('price editor closes cleanly', true);
  await auditPage(page, responseBodies, '/ai-providers', '.providers-page');
  await auditPage(page, responseBodies, '/auth-files', '.auth-files-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // Auth Files Page Flow & Behavioral Checks
  await page.goto(`${appURL}/auth-files`, { waitUntil: 'networkidle' });
  await page.locator('.auth-files-page').first().waitFor({ state: 'visible', timeout: 15000 });

  // 1. Initial card count
  const authCardCount = await page.locator('.auth-files-page .ant-card').count();
  check('auth-files page renders credential cards', authCardCount >= 5, `cards=${authCardCount}`);

  // 2. Search filtering
  const searchInput = page.locator('.auth-files-page input[placeholder*="Search"], .auth-files-page input[placeholder*="搜索"]').first();
  if (await searchInput.isVisible()) {
    await searchInput.fill('claude');
    await page.waitForTimeout(300);
    const claudeCardCount = await page.locator('.auth-files-page .ant-card').count();
    check('auth-files search filters to matching file', claudeCardCount === 1, `count=${claudeCardCount}`);
    await searchInput.fill('');
    await page.waitForTimeout(300);
  }

  // 3. Provider tabs & brand icons verification
  const codexTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Codex/i }).first();
  await codexTab.waitFor({ state: 'visible', timeout: 5000 });
  await codexTab.click();
  await page.waitForTimeout(300);
  const codexCount = await page.locator('.auth-files-page .ant-card').count();
  check('auth-files provider tab filters to Codex', codexCount === 2, `count=${codexCount}`);
  const allTab = page.locator('.auth-files-page .ant-tabs-tab').first();
  await allTab.click();
  await page.waitForTimeout(300);

  // Verify brand icons on tabs are NOT OpenAI
  const antigravityTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }).first();
  const antigravitySvgHtml = await antigravityTab.locator('svg').innerHTML();
  check('Antigravity tab icon is not OpenAI', !antigravitySvgHtml.includes('OpenAI'));

  const xaiTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /xAI|Xai/i }).first();
  const xaiSvgHtml = await xaiTab.locator('svg').innerHTML();
  check('xAI tab icon is not OpenAI', !xaiSvgHtml.includes('OpenAI'));

  const kimiTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Kimi/i }).first();
  const kimiSvgHtml = await kimiTab.locator('svg').innerHTML();
  check('Kimi tab icon is not OpenAI', !kimiSvgHtml.includes('OpenAI'));

  // Verify tab hover stability
  await codexTab.hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(root, 'tmp', 'auth-files-hover-desktop.png') });
  const hoverCheck = await codexTab.evaluate((el) => {
    const computed = window.getComputedStyle(el);
    const btn = el.querySelector('.ant-tabs-tab-btn');
    const btnComputed = btn ? window.getComputedStyle(btn) : null;
    return {
      bg: computed.backgroundColor,
      btnColor: btnComputed ? btnComputed.color : null,
    };
  });
  check('tab hover has valid background', hoverCheck.bg !== 'transparent' && hoverCheck.bg !== 'rgba(0, 0, 0, 0)');

  // 4. Quick Models modal
  const modelsBtn = page.locator('.auth-files-page button').filter({ hasText: /模型|Models/i }).first();
  if (await modelsBtn.isVisible()) {
    await modelsBtn.click();
    const modelsModal = page.locator('.ant-modal').filter({ hasText: /模型|Models/i });
    await modelsModal.waitFor({ state: 'visible', timeout: 5000 });
    check('auth-files models modal opens', await modelsModal.isVisible());
    const closeBtn = modelsModal.getByRole('button', { name: /关闭|Close/i });
    await closeBtn.click();
    await modelsModal.waitFor({ state: 'hidden', timeout: 5000 });
  }

  // 5. Drawer opening & dirty discard confirmation
  const editBtn = page.locator('.auth-files-page button').filter({ hasText: /编辑|Edit/i }).first();
  if (await editBtn.isVisible()) {
    await editBtn.click();
    const drawer = page.locator('.ant-drawer');
    await drawer.waitFor({ state: 'visible', timeout: 5000 });
    check('auth-files drawer opens', await drawer.isVisible());

    // Modify a field to dirty the form
    const noteArea = drawer.locator('textarea').first();
    await noteArea.fill('new dirty test note');

    // Attempt close while dirty -> triggers confirm modal
    const drawerCloseBtn = drawer.locator('.ant-drawer-close');
    await drawerCloseBtn.click();
    const confirmModal = page.locator('.ant-modal-confirm');
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
    check('auth-files drawer dirty close prompts confirmation', await confirmModal.isVisible());

    // Cancel keeping it open
    const cancelConfirm = confirmModal.locator('.ant-btn').filter({ hasText: /取\s*消|Cancel/i }).first();
    await cancelConfirm.click();
    await confirmModal.waitFor({ state: 'hidden', timeout: 5000 });
    check('auth-files cancel keeps drawer open', await drawer.isVisible());

    // Confirm discard
    await drawerCloseBtn.click();
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
    const okConfirm = confirmModal.locator('.ant-btn').filter({ hasText: /确\s*定|Confirm/i }).first();
    await okConfirm.click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
    check('auth-files discard closes drawer', (await page.locator('.ant-drawer-open').count()) === 0);
  }

  // 6. Select page & Batch bar
  const selectPageBtn = page.locator('.auth-files-page button').filter({ hasText: /全选|选择本页|Select/i }).first();
  if (await selectPageBtn.isVisible()) {
    await selectPageBtn.click();
    const clearBtn = page.locator('.auth-files-page button').filter({ hasText: /取消选择|Clear/i }).first();
    check('auth-files batch bar appears after selection', await clearBtn.isVisible());
    await clearBtn.click();
  }

  // 7. Actual status toggle on card
  const kimiCard = page.locator('.auth-files-page .ant-card').filter({ hasText: 'kimi-fixture.json' }).first();
  check('auth-files kimi card found', await kimiCard.isVisible());
  const kimiSwitch = kimiCard.locator('.ant-switch');
  await kimiSwitch.click();
  await page.waitForTimeout(800);
  check('auth-files single toggle disables card', await kimiCard.getByText(/DISABLED|已禁用/).first().isVisible());
  await kimiSwitch.click();
  await page.waitForTimeout(800);
  check('auth-files single toggle re-enables card', await kimiCard.getByText(/ACTIVE|正常/).first().isVisible());

  // 8. Runtime-only card guard
  const runtimeCard = page.locator('.auth-files-page .ant-card').filter({ hasText: 'virtual-runtime.json' }).first();
  check('auth-files runtime card renders VIRTUAL badge', await runtimeCard.getByText(/VIRTUAL|虚拟/).first().isVisible());
  check('auth-files runtime card has no selection checkbox', (await runtimeCard.locator('input[type="checkbox"]').count()) === 0);
  check('auth-files runtime card switch is disabled', await runtimeCard.locator('.ant-switch-disabled').isVisible());

  // 9. Drawer save submits patch and updates UI
  const xaiCard = page.locator('.auth-files-page .ant-card').filter({ hasText: 'xai-fixture.json' }).first();
  const xaiEditBtn = xaiCard.locator('button').filter({ hasText: /编辑|Edit/i });
  await xaiEditBtn.click();
  const saveDrawer = page.locator('.ant-drawer');
  await saveDrawer.waitFor({ state: 'visible', timeout: 5000 });
  const noteInput = saveDrawer.locator('textarea').first();
  await noteInput.fill('persisted note by acceptance test');
  const saveBtn = saveDrawer.locator('button').filter({ hasText: /保存|Save/i }).first();
  await saveBtn.click();
  await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
  const updatedNote = xaiCard.getByText('persisted note by acceptance test');
  await updatedNote.waitFor({ state: 'visible', timeout: 5000 });
  check('auth-files card displays updated note after save', await updatedNote.isVisible());

  // 10. Viewports at 390px and 320px for auth-files
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
    check(`auth-files ${width}px viewport has no overflow`, overflow === 0, `overflow=${overflow}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await auditPage(page, responseBodies, '/oauth', '.oauth-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/quota', '.quota-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // Quota Cards Flow & Screenshots (cards-only page)
  await page.goto(`${appURL}/quota`, { waitUntil: 'networkidle' });
  await page.locator('.quota-page').first().waitFor({ state: 'visible', timeout: 15000 });

  // Verify card grid renders one card per credential
  const cardCount = await page.locator('article[class*="quota-card"]').count();
  check('quota page renders credential cards', cardCount > 0, `quotaCards=${cardCount}`);

  // Verify quota tab brand icons are not OpenAI
  const quotaAntigravitySvg = await page.locator('.quota-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }).locator('svg').innerHTML();
  check('quota page Antigravity tab icon is not OpenAI', !quotaAntigravitySvg.includes('OpenAI'));

  // Click header refresh to trigger live quota refresh (cards have their own refresh buttons)
  const refreshAllBtn = page.locator('.terminal-page-head').getByRole('button', { name: /刷新|Refresh/i });
  if (await refreshAllBtn.isVisible()) {
    await refreshAllBtn.click();
    await page.waitForTimeout(1500);
  }

  // Verify progress bars are visible with positive fill width after live refresh
  const progressCount = await page.locator('.quota-page .ant-progress').count();
  check('quota page renders progress bars', progressCount > 0, `count=${progressCount}`);
  if (progressCount > 0) {
    const firstProgressBg = page.locator('.quota-page .ant-progress-track').first();
    const progressWidth = await firstProgressBg.evaluate((el) => parseFloat(window.getComputedStyle(el).width));
    check('quota progress bar fill has positive width', progressWidth > 0, `width=${progressWidth}`);
  }

  // Screenshot: Card Grid View with refreshed quota data
  await page.screenshot({ path: path.join(root, 'tmp', 'quota-cards-desktop.png') });

  // Mobile & Light mode view for Quota page
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(root, 'tmp', 'quota-mobile-light.png') });
  // Restore viewport and dark theme
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await auditPage(page, responseBodies, '/logs', '.logs-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/config', '.config-page');

  // Config Page: Source tab switch requires reauthentication modal
  await page.goto(`${appURL}/config`, { waitUntil: 'networkidle' });
  const sourceSegment = page.locator('.ant-segmented-item').filter({ hasText: /源码|Source/ });
  if (await sourceSegment.isVisible()) {
    await sourceSegment.click();
    const reauthModal = page.locator('.ant-modal').filter({ hasText: /源码|Source/ });
    await reauthModal.waitFor({ state: 'visible', timeout: 5000 });
    check('config source switch prompts for reauthentication', await reauthModal.isVisible());
    await reauthModal.locator('input[type="password"]').fill(FAKE_CPA_MANAGEMENT_KEY);
    await reauthModal.locator('.ant-modal-footer button.ant-btn-primary').click();
    await reauthModal.waitFor({ state: 'hidden', timeout: 10000 });
    const sourceToolbar = page.locator('.config-source-toolbar');
    await sourceToolbar.waitFor({ state: 'visible', timeout: 10000 });
    check('source mode unlocks after valid reauthentication', await sourceToolbar.isVisible());
  }
  await auditPage(page, responseBodies, '/plugins', '.plugins-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/plugin-store', '.plugin-store-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/system', '.system-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/quick-start', '.quick-start-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  await page.goto(`${appURL}/dashboard`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.setItem('omc-theme', 'light'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('390px light view has no document overflow', mobileOverflow <= 1, `overflow=${mobileOverflow}`);
  check('light theme is active', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));

  // OAuth end-to-end against the deterministic fake: start a flow, confirm
  // the card polls `waiting`, submit a callback whose session already
  // completed on the CPA side (409), and assert the card converges to the
  // success state instead of painting an error over saved credentials.
  await page.goto(`${appURL}/oauth`, { waitUntil: 'networkidle' });
  await page.locator('.oauth-page').first().waitFor({ state: 'visible', timeout: 15000 });
  responseBodies.length = 0;
  const codexStart = page.locator('[data-oauth-start="codex"]');
  await codexStart.waitFor({ state: 'visible', timeout: 15000 });
  await codexStart.click();
  // The auth URL box (or the waiting status) proves the flow started and
  // the 3s status poller is running.
  const codexCard = page.locator('[data-oauth-card="codex"]');
  await codexCard.getByText(/等待|waiting/i).first().waitFor({ state: 'visible', timeout: 15000 });
  check('oauth start shows waiting state while polling', true);
  const callbackInput = codexCard.locator('[data-oauth-callback-input]');
  await callbackInput.waitFor({ state: 'visible', timeout: 15000 });
  await callbackInput.fill('http://127.0.0.1:8317/codex/callback?code=e2e-replayed&state=already-done');
  await codexCard.locator('[data-oauth-callback-submit]').click();
  // Idempotent success: the pre-completed session resolves to the
  // success badge, never to the callback error copy.
  await codexCard.getByText(/授权成功|认证成功|success/i).first().waitFor({ state: 'visible', timeout: 20000 });
  check('oauth replay callback converges to success', true);
  const replayError = await codexCard.getByText(/提交失败|failed to submit/i).count();
  check('oauth replay callback shows no error', replayError === 0, `errorBadges=${replayError}`);

  // Plugin-discovered OAuth: a CPA plugin advertising supports_oauth with an
  // oauth_provider joins the page with the same start/poll flow, and shows
  // the plugin's own logo (data-URI in the fixture, no network needed).
  const pluginCard = page.locator('[data-oauth-card="iflow"]');
  await pluginCard.waitFor({ state: 'visible', timeout: 15000 });
  check('oauth page renders plugin-discovered provider card', (await pluginCard.count()) > 0);
  check('plugin oauth card shows plugin logo', (await pluginCard.locator('img').count()) > 0);
  const pluginStart = page.locator('[data-oauth-start="iflow"]');
  await pluginStart.click();
  await pluginCard.getByText(/等待|waiting/i).first().waitFor({ state: 'visible', timeout: 15000 });
  check('plugin oauth start polls waiting state', true);

  // Bundle budget check
  const assetsDir = path.join(root, 'web', 'dist', 'assets');
  if (fs.existsSync(assetsDir)) {
    const mainEntry = fs.readdirSync(assetsDir).find((f) => f.startsWith('index-') && f.endsWith('.js'));
    if (mainEntry) {
      const entrySize = fs.statSync(path.join(assetsDir, mainEntry)).size;
      check('bundle budget: main entry under 250 kB', entrySize <= 250 * 1024, `${(entrySize / 1024).toFixed(2)} kB`);
    }
  }

  check('browser console has no unexplained errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('browser has no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('same-origin requests did not fail', requestFailures.length === 0, requestFailures.join(' | '));

  await context.clearCookies();
  await page.goto(`${appURL}/dashboard`, { waitUntil: 'networkidle' });
  check('expired session returns to sign-in', await page.locator('input[type="password"]').isVisible());
  check('fake CPA received authenticated management calls', fakeCpa.requests.some((request) => request.path === '/v0/management/auth-files'));
} catch (error) {
  console.error(error.stack || error.message);
  failures.push(error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill();
    await new Promise((resolve) => {
      appProcess.once('exit', resolve);
      setTimeout(resolve, 3000).unref();
    });
  }
  if (fakeCpa) await new Promise((resolve) => fakeCpa.server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} acceptance check(s) failed.`);
  if (appLog.length > 0) console.error(appLog.join('').slice(-8000));
  process.exitCode = 1;
} else {
  console.log(`\n${checks.length} deterministic browser checks passed.`);
}


