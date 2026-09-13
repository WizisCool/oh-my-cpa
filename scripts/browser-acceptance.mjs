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
  FAKE_CLIENT_SECRET,
  FAKE_CPA_MANAGEMENT_KEY,
  FAKE_PROVIDER_SECRET,
} from './fake-cpa.mjs';
// The cadences every wait below is expressed against, imported from the modules
// the app itself uses rather than copied. A local copy of the debounce is how a
// suite ends up timing itself against a number the product no longer honours.
import { EVENT_AUTO_REFRESH_MS, EVENT_SEARCH_DEBOUNCE_MS } from '../web/src/types/usageEventView.ts';
import {
  createChecker,
  measureStable,
  pastDeadline,
  settleLayout,
  sleep,
  until,
} from './acceptance/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeOnly = process.argv.includes('--smoke');

class SmokeComplete extends Error {}
if (process.env.OMCPA_LIVE_CPA === '1') {
  await import('./browser-live-smoke.mjs');
  process.exit();
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-e2e-'));
// One master key for the whole run: the app, the seeder and the fingerprint
// assertions must all derive caller-key identities with the same key.
const MASTER_KEY = ['fixture', 'master', 'key', 'for', 'browser', 'acceptance', 'only'].join('-');
// The name the alias checks assign through the UI. It is deliberately not the
// key's own value: the assertions below prove the list shows this name while the
// filter keeps using the stored fingerprint.
const CLIENT_KEY_ALIAS = '验收专用密钥';
const executable = path.join(temporary, process.platform === 'win32' ? 'oh-my-cpa.exe' : 'oh-my-cpa');
const appLog = [];
const { check, checkEventually, checkHoldsFor, checks, failures } = createChecker();
let appProcess;
let browser;
let fakeCpa;
let appURL;

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

async function lobeIconSignature(locator) {
  return locator.evaluate((root) => {
    const image = root.querySelector('img[src*="/lobe-icons/"]');
    if (image) return image.getAttribute('src') ?? '';
    const masked = [...root.querySelectorAll('span')].find((node) => {
      const style = getComputedStyle(node);
      return (style.maskImage && style.maskImage !== 'none')
        || (style.webkitMaskImage && style.webkitMaskImage !== 'none');
    });
    if (!masked) return '';
    const style = getComputedStyle(masked);
    return style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage;
  });
}

/**
 * Reads a brand drawing's resolved source and its rendered ink.
 *
 * The pixel count is the part that matters: the light and dark drawings are separate files
 * with the same geometry, so a wrong or missing fill still loads, still reports a positive
 * naturalWidth, and still differs by filename. Only counting the drawn ink shows whether the
 * mark is actually visible against the surface it sits on.
 */
async function brandMarkState(page, selector = '.app-brand-logo') {
  return page.evaluate(async (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { src: '', naturalWidth: 0, darkPixels: 0, lightPixels: 0, hasDarkInk: false, hasLightInk: false };
    const image = new Image();
    image.src = el.currentSrc || el.src;
    await image.decode().catch(() => {});
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || 1;
    canvas.height = image.naturalHeight || 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let darkPixels = 0;
    let lightPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      const [red, green, blue, alpha] = [data[index], data[index + 1], data[index + 2], data[index + 3]];
      if (alpha < 128) continue;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (luminance < 90) darkPixels += 1;
      else if (luminance > 200) lightPixels += 1;
    }
    return {
      src: image.src,
      naturalWidth: image.naturalWidth,
      darkPixels,
      lightPixels,
      hasDarkInk: darkPixels > 50,
      hasLightInk: lightPixels > 50,
    };
  }, selector);
}

