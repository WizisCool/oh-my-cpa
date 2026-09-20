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
  FAKE_SECOND_PROVIDER_SECRET,
} from './fake-cpa.mjs';
import {
  createChecker,
  measureStable,
  settleLayout,
  until,
} from './acceptance/harness.mjs';
import { runAuthFilesAcceptance } from './acceptance/auth-files.mjs';
import { runKeyManagementAcceptance } from './acceptance/key-management.mjs';
import { runUsageEventsAcceptance } from './acceptance/usage-events.mjs';
import { runProvidersAcceptance } from './acceptance/providers.mjs';
import { runObservabilityAcceptance } from './acceptance/observability.mjs';
import { runConfigurationPluginsAcceptance } from './acceptance/configuration-plugins.mjs';
import { runThemeBrandAcceptance } from './acceptance/theme-brand.mjs';
import { runOAuthFlowAcceptance } from './acceptance/oauth-flow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * providerSecrets is every provider key material the fixture configures.
 *
 * It is one list rather than a literal repeated at each audit because the fixture
 * now configures two providers: an audit that names one secret verifies that one,
 * so a new fixture provider would silently be excluded from the leak checks that
 * are supposed to cover exactly this material.
 */
const providerSecrets = [FAKE_PROVIDER_SECRET, FAKE_SECOND_PROVIDER_SECRET];
const smokeOnly = process.argv.includes('--smoke');
const p0Only = process.argv.includes('--p0');

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
const configuredExecutable = process.env.OMCPA_BROWSER_BINARY?.trim();
const executable = configuredExecutable
  ? path.resolve(root, configuredExecutable)
  : path.join(temporary, process.platform === 'win32' ? 'oh-my-cpa.exe' : 'oh-my-cpa');
const configuredSeeder = process.env.OMCPA_SEED_USAGE_BINARY?.trim();
const appLog = [];
const { check, checkEventually, checkHoldsFor, checks, failures } = createChecker();
let appProcess;
let browser;
let fakeCpa;
let appURL;
let page;

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

