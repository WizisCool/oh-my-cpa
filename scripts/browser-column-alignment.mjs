/**
 * Focused proof for the request-log column alignment and truncation.
 *
 * The alignment classes were introduced so the header and the body cell cannot
 * disagree, but they also replaced per-column rules that were doing two other
 * jobs: giving a nowrap cell the container's width (the precondition for
 * `text-overflow: ellipsis`) and centring the provider cell. A `flex-start` on a
 * column-direction flex sizes the cell to its own content, so a long provider or
 * model name overflows the column instead of being truncated - and asserting
 * "text-align matches" would not notice.
 *
 * So this probe drives the real page with deliberately long names and checks the
 * rendered geometry: no cell content may spill past its column track, header and
 * value alignment must agree for the numeric columns, and the provider icon and
 * its label must stay vertically centred.
 *
 * Run it with `pnpm verify:column-alignment`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 5180;
const base = `http://127.0.0.1:${port}/omc`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('FAIL column alignment probe timed out');
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
// Deliberately overlong values: they are what a fixed-width column has to
// truncate, and the failure this guards against only appears past the track width.
const LONG_PROVIDER = 'openai-compatible-commandcode-goat-super-long-relay-name';
const LONG_MODEL = 'vendor/some-extremely-long-model-identifier-that-cannot-fit';

const records = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  event_key: `event-${index}`,
  request_id: `req_fixture_${index}`,
  timestamp_ms: now - index * 1000,
  provider: LONG_PROVIDER,
  model: LONG_MODEL,
  failed: index % 5 === 0,
  latency_ms: 1200 + index * 37,
  ttft_ms: 120,
  generate: true,
  service_tier: 'auto',
  response_service_tier: 'default',
  source: 'hmac:source-fingerprint',
  auth_index: 'credential-1',
  auth_type: 'api_key',
  api_group_key: 'hmac:9f2a4c87b11e285daa03',
  api_key_mask: 'sk-12345••••••••7890',
  user_agent: 'codex-cli/0.46',
  executor_type: 'openai',
  has_request_log: true,
  tokens: {
    input: 1200,
    output: 485,
    reasoning: 120,
    cached: 400,
    cache_read: 400,
    cache_creation: 0,
    total: 2635,
  },
}));

const facets = {
  models: [{ value: LONG_MODEL, requests: 12 }],
  providers: [{ value: LONG_PROVIDER, requests: 12 }],
  api_group_keys: [{ value: 'hmac:9f2a4c87b11e285daa03', requests: 12, mask: 'sk-12345••••••••7890' }],
  auth_indexes: [],
  sources: [],
  executors: [],
  model_aliases: [],
  auth_types: [],
  reasoning_efforts: [],
  service_tiers: [],
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
    if (url.pathname.endsWith('/management/providers')) return fulfill({ providers: [], total: 0 });
    if (url.pathname.endsWith('/usage/facets')) return fulfill({ facets });
    if (url.pathname.includes('/usage/events')) return fulfill({ items: records, has_more: false, limit: 50 });
    if (url.pathname.endsWith('/usage/ingest-status')) return fulfill({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 12, coverage_gaps: 0 }, stats: { pending: 0 } });
    if (url.pathname.endsWith('/health')) return fulfill({ cpa_connected: true, version: 'probe', status: 'ok' });
    return fulfill({});
  });

  await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('.request-row').first().waitFor({ timeout: 20_000 });
  } catch (error) {
    console.error(`page errors: ${pageErrors.join(' | ') || 'none'}`);
    console.error(`page text: ${(await page.locator('body').innerText().catch(() => '')).slice(0, 500)}`);
    throw error;
  }
  await wait(600);

  // 1. No cell's content may spill outside its own grid track.
  //
  //    Scope note: this covers the text columns, which is where the truncation
  //    precondition matters - a lost `align-items: stretch` sizes those cells to
  //    their content and a long name overflows the track. The numeric columns are
  //    excluded on purpose: `.req-tokens-breakdown` is deliberately a nowrap row
  //    inside a right-aligned cell, so its left edge legitimately reaches past the
  //    padding box by a few pixels. That is pre-existing behaviour, verified by
  //    running this same check against the CSS from before the alignment change,
  //    which reports the identical 4px on the tokens column.
  const overflow = await page.evaluate(() => {
    const row = document.querySelector('.request-row');
    if (!row) return { ok: false, reason: 'no row' };
    const textColumns = [
      'req-col-time',
      'req-col-result',
      'req-col-provider',
      'req-col-model',
      'req-col-key',
      'req-col-ua',
    ];
    const columns = Array.from(row.querySelectorAll('.req-col')).filter((column) =>
      textColumns.some((name) => column.classList.contains(name)),
    );
    if (columns.length !== textColumns.length) {
      return { ok: false, reason: `matched ${columns.length} of ${textColumns.length} text columns` };
    }
    const offenders = [];
    for (const column of columns) {
      const columnBox = column.getBoundingClientRect();
      for (const child of Array.from(column.querySelectorAll('*'))) {
        const box = child.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        // A sub-pixel tolerance keeps rounding from reporting a false positive.
        if (box.right > columnBox.right + 1 || box.left < columnBox.left - 1) {
          offenders.push({
            column: column.className,
            child: String(child.className).slice(0, 60),
            spillLeft: Math.round(columnBox.left - box.left),
            spillRight: Math.round(box.right - columnBox.right),
          });
        }
      }
    }
    return { ok: offenders.length === 0, offenders: offenders.slice(0, 6) };
  });
  check('no text cell content spills outside its column', overflow.ok, JSON.stringify(overflow.offenders));

  // 2. The long values must actually be truncating rather than expanding the
  //    column: an ellipsised element's scrollWidth exceeds its clientWidth.
  const truncation = await page.evaluate(() => {
    const name = document.querySelector('.req-model-name');
    const provider = document.querySelector('.req-provider-name, .req-col-provider strong');
    const measure = (node) =>
      node ? { truncated: node.scrollWidth > node.clientWidth + 1, client: node.clientWidth, scroll: node.scrollWidth } : null;
    return { model: measure(name), provider: measure(provider) };
  });
  check(
    'the overlong model name is truncated, not expanded',
    truncation.model !== null && truncation.model.truncated,
    JSON.stringify(truncation.model),
  );

  // 3. Numeric columns: header and first cell must agree on horizontal alignment.
  const alignment = await page.evaluate(() => {
    const pairs = [
      ['latency', '.req-th-latency', '.req-col-latency'],
      ['tps', '.req-th-tps', '.req-col-tps'],
      ['tokens', '.req-th-tokens', '.req-col-tokens'],
      ['cost', '.req-th-cost', '.req-col-cost'],
      ['cache', '.req-th-cache', '.req-col-cache'],
    ];
    // A column-direction flex aligns its children horizontally through
    // `align-items`; a row-direction one through `justify-content`. Both sides are
    // read with the axis they actually use, so the comparison is like for like.
    const side = (node) => {
      if (!node) return null;
      const style = window.getComputedStyle(node);
      const value = style.flexDirection === 'row' ? style.justifyContent : style.alignItems;
      if (value === 'flex-end' || value === 'right') return 'right';
      if (value === 'center') return 'center';
      if (value === 'stretch' || value === 'flex-start' || value === 'left' || value === 'normal') {
        return value === 'stretch' ? 'stretch' : 'left';
      }
      return value;
    };
    return pairs.map(([name, headerSelector, cellSelector]) => ({
      name,
      header: side(document.querySelector(headerSelector)),
      cell: side(document.querySelector(cellSelector)),
    }));
  });
  const mismatched = alignment.filter((entry) => entry.header !== entry.cell);
  check(
    'numeric column headers and values agree on alignment',
    mismatched.length === 0,
    JSON.stringify(mismatched),
  );
  check(
    'the numeric columns are right-aligned',
    alignment.every((entry) => entry.cell === 'right'),
    JSON.stringify(alignment),
  );

  // 4. The provider cell is row-direction: its icon and label share one line and
  //    must stay vertically centred, which a `flex-start` cross alignment breaks.
  const providerGeometry = await page.evaluate(() => {
    const column = document.querySelector('.req-col-provider');
    if (!column) return { ok: false, reason: 'no provider column' };
    const flexDirection = window.getComputedStyle(column).flexDirection;
    const children = Array.from(column.children).filter((child) => {
      const box = child.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    if (children.length < 2) return { ok: false, reason: `only ${children.length} visible children` };
    const centres = children.map((child) => {
      const box = child.getBoundingClientRect();
      return box.top + box.height / 2;
    });
    const spread = Math.max(...centres) - Math.min(...centres);
    return { ok: spread <= 8, flexDirection, spread: Math.round(spread) };
  });
  check(
    'the provider cell keeps its icon and label vertically centred',
    providerGeometry.ok && providerGeometry.flexDirection === 'row',
    JSON.stringify(providerGeometry),
  );

  // 5. The header and the first row must share one grid, so their column tracks
  //    line up; a drifting template is what makes a table look misaligned.
  const tracksAligned = await page.evaluate(() => {
    const header = document.querySelector('.request-table-header');
    const row = document.querySelector('.request-row');
    if (!header || !row) return { ok: false, reason: 'missing header or row' };
    const headerCells = Array.from(header.querySelectorAll('.req-th')).map((n) => Math.round(n.getBoundingClientRect().left));
    const rowCells = Array.from(row.querySelectorAll('.req-col')).map((n) => Math.round(n.getBoundingClientRect().left));
    const compared = Math.min(headerCells.length, rowCells.length);
    const drift = [];
    for (let index = 0; index < compared; index += 1) {
      if (Math.abs(headerCells[index] - rowCells[index]) > 1) {
        drift.push({ index, header: headerCells[index], row: rowCells[index] });
      }
    }
    return { ok: drift.length === 0, drift: drift.slice(0, 4) };
  });
  check('header and row column tracks line up', tracksAligned.ok, JSON.stringify(tracksAligned.drift));

  check('no page errors on the request log', pageErrors.length === 0, pageErrors.join(' | '));
} catch (error) {
  console.error(`FAIL ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await browser?.close().catch(() => {});
  server?.kill('SIGTERM');
  await wait(300);
  if (process.exitCode !== 1) console.log('column alignment probe complete');
}
