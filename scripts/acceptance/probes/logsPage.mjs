import { until } from '../harness.mjs';

/**
 * The logs page's two sources - the gateway's tail and this console's own service log - and the
 * operator audit trail, which is a page of its own.
 *
 * What only a browser establishes here is that the sources stay apart - each one mounted on its
 * own and reading its own route - and that the audit trail reads as sentences a person can scan:
 * an attempt folded into its outcome, a failure painted as one, and a filter that narrows the
 * server query rather than the rows already on screen.
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
      lines: ['[2026-09-28 10:00:00] [abc12345] [info ] [gin_logger.go:1] 200 |   12ms | 127.0.0.1 | POST "/v1/chat/completions"'],
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

  // ── the audit trail reads as sentences ──────────────────────────────────────
  const trail = page.locator('[data-testid="audit-trail"]');
  const trailShown = await until(async () => (await trail.count()) > 0, { label: 'the audit trail' })
    .then(() => true).catch(() => false);
  check('the audit page renders a timeline', trailShown);
  if (!trailShown) return;

  const firstEntry = page.locator('[data-testid="audit-entry"]').first();
  const firstText = await firstEntry.innerText();
  check('an entry reads as a sentence rather than an action code', /删除提供商|Deleted a provider/.test(firstText) && !firstText.includes('provider.delete'), firstText);
  check('an entry names what it acted on', firstText.includes('gemini-backup'), firstText);

  const failed = page.locator('[data-testid="audit-entry"]').nth(1);
  check('a failed operation carries the danger tone', (await failed.locator('.status-label.is-danger').count()) === 1);

  const agentText = await page.locator('[data-testid="audit-entry"]').nth(2).innerText();
  check('an opaque operation hash is not printed in the sentence', !agentText.includes('c4776c6d228a7bf0512d'), agentText);

  await firstEntry.locator('button').first().click();
  const detailText = await firstEntry.innerText();
  check('opening an entry shows its request id and action code', detailText.includes('req-probe-9') && detailText.includes('provider.delete'), detailText);

  const failedTile = page.locator('[data-testid="audit-stat-failed"]');
  const failedCounted = await until(async () => (await failedTile.innerText()).includes('1'), {
    label: 'the failed-outcome count',
  }).then(() => true).catch(() => false);
  check('the outcome tiles count the whole trail from the summary', failedCounted, await failedTile.innerText());

  // ── paging and filtering ask the server ─────────────────────────────────────
  await page.getByRole('button', { name: /加载更早的记录|Load older entries/ }).click();
  const olderShown = await until(async () => (await page.locator('[data-testid="audit-entry"]').count()) === 4, {
    label: 'the second audit page',
  }).then(() => true).catch(() => false);
  check('loading older entries appends the next page', olderShown);
  check('the next page is asked for with the cursor', auditRequests.some((search) => search.includes('before=')), auditRequests.join(' | '));

  await failedTile.click();
  const filtered = await until(async () => (await page.locator('[data-testid="audit-entry"]').count()) === 1, {
    label: 'the failed-outcome filter',
  }).then(() => true).catch(() => false);
  check('the outcome filter narrows the trail', filtered);
  check('the outcome filter is sent to the server', auditRequests.some((search) => search.includes('outcome=failed')), auditRequests.join(' | '));
  check('the outcome filter is kept in the address', new URL(page.url()).searchParams.get('outcome') === 'failed', page.url());
}

/** At a phone width no audit entry may run off the right edge. */
export async function auditTrailNarrow({ base, page, check }) {
  await page.goto(`${base}/audit`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="audit-entry"]').first().waitFor({ timeout: 20_000 });
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const outside = [];
    for (const node of document.querySelectorAll('[data-testid="audit-entry"], [data-testid="audit-stats"], .logs-toolbar')) {
      const rect = node.getBoundingClientRect();
      if (rect.right > width + 1) outside.push(`${node.className} ${Math.round(rect.right)}`);
    }
    return { outside, scroll: document.documentElement.scrollWidth - width };
  });
  check('no audit entry or control runs past a phone screen', overflow.outside.length === 0 && overflow.scroll <= 1, JSON.stringify(overflow));
}
