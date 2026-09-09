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
  await auditPage(page, responseBodies, '/usage/events', '.usage-events-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });
  await auditPage(page, responseBodies, '/pricing', '.pricing-page', { pageSecrets: [FAKE_PROVIDER_SECRET] });

  // The pricing page must open fast: a full table render is the budget, not a
  // spinner wait. This is the regression guard for the old 5s page freeze.
  const pricingOpenStart = Date.now();
  await page.goto(`${appURL}/pricing`);
  await page.locator('.pricing-page').first().waitFor({ state: 'visible', timeout: 3000 });
  const pricingOpenMS = Date.now() - pricingOpenStart;
  check('pricing page opens under 3s', pricingOpenMS < 3000, `${pricingOpenMS}ms`);
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
  const cardCount = await page.locator('article[class*="quotaCard"]').count();
  check('quota page renders credential cards', cardCount > 0, `quotaCards=${cardCount}`);

  // Verify quota tab brand icons are not OpenAI
  const quotaAntigravitySvg = await page.locator('.quota-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }).locator('svg').innerHTML();
  check('quota page Antigravity tab icon is not OpenAI', !quotaAntigravitySvg.includes('OpenAI'));

  // Click header refresh to trigger live quota refresh (cards have their own 刷新额度 buttons)
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