async function lobeIconImageState(locator) {
  return locator.evaluate((root) => {
    const image = root.querySelector('img[src*="/lobe-icons/"]');
    if (!image) return null;
    return {
      src: image.getAttribute('src') ?? '',
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  });
}

/**
 * The artwork a provider surface actually draws, whatever its source.
 *
 * `lobeIconImageState` answers for the console's own catalog only (an embedded
 * `/lobe-icons/` image), so it cannot see a plugin-published logo - which is
 * exactly the mark a plugin-owned provider is supposed to draw. This reads the
 * element's own source and decoded size, so "the plugin's icon is used, and it
 * loaded" is one assertion instead of two.
 */
async function providerMarkImage(locator) {
  return locator.evaluate((root) => {
    const image = root.querySelector('img');
    if (!image) return null;
    return {
      src: image.getAttribute('src') ?? '',
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  });
}

function shorten(value, max = 64) {
  if (typeof value !== 'string') return String(value);
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function auditPage(page, responseBodies, route, selector, { pageSecrets = [] } = {}) {
  await page.goto(`${appURL}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 15000 });
  const bodyText = await page.locator('body').innerText();
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

/**
 * auditRoutes is `auditPage` for the routes whose only claims are the secret sweep
 * and a clean render.
 *
 * The secret check comes from the same place in every case, so the per-route cost
 * is one navigation plus one README-sized assertion, not a new kind of evidence.
 * Grouping them keeps the sweep in one place instead of scattering nine
 * near-identical blocks through the audit, and lets the shared "no document
 * overflow" measurement be taken once per route rather than restated.
 *
 * `routes` is a list of `[route, selector, options?]`. The overflow measurement is
 * the one piece of geometry here that is cheap to take and genuinely per-route: a
 * route can render and still lay out wider than the viewport, which no presence
 * check would notice.
 */
async function auditRoutes(page, responseBodies, routes) {
  for (const [route, selector, options] of routes) {
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
    const strictSecrets = [FAKE_CPA_MANAGEMENT_KEY, FAKE_ACCOUNT_SECRET];
    for (const value of strictSecrets) {
      check(`${route} excludes management and OAuth credentials`, !bodyText.includes(value) && !stored.includes(value) && !responseBodies.some((body) => body.includes(value)));
    }
    for (const value of options?.pageSecrets ?? []) {
      check(`${route} excludes fixture credentials`, !bodyText.includes(value) && !stored.includes(value) && !responseBodies.some((body) => body.includes(value)));
    }
    responseBodies.length = 0;
  }
}

async function captureFailureDiagnostics(failedPage) {
  const output = path.join(root, 'tmp', 'browser-acceptance-failure');
  fs.mkdirSync(output, { recursive: true });
  await failedPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const html = await failedPage.content().catch(() => '');
  fs.writeFileSync(path.join(output, 'failure.html'), html);
  fs.writeFileSync(path.join(output, 'app.log'), appLog.join(''));
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

  if (configuredExecutable) {
    if (!fs.existsSync(executable)) throw new Error(`OMCPA_BROWSER_BINARY does not exist: ${executable}`);
  } else {
    execFileSync('go', ['build', '-trimpath', '-o', executable, './cmd/oh-my-cpa'], { cwd: root, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit' });
  }
  // Acceptance runs with ingestion disabled, so the request list would be empty
  // and every list behaviour untestable. Seed a deterministic window through the
  // repository itself (see the fixture's own doc comment) before the app opens
  // the database.
  const seeder = configuredSeeder
    ? path.resolve(root, configuredSeeder)
    : path.join(temporary, process.platform === 'win32' ? 'seed-usage.exe' : 'seed-usage');
  if (configuredSeeder) {
    if (!fs.existsSync(seeder)) throw new Error(`OMCPA_SEED_USAGE_BINARY does not exist: ${seeder}`);
  } else {
    execFileSync('go', ['build', '-trimpath', '-o', seeder, './scripts/fixture/seed-usage'], { cwd: root, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit' });
  }
  const seedUsage = () => {
    const output = execFileSync(
      seeder,
      [
        '-db',
        path.join(temporary, 'data', 'oh-my-cpa.db'),
        // The seeder must fingerprint with the same master key the app runs with,
        // or a caller-key identity it writes would not be one the app can derive.
        '-master-key',
        MASTER_KEY,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (!output.includes('SEED_USAGE_OK')) throw new Error(`seed usage failed: ${output}`);
  };
  seedUsage();
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
  page = await context.newPage();
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

  await auditPage(page, responseBodies, '/dashboard', '.dashboard-page', { pageSecrets: providerSecrets });

  // Success-rate band: the seeded window carries 1 failure in 50 (2%), which is 98% success and
  // sits above the 80% line, so the pip reads as healthy. The durable half of this check is the
  // *negative*: a window this good must never be painted as a warning.
  const verdictPip = page.locator('.dashboard-page .legend-dot').first();
  await verdictPip.waitFor({ state: 'visible', timeout: 10000 });
  const verdictClasses = (await verdictPip.getAttribute('class')) ?? '';
  check(
    'a 98%-success window is not painted as a warning',
    /success/.test(verdictClasses) && !/warn|danger/.test(verdictClasses),
    `class="${verdictClasses}"`,
  );
  await runUsageEventsAcceptance({
    auditPage,
    appURL,
    page,
    check,
    checkEventually,
    checkHoldsFor,
    responseBodies,
    providerSecrets,
    until,
    measureStable,
    settleLayout,
    smokeOnly,
    consoleErrors,
    pageErrors,
    onSmokeComplete: () => { throw new SmokeComplete(); },
    providerMarkImage,
  });
  if (!p0Only) {
    await auditPage(page, responseBodies, '/pricing', '[data-testid="pricing-page"]', { pageSecrets: providerSecrets });

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
    await runProvidersAcceptance({
      auditPage,
      appURL,
      page,
      check,
      checkEventually,
      responseBodies,
    });
  }
  await runAuthFilesAcceptance({
    auditPage,
    appURL,
    page,
    check,
    checkEventually,
    responseBodies,
    providerSecrets,
    until,
    measureStable,
    lobeIconSignature,
    lobeIconImageState,
    providerMarkImage,
    path,
    root,
  });

  if (!p0Only) {
    await runObservabilityAcceptance({
      auditPage,
      appURL,
      page,
      check,
      checkEventually,
      responseBodies,
      providerSecrets,
      settleLayout,
      lobeIconSignature,
      providerMarkImage,
    });

    await runKeyManagementAcceptance({ appURL, page, check, checkEventually, responseBodies, clientKeyAlias: CLIENT_KEY_ALIAS, clientKeySecret: FAKE_CLIENT_SECRET });

    await runConfigurationPluginsAcceptance({
      auditRoutes,
      appURL,
      page,
      check,
      providerSecrets,
      responseBodies,
    });

    await runThemeBrandAcceptance({ appURL, page, check, until, measureStable, settleLayout });

    await runOAuthFlowAcceptance({ appURL, page, check });
  }

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
  if (failures.length > 0 && page) await captureFailureDiagnostics(page);
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
  const mode = smokeOnly ? ' (smoke)' : p0Only ? ' (p0)' : '';
  console.log(`\n${checks.length} deterministic browser checks passed${mode}.`);
}
