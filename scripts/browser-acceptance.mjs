#!/usr/bin/env node
import { guardBrowserContext } from './acceptance/browser-guard.mjs';
import { launchBrowser, closeBrowser, stopProcess, closeServer, withOwnedCleanup } from './acceptance/lifecycle.mjs';
// Deterministic browser acceptance against an isolated fake CPA by default.
// Set OMCPA_LIVE_CPA=1 to run the separately maintained live-system smoke.

import { isolatedAppEnvironment } from './acceptance/environment.mjs';
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
  FAKE_SECOND_PROVIDER_SECRET,
} from './fake-cpa.mjs';
import { createChecker, measureStable } from './acceptance/harness.mjs';
import { runRequestListAcceptance } from './acceptance/request-list.mjs';
import { runAddProviderAcceptance } from './acceptance/add-provider.mjs';
import { runMcpAcceptance } from './acceptance/mcp.mjs';
import { runCopyFallbackAcceptance } from './acceptance/copy-fallback.mjs';
import { runYamlWorkerAcceptance } from './acceptance/yaml-worker.mjs';
import { auditNativePluginHostResponse, isNativePluginHostResponse, settleNativeResponseAudits, runPluginHostedPageAcceptance } from './acceptance/plugin-host.mjs';

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
if (process.env.OMCPA_LIVE_CPA === '1') {
  await import('./browser-live-smoke.mjs');
  process.exit();
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-e2e-'));
// One master key for the whole run: the app, the seeder and the fingerprint
// assertions must all derive caller-key identities with the same key.
const MASTER_KEY = ['fixture', 'master', 'key', 'for', 'browser', 'acceptance', 'only'].join('-');
const configuredExecutable = process.env.OMCPA_BROWSER_BINARY?.trim();
const executable = configuredExecutable
  ? path.resolve(root, configuredExecutable)
  : path.join(temporary, process.platform === 'win32' ? 'oh-my-cpa.exe' : 'oh-my-cpa');
const configuredSeeder = process.env.OMCPA_SEED_USAGE_BINARY?.trim();
const appLog = [];
const { check, checkEventually, checks, failures } = createChecker();
let appProcess;
let browser;
let network;
let fakeCpa;
let appURL;
let page;
const nativeResponseAudits = [];
const consoleErrors = [];
const pageErrors = [];
const requestFailures = [];

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
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
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

/**
 * The secret sweep: every console route renders on the built binary, lays out within
 * the viewport, and neither its DOM, its browser storage nor any response it read
 * carries the management key or OAuth credential material. Routes whose contract does
 * not include plaintext provider keys also exclude those (`pageSecrets`).
 *
 * `routes` is a list of `[route, selector, options?]`.
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
    env: isolatedAppEnvironment({
      OMCPA_LISTEN_ADDR: `127.0.0.1:${appPort}`,
      OMCPA_BASE_PATH: '/omc',
      OMCPA_DATA_DIR: path.join(temporary, 'data'),
      OMCPA_MASTER_KEY: MASTER_KEY,
      OMCPA_CPA_BASE_URL: `http://127.0.0.1:${cpaPort}`,
      OMCPA_CPA_MANAGEMENT_KEY: FAKE_CPA_MANAGEMENT_KEY,
      OMCPA_CPA_USAGE_ADDR: '',
      OMCPA_USAGE_INGEST_ENABLED: 'false',
      // Release checking is off, for the reason every other outbound integration is off here:
      // this suite must be hermetic. The app would otherwise fetch published versions from
      // `api.github.com`, which spends an allowance shared per address, makes the run depend on a
      // third party being reachable, and leaves whoever runs the gate reading a rate-limit error
      // where a version should be.
      //
      // Both switches are set, and that is the correction of an earlier mistake: disabling the
      // sweep alone does not stop the traffic. The sweep's first run is a full interval away and
      // never fires inside a two-minute run, while this suite does visit `/system`
      // (`configuration-plugins.mjs`), whose page checks on open. The second switch turns that
      // check off, which is what actually makes the run hermetic.
      OMCPA_UPDATE_CHECK_ENABLED: 'false',
      OMCPA_UPDATE_CHECK_ON_PAGE_LOAD: 'false',
      OMCPA_PUBLIC_URL: '',
      OMCPA_VERSION: 'v0.1.0-e2e',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProcess.stdout.on('data', (chunk) => appLog.push(chunk.toString()));
  appProcess.stderr.on('data', (chunk) => appLog.push(chunk.toString()));
  appProcess.once('exit', (code) => {
    if (code !== null && code !== 0) appLog.push(`app exited with ${code}`);
  });

  const redirect = await waitFor(appURL);
  check('fixture startup ignores operator dotenv files', !appLog.join('').includes('loaded environment file'));
  check('/omc redirects to /omc/', redirect.status === 308 && redirect.headers.get('location') === '/omc/', `status=${redirect.status}`);

  browser = await launchBrowser(chromium, { headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  network = await guardBrowserContext(context, [appURL]);
  page = await context.newPage();
  const responseBodies = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/status of 401 \(Unauthorized\)/i.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
    requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', async (response) => {
    if (!response.url().startsWith(appURL)) return;
    if (isNativePluginHostResponse(response.url(), appURL)) {
      const audit = auditNativePluginHostResponse(response, [FAKE_CPA_MANAGEMENT_KEY, FAKE_ACCOUNT_SECRET], check);
      nativeResponseAudits.push(audit);
      await audit;
      return;
    }
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

  const withProviderSecrets = { pageSecrets: providerSecrets };
  await auditRoutes(page, responseBodies, [
    ['/dashboard', '.dashboard-page', withProviderSecrets],
    ['/agent', '[data-testid="agent-page"]', withProviderSecrets],
    ['/playground', '[data-testid="playground-empty"]', withProviderSecrets],
    ['/model-square', '.model-square-page [data-model-identity]', withProviderSecrets],
    // Provider and client key management show plaintext keys by contract.
    ['/ai-providers', '.providers-page'],
    ['/oauth-management', '.oauth-management-page', withProviderSecrets],
    ['/api-keys', '[data-testid="keys-count"]'],
    ['/usage/events', '.usage-events-page', withProviderSecrets],
    ['/pricing', '[data-testid="pricing-page"]', withProviderSecrets],
    ['/logs', '.logs-page', withProviderSecrets],
    ['/audit', '[data-testid="audit-page"]', withProviderSecrets],
    ['/plugins', '.plugins-page', withProviderSecrets],
    ['/plugins/store', '[data-plugin-panel="store"]', withProviderSecrets],
    ['/plugins/settings', '[data-plugin-panel="settings"]', withProviderSecrets],
    ['/config', '.config-page'],
    ['/omc-settings', '.omc-settings-page', withProviderSecrets],
    ['/system', '.system-page', withProviderSecrets],
    // Retired paths still land on the page that replaced them.
    ['/oauth', '.oauth-management-page', withProviderSecrets],
    ['/quota', '.oauth-management-page', withProviderSecrets],
    ['/auth-files', '.oauth-management-page', withProviderSecrets],
  ]);

  await runRequestListAcceptance({ appURL, page, check });
  await runMcpAcceptance({ appURL, page, check });
  if (!smokeOnly) {
    await runAddProviderAcceptance({ appURL, page, check, checkEventually, fakeCpa });
    await runCopyFallbackAcceptance({ appURL, page, check, checkEventually });
    await runYamlWorkerAcceptance({ appURL, page, check });
    await runPluginHostedPageAcceptance({ appURL, page, check });
  }

  await Promise.all(nativeResponseAudits);

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
  check('fake CPA received authenticated management calls', fakeCpa.requests.some((request) => request.path === '/v8/management/credentials'));
} catch (error) {
  console.error(error.stack || error.message);
  failures.push(error.message);
} finally {
  if (network) check('built console makes no outbound network requests', !network.problems.some(problem => problem.kind === 'outbound'));
  await withOwnedCleanup(async () => {
    if (failures.length > 0 && page) await captureFailureDiagnostics(page);
  }, async () => {
    try {
      await closeBrowser(browser);
      await settleNativeResponseAudits(nativeResponseAudits, check);
      if (page) {
        check('browser console has no unexplained errors', consoleErrors.length === 0, consoleErrors.join(' | '));
        check('browser has no page errors', pageErrors.length === 0, pageErrors.join(' | '));
        check('same-origin requests did not fail', requestFailures.length === 0, requestFailures.join(' | '));
      }
    }
    finally {
      try { await stopProcess(appProcess); }
      finally {
        try { if (fakeCpa) await closeServer(fakeCpa.server); }
        finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      }
    }
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} acceptance check(s) failed.`);
  if (appLog.length > 0) console.error(appLog.join('').slice(-8000));
  process.exitCode = 1;
} else {
  const mode = smokeOnly ? ' (smoke)' : '';
  console.log(`\n${checks.length} deterministic browser checks passed${mode}.`);
}
