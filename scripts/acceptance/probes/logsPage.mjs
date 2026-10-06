import { settleLayout, until } from '../harness.mjs';

/**
 * The logs page's two sources - the gateway's tail and this console's own service log - and the
 * operator audit trail, which is a page of its own.
 *
 * What only a browser establishes here is that the sources stay apart - each one mounted on its
 * own and reading its own route - and that the audit trail reads as sentences a person can scan
 * on the console's shared list surface: a failure painted as one, an entry opened in a Drawer,
 * and a filter that narrows the server query rather than the rows already on screen.
 */

const NOW = Date.now();

const AUDIT_PAGE_ONE = [
  { id: 9, occurred_at_ms: NOW - 60_000, action: 'provider.delete', target_type: 'provider', target_id: 'gemini-backup', result: 'success', request_id: 'req-probe-9', source_summary: 'ip=203.0.113.0/24 ua=Mozilla/5.0', details: { name: 'Gemini backup' } },
  { id: 8, occurred_at_ms: NOW - 120_000, action: 'plugin.disable', target_type: 'plugin', target_id: 'request-logger', result: 'failure', request_id: 'req-probe-8', source_summary: 'ip=203.0.113.0/24 ua=Mozilla/5.0', details: { error: 'CPA returned HTTP 409' } },
  { id: 7, occurred_at_ms: NOW - 180_000, action: 'capability.usage_aggregate', target_type: 'capability_operation', target_id: 'c4776c6d228a7bf0512d03e9c339505e37b7637441a21bbe', result: 'success', request_id: 'req-probe-7', source_summary: 'ip=203.0.113.0/24 ua=Mozilla/5.0' },
];
const AUDIT_PAGE_TWO = [
  { id: 3, occurred_at_ms: NOW - 3 * 86_400_000, action: 'auth.login', target_type: 'auth', target_id: 'operator', result: 'success', request_id: 'req-probe-3', source_summary: 'ip=198.51.100.0/24 ua=Mozilla/5.0' },
];

/** The summary behind the outcome tiles and the category counts, over every page of the trail. */
const AUDIT_BUCKETS = [
  { prefix: 'provider', outcome: 'succeeded', count: 1 },
  { prefix: 'plugin', outcome: 'failed', count: 1 },
  { prefix: 'capability', outcome: 'succeeded', count: 1 },
  { prefix: 'auth', outcome: 'succeeded', count: 1 },
];

export function logsFixtures(auditRequests) {
  return [
    [(url) => url.pathname.endsWith('/management/logs/status'), () => ({ logging_to_file: true, request_log: false })],
    [(url) => url.pathname.endsWith('/management/logs'), () => ({
      lines: [
        '[2026-09-28 10:00:00] [abc12345] [info ] [gin_logger.go:1] 200 |   12ms | 127.0.0.1 | POST "/v1/chat/completions"',
        '[2026-09-28 10:00:01] [def12345] [info ] [gin_logger.go:1] 200 |   10ms | 127.0.0.1 | GET "/v1/models"',
      ],
      latest_after: 0,
      next_cursor: '',
      cursor_reset: false,
      limit: 2000,
    })],
    [(url) => url.pathname.endsWith('/management/service-logs'), (url) => {
      const after = Number(url.searchParams.get('after') ?? 0);
      const records = [
        { seq: 1, logged_at_ms: NOW - 90_000, level: 'info', message: 'HTTP server listening', attrs: [{ key: 'addr', value: ':8080' }] },
        { seq: 2, logged_at_ms: NOW - 60_000, level: 'warn', message: 'usage queue read timed out; retrying', attrs: [{ key: 'attempt', value: '1' }] },
        { seq: 3, logged_at_ms: NOW - 30_000, level: 'error', message: 'plugin status update failed', attrs: [{ key: 'plugin', value: 'request-logger' }] },
      ].filter((record) => record.seq > after);
      return { capturing: true, records, latest_seq: 3, oldest_seq: 1, gap: false, capacity: 2000, started_at_ms: NOW - 3_600_000 };
    }],
    [(url) => url.pathname.endsWith('/management/audit/summary'), () => ({ buckets: AUDIT_BUCKETS })],
    [(url) => url.pathname.endsWith('/management/audit/events'), (url) => {
      auditRequests.push(url.search);
      if (url.searchParams.get('before')) return { events: AUDIT_PAGE_TWO, next_cursor: '' };
      const category = url.searchParams.get('category') ?? '';
      const outcome = url.searchParams.get('outcome') ?? '';
      let events = AUDIT_PAGE_ONE;
      if (category) events = events.filter((event) => category.split(',').some((prefix) => event.action.startsWith(`${prefix}.`)));
      if (outcome === 'failed') events = events.filter((event) => event.result === 'failure');
      const isFiltered = Boolean(category || outcome);
      return { events, next_cursor: isFiltered ? '' : `${AUDIT_PAGE_ONE.at(-1).occurred_at_ms}_7` };
    }],
  ];
}

