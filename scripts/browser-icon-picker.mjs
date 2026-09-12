/**
 * Focused proof that the provider icon picker stays above the provider Drawer.
 *
 * The picker is opened from inside the Drawer but renders as a sibling of it, so
 * the two are separate antd containers competing for a stacking level rather than
 * one nesting inside the other. That is exactly the case a stray z-index breaks,
 * and it is invisible to a type check or a unit test - only the rendered stacking
 * order shows it.
 *
 * The probe opens the Drawer, opens the picker, and asserts on computed
 * z-index and on what the browser actually reports under the picker's centre
 * point: a positive z-index that still loses hit-testing would be a broken fix
 * that a z-index assertion alone would pass.
 *
 * Run it with `pnpm verify:icon-picker`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5178;
const base = `http://127.0.0.1:${port}/omc`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('FAIL icon picker probe timed out');
  process.exit(2);
}, 120_000);
watchdog.unref();

let server;
let browser;

const check = (name, condition, detail = '') => {
  assert.ok(condition, detail ? `${name} (${detail})` : name);
  console.log(`PASS ${name}`);
};

const provider = {
  id: 'openai-compat-0',
  family: 'openai-compatibility',
  name: 'CommandCode GOAT',
  protocol: 'OpenAI Compatible Chat Completions',
  base_url: 'https://api.example.test/v1',
  disabled: false,
  key_configured: true,
  models: ['deepseek-v4.1-flash'],
};

try {
  server = spawn(
    process.execPath,
    [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: path.join(root, 'web'), stdio: 'pipe', windowsHide: true },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('probe Vite server failed to start');
    if (await fetch(base).then((response) => response.ok).catch(() => false)) break;
    await wait(200);
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('omc-theme', 'light');
    localStorage.setItem('omc-lang', 'en');
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/omc/api/**', async (route) => {
    const url = new URL(route.request().url());
    const fulfill = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname.endsWith('/api/auth/session')) return fulfill({ authenticated: true });
    if (url.pathname.endsWith('/preferences') && route.request().method() === 'GET') return fulfill({ preferences: {} });
    if (url.pathname.includes('/preferences/')) return fulfill({ ok: true });
    if (url.pathname.endsWith('/management/auth-files')) return fulfill({ files: [], total: 0 });
    if (url.pathname.endsWith('/management/providers')) return fulfill({ providers: [provider], total: 1 });
    if (url.pathname.endsWith('/health')) return fulfill({ cpa_connected: true, version: 'probe', status: 'ok' });
    return fulfill({});
  });

  await page.goto(`${base}/ai-providers`, { waitUntil: 'domcontentloaded' });
  await page.locator('.providers-page').waitFor({ timeout: 20_000 });

  // Open the provider drawer by clicking the provider row's edit affordance.
  const editButton = page
    .locator('.providers-page')
    .getByRole('button', { name: /Edit|编辑/i })
    .first();
  await editButton.click({ timeout: 10_000 });
  await page.locator('.ant-drawer-open').waitFor({ state: 'visible', timeout: 10_000 });
  check('the provider drawer opens', (await page.locator('.ant-drawer-open').count()) > 0);

  // Open the picker from inside the drawer.
  const pickerTrigger = page
    .locator('.ant-drawer-open')
    .getByRole('button', { name: /Change Icon|更改图标/i })
    .first();
  if (await pickerTrigger.isVisible().catch(() => false)) {
    await pickerTrigger.click();
  } else {
    // Fall back to the inline icon tile, which opens the same picker.
    await page.locator('.ant-drawer-open').locator('div[title]').first().click();
  }
  const picker = page.locator('.ant-modal').filter({ hasText: /Select AI Provider Icon|选择 AI 提供商图标/i });
  await picker.waitFor({ state: 'visible', timeout: 10_000 });
  await wait(400);
  check('the icon picker opens from inside the drawer', await picker.isVisible());

  const readZ = (selector) =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      return Number.parseInt(window.getComputedStyle(node).zIndex, 10) || 0;
    }, selector);

  const drawerZ = await readZ('.ant-drawer-open');
  const pickerZ = await readZ('.ant-modal-wrap');
  check(
    'the picker is layered above the drawer',
    pickerZ > drawerZ,
    `drawer=${drawerZ} picker=${pickerZ}`,
  );

  // Computed z-index alone cannot prove the fix: an ancestor stacking context can
  // trap a high value. Ask the browser what is actually on top at the picker's
  // centre.
  const hit = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal');
    if (!modal) return { ok: false, reason: 'no modal' };
    const box = modal.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    if (!target) return { ok: false, reason: 'nothing hit' };
    const insidePicker = Boolean(target.closest('.ant-modal'));
    const insideDrawer = Boolean(target.closest('.ant-drawer'));
    return { ok: insidePicker && !insideDrawer, insidePicker, insideDrawer, tag: target.className };
  });
  check(
    'the picker wins hit-testing against the drawer',
    hit.ok,
    `picker=${hit.insidePicker} drawer=${hit.insideDrawer} tag=${hit.tag}`,
  );

  // Reopening must not flip the order: this is the reported "sometimes" case.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden', timeout: 10_000 });
    if (await pickerTrigger.isVisible().catch(() => false)) {
      await pickerTrigger.click();
    } else {
      await page.locator('.ant-drawer-open').locator('div[title]').first().click();
    }
    await picker.waitFor({ state: 'visible', timeout: 10_000 });
    await wait(250);
    const repeatedHit = await page.evaluate(() => {
      const modal = document.querySelector('.ant-modal');
      if (!modal) return false;
      const box = modal.getBoundingClientRect();
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
      return Boolean(target && target.closest('.ant-modal') && !target.closest('.ant-drawer'));
    });
    check(`reopen ${attempt + 2} keeps the picker on top`, repeatedHit);
  }

  check('no page errors while toggling the picker', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  console.error(`FAIL ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
  server?.kill('SIGTERM');
  await wait(300);
  if (process.exitCode !== 1) console.log('icon picker overlay probe complete');
}
