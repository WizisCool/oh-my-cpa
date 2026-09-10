import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv.includes('--baseline');
const base = 'http://127.0.0.1:5176/omc';
const output = path.join(root, 'tmp', 'performance');
fs.mkdirSync(output, { recursive: true });
const server = spawn(process.execPath, [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5176', '--strictPort'], { cwd: path.join(root, 'web'), stdio: 'pipe', windowsHide: true });
let browser;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('Vite failed to start');
    if (await fetch(base).then(r => r.ok).catch(() => false)) break;
    await wait(200);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.addInitScript(() => {
    const originalSet = window.setInterval.bind(window);
    const originalClear = window.clearInterval.bind(window);
    const active = new Map();
    window.setInterval = (fn, ms, ...args) => { const id = originalSet(fn, ms, ...args); active.set(id, ms); return id; };
    window.clearInterval = id => { active.delete(id); return originalClear(id); };
    window.__activeIntervals = () => [...active.values()].filter(ms => ms === 15000).length;
  });
  const now = Date.now();
  await page.route('**/omc/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let body = {};
    if (pathname.endsWith('/api/auth/session')) body = { authenticated: true };
    else if ((pathname.endsWith('/health') || pathname.endsWith('/healthz'))) body = { cpa_connected: true, version: 'fixture', status: 'ok' };
    else if (pathname.endsWith('/preferences')) body = { preferences: [] };
    else if (pathname.endsWith('/management/quota')) body = {
      total: 100,
      summary: { total_credentials: 100, healthy_count: 100, warning_count: 0, exhausted_count: 0, cooldown_count: 0, attention_count: 0 },
      quotas: Array.from({ length: 100 }, (_, i) => ({
        auth_index: `fixture-${i}`, name: `fixture-${i}.json`, provider: 'codex', type: 'codex', disabled: false, status: 'healthy', observed_at_ms: now,
        recommendation: { status: 'healthy', priority: 'none', action: 'none', reason: '' },
        capabilities: { refresh_supported: true, clear_cooldown_supported: false, reset_credit_supported: false },
        quota_exceeded: false,
        windows: ['five_hour', 'weekly', 'daily'].map(kind => ({ id: kind, label: kind, kind, scope: 'standard', remaining_percent: 80, reset_at_ms: now + 3600000 })),
      })),
    };
    else { errors.push(`Unexpected fixture request: ${pathname}`); return route.fulfill({ status: 404, json: {} }); }
    await route.fulfill({ status: 200, json: body });
  });
  await page.goto(`${base}/quota`, { waitUntil: 'networkidle' });
  await page.locator('article[class*="quotaCard"]').first().waitFor();
  const cards = await page.locator('article[class*="quotaCard"]').count();
  const bars = await page.locator('.quota-page .ant-progress').count();
  const visibleTimers = await page.evaluate(() => window.__activeIntervals());
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenTimers = await page.evaluate(() => window.__activeIntervals());
  await page.evaluate(() => {
    delete document.visibilityState; delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const resumedTimers = await page.evaluate(() => window.__activeIntervals());
  const report = { cards, bars, visibleTimers, hiddenTimers, resumedTimers, domNodes: await page.locator('*').count(), errors };
  fs.writeFileSync(path.join(output, baseline ? 'quota-before.json' : 'quota-after.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.equal(cards, 100);
  assert.equal(bars, 300);
  assert.deepEqual(errors, []);
  if (!baseline) {
    assert.equal(visibleTimers, 2, 'one quota clock plus existing health timer');
    assert.equal(hiddenTimers, 1, 'hidden quota clock is stopped');
    assert.equal(resumedTimers, 2, 'visible quota clock restarts once');
  }
  await page.screenshot({ path: path.join(output, baseline ? 'quota-before.png' : 'quota-after.png') });
} finally {
  await browser?.close();
  server.kill();
}