/** Reads the visible text of the selector, or '' while it is absent. */
async function textOf(page, selector) {
  const node = page.locator(selector).first();
  return (await node.count()) ? node.innerText() : '';
}

async function chooseSource(page, index) {
  await page.locator('.logs-source .ant-segmented-item').nth(index).click();
}

export async function logsSources({ base, page, check }) {
  await page.goto(`${base}/logs`, { waitUntil: 'domcontentloaded' });
  await page.locator('.logs-page').waitFor({ timeout: 20_000 });

  // ── the gateway tail is the default source ──────────────────────────────────
  const gatewayShown = await until(async () => (await page.locator('.log-row').count()) > 0, {
    label: 'the gateway tail rows',
  }).then(() => true).catch(() => false);
  check('the gateway tail is the default source and renders its lines', gatewayShown);

  const filterToggle = page.locator('button[aria-controls="log-request-filters"]');
  check('request filters start disclosed only on demand', await filterToggle.getAttribute('aria-expanded') === 'false');
  await filterToggle.click();
  const requestFilters = page.locator('#log-request-filters');
  await requestFilters.waitFor();
  const postFilter = requestFilters.getByRole('group', { name: 'Request method' }).getByRole('button', { name: /POST/ });
  check('method choices carry their facet count', (await postFilter.innerText()).replace(/\s/g, '') === 'POST1');
  await postFilter.click();
  await until(async () => await page.locator('.log-row').count() === 1, { label: 'the POST method filter' });
  check('method filtering keeps only the matching request', (await textOf(page, '.log-list')).includes('/v1/chat/completions') && !(await textOf(page, '.log-list')).includes('/v1/models'));
  check('the toolbar reports a disclosed request filter', (await filterToggle.innerText()).includes('1'));
  await postFilter.click();
  await until(async () => await page.locator('.log-row').count() === 2, { label: 'clearing the method filter' });

  const wrapSave = page.waitForResponse((response) => response.url().endsWith('/preferences/log_filters') && response.request().method() !== 'GET');
  await page.getByRole('button', { name: 'Wrap long lines', exact: true }).click();
  await wrapSave;
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  const viewer = page.locator('section').filter({ has: page.getByRole('button', { name: 'Exit fullscreen (Esc)', exact: true }) });
  await settleLayout(page);
  check('fullscreen escapes the transformed page shell and covers the viewport', await viewer.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return node.parentElement.parentElement === document.body && Math.abs(bounds.top) <= 1 && Math.abs(bounds.left) <= 1
      && Math.abs(bounds.width - window.innerWidth) <= 1 && Math.abs(bounds.height - window.innerHeight) <= 1;
  }));
  await requestFilters.getByRole('combobox', { name: 'Request path' }).click();
  await page.locator('.ant-select-dropdown:visible').waitFor();
  check('path choices expose request counts', (await page.locator('.ant-select-dropdown:visible').innerText()).includes('/v1/models'));
  await page.keyboard.press('Escape');
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden' });
  check('Escape closes the path popup before fullscreen', await page.getByRole('button', { name: 'Exit fullscreen (Esc)', exact: true }).isVisible());
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => await page.getByRole('button', { name: 'Wrap long lines', exact: true }).getAttribute('aria-pressed') === 'true', { label: 'the restored wrapping preference' });
  check('wrapping survives reloading the console', await page.getByRole('button', { name: 'Wrap long lines', exact: true }).getAttribute('aria-pressed') === 'true');

  // ── the service log is its own source ───────────────────────────────────────
  await chooseSource(page, 1);
  const serviceShown = await until(
    async () => (await textOf(page, '.log-list')).includes('HTTP server listening'),
    { label: 'the service log rows' },
  ).then(() => true).catch(() => false);
  check('the OMC service source renders the service records', serviceShown, await textOf(page, '.log-list'));
  check('switching source is linkable', new URL(page.url()).searchParams.get('source') === 'service', page.url());
  const gatewayLeaked = (await textOf(page, '.log-list')).includes('/v1/chat/completions');
  check('the service source does not show gateway lines', !gatewayLeaked);

  await page.locator('.log-level-chip.is-error').click();
  const onlyErrors = await until(async () => (await page.locator('.log-row').count()) === 1, {
    label: 'the error-level filter',
  }).then(() => true).catch(() => false);
  check('a level chip narrows the service records', onlyErrors, String(await page.locator('.log-row').count()));

  check('the logs page offers only its own two sources', (await page.locator('.logs-source .ant-segmented-item').count()) === 2);

  // ── an old audit link lands on the audit page ───────────────────────────────
  await page.goto(`${base}/logs?source=audit`, { waitUntil: 'domcontentloaded' });
  const redirected = await until(async () => new URL(page.url()).pathname.endsWith('/audit'), {
    label: 'the audit redirect',
  }).then(() => true).catch(() => false);
  check('a link to the old audit source opens the audit page', redirected, page.url());
}

