/**
 * Focused proof that the request-records refresh button pulls before it reads.
 *
 * Request counts alone cannot establish ordering: a page that fired the pull and
 * both reads in parallel would still "issue" all three. So this fixture holds the
 * pull's response open and asserts that no list or facet read happens while it is
 * held, that both happen after it is answered, and that the first post-sync read
 * lands after the pull was served. It then checks that a pull which could not
 * drain CPA is reported as incomplete rather than shown as success.
 *
 * This lives apart from `scripts/browser-usage-events.mjs` because that suite
 * covers the whole request-records page and stops on its own earlier assertions,
 * which would mask this one. Run it with `pnpm verify:refresh`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5177;
const base = `http://127.0.0.1:${port}/omc`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A hung page must fail the run rather than hold CI open.
const watchdog = setTimeout(() => {
  console.error('FAIL refresh probe timed out');
  process.exit(2);
}, 90_000);
watchdog.unref();

let server;
let browser;
let failSync = false;
let pullCount = 0;
let releasePull = null;
let isPullHeld = false;
const pullHeld = new Promise((resolve) => {
  releasePull = resolve;
});
const reads = { pulls: [], list: [], facets: [] };

const now = Date.now();
const records = Array.from({ length: 25 }, (_, index) => ({
  id: index + 1,
  request_id: `refresh-probe-${index + 1}`,
  timestamp_ms: now - index * 60_000,
  timestamp: new Date(now - index * 60_000).toISOString(),
  provider: ['openai', 'claude', 'gemini'][index % 3],
  model: 'gpt-5-codex',
  auth_index: 'credential-1',
  source: 'codex-team-production.json',
  failed: false,
  latency_ms: 250,
  ttft_ms: 80,
  generate: true,
  api_group_key: 'hmac:abcdef0123456789',
  api_key_mask: 'sk-12345••••••••7890',
  user_agent: 'codex-cli/0.46',
  executor_type: 'openai',
  tokens: { input: 1200, output: 485, reasoning: 120, cached: 400, cache_read: 400, cache_creation: 0, total: 2635 },
  has_request_log: true,
}));

const check = (name, condition, detail = '') => {
  assert.ok(condition, detail ? `${name} (${detail})` : name);
  console.log(`PASS ${name}`);
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
    if (url.pathname.endsWith('/preferences') && route.request().method() === 'GET')
      return fulfill({ preferences: {} });
    if (url.pathname.includes('/preferences/')) return fulfill({ ok: true });
    if (url.pathname.endsWith('/management/auth-files')) return fulfill({ files: [], total: 0 });
    if (url.pathname.endsWith('/management/providers')) return fulfill({ providers: [], total: 0 });
    if (url.pathname.endsWith('/health')) return fulfill({ cpa_connected: true, version: 'probe', status: 'ok' });
    if (url.pathname.endsWith('/usage/ingest-status'))
      return fulfill({
        enabled: true,
        healthy: true,
        collector: { mode: 'subscribe', captured: 10, coverage_gaps: 0 },
        stats: { pending: 0 },
      });
    if (url.pathname.endsWith('/usage/ingest/refresh')) {
      pullCount += 1;
      reads.pulls.push(Date.now());
      // The first pull is held so the ordering is observed rather than assumed.
      if (pullCount === 1 && !isPullHeld) {
        isPullHeld = true;
        await pullHeld;
      }
      const synced = !failSync;
      return fulfill({
        enabled: true,
        synced,
        mode: 'subscribe',
        captured: synced ? 2 : 0,
        decoded: synced ? 2 : 0,
        error: synced ? undefined : 'connection refused',
      });
    }
    if (url.pathname.endsWith('/usage/facets')) {
      reads.facets.push(Date.now());
      return fulfill({
        window: { from: now - 3600000, to: now },
        facets: {
          models: [{ value: 'gpt-5-codex', requests: 25 }],
          providers: [{ value: 'openai', requests: 25 }],
          sources: [],
          auth_indexes: [],
          api_group_keys: [],
          executors: [],
        },
      });
    }
    if (url.pathname.endsWith('/usage/events')) {
      reads.list.push(Date.now());
      const limit = Number(url.searchParams.get('limit') || 100);
      return fulfill({
        items: records.slice(0, limit),
        has_more: false,
        limit,
        window: { from: now - 3600000, to: now },
      });
    }
    return fulfill({});
  });

  const customFrom = now - 3600000;
  const customTo = now - 1000;
  await page.goto(`${base}/usage/events?from=${customFrom}&to=${customTo}`);
  await page.locator('.request-row').first().waitFor({ timeout: 15000 });
  // The page writes the resolved view back into the URL shortly after hydration,
  // which re-resolves the window and re-reads facets. Settling first keeps that
  // churn out of the baseline this probe compares against.
  await wait(1800);
  const listBefore = reads.list.length;
  const facetBefore = reads.facets.length;

  // The wait is registered before the click: registering it afterwards can miss a
  // request that resolved faster than the listener attached.
  const pullIssued = page
    .waitForRequest((request) => request.url().includes('/usage/ingest/refresh'), { timeout: 5000 })
    .catch(() => null);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  check('the refresh issues the pull', (await pullIssued) !== null);

  await wait(700);
  check('no list read happens while the pull is held', reads.list.length === listBefore, `list=${reads.list.length - listBefore}`);
  check(
    'no facet read happens while the pull is held',
    reads.facets.length === facetBefore,
    `facets=${reads.facets.length - facetBefore}`,
  );

  releasePull();
  await wait(1200);
  check('the list is re-read after the pull completes', reads.list.length > listBefore);
  check('the facets are re-read after the pull completes', reads.facets.length > facetBefore);
  check(
    'the first post-sync list read lands after the pull was answered',
    Math.min(...reads.list.slice(listBefore)) >= reads.pulls[0],
  );
  check(
    'the first post-sync facet read lands after the pull was answered',
    Math.min(...reads.facets.slice(facetBefore)) >= reads.pulls[0],
  );
  check(
    'a completed sync is reported to the operator',
    /Fetched and stored 2 new record/.test(await page.locator('.ant-message').innerText()),
  );

  failSync = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText(/Sync incomplete/i).first().waitFor({ timeout: 5000 });
  check('a pull that could not drain CPA is reported, not shown as success', true);

  check('the refresh flow raises no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  console.log('REFRESH_SYNC_OK');
} finally {
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
  server?.kill();
}
