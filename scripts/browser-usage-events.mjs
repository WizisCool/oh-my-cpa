// Isolated browser regression: fixture responses never touch the user's CPA.
// Starts its own Vite server unless OMCPA_EVENTS_TEST_URL is provided.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.OMCPA_EVENTS_TEST_URL || 'http://127.0.0.1:5175/omc';
const output = path.join(root, 'tmp', 'request-events-qa');
fs.mkdirSync(output, { recursive: true });
let server;
let browser;
let page;
const now = Date.now();
const records = Array.from({ length: 1100 }, (_, index) => ({
  id: 1100 - index,
  event_key: `event-${index}`,
  request_id: `req_7fa2c9d1_${String(index).padStart(5, '0')}`,
  timestamp_ms: now - index * 1000,
  provider: ['openai', 'claude', 'gemini'][index % 3],
  model: ['gpt-5.4', 'claude-sonnet-4-6', 'gemini-2.5-pro'][index % 3],
  model_alias: index % 4 === 0 ? 'coding-fast' : undefined,
  source: `hmac:source-fingerprint-${index % 3}`,
  resource_name: index % 3 === 0 ? 'codex-team-production.json' : undefined,
  resource_id: index % 3 === 0 ? 'resource-1' : undefined,
  auth_index: `credential-${index % 3}`,
  auth_type: 'oauth',
  api_group_key: 'hmac:9f2a4c87b11e285daa03',
  api_group_label: 'api_key',
  executor_type: 'responses',
  failed: index % 7 === 0,
  generate: true,
  latency_ms: 1830 + index * 3,
  ttft_ms: index % 5 === 0 ? null : 284,
  tokens: {
    input: 2150,
    output: 485,
    reasoning: 120,
    cached: 1024,
    cache_read: 1024,
    cache_creation: 0,
    total: 2635,
  },
  has_request_log: true,
}));
const calls = [];
const errors = [];
let failList = false;
let failMetadata = false;
let partial = false;
let downloadCount = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  if (!process.env.OMCPA_EVENTS_TEST_URL) {
    server = spawn(
      process.execPath,
      [
        path.join(root, 'web/node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        '5175',
        '--strictPort',
      ],
      { cwd: path.join(root, 'web'), stdio: 'pipe', windowsHide: true },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error('Test Vite server failed to start');
      if (
        await fetch(base)
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      await wait(200);
    }
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('omc-theme')) localStorage.setItem('omc-theme', 'light');
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/omc/api/**', async (route) => {
    const url = new URL(route.request().url());
    const fulfill = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname.endsWith('/api/auth/session')) return fulfill({ authenticated: true });
    if (url.pathname.endsWith('/management/auth-files') && failMetadata)
      return fulfill({ error: 'Fixture metadata unavailable' }, 503);
    if (url.pathname.endsWith('/management/auth-files'))
      return fulfill({
        files: ['codex-team-production.json', 'claude-developer.json', 'gemini-workspace.json'].map(
          (name, i) => ({
            name,
            auth_index: 'credential-' + i,
            provider: ['openai', 'claude', 'gemini'][i],
            disabled: false,
            runtime_only: false,
          }),
        ),
        total: 3,
      });
    if (url.pathname.endsWith('/health'))
      return fulfill({ cpa_connected: true, version: 'fixture', status: 'ok' });
    if (url.pathname.endsWith('/usage/ingest-status'))
      return fulfill({
        enabled: true,
        healthy: true,
        collector: { mode: 'plugin', captured: 1100, coverage_gaps: 0 },
        stats: { pending: 0 },
      });
    if (url.pathname.endsWith('/usage/facets')) {
      const facet = (key) =>
        [...new Set(records.map((r) => r[key]))].filter(Boolean).map((value) => ({ value, requests: 100 }));
      return fulfill({
        window: { from: now - 3600000, to: now },
        facets: {
          models: facet('model'),
          providers: facet('provider'),
          sources: facet('source'),
          auth_indexes: facet('auth_index'),
          api_group_keys: facet('api_group_key'),
          executors: facet('executor_type'),
        },
      });
    }
    if (url.pathname.endsWith('/usage/events')) {
      calls.push(url);
      await wait(120);
      if (failList) return fulfill({ error: 'Fixture list unavailable' }, 503);
      let items = records.filter(
        (r) =>
          (!url.searchParams.get('request_id') || r.request_id === url.searchParams.get('request_id')) &&
          (!url.searchParams.get('provider') || r.provider === url.searchParams.get('provider')) &&
          (!url.searchParams.get('source') || r.source === url.searchParams.get('source')) &&
          (!url.searchParams.get('auth_index') || r.auth_index === url.searchParams.get('auth_index')) &&
          (url.searchParams.get('result') !== 'failed' || r.failed) &&
          (url.searchParams.get('result') !== 'success' || !r.failed),
      );
      const start = Number(url.searchParams.get('cursor') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      const hasMore = items.length > start + limit;
      items = items.slice(start, start + limit);
      return fulfill({
        items,
        has_more: hasMore,
        next_cursor: hasMore ? String(start + limit) : undefined,
        limit,
        window: { from: now - 3600000, to: now },
      });
    }
    if (url.pathname.endsWith('/request-log')) {
      downloadCount++;
      return route.fulfill({
        status: 200,
        body: 'Fixture request and response log',
        contentType: 'text/plain',
      });
    }
    if (/\/usage\/events\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      return fulfill({
        event: {
          ...records.find((r) => r.id === id),
          endpoint: '/v1/responses',
          client_ip: '192.0.2.10',
          user_agent: 'fixture-client/1.0',
          reasoning_effort: 'high',
          service_tier: 'default',
          response_service_tier: 'default',
        },
        related_errors: partial
          ? []
          : [
              {
                id: 1,
                timestamp_ms: now,
                status_code: 429,
                code: 'rate_limit',
                body: '{"error":"Rate limit exceeded"}',
                retryable: true,
                quota_exceeded: true,
                quota_reason: 'daily_limit',
              },
            ],
        partial_errors: partial ? ['correlated errors unavailable'] : [],
      });
    }
    return fulfill({});
  });
  await page.goto(`${base}/usage/events?limit=500`);
  await page
    .locator('.request-row')
    .first()
    .waitFor()
    .catch(async (error) => {
      console.log('PAGE ERRORS', errors, await page.locator('body').innerText());
      await page.screenshot({ path: path.join(output, 'failure.png') });
      throw error;
    });
  await wait(400);
  check(
    '500 loaded records use fewer than 40 mounted rows',
    (await page.locator('.request-row').count()) < 40,
  );
  check(
    'page-scoped metrics are visible',
    (await page.locator('.request-summary').innerText()).includes('500'),
  );
  check(
    'unbound auth indexes resolve to safe current file metadata',
    (await page.locator('.request-row').nth(1).innerText()).includes('claude-developer.json'),
  );
  check(
    'API grouping categories are not mistaken for client names',
    (await page.locator('.request-row').first().innerText()).includes('API Key · 9f2a4c87b11e'),
  );
  check(
    'source and caller appear in stream',
    (await page.locator('.request-row').first().innerText()).includes('codex-team-production.json'),
  );
  await page.screenshot({ path: path.join(output, 'desktop-light.png'), fullPage: true });
  // Discover the actual scroll container rather than depending on rc internals.
  const scrollResult = await page.locator('.request-list').evaluate((root) => {
    const el = [...root.querySelectorAll('*')].find(
      (e) =>
        e.scrollHeight > e.clientHeight + 100 &&
        ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowY),
    );
    if (!el) return false;
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  });
  check('Listy exposes a real scroll container', scrollResult);
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.locator('.request-list').hover();
    await page.mouse.wheel(0, 100000);
    await wait(150);
  }
  check(
    'virtual scroll reaches last record',
    (await page.locator('.request-list').innerText()).includes(records[499].request_id),
  );
  check('virtual DOM stays bounded at the bottom', (await page.locator('.request-row').count()) < 40);
  const beforePage = calls.at(-1);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('第 2 页 · 500 条记录').waitFor();
  check(
    'cursor navigation preserves frozen window',
    calls.at(-1).searchParams.get('from') === beforePage.searchParams.get('from') &&
      calls.at(-1).searchParams.get('to') === beforePage.searchParams.get('to'),
  );
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByText('第 1 页 · 500 条记录').waitFor();
  await page.getByRole('combobox', { name: '分组方式' }).click();
  await page.getByText('按提供商分组', { exact: true }).last().click();
  await page.locator('.request-group-title').first().waitFor();
  check(
    'provider grouping uses Listy group headers',
    (await page.locator('.request-group-title').count()) > 0,
  );
  await page.getByRole('combobox', { name: '分组方式' }).click();
  await page.getByText('按认证来源分组', { exact: true }).last().click();
  check(
    'credential group includes provider and source',
    (await page.locator('.request-group-title').first().innerText()).includes('.json'),
  );
  await page.getByRole('combobox', { name: '分组方式' }).click();
  await page.getByText('按时间排列', { exact: true }).last().click();
  await page.locator('.request-row').first().click();
  await page.locator('.request-source-chain').waitFor();
  await wait(200);
  await page.screenshot({ path: path.join(output, 'detail-light.png'), fullPage: true });
  check(
    'drawer shows upstream source and endpoint',
    (await page.locator('.request-detail').innerText()).includes('/v1/responses'),
  );
  await page.getByRole('tab', { name: '性能与用量' }).click();
  await page.getByText('Token 详细明细', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '诊断 (1)' }).click();
  await page.getByText('HTTP 429', { exact: true }).waitFor();
  check(
    'related errors disclose correlation rather than claiming exact status',
    (await page.locator('.request-detail').innerText()).includes('不代表本次请求的 HTTP 状态'),
  );
  check('raw logs are not prefetched', downloadCount === 0);
  await page.getByRole('button', { name: '下载请求日志', exact: true }).click();
  await page.getByText('下载请求日志确认', { exact: true }).waitFor();
  check('download requires explicit confirmation', downloadCount === 0);
  await Promise.all([
    page.waitForEvent('download'),
    page
      .locator('.ant-modal')
      .getByRole('button', { name: /确\s*定/ })
      .click(),
  ]);
  check('confirmed download uses same-origin log proxy', downloadCount === 1);
  await page.locator('.request-detail').getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.request-detail').waitFor({ state: 'hidden' });
  await wait(150);
  await page.getByRole('button', { name: '更多筛选', exact: true }).click();
  await page.getByRole('combobox', { name: '认证文件 / 索引' }).click();
  await page.getByText('claude-developer.json · credential-1', { exact: true }).last().click();
  await wait(350);
  check(
    'credential filter reaches API and URL',
    calls.at(-1).searchParams.get('auth_index') === 'credential-1' &&
      new URL(page.url()).searchParams.get('auth_index') === 'credential-1',
  );
  await page.getByRole('button', { name: /重\s*置/ }).click();
  await page.getByText('第 1 页 · 100 条记录').waitFor();
  const search = page.getByRole('textbox', { name: 'Request ID', exact: true });
  const beforeSearch = calls.length;
  await search.fill(records[0].request_id);
  await wait(150);
  check('request search is debounced', calls.length === beforeSearch);
  await page.getByText('第 1 页 · 1 条记录').waitFor();
  check(
    'search sends the full request identifier',
    calls.at(-1).searchParams.get('request_id') === records[0].request_id,
  );
  await search.fill('does-not-exist');
  await page.getByText('没有请求记录', { exact: true }).waitFor();
  check(
    'filtered empty state gives a recovery path',
    (await page.locator('.request-stream').innerText()).includes('移除筛选'),
  );
  await page.getByRole('button', { name: /重\s*置/ }).click();
  await page
    .locator('.request-row')
    .first()
    .waitFor()
    .catch(async (error) => {
      console.log('PAGE ERRORS', errors, await page.locator('body').innerText());
      await page.screenshot({ path: path.join(output, 'failure.png') });
      throw error;
    });
  failList = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('Fixture list unavailable', { exact: true }).waitFor();
  check(
    'refetch error retains previously displayed requests',
    (await page.locator('.request-row').count()) > 0,
  );
  failList = false;
  await page.getByRole('button', { name: /重\s*试/ }).click();
  await wait(300);
  partial = true;
  await page.locator('.request-row').nth(1).click();
  await page.getByRole('tab', { name: '诊断', exact: true }).click();
  await page.getByText('关联异常数据不完整', { exact: true }).waitFor();
  check(
    'partial error data is not represented as empty',
    (await page.getByText('未找到关联异常', { exact: true }).count()) === 0,
  );
  await page.locator('.request-detail').getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.request-detail').waitFor({ state: 'hidden' });
  await wait(150);
  await page.evaluate(() => localStorage.setItem('omc-theme', 'dark'));
  await page.reload();
  await page
    .locator('.request-row')
    .first()
    .waitFor()
    .catch(async (error) => {
      console.log('PAGE ERRORS', errors, await page.locator('body').innerText());
      await page.screenshot({ path: path.join(output, 'failure.png') });
      throw error;
    });
  check(
    'dark theme is applied',
    await page.evaluate(() => document.documentElement.dataset.theme === 'dark'),
  );
  await wait(200);
  await page.screenshot({ path: path.join(output, 'desktop-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(250);
  await page.screenshot({ path: path.join(output, 'mobile-dark.png'), fullPage: true });
  check(
    'mobile document has no horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  check(
    'mobile rows stay inside list',
    await page
      .locator('.request-row')
      .first()
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.locator('.request-row').first().click();
  await page.locator('.request-source-chain').waitFor();
  await wait(200);
  await page.screenshot({ path: path.join(output, 'mobile-detail.png'), fullPage: true });
  check(
    'mobile drawer has no horizontal overflow',
    await page.locator('.request-detail .ant-drawer-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.locator('.request-detail').getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.request-detail').waitFor({ state: 'hidden' });
  await wait(150);
  await page.evaluate(() => {
    localStorage.setItem('omc-lang', 'en');
    localStorage.setItem('omc-theme', 'light');
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('heading', { name: 'Requests', exact: true }).waitFor();
  check(
    'English locale does not expose translation keys',
    !/events\.[a-z_]+/.test(await page.locator('.request-events-page').innerText()),
  );
  await page.screenshot({ path: path.join(output, 'desktop-en.png'), fullPage: true });
  const customFrom = now - 3600000;
  const customTo = now - 1000;
  await page.goto(base + '/usage/events?from=' + customFrom + '&to=' + customTo + '&auth_index=credential-1');
  await page.locator('.request-row').first().waitFor();
  check(
    'dashboard custom range and auth drill-down are honored',
    calls.at(-1).searchParams.get('from') === String(customFrom) &&
      calls.at(-1).searchParams.get('to') === String(customTo) &&
      calls.at(-1).searchParams.get('auth_index') === 'credential-1',
  );
  const customCalls = calls.length;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await wait(350);
  check(
    'manual refresh refetches a fixed custom window',
    calls.length > customCalls && calls.at(-1).searchParams.get('from') === String(customFrom),
  );
  await page.locator('.request-row').first().focus();
  await page.keyboard.press('Enter');
  await page.locator('.request-source-chain').waitFor();
  check('keyboard Enter opens the selected request', await page.locator('.request-detail').isVisible());
  check(
    'current-file enrichment is labeled as nonhistorical',
    (await page.locator('.request-detail').innerText()).includes('not a historical snapshot'),
  );
  await page.locator('.request-detail').getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.request-detail').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    history.pushState({}, '', '?provider=gemini');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL('**?provider=gemini');
  await wait(350);
  check(
    'history navigation rehydrates filters',
    calls.at(-1).searchParams.get('provider') === 'gemini' && !calls.at(-1).searchParams.has('auth_index'),
  );
  await page.goBack();
  await wait(350);
  check(
    'Back restores original filter controls',
    new URL(page.url()).searchParams.get('auth_index') === 'credential-1' &&
      (await page.locator('.request-row').first().innerText()).includes('claude-developer.json'),
  );
  failMetadata = true;
  await page.reload();
  await page
    .getByText('Auth file metadata is unavailable. Linked resources or auth indexes are shown instead.', {
      exact: true,
    })
    .waitFor();
  check(
    'metadata failures preserve the request list and auth indexes',
    (await page.locator('.request-row').first().innerText()).includes('credential-1'),
  );
  failList = true;
  await page.reload();
  await page.getByText('Fixture list unavailable', { exact: true }).waitFor();
  check(
    'initial load failure is not presented as empty history',
    (await page.getByText('No request records', { exact: true }).count()) === 0,
  );
  check('no browser runtime errors', errors.length === 0);
  console.log(`Screenshots: ${output}`);
} catch (error) {
  console.log('FAILURE STATE', await page?.locator('body').innerText());
  await page?.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  await browser?.close();
  server?.kill();
}