function shorten(value, max = 64) {
  if (typeof value !== 'string') return String(value);
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function auditPage(page, responseBodies, route, selector, { pageSecrets = [] } = {}) {
  await page.goto(`${appURL}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 });
  const bodyText = await page.locator('body').innerText();
  const overflow = await measureStable(
    () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { page, label: `the ${route} overflow measurement` },
  );
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
    const output = execFileSync(
      seeder,
      [
        '-db',
        path.join(temporary, 'data', 'oh-my-cpa.db'),
        '-scenario',
        name,
        // The seeder must fingerprint with the same master key the app runs with,
        // or a caller-key identity it writes would not be one the app can derive.
        '-master-key',
        MASTER_KEY,
      ],
      { cwd: root, encoding: 'utf8' },
    );
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
      OMCPA_MASTER_KEY: MASTER_KEY,
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

  await page.goto(`${appURL}/dashboard`, { waitUntil: 'domcontentloaded' });
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

  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // The list is virtualized, so only the visible window of rows is in the DOM;
  // the footer reports the real page size.
  const visibleRows = await page.locator('.request-row').count();
  const footerText = await page.locator('.request-pagination span').first().innerText();
  check('request list renders seeded records', visibleRows >= 2, `visibleRows=${visibleRows}`);
  check('the whole seeded page is loaded', /50/.test(footerText), `footer="${footerText}"`);

  if (smokeOnly) {
    check('browser console has no errors in the smoke path', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('browser has no page errors in the smoke path', pageErrors.length === 0, pageErrors.join(' | '));
    throw new SmokeComplete();
  }

  // Latency carries no verdict colour. The fixture's slowest row is a nine-minute
  // agent request, and an absolute threshold used to paint it amber. It is located
  // by its own latency rather than by position: the list is ordered by request
  // time, so the slowest request is not the first row.
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
  const latencyTexts = await page.locator('.request-row .req-latency-val').allInnerTexts();
  const slowestLatency = latencyTexts.reduce((worst, text) => {
    const seconds = /m /.test(text)
      ? Number.parseFloat(text) * 60
      : Number.parseFloat(text) || 0;
    return Math.max(worst, seconds);
  }, 0);
  check('long agent latency is rendered without a warning colour', !latencyColours.includes(warnColour), `colours=${latencyColours.length}`);
  // Anchored so the assertion above cannot pass vacuously on an empty list.
  check('a long agent request really is on screen', slowestLatency > 60, `slowest=${slowestLatency}s`);

  // The window states no ordering label: the list's order now matches the time
  // column it displays, so there is nothing to explain. The absence is pinned.
  check('the window states no ordering label', (await page.locator('.request-order-hint').count()) === 0);
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
  await checkEventually(
    'selecting a facet writes the committed filter to the URL',
    () => filterSuffix().includes(`model=${encodeURIComponent(firstModel)}`),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('a committed filter appears as a removable chip', (await page.locator('.req-filter-chip').count()) >= 1);

  // Removing the chip must clear the filter. This is the regression guard for
  // the persistence bug where a cleared filter was written straight back from
  // the stale query and reappeared on the next navigation.
  await page.locator('.req-filter-chip-remove').first().click();
  await checkEventually(
    'removing the chip clears the filter from the URL',
    () => !filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('removing the only filter hides the chip strip', (await page.locator('.req-filter-chip').count()) === 0);

  // The advanced drawer is a draft: Apply commits once, Cancel discards.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  const drawerGroups = await page.locator('.req-filter-group-title').allInnerTexts();
  check('the advanced panel groups its fields', drawerGroups.length >= 4, `groups=${drawerGroups.join('|')}`);
  const latencyMin = page.locator('#req-range-latency-min');
  await latencyMin.fill('30000');
  // Irreducible window. The claim is that nothing happens, so the only evidence
  // is that nothing happens for as long as the app could still have acted. The
  // drawer commits on Apply, so the app's shortest debounce bounds how late a
  // stray write could arrive.
  await checkHoldsFor(
    'editing a draft field does not change the URL',
    () => !filterSuffix().includes('latency_min'),
    EVENT_SEARCH_DEBOUNCE_MS,
    { detail: () => `url=${filterSuffix()}` },
  );
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
  await checkEventually(
    'applying the drawer commits the range once',
    () => filterSuffix().includes('latency_min=30000'),
    { detail: () => `url=${filterSuffix()}` },
  );
  check(
    'an applied range is reported as a chip',
    (await page.locator('.req-filter-chip').allInnerTexts()).some((text) => /30000/.test(text)),
  );

  // A reversed range is a validation error, not a silently empty list.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#req-range-latency-min').fill('500');
  await page.locator('#req-range-latency-max').fill('100');
  await checkEventually(
    'a reversed range is explained inline',
    async () => (await page.locator('.req-filter-error').count()) >= 1,
  );
  await checkEventually(
    'a reversed range blocks Apply',
    () => page.locator('[data-testid="req-filter-apply"]').isDisabled(),
  );
  await page.locator('[data-testid="req-filter-cancel"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 5000 });

  // Clear-all returns the list to the bare window and leaves nothing behind.
  await page.locator('.req-clear-all-chips').click();
  await checkEventually(
    'clear-all removes every filter',
    () => new URL(page.url()).searchParams.toString().split('&').every((pair) => /^(preset|limit)=/.test(pair) || pair === ''),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('clear-all hides the chip strip', (await page.locator('.req-filter-chip').count()) === 0);
  check(
    'the list is back to the unfiltered page',
    /50/.test(await page.locator('.request-pagination span').first().innerText()),
  );

  // The result verdict is a filter with no URL parameter of its own, so the
  // reset affordance must still appear when it is the only thing narrowing the
  // list.
  await page.locator('.request-filters .req-result-segmented .ant-segmented-item').filter({ hasText: /失败|Failed/ }).click();
  await checkEventually(
    'the result verdict is committed to the URL',
    () => filterSuffix().includes('result=failed'),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('a result-only filter still offers Reset', await page.locator('.req-reset-filters').isVisible());
  // Clear-all must reset the filters without silently moving the reader to a
  // different hour. The window is chosen explicitly here, because the default
  // window is implicit in the URL and so cannot prove it was preserved.
  //
  // The hour is moved to 1h first. Asserting 24h directly used to pass on the
  // 24h the checks above had already committed, so the assertion could not have
  // failed for the reason its name gives; starting from a different window is
  // what makes "the time menu sets an explicit window" a real transition.
  await page.locator('.req-time-button').click();
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /1h/ })
    .first()
    .click();
  await until(() => filterSuffix().includes('preset=1h'), { label: 'a window other than 24h to be selected first' });
  await page.locator('.req-time-button').click();
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /24h/ })
    .first()
    .click();
  await checkEventually(
    'the time menu sets an explicit window',
    () => filterSuffix().includes('preset=24h'),
    { detail: () => `url=${filterSuffix()}` },
  );
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await checkEventually(
    'a filter and a window coexist in the URL',
    () => filterSuffix().includes('preset=24h') && filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  await page.locator('.req-clear-all-chips').click();
  await checkEventually(
    'clear-all removes the filter',
    () => !filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('clear-all keeps the chosen window', filterSuffix().includes('preset=24h'), `url=${filterSuffix()}`);

  // A pending debounce must not resurrect a filter that was just cleared. A
  // committed facet is seeded first: without one the chip strip is absent, so
  // clicking "clear all" would have no target and the check could pass vacuously
  // while the debounce wrote `q` back afterwards.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await checkEventually(
    'a facet is committed before the debounce race',
    () => filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  await page.locator('.request-search input').type('gpt', { delay: 20 });
  // Deliberately shorter than the debounce, so the timer is still pending when
  // the clear lands. This window can never become a condition wait: the test has
  // to interrupt the debounce, which means acting before the deadline rather than
  // waiting for something to become true. Derived from the app's own debounce
  // instead of the hand-tuned millisecond it used to be.
  await sleep(EVENT_SEARCH_DEBOUNCE_MS / 3);
  await page.locator('.req-clear-all-chips').click();
  // Past the debounce deadline. The slack is not padding: this is a negative
  // claim, so the window has to outlast every moment at which the queued
  // keystroke could still have landed.
  await pastDeadline(EVENT_SEARCH_DEBOUNCE_MS, { slackMs: 550 });
  check('a pending search debounce cannot revive a cleared filter', !filterSuffix().includes('q='), `url=${filterSuffix()}`);
  check('the clear also removed the committed facet', !filterSuffix().includes('model='), `url=${filterSuffix()}`);
  check('the search box is emptied by the clear', (await page.locator('.request-search input').inputValue()) === '');

  // A filter change must drop the pagination position rather than reusing a
  // cursor that was minted against a different result set.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  // The facet commit is the URL write this claim is about, so it is awaited
  // rather than slept through: without it the "no cursor" assertion could be
  // reading a URL that never changed.
  await until(() => filterSuffix().includes('model='), {
    label: 'the facet commit that drops the cursor',
  });
  check('a filter change drops the cursor', !filterSuffix().includes('cursor='), `url=${filterSuffix()}`);
  await page.locator('.req-clear-all-chips').click();
  await until(() => !filterSuffix().includes('model='), { label: 'clear-all to drop the facet'});
  // Return to the window the rest of the audit expects before it continues.
  await page.locator('.req-time-button').click();
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /1h/ })
    .first()
    .click();
  await until(() => filterSuffix().includes('preset=1h'), { label: 'the 1h window to be selected' });
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  check('the audit resumed on the default window', filterSuffix() === initialFilterQuery, `before=${initialFilterQuery} after=${filterSuffix()}`);

  // Ordering: the visible time column must be monotonic. The fixture writes its
  // slow agent request last but gives it the oldest start time, so a regression
  // back to recording order would put it first and invert the column.
  const ordered = await rowTimestamps();
  const strictlyDescending = ordered.every((value, index) => index === 0 || ordered[index - 1] >= value);
  check(
    'the list is ordered by request time, newest first',
    ordered.length >= 2 && strictlyDescending,
    `order=${ordered.slice(0, 4).map((value) => new Date(value).toISOString()).join(' > ')}`,
  );
  // The slow request is recorded last yet starts earliest, so request-time order
  // must place it below the top: this is the row that distinguishes the two
  // orderings, and asserting only monotonicity above could pass on a fixture
  // where nothing disagrees.
  check(
    'the last-recorded but earliest-starting request is not the first row',
    ordered.length >= 2 && ordered[0] > ordered[ordered.length - 1],
    `first=${new Date(ordered[0]).toISOString()} last=${new Date(ordered[ordered.length - 1]).toISOString()}`,
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
    'the enabled switch states no cadence label',
    (await page.locator('.req-auto-refresh-cadence').count()) === 0,
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
  // The scroll is what the whole block compares against afterwards, so the check
  // that it registered is also the gate for reading the value.
  await checkEventually(
    'the list actually scrolled away from the top',
    async () => (await scroller.evaluate((node) => node.scrollTop)) > 100,
    {
      detail: async () => `scrollTop=${await scroller.evaluate((node) => node.scrollTop)}`,
    },
  );
  const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
  // What the poll must not disturb is *which* rows are under the cursor, so the
  // comparison below is by row identity rather than by mounted row count. The
  // count is a moving target: the virtualized window keeps filling in for several
  // frames after the scroll, so a count read at any single moment reports a
  // smaller "before" and makes an untouched list look as if the poll had
  // inserted a row above the reader - a real failure that the flat pause this
  // replaces used to hide behind its own latency.
  const visibleRowIdentities = () =>
    page.locator('.request-row .req-col-time time').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('datetime') ?? ''),
    );
  // A virtualized window has no completion event: it keeps filling for an
  // unbounded number of frames after the scroll, and two animation frames can
  // agree on a window that is still growing. Requiring the window to hold across
  // a real gap is the only condition available here. 250 ms is the smallest gap
  // that proved sufficient (two animation frames were not) and stays under the
  // blind 400 ms pause this replaces, with the difference that the read now
  // verifies the window has stopped growing instead of assuming it.
  const windowBefore = await measureStable(
    async () => (await visibleRowIdentities()).join('|'),
    { page, label: 'the visible row window at the scrolled position', settleMs: 250 },
  );
  const rowsBefore = windowBefore.split('|').filter(Boolean);
  const pageLabelBefore = await page.locator('.request-pagination span').first().innerText();

  seedScenario('append');
  // The cadence is 10s, so the wait has to clear one full interval plus the
  // request itself. It was 20s against the old 5s option.
  //
  // This is the largest wait left in the suite and it is irreducible from the
  // test side: the interval was scheduled by the page when auto-refresh was
  // switched on, so only a fake clock installed before that navigation could
  // fire it early - and a fake clock would also freeze the search debounce this
  // same block asserts on. Buying back ten seconds there would cost the coverage
  // that made the block worth writing.
  await page.locator('.req-back-to-top-btn.is-live').waitFor({ state: 'visible', timeout: 30000 });

  const scrollAfterPoll = await scroller.evaluate((node) => node.scrollTop);
  const rowsAfterPoll = await visibleRowIdentities();
  const pageLabelAfter = await page.locator('.request-pagination span').first().innerText();
  check('a poll does not scroll the reader back to the top', Math.abs(scrollAfterPoll - scrollBefore) <= 4, `before=${scrollBefore} after=${scrollAfterPoll}`);
  check(
    'a poll does not reorder the rows under the cursor',
    rowsAfterPoll.length >= rowsBefore.length &&
      rowsBefore.every((datetime, index) => rowsAfterPoll[index] === datetime),
    `before=${rowsBefore.length} after=${rowsAfterPoll.length} topBefore=${rowsBefore[0] ?? 'none'} topAfter=${rowsAfterPoll[0] ?? 'none'}`,
  );
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
  await checkEventually(
    'applying the backlog returns to the top',
    async () => (await scroller.evaluate((node) => node.scrollTop)) <= 4,
    { detail: async () => `scrollTop=${await scroller.evaluate((node) => node.scrollTop)}` },
  );
  const newestFirst = await rowTimestamps();
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
  // The window is a precondition for the page-size check below, not a claim of
  // its own, so it is awaited without being reported as a check.
  await until(() => filterSuffix().includes('preset=24h'), { label: 'the 24h window to be committed' });
  await page.locator('.request-pagination .ant-select').click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: /250/ })
    .first()
    .click();
  await checkEventually(
    'the page size is committed',
    () => filterSuffix().includes('limit=250'),
    { detail: () => `url=${filterSuffix()}` },
  );

  // Every preset stays selectable exactly once, including whichever is selected,
  // for a quick preset and a slow one. A menu that omits the current choice is how
  // the operator loses the ability to see or return to the window they are on.
  for (const selected of ['1h', '7d']) {
    await page.goto(`${appURL}/usage/events?preset=${selected}`, { waitUntil: 'domcontentloaded' });
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
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // Rendering the chips is the signal that the page has parsed the navigated URL
  // and normalised it; the checks below read that normalised result rather than
  // the raw link.
  await until(async () => (await page.locator('.req-filter-chip').count()) >= 1, {
    label: 'the navigated filters to render as chips',
  });
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
  await checkEventually(
    'clear-all drops the filters',
    () => !filterSuffix().includes('cost=') && !filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  check(
    'clear-all keeps the window and the page size',
    filterSuffix().includes('preset=24h') && filterSuffix().includes('limit=250'),
    `url=${filterSuffix()}`,
  );
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // Hydration from the saved view is the event all four checks below read, so it
  // is awaited rather than slept through.
  await checkEventually(
    'the saved window is restored on the bare route',
    () => filterSuffix().includes('preset=24h'),
    { detail: () => `url=${filterSuffix()}` },
  );
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
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
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
  await checkEventually(
    'typing an alias the window does not report creates a tag',
    async () => (await page.locator('.req-filter-drawer').innerText()).includes('retired-alias'),
  );
  check(
    'a typed alias marks the draft as changed',
    !(await page.locator('[data-testid="req-filter-apply"]').isDisabled()),
  );
  await page.locator('[data-testid="req-filter-apply"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  await checkEventually(
    'a typed alias reaches the URL',
    () => filterSuffix().includes('model_alias=retired-alias'),
    { detail: () => `url=${filterSuffix()}` },
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
  await checkEventually(
    'the alias filter can be cleared',
    () => !filterSuffix().includes('model_alias'),
    { detail: () => `url=${filterSuffix()}` },
  );

  // A filter changed while a keystroke is still queued must survive: the queued
  // commit has to patch the newest URL rather than restore the snapshot captured
  // when it was scheduled.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await until(() => filterSuffix().includes('model='), {
    label: 'the committed facet the queued keystroke has to survive',
  });
  const committedModel = new URL(page.url()).searchParams.get('model');
  await page.locator('.request-search input').type('gpt', { delay: 20 });
  // Inside the debounce window: the queued commit has to still be pending when
  // the unrelated dimension changes. Derived from the app's debounce so a change
  // there cannot silently move this test outside the window it needs to be in.
  await sleep(EVENT_SEARCH_DEBOUNCE_MS / 4);
  // Change an unrelated dimension inside the debounce window.
  await providerFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  // Waiting for the queued commit to land is both faster and stronger than the
  // flat window this replaces: it stops as soon as the debounce fires, and it
  // fails loudly instead of expiring quietly if the commit never arrives.
  await checkEventually(
    'the queued search still lands',
    () => filterSuffix().includes('q=gpt'),
    { detail: () => `url=${filterSuffix()}` },
  );
  const afterRace = new URL(page.url()).searchParams;
  check('a queued search does not erase a filter chosen during the debounce', afterRace.get('model') === committedModel, `url=${filterSuffix()}`);
  check('the provider chosen during the debounce survives', afterRace.get('provider') !== null, `url=${filterSuffix()}`);
  await page.locator('.req-clear-all-chips').click();
  await checkEventually(
    'the race left the view clearable',
    async () => (await page.locator('.req-filter-chip').count()) === 0,
    { detail: () => `url=${filterSuffix()}` },
  );

  // Search text must follow the URL when the operator navigates between two saved
  // search views. A debounce that only listens for its own commits would let the
  // loaded value be overwritten by the one it replaced.
  for (const term of ['alpha-search', 'beta-search']) {
    await page.goto(`${appURL}/usage/events?preset=24h&q=${term}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.request-row, .ant-empty').first().waitFor({ state: 'visible', timeout: 15000 });
    await checkEventually(
      `the search box shows the navigated term (${term})`,
      async () => (await page.locator('.request-search input').inputValue()) === term,
      { detail: async () => `input=${await page.locator('.request-search input').inputValue()}` },
    );
    // Past the debounce window: a stale timer would rewrite the URL here. Another
    // irreducible window - the claim is that a cancelled timer stays cancelled,
    // so the evidence has to span every moment it could still have fired.
    await pastDeadline(EVENT_SEARCH_DEBOUNCE_MS);
    check(
      `the navigated term survives the debounce window (${term})`,
      filterSuffix().includes(`q=${term}`) &&
        (await page.locator('.request-search input').inputValue()) === term,
      `url=${filterSuffix()} input=${await page.locator('.request-search input').inputValue()}`,
    );
  }
  await page.locator('.req-clear-all-chips').click();
  await until(() => !filterSuffix().includes('q='), { label: 'clear-all to drop the search term' });

  // A malformed parameter must be reported, not silently dropped: dropping it would
  // show a wider result set than the link asked for while the panel still looked
  // narrowed, which is the failure mode this notice exists to prevent.
  await page.goto(`${appURL}/usage/events?preset=24h&latency_min=abc&cost=maybe`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.usage-events-page .ant-alert').first().waitFor({ state: 'visible', timeout: 10000 });
  const rejectedNotice = await page.locator('.usage-events-page .ant-alert').first().innerText();
  check('an unusable filter parameter is reported', /latency_min/.test(rejectedNotice) && /cost/.test(rejectedNotice), `notice=${JSON.stringify(rejectedNotice)}`);
  check('the list still runs on the usable filters', (await page.locator('.request-row').count()) > 0);
  await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  check('a clean URL shows no notice', (await page.locator('.usage-events-page .ant-alert').count()) === 0);

  // Same-component navigation with a pending keystroke. `page.goto` remounts the
  // page, so it cannot exercise this: the two URLs below share a committed `q`, so
  // only history navigation (not the committed value) distinguishes them.
  await page.goto(`${appURL}/usage/events?preset=24h&q=keep-me&provider=openai`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row, .ant-empty').first().waitFor({ state: 'visible', timeout: 15000 });
  // The rows rendering proves the shell mounted, which is also what registers the
  // popstate listener the two pushes below depend on.
  // Client-side navigation to the same view with a different unrelated dimension.
  await page.evaluate(() => history.pushState({}, '', '/omc/usage/events?preset=24h&q=keep-me&provider=claude'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await page.locator('.request-search input').click();
  await page.keyboard.type('stale-typing', { delay: 20 });
  // Navigate again before the debounce commits.
  await page.evaluate(() => history.pushState({}, '', '/omc/usage/events?preset=24h&q=keep-me&provider=gemini'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  // Negative claim, irreducible window: the queued keystroke has to be given the
  // full debounce deadline to fail to arrive. The slack matches the flat window
  // this replaces, so the evidence is neither weaker nor shorter than before.
  await pastDeadline(EVENT_SEARCH_DEBOUNCE_MS, { slackMs: 550 });
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
  await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });

  // Switching the poll off again keeps the rest of the audit deterministic.
  await autoRefreshSwitch.click();
  check('auto-refresh turns off again', !(await autoRefreshSwitch.isChecked()));

  // A manual refresh is the other event that re-reads the facets: the operator
  // asked for current data, and stale dropdown counts are on screen too.
  const manualFacets = [];
  const countManualFacet = (request) => {
    if (request.url().includes('/usage/facets')) manualFacets.push(request.url());
  };
  page.on('request', countManualFacet);
  // The evidence is a network event, so the wait is for that event. A flat window
  // could only hope the request had already happened, and would report the count
  // as zero when the machine was merely slow.
  const facetRefresh = page
    .waitForRequest((request) => request.url().includes('/usage/facets'), { timeout: 10000 })
    .catch(() => null);
  await page.locator('.terminal-page-head .request-actions button').last().click();
  const facetRefreshLanded = (await facetRefresh) !== null;
  page.off('request', countManualFacet);
  check('a manual refresh re-reads the facets', facetRefreshLanded && manualFacets.length >= 1, `requests=${manualFacets.length}`);
  await page.screenshot({ path: path.join(root, 'tmp', 'req-page-desktop.png') });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 800 });
    // Measured once it stops moving instead of after a flat pause: the property
    // the old sleep was guessing at is that the responsive reflow has finished.
    const overflow = await measureStable(
      () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)),
      { page, label: 'the request page overflow measurement' },
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
    const drawerOverflow = await measureStable(
      () =>
        page.evaluate(() => {
          const panel = document.querySelector('.req-filter-drawer .ant-drawer-body');
          if (!panel) return -1;
          // Content wider than the panel is the failure mode a narrow viewport
          // exposes: a range pair whose inputs cannot shrink pushes the dialog off
          // screen.
          return Math.round(panel.scrollWidth - panel.clientWidth);
        }),
      { page, label: 'the filter drawer overflow measurement' },
    );
    check(`filter drawer fits at ${width}px`, drawerOverflow <= 1, `drawerOverflow=${drawerOverflow}`);
    const drawerOnScreen = () =>
      page.evaluate(() => {
        const root = document.querySelector('.req-filter-drawer');
        if (!root) return 'no root';
        // The positioning element is not guaranteed to be a fixed class name in
        // antd v6, so the check walks the drawer's own elements and requires that
        // at least one sizing box sits inside the viewport.
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
    // The assertion is also the wait. The drawer slides in from the right, so a
    // fixed pause either samples it mid-slide - reporting an off-screen panel as a
    // failure, which is what a flat 250ms did here - or wastes the rest of the
    // window on a drawer that arrived immediately.
    await checkEventually(
      `filter drawer stays on screen at ${width}px`,
      async () => (await drawerOnScreen()) === true,
      { detail: async () => String(await drawerOnScreen()) },
    );
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
    const modalOnScreen = () =>
      page.evaluate(() => {
        const dialog = document.querySelector('.req-time-modal');
        if (!dialog) return 'no dialog';
        const box = dialog.getBoundingClientRect();
        if (box.left < -1 || box.right > window.innerWidth + 1) {
          return `left=${Math.round(box.left)} right=${Math.round(box.right)} viewport=${window.innerWidth}`;
        }
        return true;
      });
    // Same shape as the drawer above: the dialog scales into place, so the
    // placement assertion waits for it rather than sampling a fixed pause after
    // it became nominally visible.
    await checkEventually(
      `custom time dialog stays on screen at ${width}px`,
      async () => (await modalOnScreen()) === true,
      { detail: async () => String(await modalOnScreen()) },
    );
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

  // The provider homepage is console metadata, so the row's own name is the link
  // when one is stored, and it must open safely. Both states are exercised:
  // with a stored website the name becomes a safe external link, and with none
  // it stays plain text rather than becoming a dead link or a link to nowhere.
  const setProviderWebsite = async (value) => {
    const status = await page.evaluate(async (body) => {
      const response = await fetch('/omc/api/v1/preferences/provider_websites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      return response.status;
    }, JSON.stringify(value));
    check('provider website preference is writable through the API', status === 200, `status=${status}`);
  };
  const openProvidersPage = async () => {
    await page.goto(`${appURL}/ai-providers`, { waitUntil: 'domcontentloaded' });
    await page.locator('.providers-page tbody tr').first().waitFor({ state: 'visible', timeout: 15000 });
  };

  await openProvidersPage();
  check(
    'a provider with no website keeps its name as plain text',
    (await page.locator('.providers-page tbody a').count()) === 0,
    `links=${await page.locator('.providers-page tbody a').count()}`,
  );

  // The fake CPA's only configured provider is the codex entry, which the
  // console addresses as `codex-0`.
  await setProviderWebsite({ 'codex-0': 'https://provider.example.test' });
  await openProvidersPage();
  const websiteLink = page.locator('.providers-page tbody a').first();
  await checkEventually(
    'a provider with a website renders its name as a link',
    () => websiteLink.isVisible(),
  );
  const websiteHref = (await websiteLink.getAttribute('href')) ?? '';
  const websiteRel = (await websiteLink.getAttribute('rel')) ?? '';
  const websiteTarget = (await websiteLink.getAttribute('target')) ?? '';
  check(
    'the provider link points at the stored website',
    websiteHref === 'https://provider.example.test',
    `href=${websiteHref}`,
  );
  check(
    'the provider link opens in a new tab without handing over window.opener',
    websiteTarget === '_blank' && websiteRel.includes('noopener') && websiteRel.includes('noreferrer'),
    `target=${websiteTarget} rel=${websiteRel}`,
  );

  // Clearing it returns the row to plain text, so the link is a property of the
  // record rather than of the page having been visited.
  await setProviderWebsite({});
  await openProvidersPage();
  check(
    'clearing the website returns the name to plain text',
    (await page.locator('.providers-page tbody a').count()) === 0,
  );

  // ---- Provider enable/disable: consecutive-operation reliability ----
  //
  // The requirement is that a second click is never lost and that the row never
  // settles on a value the gateway does not hold. The fake CPA now keeps the codex
  // API-key list in memory and replaces it on a write, which is what makes the
  // round trip observable: the toggle disables an entry, re-reads the list, and
  // the entry really is disabled the second time.
  const providerSwitch = page.locator('.providers-page tbody .ant-switch').first();
  await providerSwitch.waitFor({ state: 'visible', timeout: 15000 });

  /** Reads the gateway's own answer for one provider, rather than trusting the page. */
  const providerEnabledFromApi = async (id) => {
    const body = await page.evaluate(() => fetch('/omc/api/v1/management/providers').then((r) => r.json()));
    const row = (body.providers ?? []).find((provider) => provider.id === id);
    return row === undefined ? undefined : !row.disabled;
  };

  const toggleWrites = [];
  const recordToggleWrite = (request) => {
    if (request.method() !== 'PATCH' || !request.url().includes('/management/providers/status')) return;
    try {
      toggleWrites.push(JSON.parse(request.postData() ?? '{}'));
    } catch {
      toggleWrites.push({ unparsable: request.postData() });
    }
  };
  page.on('request', recordToggleWrite);

  const initialEnabled = await providerEnabledFromApi('codex-0');
  check(
    'the provider row starts enabled, so the toggle has somewhere to go',
    initialEnabled === true,
    `enabled=${initialEnabled}`,
  );
  check(
    'the single fixture provider renders exactly one enable switch',
    (await page.locator('.providers-page tbody .ant-switch').count()) === 1,
    `switches=${await page.locator('.providers-page tbody .ant-switch').count()}`,
  );

  // One deliberate click first, to pin the whole round trip before measuring a
  // burst: the click asks for disabled, the write says disabled, the control
  // reports disabled, and the gateway agrees.
  await providerSwitch.click();
  await checkEventually(
    'a click on the switch reports the value that click asked for',
    async () => (await providerSwitch.getAttribute('aria-checked')) === 'false',
    { detail: async () => `aria-checked=${await providerSwitch.getAttribute('aria-checked')}` },
  );
  check(
    'the toggle writes to the codex family at index 0 rather than the row id',
    toggleWrites.length === 1 &&
      toggleWrites[0].family === 'codex' &&
      toggleWrites[0].index === 0 &&
      toggleWrites[0].disabled === true,
    JSON.stringify(toggleWrites),
  );
  await checkEventually(
    'the gateway itself holds the value the click asked for',
    async () => (await providerEnabledFromApi('codex-0')) === false,
    { detail: async () => `api=${await providerEnabledFromApi('codex-0')}` },
  );
  const settledEnabled = await providerEnabledFromApi('codex-0');
  check(
    'the rendered switch agrees with a fresh read of the providers API',
    (await providerSwitch.getAttribute('aria-checked')) === String(settledEnabled),
    `aria-checked=${await providerSwitch.getAttribute('aria-checked')} api=${settledEnabled}`,
  );

  // The rapid burst: several clicks with no waiting in between, which is the
  // gesture that used to lose an operation. They are dispatched from inside one
  // page script rather than one Playwright call at a time, so an unawaited
  // `click()` cannot serialise the burst behind its own actionability checks and
  // hide the very window being probed. Every click's requested value is recorded
  // in order, so the last entry is exactly "what the operator last asked for".
  const burst = await page.evaluate(() => {
    const node = document.querySelector('.providers-page tbody .ant-switch');
    if (!node) return { clicks: 0, intents: [], accepted: [] };
    const intents = [];
    const accepted = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const before = node.getAttribute('aria-checked') === 'true';
      const wanted = !before;
      intents.push(wanted);
      accepted.push(!node.disabled);
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    return { clicks: intents.length, intents, accepted };
  });
  check(
    'the rapid burst dispatched every click it intended to',
    burst.clicks === 5,
    `clicks=${burst.clicks}`,
  );

  const lastIntent = burst.intents[burst.intents.length - 1];
  // The burst is over when the queue has drained, which is observable as "the
  // switch no longer reports a write in flight". Waiting for that first is what
  // keeps the two checks below from passing on a transient: mid-burst the row
  // already shows the newest intent, so an assertion taken then would be green
  // for the wrong reason.
  await checkEventually(
    'the burst stops reporting a write in flight',
    async () => !(await providerSwitch.getAttribute('class'))?.includes('ant-switch-loading'),
    { timeoutMs: 15000, detail: async () => `class=${await providerSwitch.getAttribute('class')}` },
  );

  // The requirement, stated directly: once the queue drains, what the row shows is
  // what the last click asked for, and a fresh read of the gateway agrees with it.
  await checkEventually(
    'a rapid burst settles on the value of the last click',
    async () => (await providerSwitch.getAttribute('aria-checked')) === String(lastIntent),
    {
      timeoutMs: 15000,
      detail: async () =>
        `aria-checked=${await providerSwitch.getAttribute('aria-checked')} lastIntent=${lastIntent} writes=${toggleWrites.length} clicks=${burst.clicks}`,
    },
  );
  const burstApiEnabled = await providerEnabledFromApi('codex-0');
  check(
    'after a rapid burst the switch still agrees with the gateway',
    (await providerSwitch.getAttribute('aria-checked')) === String(burstApiEnabled),
    `aria-checked=${await providerSwitch.getAttribute('aria-checked')} api=${burstApiEnabled} writes=${toggleWrites.length}`,
  );
  check(
    'a rapid burst never costs more writes than it had clicks',
    toggleWrites.length > 0 && toggleWrites.length <= burst.clicks,
    `writes=${toggleWrites.length} clicks=${burst.clicks} accepted=${burst.accepted.filter(Boolean).length}`,
  );
  // The coalescing property that makes this a root-cause fix rather than a lock:
  // the clicks arrive in one synchronous script, so no network round trip can
  // resolve between them and the queue has no chance to send each one. The burst
  // therefore costs strictly fewer writes than it had clicks - while still ending
  // on the last click's value, which the checks around this one pin. A queue that
  // fired one request per click (or that dropped the later ones) cannot satisfy
  // both at once.
  check(
    'a rapid burst coalesces instead of writing once per click',
    toggleWrites.length < burst.clicks,
    `writes=${toggleWrites.length} clicks=${burst.clicks}`,
  );
  check(
    'every burst write names the codex family at index 0',
    toggleWrites.every((write) => write.family === 'codex' && write.index === 0),
    JSON.stringify(toggleWrites),
  );
  // The last write the gateway received must be the last click's intent. A queue
  // that dropped the final click, or let an older response win, fails here even
  // when the write count looks healthy.
  const lastWrite = toggleWrites[toggleWrites.length - 1];
  check(
    'the last write the gateway received is the last click intent',
    lastWrite !== undefined && lastWrite.disabled === !lastIntent,
    `lastWrite=${JSON.stringify(lastWrite)} lastIntentEnabled=${lastIntent}`,
  );

  // The status label and the switch are two statements about the same fact on
  // one row, and both read the row's single `resolveEnabled`. A burst is exactly
  // when they could drift apart, so the agreement is asserted rather than assumed.
  const statusCellText = await page.locator('.providers-page tbody tr').first().innerText();
  const switchEnabled = (await providerSwitch.getAttribute('aria-checked')) === 'true';
  check(
    'the status label and the switch agree on the same row',
    switchEnabled ? /Active|正常/.test(statusCellText) : /Disabled|已停用/.test(statusCellText),
    `switch=${switchEnabled} row="${statusCellText.replace(/\s+/g, ' ').trim()}"`,
  );

  page.off('request', recordToggleWrite);

  // The suite reuses this app and fake CPA, so the fixture is put back where the
  // rest of the run expects to find it and then confirmed, rather than assumed.
  if ((await providerEnabledFromApi('codex-0')) !== initialEnabled) {
    await providerSwitch.click();
  }
  await checkEventually(
    'the provider row is left enabled for the rest of the run',
    async () => (await providerEnabledFromApi('codex-0')) === initialEnabled,
    { detail: async () => `api=${await providerEnabledFromApi('codex-0')}` },
  );

  // The providers list is read with `include_keys=true`, so its response body
  // carries provider key material. auditPage scans whatever is still buffered in
  // `responseBodies`, and the next audit is for a page whose contract excludes
  // those secrets - so the buffer is cleared here, at the end of the block, where
  // the convention in this file puts it.
  responseBodies.length = 0;

  await auditPage(page, responseBodies, '/auth-files', '.auth-files-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // Auth Files Page Flow & Behavioral Checks
  await page.goto(`${appURL}/auth-files`, { waitUntil: 'domcontentloaded' });
  await page.locator('.auth-files-page').first().waitFor({ state: 'visible', timeout: 15000 });

  // 1. Initial card count
  const authCardCount = await page.locator('.auth-files-page .ant-card').count();
  check('auth-files page renders credential cards', authCardCount >= 5, `cards=${authCardCount}`);

  // 2. Search filtering
  const searchInput = page.locator('.auth-files-page input[placeholder*="Search"], .auth-files-page input[placeholder*="搜索"]').first();
  if (await searchInput.isVisible()) {
    await searchInput.fill('claude');
    await checkEventually(
      'auth-files search filters to matching file',
      async () => (await page.locator('.auth-files-page .ant-card').count()) === 1,
      { detail: async () => `count=${await page.locator('.auth-files-page .ant-card').count()}` },
    );
    await searchInput.fill('');
    // Clearing is a precondition for the tab checks below, so the list is awaited
    // rather than slept through.
    await until(async () => (await page.locator('.auth-files-page .ant-card').count()) > 1, {
      label: 'the cleared search box to restore the card list',
    });
  }

  // 3. Provider tabs & brand icons verification
  const codexTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Codex/i }).first();
  await codexTab.waitFor({ state: 'visible', timeout: 5000 });
  await codexTab.click();
  await checkEventually(
    'auth-files provider tab filters to Codex',
    async () => (await page.locator('.auth-files-page .ant-card').count()) === 2,
    { detail: async () => `count=${await page.locator('.auth-files-page .ant-card').count()}` },
  );
  const allTab = page.locator('.auth-files-page .ant-tabs-tab').first();
  await allTab.click();
  await until(async () => (await page.locator('.auth-files-page .ant-card').count()) > 2, {
    label: 'the unfiltered card list to come back',
  });

  // Verify brand icons on tabs are NOT OpenAI
  const antigravityTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }).first();
  const antigravityIcon = await lobeIconSignature(antigravityTab);
  check('Antigravity tab icon is not OpenAI', /antigravity/i.test(antigravityIcon) && !/openai/i.test(antigravityIcon), antigravityIcon);

  const xaiTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /xAI|Xai/i }).first();
  const xaiIcon = await lobeIconSignature(xaiTab);
  check('xAI tab icon is not OpenAI', /xai/i.test(xaiIcon) && !/openai/i.test(xaiIcon), xaiIcon);

  const kimiTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Kimi/i }).first();
  const kimiIcon = await lobeIconSignature(kimiTab);
  check('Kimi tab icon is not OpenAI', /kimi/i.test(kimiIcon) && !/openai/i.test(kimiIcon), kimiIcon);

  // Verify tab hover stability
  await codexTab.hover();
  // Read once the hover transition has settled: a mid-transition read would
  // compare an interpolated colour against the transparent check below.
  const hoverBackground = await measureStable(
    () => codexTab.evaluate((el) => window.getComputedStyle(el).backgroundColor),
    { page, label: 'the tab hover background' },
  );
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
  check('tab hover has valid background', hoverBackground !== 'transparent' && hoverBackground !== 'rgba(0, 0, 0, 0)', `bg=${hoverBackground}`);

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
  await checkEventually(
    'auth-files single toggle disables card',
    () => kimiCard.getByText(/DISABLED|已禁用/).first().isVisible(),
  );
  await kimiSwitch.click();
  await checkEventually(
    'auth-files single toggle re-enables card',
    () => kimiCard.getByText(/ACTIVE|正常/).first().isVisible(),
  );

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
    const overflow = await measureStable(
      () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)),
      { page, label: 'the auth-files page overflow measurement' },
    );
    check(`auth-files ${width}px viewport has no overflow`, overflow === 0, `overflow=${overflow}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await auditPage(page, responseBodies, '/oauth', '.oauth-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/quota', '.quota-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // Quota Cards Flow & Screenshots (cards-only page)
  await page.goto(`${appURL}/quota`, { waitUntil: 'domcontentloaded' });
  await page.locator('.quota-page').first().waitFor({ state: 'visible', timeout: 15000 });

  // Verify card grid renders one card per credential
  const cardCount = await page.locator('article[class*="quota-card"]').count();
  check('quota page renders credential cards', cardCount > 0, `quotaCards=${cardCount}`);

  // Verify quota tab brand icons are not OpenAI
  const quotaAntigravityIcon = await lobeIconSignature(page.locator('.quota-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }));
  check('quota page Antigravity tab icon is not OpenAI', /antigravity/i.test(quotaAntigravityIcon) && !/openai/i.test(quotaAntigravityIcon), quotaAntigravityIcon);

  // Click header refresh to trigger live quota refresh (cards have their own refresh buttons)
  const refreshAllBtn = page.locator('.terminal-page-head').getByRole('button', { name: /刷新|Refresh/i });
  if (await refreshAllBtn.isVisible()) {
    await refreshAllBtn.click();
  }

  // Verify progress bars are visible with positive fill width after live refresh
  await checkEventually(
    'quota page renders progress bars',
    async () => (await page.locator('.quota-page .ant-progress').count()) > 0,
    { detail: async () => `count=${await page.locator('.quota-page .ant-progress').count()}` },
  );
  const firstProgressBg = page.locator('.quota-page .ant-progress-track').first();
  await checkEventually(
    'quota progress bar fill has positive width',
    async () => (await firstProgressBg.evaluate((el) => parseFloat(window.getComputedStyle(el).width))) > 0,
    {
      detail: async () =>
        `width=${await firstProgressBg.evaluate((el) => parseFloat(window.getComputedStyle(el).width))}`,
    },
  );

  // Screenshot: Card Grid View with refreshed quota data
  await page.screenshot({ path: path.join(root, 'tmp', 'quota-cards-desktop.png') });

  // Mobile & Light mode view for Quota page
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  // The screenshot has to capture the applied theme, so the wait is for the paint
  // rather than for a flat pause.
  await settleLayout(page);
  await page.screenshot({ path: path.join(root, 'tmp', 'quota-mobile-light.png') });
  // Restore viewport and dark theme
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await auditPage(page, responseBodies, '/logs', '.logs-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/config', '.config-page');

  // ---- key management: the list is rendered from the config document ----
  // The page reads `api-keys` out of the parsed config YAML rather than calling
  // the immediate `/management/api-keys` facade, so a sequence node read without
  // unwrapping renders as an empty list no matter how many keys CPA holds. The
  // fixture keeps the config round trip stateful so this reads the real path.
  await page.goto(`${appURL}/api-keys`, { waitUntil: 'domcontentloaded' });
  await page.locator('.keys-page').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('.config-api-keys-table .ant-table-row').first().waitFor({ state: 'visible', timeout: 15000 });
  const keyRows = await page.locator('.config-api-keys-table .ant-table-row').count();
  check('key management lists the client keys CPA reports', keyRows === 1, `rows=${keyRows}`);
  const keySummary = await page.locator('.settings-group-head .ant-tag').first().innerText();
  check('key management counts the listed keys', /(^|\D)1(\D|$)/.test(keySummary), `summary="${keySummary}"`);
  // Masked by default: the row shows a preview, never the stored secret.
  const keyText = await page.locator('.config-api-keys-table .config-key-text').first().innerText();
  check(
    'key management masks the stored secret',
    keyText.includes('•') && keyText !== FAKE_CLIENT_SECRET,
    `text="${keyText}"`,
  );
  // Reveal is the operator's explicit action, and then the full value is shown.
  // Located by its accessible name rather than by position: the row now carries
  // several actions, so "the first button" is no longer the reveal control.
  await page.getByRole('button', { name: /显示密钥|Reveal secret/ }).first().click();
  const revealedKey = await page.locator('.config-api-keys-table .config-key-text').first().innerText();
  check('revealing a key shows its full value', revealedKey.trim() === FAKE_CLIENT_SECRET, `text="${revealedKey}"`);
  responseBodies.length = 0;

  // ---- key aliases: name a key, then see that name on its request records ----
  // This is the whole feature end to end: the name is written through the UI,
  // resolved server-side against the fingerprint the usage records carry, and
  // rendered in the request list in place of the mask. The filter identity must
  // stay the fingerprint, so the assertion also pins that the visible name and
  // the value being filtered on are not the same thing.
  const aliasRow = page.locator('.config-api-keys-table .ant-table-row').first();
  check(
    'an unnamed key states that it is unnamed rather than showing a blank',
    (await aliasRow.locator('td').first().innerText()).trim().length > 0,
    `name="${await aliasRow.locator('td').first().innerText()}"`,
  );
  await aliasRow.getByRole('button', { name: /重命名|Rename/ }).click();
  const renameInput = page.locator('.ant-modal input').first();
  await renameInput.waitFor({ state: 'visible', timeout: 10000 });
  await renameInput.fill(CLIENT_KEY_ALIAS);
  await page.locator('.ant-modal .ant-btn-primary').click();
  await checkEventually(
    'the new name is saved and shown in the key table',
    async () => (await aliasRow.locator('td').first().innerText()).includes(CLIENT_KEY_ALIAS),
    { detail: async () => `name="${await aliasRow.locator('td').first().innerText()}"` },
  );
  // The masked secret is still what the key column shows by default: naming a key
  // must not turn the table into a secret display. The reveal toggled earlier in
  // this same run is still on, so it is switched back off first - otherwise this
  // check would assert against a state the previous check deliberately created.
  await page.getByRole('button', { name: /隐藏密钥|Hide secret/ }).first().click();
  const namedKeyText = await page.locator('.config-api-keys-table .config-key-text').first().innerText();
  check(
    'naming a key does not reveal the secret',
    namedKeyText.includes('•') && !namedKeyText.includes(FAKE_CLIENT_SECRET),
    `text="${namedKeyText}"`,
  );
  responseBodies.length = 0;

  // ---- the request list shows the name instead of the mask ----
  await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // The row is located by its own request id rather than by position. The
  // key-attributed fixture record is not the newest one in the window, and a
  // position-based read would silently assert against whichever row happened to
  // sort first.
  const callerRow = page.locator('.request-row').filter({ hasText: 'fixture-key-caller' }).first();
  await callerRow.waitFor({ state: 'visible', timeout: 15000 });
  const keyColumnText = await callerRow.locator('.req-key-val').innerText();
  check(
    'the request list labels the caller with its assigned name',
    keyColumnText.includes(CLIENT_KEY_ALIAS),
    `key column="${keyColumnText}"`,
  );
  check(
    'the request list no longer prints the raw mask for a named key',
    !keyColumnText.includes('••'),
    `key column="${keyColumnText}"`,
  );
  // A different, unnamed caller still reads as a mask (or an em dash), so the
  // alias has not replaced the fallback for every row.
  const otherKeyText = await page.locator('.request-row .req-key-val').first().innerText();
  check(
    'an unnamed row keeps its non-alias label',
    !otherKeyText.includes(CLIENT_KEY_ALIAS),
    `first row key column="${otherKeyText}"`,
  );

  // The filter value must remain the fingerprint: the visible name is a label,
  // and a filter that meant something different from what it displays is exactly
  // the ambiguity aliases exist to remove. The caller facet lives in the filter
  // drawer, which is the surface an operator actually reaches it through; the row
  // is addressed by its stable control id rather than by label text.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#req-multi-api_key').click();
  const aliasOption = page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: CLIENT_KEY_ALIAS })
    .first();
  await aliasOption.waitFor({ state: 'visible', timeout: 10000 });
  // Asserted by acting on it rather than by a separate visibility probe: antd re-renders
  // the virtualised dropdown as the search settles, so an isVisible() read taken right
  // after waitFor can sample a detached node and report false for an option that is there.
  // Clicking it is both the check and the next step.
  const aliasOptionText = await aliasOption.innerText();
  check('the caller filter offers the assigned name', aliasOptionText.includes(CLIENT_KEY_ALIAS), `option="${aliasOptionText}"`);
  await aliasOption.click();
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="req-filter-apply"]').click();
  await checkEventually(
    'applying the named caller commits an api_key filter',
    async () => new URL(page.url()).searchParams.get('api_key') !== null,
    { detail: () => `url=${new URL(page.url()).search}` },
  );
  const filteredUrl = new URL(page.url()).search;
  check(
    'the filter value is the stored fingerprint rather than the displayed name',
    !filteredUrl.includes(encodeURIComponent(CLIENT_KEY_ALIAS)),
    `url=${filteredUrl}`,
  );
  // The chip names the key the way the list does, so the applied filter is
  // readable without decoding a fingerprint by hand.
  await checkEventually(
    'the applied filter chip shows the assigned name',
    async () => (await page.locator('.req-filter-chip').first().innerText()).includes(CLIENT_KEY_ALIAS),
    { detail: async () => `chip="${await page.locator('.req-filter-chip').first().innerText()}"` },
  );
  // After the filter is applied the list holds only that key's traffic, so every
  // visible key cell must carry the name. Reading all of them also catches a
  // partial resolution, where only some rows were labelled.
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  const filteredKeyTexts = await page.locator('.request-row .req-key-val').allInnerTexts();
  check(
    'every filtered row carries the assigned name',
    filteredKeyTexts.length > 0 && filteredKeyTexts.every((text) => text.includes(CLIENT_KEY_ALIAS)),
    `key cells=${JSON.stringify(filteredKeyTexts)}`,
  );
  await page.locator('.req-clear-all-chips').click();
  responseBodies.length = 0;

  // Payload section: one heading entry, not the section header followed by a
  // group head restating it. The panel is reached through the section nav.
  await page.goto(`${appURL}/config`, { waitUntil: 'domcontentloaded' });
  await page.locator('.config-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const payloadNav = page.locator('.config-nav-btn').filter({ hasText: /Payload/ });
  if ((await payloadNav.count()) > 0) {
    await payloadNav.first().click();
    await page.locator('.payload-rules-container').first().waitFor({ state: 'visible', timeout: 10000 });
    const payloadHeadingCount = await page.locator('.payload-builder-group .settings-group-title').count();
    check(
      'the Payload panel prints no second heading under the section header',
      payloadHeadingCount === 0,
      `duplicateHeadings=${payloadHeadingCount}`,
    );
    // Losing the head must not lose the capability: the rule builder is the whole
    // point of the panel, and its five sections must still carry their own
    // titles and explanations.
    const payloadPanels = await page.locator('.payload-collapse .ant-collapse-item').count();
    check('the Payload rule builder still renders its rule panels', payloadPanels >= 5, `panels=${payloadPanels}`);
    const payloadTitles = await page.locator('.payload-panel-title').count();
    const payloadDescs = await page.locator('.payload-panel-desc').count();
    check(
      'the Payload sections keep their own titles and descriptions',
      payloadTitles >= 5 && payloadDescs >= 5,
      `titles=${payloadTitles} descs=${payloadDescs}`,
    );
  }

  // Config Page: Source tab switch requires reauthentication modal
  await page.goto(`${appURL}/config`, { waitUntil: 'domcontentloaded' });
  await page.locator('.config-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const sourceSegment = page.locator('.ant-segmented-item').filter({ hasText: /源码|Source/ });
  // The block below is optional, so it is guarded by `isVisible`. That guard is
  // also the trap: asked before the segmented control has rendered, it answers
  // false and the two checks inside disappear from the run without a failure.
  // Waiting for the control first makes the skip a decision instead of a race.
  await sourceSegment.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (await sourceSegment.isVisible()) {
    await sourceSegment.click();
    // The source view is opened by the session alone: the step-up re-authentication
    // prompt was removed as a deliberate policy change (the reveal grant
    // re-checked the same management key the session already carries). So the
    // observable contract is the opposite of what it used to be - the source
    // editor opens directly, with no modal in the way.
    const sourceToolbar = page.locator('.config-source-toolbar');
    await sourceToolbar.waitFor({ state: 'visible', timeout: 10000 });
    check('source mode opens without re-authentication', await sourceToolbar.isVisible());
    check(
      'no re-authentication modal is raised for the source view',
      (await page.locator('.ant-modal').filter({ hasText: /源码|Source/ }).count()) === 0,
    );
    // Return to the visual view so the rest of the audit starts from the same
    // place it did before this section ran.
    const visualSegment = page.locator('.ant-segmented-item').filter({ hasText: /可视化|Visual/ });
    if (await visualSegment.first().isVisible().catch(() => false)) {
      await visualSegment.first().click();
      await page.locator('.config-workbench').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    }
  }
  await auditPage(page, responseBodies, '/plugins', '.plugins-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/plugin-store', '.plugin-store-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/system', '.system-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/quick-start', '.quick-start-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  await page.goto(`${appURL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('omc-theme', 'light'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The stored theme is applied during hydration. Waiting for it is the readiness
  // signal both checks below depend on, and it is stronger than a pause: a
  // half-hydrated page can show the dark theme with correct geometry.
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), {
    label: 'the stored light theme to be applied after reload',
  });
  const mobileOverflow = await measureStable(
    () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { page, label: 'the light-mode mobile overflow measurement' },
  );
  check('390px light view has no document overflow', mobileOverflow <= 1, `overflow=${mobileOverflow}`);
  check('light theme is active', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));

  // ---- the brand mark follows the console's own theme ----
  // Checking the resolved source rather than the theme attribute: the two drawings are
  // separate files, so a wrong pick is invisible to every other assertion in this file.
  // It has to be the console's theme, not the OS scheme, because that setting can
  // contradict the operating system.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${appURL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('omc-theme', 'light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), {
    label: 'the light theme before reading the brand mark',
  });
  const lightMark = await brandMarkState(page);
  check('the brand mark loads in the light theme', lightMark.naturalWidth > 0, `naturalWidth=${lightMark.naturalWidth}`);
  check('the light theme uses the light wordmark', /omc-wordmark-light|data:image/.test(lightMark.src), `src=${shorten(lightMark.src)}`);
  check('the light wordmark renders near-black ink', lightMark.hasDarkInk, `darkPixels=${lightMark.darkPixels} lightPixels=${lightMark.lightPixels}`);

  await page.evaluate(() => localStorage.setItem('omc-theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'), {
    label: 'the dark theme before reading the brand mark',
  });
  const darkMark = await brandMarkState(page);
  check('the brand mark loads in the dark theme', darkMark.naturalWidth > 0, `naturalWidth=${darkMark.naturalWidth}`);
  check('the dark theme uses the dark wordmark', /omc-wordmark-dark|data:image/.test(darkMark.src), `src=${shorten(darkMark.src)}`);
  check('the dark wordmark renders near-white ink', darkMark.hasLightInk, `darkPixels=${darkMark.darkPixels} lightPixels=${darkMark.lightPixels}`);
  check('the two themes do not resolve the same drawing', lightMark.src !== darkMark.src, `both=${shorten(lightMark.src)}`);

  // The wordmark is left-aligned on the rail's own text axis, not centred, so it lines up
  // with the navigation below it.
  const markBox = await page.locator('.app-brand-logo').first().boundingBox();
  const navBox = await page.locator('.app-menu .ant-menu-item').first().boundingBox();
  check('the brand mark sits on the navigation column', markBox !== null && navBox !== null && Math.abs(markBox.x - navBox.x) <= 6, `mark.x=${markBox?.x} nav.x=${navBox?.x}`);
  check('the brand mark does not fill the rail', markBox !== null && markBox.width < 200, `width=${markBox?.width}`);

  // Collapsed, the rail cannot hold the wordmark, so it shows the O. That drawing has its
  // own colour pair, which is what the earlier per-file check could not catch.
  // The viewport was widened above, and `isMobile` is recomputed from a resize event, so the
  // click has to wait for that reflow: before it lands the rail is still 0px wide and the
  // toggle is not the control this step means to press.
  await settleLayout(page);
  const collapseToggle = page.getByRole('button', { name: /收起侧栏|Collapse sidebar/ });
  await collapseToggle.waitFor({ state: 'visible', timeout: 10000 });
  await collapseToggle.click();
  await until(async () => (await page.locator('.app-brand-collapsed').count()) > 0, {
    label: 'the collapsed rail to appear',
  });
  // The rail's width is animated, so the class appearing is the start of the transition,
  // not its end: measuring then reads a 236px rail and reports a mark that is really
  // centred as off-centre. Wait for the width itself to settle.
  await measureStable(
    () => page.evaluate(() => document.querySelector('.app-sider')?.getBoundingClientRect().width ?? 0),
    { page, label: 'the collapsed rail width' },
  );
  const collapsedMark = await brandMarkState(page, '.app-brand-collapsed img');
  check('the collapsed rail shows a loadable mark', collapsedMark.naturalWidth > 0, `naturalWidth=${collapsedMark.naturalWidth}`);
  check('the collapsed mark renders visible ink on the rail', collapsedMark.hasLightInk, `lightPixels=${collapsedMark.lightPixels} darkPixels=${collapsedMark.darkPixels}`);
  const collapsedBox = await page.locator('.app-brand-collapsed img').boundingBox();
  const railBox = await page.locator('.app-sider').boundingBox();
  check(
    'the collapsed mark is centred in the rail',
    collapsedBox !== null && railBox !== null && Math.abs((collapsedBox.x + collapsedBox.width / 2) - (railBox.x + railBox.width / 2)) <= 2,
    `markCentre=${collapsedBox ? collapsedBox.x + collapsedBox.width / 2 : null} railCentre=${railBox ? railBox.x + railBox.width / 2 : null}`,
  );
  await page.locator('.app-brand-collapsed').click();
  await page.evaluate(() => localStorage.setItem('omc-theme', 'dark'));

  // OAuth end-to-end against the deterministic fake: start a flow, confirm
  // the card polls `waiting`, submit a callback whose session already
  // completed on the CPA side (409), and assert the card converges to the
  // success state instead of painting an error over saved credentials.
  await page.goto(`${appURL}/oauth`, { waitUntil: 'domcontentloaded' });
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
  await page.goto(`${appURL}/dashboard`, { waitUntil: 'domcontentloaded' });
  // Waited for rather than read once: without the sign-in form in the DOM, the
  // assertion below would report the same failure whether the session expired or
  // the page simply had not booted yet.
  await checkEventually(
    'expired session returns to sign-in',
    () => page.locator('input[type="password"]').isVisible(),
    { timeoutMs: 15000 },
  );
  check('fake CPA received authenticated management calls', fakeCpa.requests.some((request) => request.path === '/v0/management/auth-files'));
} catch (error) {
  if (!(error instanceof SmokeComplete)) {
    console.error(error.stack || error.message);
    failures.push(error.message);
  }
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
  console.log(`\n${checks.length} deterministic browser checks passed${smokeOnly ? ' (smoke)' : ''}.`);
}


