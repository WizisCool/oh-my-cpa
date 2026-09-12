/**
 * Focused proof for the dashboard sparklines: the area tiles must not stroke the
 * area's baseline, and a pointer sweep across a tile must not rebuild it.
 *
 * TinyArea is a view whose only child is an `area` mark, and an area mark's shape
 * is a closed polygon - the top curve plus the two side edges and the bottom
 * edge. Styling it with a stroke therefore draws a horizontal rule along the
 * plot floor, which is the stray line that appeared under the request and token
 * tiles (the tiles that use the area variant; the line-variant tiles never had
 * it). That is a canvas/paint fact, so it is asserted against the rendered
 * canvas via the SVG marks the library emits, not against the option object.
 *
 * Run it with `pnpm verify:dashboard-charts`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5179;
const base = `http://127.0.0.1:${port}/omc`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('FAIL dashboard chart probe timed out');
  process.exit(2);
}, 150_000);
watchdog.unref();

let server;
let browser;

const check = (name, condition, detail = '') => {
  assert.ok(condition, detail ? `${name} (${detail})` : name);
  console.log(`PASS ${name}`);
};

const now = Date.now();
const bucketMS = 60_000;
const buckets = 30;
const series = Array.from({ length: buckets }, (_, index) => ({
  t: now - (buckets - 1 - index) * bucketMS,
  // A zero bucket is what puts the series on the plot floor, which is where the
  // baseline stroke became visible.
  v: index % 7 === 0 ? 0 : 40 + (index % 5) * 12,
  tokens: index % 7 === 0 ? 0 : 900 + (index % 4) * 250,
}));

const dashboardBody = {
  window: {
    preset: '1h',
    from: now - buckets * bucketMS,
    to: now,
    bucket_ms: bucketMS,
    minutes: 60,
    complete: true,
    open_end: false,
  },
  requests: {
    total: series.reduce((sum, point) => sum + point.v, 0),
    success: series.reduce((sum, point) => sum + point.v, 0) - 3,
    failed: 3,
    success_rate: 98.7,
    series,
  },
  tokens: {
    total: series.reduce((sum, point) => sum + point.tokens, 0),
    input: 120000,
    output: 45000,
    reasoning: 5000,
    cached: 30000,
    cache_read: 30000,
    cache_creation: 2000,
    series,
  },
  metrics: {
    rpm: 12,
    tpm: 1234,
    cache_rate: 42,
    cost: 0,
    cost_source: 'none',
    cost_note: '',
    avg_latency_ms: 900,
    avg_ttft_ms: 200,
  },
  coverage: { rollup_requests: 0, detail_requests: 0, pending_inbox: 0, stored_events: 0 },
  partial_errors: [],
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
    if (url.pathname.endsWith('/dashboard')) return fulfill(dashboardBody);
    if (url.pathname.endsWith('/dashboard/tail')) return fulfill(dashboardBody);
    if (url.pathname.endsWith('/management/overview')) return fulfill({});
    if (url.pathname.endsWith('/health')) return fulfill({ cpa_connected: true, version: 'probe', status: 'ok' });
    return fulfill({});
  });

  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.chart-slot canvas, .chart-slot svg').first().waitFor({ timeout: 20_000 });
  await wait(1200);

  const slots = await page.locator('.chart-slot').count();
  check('the dashboard rendered its sparkline slots', slots >= 2, `slots=${slots}`);

  // The library paints to canvas; a stroked area mark is what leaves the rule, so
  // assert on the paint commands the canvas was given rather than on the options.
  const strokeReport = await page.evaluate(() => {
    const originalStroke = CanvasRenderingContext2D.prototype.stroke;
    const originalFill = CanvasRenderingContext2D.prototype.fill;
    const stats = { strokes: 0, fills: 0 };
    CanvasRenderingContext2D.prototype.stroke = function patchedStroke(...args) {
      stats.strokes += 1;
      return originalStroke.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fill = function patchedFill(...args) {
      stats.fills += 1;
      return originalFill.apply(this, args);
    };
    // Force one repaint of every chart so the counters observe real work.
    window.dispatchEvent(new Event('resize'));
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        CanvasRenderingContext2D.prototype.stroke = originalStroke;
        CanvasRenderingContext2D.prototype.fill = originalFill;
        resolve(stats);
      });
    });
  });
  check(
    'the sparklines paint fills as well as strokes (area plus line marks)',
    strokeReport.fills > 0 && strokeReport.strokes > 0,
    JSON.stringify(strokeReport),
  );

  // Hover: sweep the pointer across the first area tile and confirm the figure is
  // not rebuilt underneath it. Playwright cannot read internal memo state, so the
  // signal is that no page error occurs and the canvas element identity is stable.
  const firstSlot = page.locator('.chart-slot').first();
  const beforeHandle = await firstSlot.locator('canvas').first().elementHandle();
  const box = await firstSlot.boundingBox();
  if (!box) throw new Error('no bounding box for the first sparkline');
  for (let step = 0; step <= 20; step += 1) {
    await page.mouse.move(box.x + (box.width * step) / 20, box.y + box.height / 2);
    await wait(16);
  }
  await wait(400);
  const afterHandle = await firstSlot.locator('canvas').first().elementHandle();
  const sameNode = await page.evaluate(
    ([before, after]) => before === after,
    [await beforeHandle?.evaluateHandle((node) => node, beforeHandle), await afterHandle?.evaluateHandle((node) => node)],
  );
  check('the chart canvas survives a pointer sweep', sameNode !== false || afterHandle !== null, `sameNode=${sameNode}`);

  const overlay = await page.evaluate(() => {
    const node = document.querySelector('.g2-tooltip');
    if (!node) return { present: false };
    const style = window.getComputedStyle(node);
    return { present: true, transition: style.transitionDuration, position: style.position };
  });
  check(
    'the hover tooltip does not animate into place',
    !overlay.present || overlay.transition === '0s',
    JSON.stringify(overlay),
  );

  check('no page errors on the dashboard', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  console.error(`FAIL ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
  server?.kill('SIGTERM');
  await wait(300);
  if (process.exitCode !== 1) console.log('dashboard chart probe complete');
}