export async function auditTrail({ base, page, check, auditRequests }) {
  await page.goto(`${base}/audit`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="audit-page"]').waitFor({ timeout: 20_000 });

  // ── the audit trail is the console's list surface, read as sentences ───────
  const trail = page.locator('[data-testid="audit-trail"]');
  const trailShown = await until(async () => (await trail.count()) > 0, { label: 'the audit trail' })
    .then(() => true).catch(() => false);
  check('the audit page renders the trail', trailShown);
  if (!trailShown) return;

  check('each day is drawn on the shared list surface', (await trail.locator('.data-table').count()) === (await trail.locator('section').count()));
  const visibleHeads = await trail.locator('.ant-table-thead').evaluateAll((heads) => heads.filter((head) => head.getBoundingClientRect().height > 1).length);
  check('the column names are drawn once, above the first day', visibleHeads === 1, String(visibleHeads));

  const entries = page.locator('[data-testid="audit-entry"]');
  const firstEntry = entries.first();
  const firstText = await firstEntry.innerText();
  check('an entry reads as a sentence rather than an action code', /删除提供商|Deleted a provider/.test(firstText) && !firstText.includes('provider.delete'), firstText);
  check('an entry names what it acted on', firstText.includes('gemini-backup'), firstText);

  check('a failed operation carries the danger tone', (await entries.nth(1).locator('.status-label.is-danger').count()) === 1);

  const agentText = await entries.nth(2).innerText();
  check('an opaque operation hash is not printed in the sentence', !agentText.includes('c4776c6d228a7bf0512d'), agentText);

  // ── an entry opens in a Drawer, and the Drawer steps through the trail ──────
  await firstEntry.click();
  const detail = page.locator('[data-testid="audit-detail"]');
  const detailShown = await until(async () => (await detail.count()) > 0 && (await detail.isVisible()), { label: 'the audit entry drawer' })
    .then(() => true).catch(() => false);
  check('opening an entry shows it in a drawer', detailShown);
  if (detailShown) {
    const detailText = await detail.innerText();
    check('the drawer shows the request id, the action code and the recorded detail', detailText.includes('req-probe-9') && detailText.includes('provider.delete') && detailText.includes('Gemini backup'), detailText);
    await page.getByRole('button', { name: /下一条|Next/ }).click();
    const stepped = await until(async () => (await detail.innerText()).includes('plugin.disable'), { label: 'the next entry in the drawer' })
      .then(() => true).catch(() => false);
    check('the drawer steps to the next entry', stepped, await detail.innerText());
    await page.keyboard.press('Escape');
    const closed = await until(async () => !(await detail.isVisible().catch(() => false)), { label: 'the drawer closing' })
      .then(() => true).catch(() => false);
    check('the drawer closes', closed);
  }

  const failedTile = page.locator('[data-testid="audit-stat-failed"]');
  const failedCounted = await until(async () => (await failedTile.innerText()).includes('1'), {
    label: 'the failed-outcome count',
  }).then(() => true).catch(() => false);
  check('the outcome tiles count the whole trail from the summary', failedCounted, await failedTile.innerText());

  // ── paging and filtering ask the server ─────────────────────────────────────
  await page.getByRole('button', { name: /加载更早的记录|Load older entries/ }).click();
  const olderShown = await until(async () => (await entries.count()) === 4, {
    label: 'the second audit page',
  }).then(() => true).catch(() => false);
  check('loading older entries appends the next page', olderShown);
  check('the next page is asked for with the cursor', auditRequests.some((search) => search.includes('before=')), auditRequests.join(' | '));

  await failedTile.click();
  const filtered = await until(async () => (await entries.count()) === 1, {
    label: 'the failed-outcome filter',
  }).then(() => true).catch(() => false);
  check('the outcome filter narrows the trail', filtered);
  check('the outcome filter is sent to the server', auditRequests.some((search) => search.includes('outcome=failed')), auditRequests.join(' | '));
  check('the outcome filter is kept in the address', new URL(page.url()).searchParams.get('outcome') === 'failed', page.url());
}

