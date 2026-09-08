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
  provider: index === 3 ? 'openai-compatible-opencode go' : ['openai', 'claude', 'gemini'][index % 3],
  model: ['gpt-5.4', 'claude-sonnet-4-6', 'gemini-2.5-pro'][index % 3],
  model_alias: index % 4 === 0 ? 'coding-fast' : undefined,
  reasoning_effort: index % 3 === 0 ? 'high' : undefined,
  // Present on every record: the list must never render the requested tier.
  service_tier: 'auto',
  source: `hmac:source-fingerprint-${index % 3}`,
  resource_name: index % 3 === 0 ? 'codex-team-production.json' : undefined,
  resource_id: index % 3 === 0 ? 'resource-1' : undefined,
  auth_index: index === 3 ? 'opencode-idx' : `credential-${index % 3}`,
  auth_type: index === 3 ? 'api_key' : 'oauth',
  api_group_key: 'hmac:9f2a4c87b11e285daa03',
  api_group_label: 'api_key',
  // Display mask the pipeline stores alongside the fingerprint. Record 5 has
  // none, standing in for rows ingested before the mask column existed.
  api_key_mask: index === 5 ? undefined : 'sk-12345xxxxxxx7890',
  user_agent: index % 10 === 0 ? undefined : 'codex-cli/0.46',
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
  const storedPreferences = {};
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/omc/api/**', async (route) => {
    const url = new URL(route.request().url());
    const fulfill = (body, status = 200) => route.fulfill({ status, json: body });
    if (url.pathname.endsWith('/preferences') && route.request().method() === 'GET') {
      return fulfill({ preferences: storedPreferences });
    }
    if (url.pathname.includes('/preferences/') && route.request().method() === 'PUT') {
      const key = url.pathname.split('/').at(-1);
      try {
        storedPreferences[key] = JSON.parse(route.request().postData() || '{}');
      } catch {
        storedPreferences[key] = {};
      }
      return fulfill({ ok: true });
    }
    if (url.pathname.endsWith('/api/auth/session')) return fulfill({ authenticated: true });
    if (url.pathname.endsWith('/management/providers')) {
      return fulfill({
        providers: [
          { id: 'opencode-1', name: 'Opencode', family: 'openai-compatibility', auth_index: 'opencode-idx' },
        ],
        total: 1,
      });
    }
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
    if (url.pathname.includes('/preferences')) {
      return fulfill({ preferences: {} });
    }
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
      // The caller-key facet carries the display mask, exactly like the real
      // backend: the value stays the stored identity used for filtering.
      const apiGroupKeys = facet('api_group_key').map((entry) => ({
        ...entry,
        mask: 'sk-12345xxxxxxx7890',
      }));
      return fulfill({
        window: { from: now - 3600000, to: now },
        facets: {
          models: facet('model'),
          providers: facet('provider'),
          sources: facet('source'),
          auth_indexes: facet('auth_index'),
          api_group_keys: apiGroupKeys,
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
    (await page.locator('.request-row').first().innerText()).includes('sk-12345xxxxxxx7890') &&
      !(await page.locator('.request-row').first().innerText()).includes('hmac:') &&
      !(await page.locator('.request-row').first().innerText()).includes('API Key · '),
  );
  check(
    'source and caller appear in stream',
    (await page.locator('.request-row').first().innerText()).includes('codex-team-production.json'),
  );
  const row3Text = await page.locator('.request-row').nth(3).innerText();
  check(
    'AI provider displays only clean Name and no technical driver subtitle',
    row3Text.includes('Opencode') && !row3Text.includes('openai-compatible-opencode go'),
  );
  check(
    'TPS column header and generation speed metric are rendered',
    (await page.locator('.req-th-tps').innerText()).includes('TPS') &&
      (await page.locator('.req-col-tps').first().innerText()).includes('t/s'),
  );
  check(
    'model column stacks the reasoning effort under the model name',
    await page.locator('.req-col-model').first().evaluate((col) => {
      const name = col.querySelector('.req-model-name')?.textContent || '';
      const effort = col.querySelector('.req-model-sub .req-effort-badge')?.textContent || '';
      // Fixture record 0 is gpt-5.4 with reasoning_effort high.
      return name.includes('gpt-5.4') && effort.includes('high');
    }),
  );
  check(
    'model column drops the requested service tier and the alias line',
    await page.locator('.request-row').first().evaluate((row) => {
      const text = row.textContent || '';
      // Record 0 carries service_tier auto and model_alias coding-fast; the tier
      // is never a model fact and the alias now lives in the name tooltip.
      const alias = row.querySelector('.req-model-name')?.getAttribute('title') || '';
      return !text.includes('auto') && !text.includes('coding-fast') && alias.includes('coding-fast');
    }),
  );
  const firstResultText = await page.locator('.req-col-result').first().innerText();
  check(
    'result column renders a success/failed capsule with text',
    (await page.locator('.req-th-result').innerText()).includes('结果') &&
      ['成功', '失败'].some((label) => firstResultText.includes(label)),
  );
  check(
    'result capsule tone matches the stored failed flag',
    await page.locator('.request-row').first().evaluate((row) => {
      const pill = row.querySelector('.req-result-pill');
      if (!pill) return false;
      // Fixture record 0 is a failed request (index % 7 === 0).
      return pill.classList.contains('is-failed') && pill.textContent?.includes('失败');
    }),
  );
  check(
    'Key column renders the stored display mask, never the fingerprint',
    (await page.locator('.req-th-key').innerText()).trim().length > 0 &&
      await page.locator('.req-col-key').first().evaluate((col) => {
        const cell = col.querySelector('.req-key-val');
        const text = cell?.textContent?.trim() || '';
        return text === 'sk-12345xxxxxxx7890' && !text.includes('hmac:') && !text.includes('API Key');
      }),
  );
  check(
    'records without a stored key mask read as an em dash',
    (await page.locator('.req-col-key').nth(5).innerText()).trim() === '—',
  );
  check(
    'the key mask is not clipped by its column',
    await page.locator('.req-col-key').first().evaluate((col) => {
      const cell = col.querySelector('.req-key-val');
      return cell ? cell.scrollWidth <= cell.clientWidth + 1 : false;
    }),
  );
  check(
    'executor column shows only the executor, never the auth type beneath it',
    await page.locator('.req-col-executor').evaluateAll((cells) =>
      cells
        .slice(0, 4)
        .map((cell) => (cell.textContent || '').trim())
        // Every fixture record runs the responses executor; record 3 is the only
        // api_key auth record, so a leaked auth type would surface here.
        .every((text) => text.includes('responses') && !/oauth|api_key/i.test(text)),
    ),
  );
  check(
    'UA column renders the minimized client label',
    (await page.locator('.req-th-ua').innerText()).trim().length > 0 &&
      (await page.locator('.req-col-ua').nth(1).innerText()).includes('codex-cli/0.46'),
  );
  check(
    'records without a user agent read as an em dash',
    (await page.locator('.req-col-ua').first().innerText()).trim() === '—',
  );

  // Column resize & persistence testing
  const providerTh = page.locator('.req-th-provider');
  const providerResizer = providerTh.locator('.req-col-resizer');
  check('column resize handle exists', (await providerResizer.count()) > 0);

  const initialWidth = await providerTh.evaluate((el) => el.getBoundingClientRect().width);
  const resizerBox = await providerResizer.boundingBox();
  if (resizerBox) {
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 60, resizerBox.y + resizerBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await wait(250);
  }
  const resizedWidth = await providerTh.evaluate((el) => el.getBoundingClientRect().width);
  check('dragging resize handle changes column width', resizedWidth > initialWidth);
  check('column width preference is persisted', Boolean(storedPreferences.usage_events_columns?.provider));

  // Reset columns button
  const resetColBtn = page.locator('.req-reset-columns-btn');
  check('reset columns button appears when columns are customized', (await resetColBtn.count()) > 0);
  await resetColBtn.click();
  await wait(250);
  check(
    'reset columns button clears overrides in preferences',
    !storedPreferences.usage_events_columns?.provider,
  );

  // Header/row column boundaries must agree, and long names must not push the
  // last column out of the table region.
  const alignment = await page.evaluate(() => {
    const ids = ['time', 'result', 'provider', 'model', 'latency', 'tps', 'tokens', 'cache', 'executor', 'key', 'ua'];
    const row = document.querySelector('.request-row');
    return ids.map((id) => {
      const th = document.querySelector(`.req-th-${id}`);
      const cell = row?.querySelector(`.req-col-${id}`);
      if (!th || !cell) return { id, ok: false, delta: null };
      const a = th.getBoundingClientRect();
      const b = cell.getBoundingClientRect();
      return { id, ok: Math.abs(a.left - b.left) <= 2 && Math.abs(a.right - b.right) <= 2, delta: Math.round(Math.abs(a.left - b.left)) };
    });
  });
  const misaligned = alignment.filter((entry) => !entry.ok);
  check(
    'header and row column boundaries align within 2px',
    misaligned.length === 0,
  );
  if (misaligned.length > 0) console.log('MISALIGNED:', misaligned);
  check(
    'executor column stays inside the table region with long provider names',
    await page.locator('.request-row').first().evaluate((row) => {
      const cell = row.querySelector('.req-col-executor');
      const area = document.querySelector('.request-table-scroll-area');
      if (!cell || !area) return false;
      return cell.getBoundingClientRect().right <= area.getBoundingClientRect().right + 2;
    }),
  );
  check(
    'table region scrolls internally instead of the document',
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
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
  // Middle-of-stream: the fixed itemHeight is only an estimate for 88px rows,
  // so measured heights must still line up without skipping, duplicating or
  // overlapping neighbours.
  const midScroll = await page.locator('.request-list').evaluate((root) => {
    const el = [...root.querySelectorAll('*')].find(
      (e) =>
        e.scrollHeight > e.clientHeight + 100 &&
        ['auto', 'scroll', 'hidden'].includes(getComputedStyle(e).overflowY),
    );
    if (!el) return { found: false };
    el.scrollTop = Math.floor(el.scrollHeight / 2);
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { found: true };
  });
  check('Listy scrolls to the middle of the stream', midScroll.found);
  await wait(250);
  const midRows = await page.locator('.request-row').evaluateAll((rows) =>
    rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const match = (row.textContent || '').match(/req_7fa2c9d1_(\d{5})/);
      return { id: match ? Number(match[1]) : null, top: rect.top, bottom: rect.bottom, width: rect.width };
    }),
  );
  const midIds = midRows.map((row) => row.id);
  check(
    'middle rows are contiguous without gaps or duplicates',
    midIds.every((id) => id !== null) &&
      midIds.every((id, index) => index === 0 || id - midIds[index - 1] === 1),
  );
  check(
    'middle rows never overlap vertically',
    midRows.every((row, index) => index === 0 || row.top >= midRows[index - 1].bottom - 1),
  );
  check('middle rows render at full width', midRows.every((row) => row.width > 300));
  check('virtual DOM stays bounded in the middle', (await page.locator('.request-row').count()) < 40);
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
  await page.getByRole('combobox', { name: '请求来源' }).click();
  const callerFacetOption = page.getByText('sk-12345xxxxxxx7890 (100)', { exact: true }).last();
  check(
    'caller key facet lists the display mask instead of the stored fingerprint',
    await callerFacetOption.isVisible(),
  );
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: '认证文件 / 索引' }).click();
  await page.getByText('claude-developer.json · credential-1', { exact: true }).last().click();
  await wait(350);
  check(
    'credential filter reaches API and URL',
    calls.at(-1).searchParams.get('auth_index') === 'credential-1' &&
      new URL(page.url()).searchParams.get('auth_index') === 'credential-1',
  );
  // Advanced text inputs share the request-id debounce: typing must not fire
  // one list request per character.
  const authTypeInput = page.getByRole('textbox', { name: '认证方式', exact: true });
  const beforeAuthType = calls.length;
  await authTypeInput.fill('oauth');
  await wait(120);
  check(
    'advanced text filters are debounced',
    calls.length === beforeAuthType && !calls.at(-1).searchParams.has('auth_type'),
  );
  await page.waitForURL('**auth_type=oauth');
  let sawAuthTypeCall = false;
  for (let attempt = 0; attempt < 20 && !sawAuthTypeCall; attempt++) {
    sawAuthTypeCall = calls.some((call) => call.searchParams.get('auth_type') === 'oauth');
    if (!sawAuthTypeCall) await wait(100);
  }
  check(
    'debounced auth_type reaches API and URL',
    sawAuthTypeCall && new URL(page.url()).searchParams.get('auth_type') === 'oauth',
  );
  await authTypeInput.fill('');
  await page.waitForFunction(
    () => !new URLSearchParams(location.search).has('auth_type'),
    undefined,
    { timeout: 5000 },
  );
  check('clearing a debounced filter removes it from the URL', true);
  await wait(300);
  const modelAliasInput = page.getByRole('textbox', { name: '模型别名', exact: true });
  await authTypeInput.fill('p1');
  await modelAliasInput.fill('p2');
  const beforePendingReset = calls.length;
  check(
    'advanced drafts are still pending before reset',
    !new URL(page.url()).searchParams.has('auth_type') &&
      !new URL(page.url()).searchParams.has('model_alias'),
  );
  await page.getByRole('button', { name: /重\s*置/ }).click();
  await page.getByText('第 1 页 · 100 条记录').waitFor();
  await wait(800);
  check(
    'reset clears both pending advanced drafts',
    (await authTypeInput.inputValue()) === '' && (await modelAliasInput.inputValue()) === '',
  );
  check(
    'reset cancels pending advanced filter URL and API updates',
    !new URL(page.url()).searchParams.has('auth_type') &&
      !new URL(page.url()).searchParams.has('model_alias') &&
      calls.slice(beforePendingReset).every(
        (call) => !call.searchParams.has('auth_type') && !call.searchParams.has('model_alias'),
      ),
  );
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
  // Card mode must label every metric so values keep their meaning without the
  // desktop header.
  const mobileLabels = (await page
    .locator('.request-row')
    .first()
    .locator('.req-mobile-label')
    .allInnerTexts()).map((label) => label.toLowerCase());
  check(
    'mobile cards label every metric column',
    ['结果', 'tps', 'token', '缓存率', '执行器', 'key', 'ua'].every((needle) =>
      mobileLabels.some((label) => label.includes(needle)),
    ),
  );
  // A 320px viewport is the narrowest supported phone; multi-line rows may grow
  // past the height estimate, so both layout and virtualization must hold.
  await page.setViewportSize({ width: 320, height: 640 });
  await wait(250);
  check(
    '320px document has no horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  check(
    '320px rows stay inside list',
    await page
      .locator('.request-row')
      .first()
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  check('320px keeps the stream interactive', (await page.locator('.request-row').count()) > 0);
  // Shrinking the host exercises the ResizeObserver: the Listy height must
  // follow without unmounting the stream.
  const rowsBeforeResize = await page.locator('.request-row').count();
  await page.setViewportSize({ width: 320, height: 480 });
  await wait(250);
  const rowsAfterResize = await page.locator('.request-row').count();
  check(
    'window resize keeps the stream mounted and bounded',
    rowsAfterResize > 0 && rowsAfterResize <= rowsBeforeResize + 10,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(250);
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
  await page.keyboard.press('Escape');
  await page.locator('.request-detail').waitFor({ state: 'hidden' });
  check('keyboard Escape closes the detail drawer', await page.locator('.request-detail').count() === 0 || !(await page.locator('.request-detail').isVisible()));
  check(
    'focus returns to the page after closing the drawer',
    await page.evaluate(() => document.activeElement !== null && document.body.contains(document.activeElement)),
  );
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
  failList = false;
  failMetadata = false;
  // Test preference persistence: seed a preference, revisit bare route /usage/events without query params
  storedPreferences.usage_events_view = {
    preset: '24h',
    result: 'failed',
    grouping: 'provider',
    limit: 250,
  };
  await page.goto(base + '/usage/events');
  await page.locator('.request-row').first().waitFor();
  await wait(300);
  const rehydratedUrl = new URL(page.url());
  check(
    'bare route rehydrates filters and view settings from stored preferences',
    rehydratedUrl.searchParams.get('preset') === '24h' &&
      rehydratedUrl.searchParams.get('result') === 'failed' &&
      rehydratedUrl.searchParams.get('limit') === '250',
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