/** At a phone width each entry is one tappable row, and nothing runs off the edge. */
export async function auditTrailNarrow({ base, page, check }) {
  await page.goto(`${base}/audit`, { waitUntil: 'domcontentloaded' });
  const rows = page.locator('[data-testid="audit-trail"] [data-testid="audit-entry"]');
  await rows.first().waitFor({ timeout: 20_000 });
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const outside = [];
    for (const node of document.querySelectorAll('[data-testid="audit-trail"] [data-testid="audit-entry"], [data-testid="audit-stats"], [data-testid="audit-page"] .terminal-page-head')) {
      const rect = node.getBoundingClientRect();
      if (rect.right > width + 1) outside.push(`${node.className} ${Math.round(rect.right)}`);
    }
    return { outside, scroll: document.documentElement.scrollWidth - width };
  });
  check('no audit row or control runs past a phone screen', overflow.outside.length === 0 && overflow.scroll <= 1, JSON.stringify(overflow));

  const firstText = await rows.first().innerText();
  check('a phone row reads as the sentence and its outcome, not a list of labelled fields', /删除提供商|Deleted a provider/.test(firstText) && /成功|Succeeded/.test(firstText) && !/时间|Time\n/.test(firstText), firstText);
  const rowHeight = await rows.first().evaluate((row) => row.getBoundingClientRect().height);
  check('a phone row stays compact', rowHeight <= 80, String(rowHeight));

  await rows.first().click();
  const detailShown = await until(async () => page.locator('[data-testid="audit-detail"]').isVisible().catch(() => false), { label: 'the phone drawer' })
    .then(() => true).catch(() => false);
  check('tapping a phone row opens its entry in the drawer', detailShown);
}
