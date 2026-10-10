import { fulfillFixture } from '../browser-guard.mjs';
import fs from 'node:fs';

import { sleep } from '../probe.mjs';
import { until } from '../harness.mjs';

/**
 * Probes for the request-record console: the column geometry and truncation, the
 * live tail and the hold a reader takes when they scroll away, the refresh
 * sequence, and the interactions the table answers (resize, keyboard, download).
 */

export const LONG_PROVIDER = 'openai-compatible-commandcode-goat-super-long-relay-name';
export const LONG_MODEL = 'vendor/some-extremely-long-model-identifier-that-cannot-fit';

export const alignmentRecords = (() => {
  const now = Date.now();
  return Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    event_key: `event-${index}`,
    // CPA v8's shape: one UUID per execution, far wider than the time column.
    request_id: `01a0ebc0-1f12-780f-b958-91d438ab${String(1000 + index)}`,
    timestamp_ms: now - index * 1000,
    provider: LONG_PROVIDER,
    model: LONG_MODEL,
    // A substitution adds a line to the model cell, and the served name can be
    // as long as the requested one, so it has to truncate inside the same track.
    response_model: `${LONG_MODEL}-substituted`,
    model_substituted: true,
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
    tokens: { input: 1200, output: 485, reasoning: 120, cached: 400, cache_read: 400, cache_creation: 0, total: 2635 },
  }));
})();

export const alignmentFacets = {
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

/**
 * The alignment classes replaced per-column rules that were also doing two other
 * jobs: giving a nowrap cell the container's width (the precondition for
 * `text-overflow: ellipsis`) and centring the provider cell. A `flex-start` on a
 * column-direction flex sizes the cell to its own content, so a long provider or
 * model name overflows the column instead of being truncated - and asserting
 * "text-align matches" would not notice.
 */
export async function columnAlignment({ base, page, check }) {
  // Headless Chromium draws no scrollbars, so a desktop's classic 14px scrollbar is emulated for
  // any code that measures one. The virtual list draws its own overlay scrollbar and loses no
  // width to a native one, so a header that pads a measured gutter drifts off the rows' tracks.
  await page.addInitScript(() => {
    const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get() {
        const width = clientWidth.get.call(this);
        return this instanceof HTMLElement && this.style.overflow === 'scroll' ? Math.max(0, width - 14) : width;
      },
    });
  });
  await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

  // Change the shared display-zone store while the row remains mounted; route navigation
  // would recreate its memo and could not detect a missing timezone dependency.
  const timeLabel = page.locator('.request-row .req-time-text').first();
  const initialTimestamp = Date.parse(await timeLabel.getAttribute('datetime'));
  const timeHandle = await timeLabel.elementHandle();
  await timeLabel.hover();
  const timePopup = page.locator('.request-cell-tooltip');
  await timePopup.waitFor({ state: 'visible' });
  const timeModuleUrl = `${base}/src/utils/time.ts`;
  const originalZone = await page.evaluate(async (url) => (await import(url)).getTimeZone(), timeModuleUrl);
  try {
    for (const zone of ['UTC', 'Asia/Kathmandu']) {
      const fields = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(initialTimestamp).map((part) => [part.type, part.value]));
      const expected = `${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`;
      await page.evaluate(async ({ url, zone }) => (await import(url)).configureTimeZone(zone), { url: timeModuleUrl, zone });
      const hasUpdated = await until(async () => (await timeLabel.innerText()) === expected, { label: `mounted request time in ${zone}` })
        .then(() => true).catch(() => false);
      check(`mounted request labels follow ${zone} without replacing the row`, hasUpdated &&
        await timeHandle.evaluate((element) => element.isConnected && element === document.querySelector('.request-row .req-time-text')),
      await timeLabel.innerText());
      await until(async () => (await timePopup.innerText()) === (await timeLabel.getAttribute('data-request-tooltip')),
        { label: `active request tooltip in ${zone}` });
      check(`active timestamp tooltip follows ${zone} on the same cell`,
        (await timePopup.innerText()).includes(expected.slice(0, 5)) &&
        (await timePopup.innerText()).includes(expected.slice(6)));
    }
  } finally {
    await page.evaluate(async ({ url, zone }) => (await import(url)).configureTimeZone(zone), { url: timeModuleUrl, zone: originalZone });
    await timeHandle.dispose();
    await page.keyboard.press('Escape');
    await timePopup.waitFor({ state: 'hidden' });
  }

  // 1. No cell's content may spill outside its own grid track.
  //
  //    Scope note: this covers the text columns, which is where the truncation
  //    precondition matters. The numeric columns are excluded on purpose:
  //    `.req-tokens-breakdown` is deliberately a nowrap row inside a right-aligned
  //    cell, so its left edge legitimately reaches past the padding box by a few
  //    pixels - pre-existing behaviour, verified by running this same check
  //    against the CSS from before the alignment change, which reports the
  //    identical 4px on the tokens column.
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
  const servedLine = page.locator('.request-row').first().locator('[data-testid="request-served-model"]');
  check('a substituted request names the served model in its row',
    (await servedLine.count()) === 1 && (await servedLine.innerText()).includes('-substituted'));

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

  // 2b. The request id sits under the time on one line: a wrapped UUID made every row several
  //     lines tall.
  const requestIdLine = await page.evaluate(() => {
    const node = document.querySelector('.req-time-sub-id');
    if (!node) return null;
    const lineHeight = parseFloat(window.getComputedStyle(node).lineHeight) || 16;
    return { height: node.getBoundingClientRect().height, lineHeight, whiteSpace: window.getComputedStyle(node).whiteSpace };
  });
  check(
    'the request id stays on one line under the time',
    requestIdLine !== null && requestIdLine.height < requestIdLine.lineHeight * 1.5,
    JSON.stringify(requestIdLine),
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
  check('numeric column headers and values agree on alignment', mismatched.length === 0, JSON.stringify(mismatched));
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
    // The selection track is compared by `request-export`; here the cells are the data columns.
    const headerCells = Array.from(header.querySelectorAll('.req-th:not(.req-th-select)')).map((n) => Math.round(n.getBoundingClientRect().left));
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

  // 6. The responsive breakpoints must still win. The base rules are written with
  //    `:where()` at zero specificity on purpose, so the mobile numeric overrides
  //    (which restore left alignment when the layout stacks) have to beat them -
  //    a specificity slip here would silently re-right-align the stacked cards.
  await page.setViewportSize({ width: 600, height: 1000 });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 10_000 });
  const stacked = await page.evaluate(() => {
    const measure = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const style = window.getComputedStyle(node);
      return { align: style.alignItems, textAlign: style.textAlign, direction: style.flexDirection };
    };
    return {
      latency: measure('.req-col-latency'),
      tokens: measure('.req-col-tokens'),
      cache: measure('.req-col-cache'),
    };
  });
  const stackedEntries = Object.entries(stacked).filter(([, value]) => value !== null);
  check(
    'the stacked layout restores left alignment for numeric columns',
    stackedEntries.length === 3 &&
      stackedEntries.every(([, value]) => value.align === 'flex-start' && value.textAlign === 'left'),
    JSON.stringify(stacked),
  );

  // 7. Narrowest supported width, the row was the tallest thing on the page: a UUID that wraps at
  //    every hyphen turns one record into four or five lines. The id has to ellipsise here rather
  //    than grow, which is a different failure from overflowing its cell and so is asserted again.
  const narrowRequestId = await page.evaluate(() => {
    const node = document.querySelector('.req-time-sub-id');
    if (!node) return null;
    const lineHeight = parseFloat(window.getComputedStyle(node).lineHeight) || 16;
    const cell = node.closest('.req-col-time');
    return {
      height: node.getBoundingClientRect().height,
      lineHeight,
      overflowsCell: cell ? node.getBoundingClientRect().right > cell.getBoundingClientRect().right + 1 : false,
    };
  });
  check(
    'the request id still ellipsises to one line at 600px',
    narrowRequestId !== null
      && narrowRequestId.height < narrowRequestId.lineHeight * 1.5
      && narrowRequestId.overflowsCell === false,
    JSON.stringify(narrowRequestId),
  );
}

// ---------------------------------------------------------------------------
// Icon picker layering
// ---------------------------------------------------------------------------


export const interactionRecords = (() => {
  const now = Date.now();
  return Array.from({ length: 500 }, (_, index) => ({
    id: 500 - index,
    event_key: `event-${index}`,
    request_id: `req_interaction_${String(index).padStart(4, '0')}`,
    timestamp_ms: now - index * 1000,
    provider: ['openai', 'claude', 'gemini'][index % 3],
    model: ['gpt-5.4', 'claude-sonnet-4-6', 'gemini-2.5-pro'][index % 3],
    service_tier: 'auto',
    source: `hmac:source-fingerprint-${index % 3}`,
    auth_index: `credential-${index % 3}`,
    auth_type: 'oauth',
    api_group_key: 'hmac:9f2a4c87b11e285daa03',
    api_key_mask: 'sk-12345••••••••7890',
    user_agent: index % 10 === 0 ? undefined : 'fixture-client/1.0',
    executor_type: 'responses',
    failed: index % 7 === 0,
    ...(index % 7 === 0 ? { fail_status_code: 502 } : {}),
    generate: true,
    latency_ms: 1830 + index * 3,
    ttft_ms: 284,
    endpoint: '/v1/responses',
    tokens: { input: 2150, output: 485, reasoning: 120, cached: 400, cache_read: 400, cache_creation: 0, total: 2635 },
    has_request_log: true,
  }));
})();

export const INTERACTION_FAILURE_BODY =
  '{"error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded."}}';

export const INTERACTION_RESPONSE_HEADERS = [
  { name: 'cf-cache-status', value: 'DYNAMIC' },
  { name: 'cf-ray', value: 'a4838167fd32d5c8-NRT' },
  { name: 'retry-after', value: '30' },
  { name: 'server', value: 'cloudflare' },
  { name: 'x-ratelimit-remaining-requests', value: '0' },
  { name: 'x-request-id', value: 'req_upstream_0001' },
];

/** The single-record view of one interaction record: the list omits the upstream body. */
export function interactionRecordDetail(id) {
  const record = interactionRecords.find((candidate) => candidate.id === id);
  if (!record) return { status: 404, json: { error: 'usage event not found' } };
  return {
    event: {
      ...record,
      ...(record.failed ? { fail_body: INTERACTION_FAILURE_BODY } : {}),
      response_headers: INTERACTION_RESPONSE_HEADERS,
    },
  };
}

/**
 * The request list's reader interactions: virtualization bounds, the column
 * resizer and its persistence, the collapse gesture, keyboard access to the detail
 * drawer, and the gated request-log download.
 *
 * These came from `scripts/browser-usage-events.mjs`, which was deleted when the
 * probe files were combined. They are restored here rather than dropped: every one
 * is a claim only a real engine can make, and several (the download gate, the
 * keyboard path, the resize handle) had no replacement anywhere. The scenario runs
 * against the same Vite dev server and mocked API as the other probes, with a large
 * record set because a bounded virtual window is only observable when there is
 * something to virtualize.
 */
export async function requestListInteractions({ base, page, check }) {
  await page.addInitScript(() => {
    window.__requestRowMountPeak = 0;
    new MutationObserver(() => {
      window.__requestRowMountPeak = Math.max(window.__requestRowMountPeak, document.querySelectorAll('.request-row').length);
    }).observe(document, { childList: true, subtree: true });
  });
  const downloads = [];
  page.on('request', (request) => {
    if (request.url().includes('/request-log')) downloads.push(request.url());
  });

  await page.goto(`${base}/usage/events?preset=24h&limit=100`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

  const mountWindow = await page.evaluate(() => {
    const holder = document.querySelector('.request-list [class*="-holder"]');
    const row = document.querySelector('.request-row');
    const rowMinimum = row ? Number.parseFloat(getComputedStyle(row).minHeight) : NaN;
    const allowedRows = Math.ceil((holder?.clientHeight ?? 0) / rowMinimum) + 3;
    return { peak: window.__requestRowMountPeak, allowedRows };
  });
  check('the initial request mount is bounded by row geometry rather than generic list items',
    mountWindow.peak > 0 && mountWindow.peak <= mountWindow.allowedRows, JSON.stringify(mountWindow));

  check('request cells mount without dormant popup instances',
    await page.locator('.request-cell-tooltip').count() === 0);
  const timestampCell = page.locator('.request-row .req-time-text').first();
  const timestampHandle = await timestampCell.elementHandle();
  const timestampTitle = await timestampCell.getAttribute('data-request-tooltip');
  await timestampCell.hover();
  const cellPopup = page.locator('.request-cell-tooltip');
  await cellPopup.waitFor({ state: 'visible' });
  await until(async () => (await cellPopup.innerText()) === timestampTitle, { label: 'request timestamp tooltip' });
  const tooltipAnchor = await page.evaluate(() => {
    const cell = document.querySelector('.req-time-text');
    const popup = document.querySelector('.request-cell-tooltip');
    const bounds = cell.getBoundingClientRect();
    const popupBounds = popup.getBoundingClientRect();
    return { described: document.getElementById(cell.getAttribute('aria-describedby'))?.closest('.request-cell-tooltip') === popup,
      aligned: popupBounds.bottom <= bounds.top + 1 && popupBounds.right > bounds.left && popupBounds.left < bounds.right };
  });
  check('one popup shows the exact timestamp and describes its stationary cell',
    await cellPopup.count() === 1 && tooltipAnchor.described && tooltipAnchor.aligned &&
    await timestampHandle.evaluate((element) => element === document.querySelector('.req-time-text')),
    JSON.stringify(tooltipAnchor));

  const cacheCell = page.locator('.request-row .req-cache-hit').first();
  await cacheCell.hover();
  const cacheTitle = await cacheCell.getAttribute('data-request-tooltip');
  await until(async () => (await cellPopup.innerText()) === cacheTitle, { label: 'shared cache tooltip' });
  check('switching cells reuses one popup and releases the previous description',
    await cellPopup.count() === 1 && await timestampCell.getAttribute('aria-describedby') === null);
  await cellPopup.hover();
  check('the tooltip stays visible while its text is hovered', await cellPopup.isVisible());
  await page.keyboard.press('Escape');
  await cellPopup.waitFor({ state: 'hidden' });
  check('Escape dismisses the shared request tooltip', await cacheCell.getAttribute('aria-describedby') === null);
  await page.mouse.move(0, 0);

  // A failed pill explains itself: the list knows the status, and the upstream's
  // own error body is read for that one record when the pill is pointed at.
  const detailReads = [];
  page.on('request', (request) => {
    if (/\/usage\/events\/\d+$/.test(new URL(request.url()).pathname)) detailReads.push(request.url());
  });
  const failedPill = page.locator('.request-row .req-result-pill.is-failed').first();
  await failedPill.hover();
  const failurePopup = page.locator('.request-failure-tooltip');
  await failurePopup.waitFor({ state: 'visible' });
  await until(async () => (await failurePopup.innerText()).includes('server_is_overloaded'), { label: 'upstream error body' });
  const failureText = await failurePopup.innerText();
  const failureFit = await page.evaluate(() => {
    const bounds = document.querySelector('.request-failure-tooltip').getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight };
  });
  check('hovering a failed result shows its HTTP status and the upstream error body',
    failureText.includes('HTTP 502') && failureText.includes(INTERACTION_FAILURE_BODY) && detailReads.length === 1,
    `reads=${detailReads.length} text=${failureText.slice(0, 80)}`);
  check('the failure popup stays inside the viewport',
    failureFit.left >= 0 && failureFit.top >= 0 && failureFit.right <= failureFit.width && failureFit.bottom <= failureFit.height,
    JSON.stringify(failureFit));
  await page.screenshot({ path: 'tmp/request-failure-popup.png' });
  await failurePopup.locator('pre').hover();
  check('the failure popup stays open while its text is read', await failurePopup.isVisible());
  check('a successful result carries no failure popup',
    await page.locator('.request-row .req-result-pill.is-success[data-request-failure]').count() === 0);
  await page.keyboard.press('Escape');
  await failurePopup.waitFor({ state: 'hidden' });
  await page.mouse.move(0, 0);

  const priceAction = page.locator('[data-testid="request-set-price"]').first();
  await priceAction.focus();
  await cellPopup.waitFor({ state: 'visible' });
  await until(async () => (await cellPopup.innerText()) === (await priceAction.getAttribute('aria-label')),
    { label: 'keyboard price tooltip' });
  await page.keyboard.press('Escape');
  await cellPopup.waitFor({ state: 'hidden' });
  check('keyboard dismissal preserves the price action and its focus',
    await priceAction.evaluate((element) => element === document.activeElement && !element.hasAttribute('aria-describedby')));
  await timestampCell.hover();
  await cellPopup.waitFor({ state: 'visible' });
  // The same DOM node can be recycled by an identical refresh; its current label must win.
  await timestampCell.evaluate((element) => { element.dataset.requestTooltip += ' refreshed'; });
  await until(async () => (await cellPopup.innerText()) === `${timestampTitle} refreshed`, { label: 'active tooltip revision' });
  check('an active tooltip follows updates without replacing its request cell',
    await timestampHandle.evaluate((element) => element.isConnected && element === document.querySelector('.req-time-text')));
  await timestampCell.evaluate((element, title) => { element.dataset.requestTooltip = title; }, timestampTitle);
  await timestampHandle.dispose();
  await timestampCell.hover();
  await cellPopup.waitFor({ state: 'visible' });
  await page.locator('.app-menu [data-route-path="/system"]').first().click();
  await until(async () => (await page.locator('.request-list-host').count()) === 0,
    { label: 'leave the request tooltip host' });
  await page.locator('.system-page .ant-card').first().waitFor();
  check('leaving Requests removes the active popup and its anchor',
    await page.locator('.request-cell-tooltip').count() === 0 &&
    await page.locator('[data-request-tooltip-anchor]').count() === 0);
  await page.locator('.app-menu [data-route-path="/usage/events"]').first().click();
  await page.locator('.request-row').first().waitFor();
  await page.locator('.request-row .req-time-text').first().hover();
  await cellPopup.waitFor({ state: 'visible' });

  // The virtualizer must expose a real scroll container, and the mounted window must
  // stay bounded however far the reader goes: an unbounded DOM is what makes a long
  // stream unusable, and a row count that grows with the scroll is the only symptom
  // a presence check would miss.
  const hasScrollContainer = await page.evaluate(() => {
    const root = document.querySelector('.request-list-host') ?? document.body;
    return [...root.querySelectorAll('*')].some(
      (node) =>
        node.scrollHeight > node.clientHeight + 100 &&
        ['auto', 'scroll', 'hidden'].includes(getComputedStyle(node).overflowY),
    );
  });
  check('the request list exposes a real scroll container', hasScrollContainer);

  const scroller = await page.evaluateHandle(() => {
    const root = document.querySelector('.request-list-host') ?? document.body;
    return (
      [...root.querySelectorAll('*')].find(
        (node) =>
          node.scrollHeight > node.clientHeight + 100 &&
          ['auto', 'scroll', 'hidden'].includes(getComputedStyle(node).overflowY),
      ) ?? null
    );
  });
  const scrollNode = scroller.asElement();
  check('the request list has a scroll node to drive', scrollNode !== null);
  if (scrollNode) {
    await scrollNode.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    // The mounted window is what must stay bounded; it settles asynchronously, so
    // the count is read after the virtualizer stops changing it.
    await sleep(400);
    const mounted = await page.locator('.request-row').count();
    check('the virtualized window stays bounded at the bottom', mounted > 0 && mounted < 40, `rows=${mounted}`);
    await cellPopup.waitFor({ state: 'hidden' });
    check('scrolling virtualized rows dismisses stale tooltip anchors',
      await page.locator('[data-request-tooltip][aria-describedby]').count() === 0);
  }

  const returnToLatest = async () => {
    await page.locator('.req-back-to-top-btn').click();
    await until(() => page.evaluate(() => {
      const holder = document.querySelector('.request-list [class*="-holder"]');
      return holder && holder.scrollTop <= 1 && !document.querySelector('.request-collapsible-header.is-collapsed');
    }), { label: 'return to the expanded request controls' });
  };
  await returnToLatest();
  const groupingControl = page.getByRole('combobox', { name: 'Group by', exact: true });
  const groupingSelect = page.locator('.request-toolbar .ant-select').filter({ has: groupingControl });
  for (const [label, lastRequestId] of [
    ['By source', interactionRecords.filter((record) => record.provider === interactionRecords[2].provider).at(-1).request_id],
    ['By client', interactionRecords.at(-1).request_id],
  ]) {
    await groupingSelect.click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
      .filter({ hasText: label }).click();
    await until(async () => (await page.locator('.request-group-title').count()) > 0 &&
      (await page.locator('.request-row .req-time-sub-id').first().innerText()) === interactionRecords[0].request_id,
    { label: `first row after ${label}` });
    const holder = page.locator('.request-list [class*="-holder"]').first();
    await holder.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const hasReachedLast = await until(async () => (await page.locator('.request-row .req-time-sub-id').last().innerText()) === lastRequestId,
      { label: `last row after ${label}` }).then(() => true).catch(() => false);
    const mounted = await page.locator('.request-row').count();
    check(`${label} measures group headers and keeps the final request reachable`,
      hasReachedLast && mounted > 0 && mounted < 40, `rows=${mounted} last=${await page.locator('.request-row .req-time-sub-id').last().innerText()}`);
    await returnToLatest();
  }
  await groupingSelect.click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: 'Chronological' }).click();
  await until(async () => (await page.locator('.request-row .req-time-sub-id').first().innerText()) === interactionRecords[0].request_id,
    { label: 'chronological request rows restored' });

  // Column resize: the handle has to exist, a drag has to change the track, and the
  // width has to survive as a preference - the last part is what makes a column
  // layout the reader chose outlive the visit.
  const providerHeader = page.locator('.req-th-provider');
  const resizer = providerHeader.locator('.req-col-resizer');
  check('the column resize handle exists', (await resizer.count()) > 0);
  const widthBefore = await providerHeader.evaluate((node) => node.getBoundingClientRect().width);
  const resizerBox = await resizer.boundingBox();
  if (resizerBox) {
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizerBox.x + resizerBox.width / 2 + 60, resizerBox.y + resizerBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await sleep(300);
  }
  const widthAfter = await providerHeader.evaluate((node) => node.getBoundingClientRect().width);
  check('dragging the resize handle changes the column width', widthAfter > widthBefore, `${widthBefore} -> ${widthAfter}`);
  const storedWidth = await page.evaluate(async () => {
    const response = await fetch('/omc/api/v1/preferences');
    const body = await response.json();
    return body?.preferences?.usage_events_columns?.provider ?? null;
  });
  check('the column width is persisted as a preference', typeof storedWidth === 'number', `stored=${storedWidth}`);

  // Keyboard access to the detail drawer. A list that can only be opened with a
  // mouse is unusable for anyone who does not have one, and both directions have to
  // work or the reader is trapped in the drawer.
  const rows = page.locator('.request-row');
  await rows.first().click();
  await page.locator('.request-detail').waitFor({ state: 'visible', timeout: 10_000 });
  check('clicking a row opens the request detail', await page.locator('.request-detail').isVisible());
  await page.keyboard.press('Escape');
  await page
    .locator('.request-detail')
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => {});
  check('Escape closes the request detail', !(await page.locator('.request-detail').isVisible().catch(() => false)));

  // The log download is a high-intent action: it must not happen on page load, and
  // it must not happen on the first click either - the confirmation is what makes it
  // deliberate.
  await rows.first().click();
  await page.locator('.request-detail').waitFor({ state: 'visible', timeout: 10_000 });
  // Diagnostics reads top-down in the order a failure is worked out: the upstream's
  // answer, the headers it came with, the credential's state, the caller, the log.
  await page.locator('.request-detail .ant-tabs-tab[data-node-key="diagnostics"]').click();
  await page.locator('.request-detail .request-header-group').first().waitFor({ state: 'visible' });
  const diagnostics = await page.evaluate(() => {
    const panel = document.querySelector('.request-header-group').closest('[role="tabpanel"]');
    return {
      sections: [...panel.querySelectorAll('.request-detail-section > h3')].map((heading) => heading.textContent),
      status: panel.querySelector('.request-error header strong')?.textContent,
      body: panel.querySelector('.request-error pre')?.textContent,
      groups: [...panel.querySelectorAll('.request-header-group')].map((group) =>
        [...group.querySelectorAll('dt')].map((name) => name.textContent)),
      overflow: panel.scrollWidth - panel.clientWidth,
    };
  });
  check('diagnostics names the failure, then its headers, before credential, client and log context',
    diagnostics.sections.length === 5 && diagnostics.status === 'HTTP 502' && diagnostics.body === INTERACTION_FAILURE_BODY,
    JSON.stringify(diagnostics.sections));
  check('response headers are grouped as identifiers, limits and routing',
    JSON.stringify(diagnostics.groups) === JSON.stringify([
      ['cf-ray', 'x-request-id'], ['retry-after', 'x-ratelimit-remaining-requests'], ['cf-cache-status', 'server'],
    ]) && diagnostics.overflow <= 0,
    JSON.stringify(diagnostics.groups));
  await page.screenshot({ path: 'tmp/request-diagnostics.png' });
  const downloadsBefore = downloads.length;
  const downloadButton = page.getByRole('button', { name: /下载请求日志|Download request log/ }).first();
  if ((await downloadButton.count()) > 0) {
    await downloadButton.click();
    await page
      .locator('.ant-modal')
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => {});
    check(
      'a request-log download requires explicit confirmation',
      downloads.length === downloadsBefore,
      `downloads=${downloads.length - downloadsBefore}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The request-records refresh sequence
// ---------------------------------------------------------------------------

/**
 * Ordering cannot be established by request counts: a page that fired the pull and
 * both reads in parallel would still "issue" all three. So this scenario holds the
 * pull's response open and asserts that no list or facet read happens while it is
 * held, that both happen after it is answered, and that the first post-sync read
 * lands after the pull was served.
 *
 * This is the one probe whose claim is about sequencing rather than layout, and it
 * cannot be replaced by a unit test of the poll decision: a `shouldPoll()` test says
 * nothing about whether the *page* actually serialises the pull before the reads.
 */

export function refreshRecords() {
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

  return async ({ base, page, check }) => {
    const reads = { pulls: [], list: [], facets: [] };
    let failSync = false;
    let pullCount = 0;
    let isPullHeld = false;
    let releasePull;
    const pullHeld = new Promise((resolve) => {
      releasePull = resolve;
    });

    // Registered after the shared routes, so these win: the last matching entry is
    // the one that responds.
    await page.route('**/omc/api/**', async (route) => {
      const url = new URL(route.request().url());
      const fulfill = (body) => fulfillFixture(route, { status: 200, json: body });
      if (url.pathname.endsWith('/usage/ingest-status')) {
        return fulfill({
          enabled: true,
          healthy: true,
          collector: { mode: 'subscribe', captured: 10, coverage_gaps: 0 },
          stats: { pending: 0 },
        });
      }
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
        return fulfill({ items: records.slice(0, limit), has_more: false, limit, window: { from: now - 3600000, to: now } });
      }
      return route.fallback();
    });

    const customFrom = now - 3600000;
    await page.goto(`${base}/usage/events?from=${customFrom}&to=${now - 1000}`);
    await page.locator('.request-row').first().waitFor({ timeout: 15_000 });
    // The page writes the resolved view back into the URL shortly after hydration,
    // which re-resolves the window and re-reads facets. Settling first keeps that
    // churn out of the baseline this probe compares against.
    await sleep(1800);
    const listBefore = reads.list.length;
    const facetBefore = reads.facets.length;

    // The wait is registered before the click: registering it afterwards can miss a
    // request that resolved faster than the listener attached.
    const pullIssued = page
      .waitForRequest((request) => request.url().includes('/usage/ingest/refresh'), { timeout: 5000 })
      .catch(() => null);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    check('the refresh issues the pull', (await pullIssued) !== null);

    await sleep(700);
    check('no list read happens while the pull is held', reads.list.length === listBefore, `list=${reads.list.length - listBefore}`);
    check(
      'no facet read happens while the pull is held',
      reads.facets.length === facetBefore,
      `facets=${reads.facets.length - facetBefore}`,
    );

    releasePull();
    await page.locator('.omc-toast').getByText(/Fetched and stored 2 new record/).waitFor({ timeout: 10_000 });
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

    failSync = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText(/Sync incomplete/i).first().waitFor({ timeout: 10_000 });
    check('a pull that could not drain CPA is reported, not shown as success', true);
  };
}

/**
 * The alignment records with what an export has to withhold: two OAuth accounts
 * (one of them answering twice) and a provider key on the API-key rows.
 */
export const exportRecords = alignmentRecords.map((record, index) =>
  index < 3
    ? { ...record, auth_type: 'oauth', auth_index: index === 1 ? 'oauth-b' : 'oauth-a', source: index === 1 ? 'second@example.com' : 'first@example.com' }
    : { ...record, provider_key_mask: 'sk-up••••••••4321' });

/**
 * Picking requests and exporting them as an image.
 *
 * The selection is browser work because its failure modes are: a tick that also
 * opens the record under it, a "select all" that only reaches the rows the
 * virtual list has mounted, and a checkbox column that shifts the header off the
 * rows. The export is here for what needs a real canvas and a real download: the
 * sheet is drawn, a redaction redraws it, and both formats reach the disk. What a
 * redacted export may contain is asserted on its data in `scripts/test-request-export.ts`.
 */
export async function requestExport({ base, page, check }) {
  await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

  const rowBox = (index) => page.locator('.request-row').nth(index).locator('.req-select-box');
  const count = page.locator('.request-selection-count');

  await rowBox(0).click();
  await count.waitFor();
  check('ticking a row selects it without opening the record',
    (await count.innerText()).includes('1') && (await page.locator('.ant-drawer-open').count()) === 0,
    await count.innerText());

  await rowBox(2).click({ modifiers: ['Shift'] });
  await until(async () => (await count.innerText()).includes('3'), { label: 'a Shift click extends the selection' })
    .then(() => check('a Shift click selects the run between the two rows', true))
    .catch(async () => check('a Shift click selects the run between the two rows', false, await count.innerText()));

  const mounted = await page.locator('.request-row').count();
  await page.locator('.req-th-select .req-select-box').click();
  await until(async () => (await count.innerText()).includes(String(exportRecords.length)), { label: 'select all' })
    .then(() => check('select all reaches every loaded record, mounted or not', mounted <= exportRecords.length, `mounted ${mounted}`))
    .catch(async () => check('select all reaches every loaded record, mounted or not', false, await count.innerText()));

  const boxes = await page.evaluate(() => {
    const centre = (node) => {
      const box = node.getBoundingClientRect();
      return Math.round(box.left + box.width / 2);
    };
    return {
      header: centre(document.querySelector('.req-th-select .req-select-box')),
      row: centre(document.querySelector('.request-row .req-select-box')),
    };
  });
  check('the header checkbox sits over the rows\' checkboxes', Math.abs(boxes.header - boxes.row) <= 1, JSON.stringify(boxes));

  await page.getByTestId('req-export-open').click();
  const sheet = page.getByTestId('req-export-sheet');
  const painted = page.locator('[data-testid="req-export-sheet"][data-painted]');
  await painted.waitFor();
  // What the sheet may contain is a logic-suite claim about its data. What only a
  // browser can show is that the canvas was drawn at all, and redrawn on a change.
  const readCanvas = () => sheet.evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colours = new Set();
    let digest = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const colour = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
      if (colours.size < 64) colours.add(colour);
      digest = (Math.imul(digest, 31) + colour) | 0;
    }
    return { width: canvas.width, height: canvas.height, colours: colours.size, digest, shown: canvas.clientWidth };
  });
  const drawn = await readCanvas();
  check('the preview is a drawn sheet, fitted to the dialog', drawn.colours > 8 && drawn.width > drawn.shown && drawn.shown > 0,
    JSON.stringify(drawn));

  await page.locator('.req-export-masks .ant-checkbox-wrapper', { hasText: /^(请求 ID|Request IDs)$/ }).click();
  await until(async () => (await painted.count()) === 1 && (await readCanvas()).digest !== drawn.digest, { label: 'the sheet is redrawn' })
    .then(() => check('changing a redaction redraws the sheet', true))
    .catch(() => check('changing a redaction redraws the sheet', false));

  const canvasSize = await readCanvas();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('req-export-download').click(),
  ]);
  const imagePath = 'tmp/request-export-download.png';
  await download.saveAs(imagePath);
  const image = fs.readFileSync(imagePath);
  const isPng = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const pixels = { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  check('the download is a PNG named for the requests', isPng && /^requests-\d{8}-\d{6}\.png$/.test(download.suggestedFilename()),
    download.suggestedFilename());
  check('the image is the previewed canvas, pixel for pixel in size',
    pixels.width === canvasSize.width && pixels.height === canvasSize.height, JSON.stringify({ pixels, canvasSize }));

  await page.locator('.req-export-format .ant-segmented-item', { hasText: 'JSON' }).click();
  const preview = page.getByTestId('req-export-json');
  await preview.waitFor();
  const previewText = await preview.innerText();
  check('the JSON preview carries the redaction the image had',
    previewText.includes(LONG_MODEL) && !previewText.includes('example.com') && !previewText.includes(exportRecords[0].request_id),
    previewText.slice(0, 200));
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('req-export-download').click(),
  ]);
  const jsonPath = 'tmp/request-export-download.json';
  await jsonDownload.saveAs(jsonPath);
  const exported = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  check('the JSON download holds every selected record',
    /^requests-\d{8}-\d{6}\.json$/.test(jsonDownload.suggestedFilename()) && exported.count === exportRecords.length &&
    exported.requests.length === exportRecords.length && exported.redacted.includes('request_id'),
    JSON.stringify({ name: jsonDownload.suggestedFilename(), count: exported.count, redacted: exported.redacted }));
}

/** Facets for the mark probe: a model whose maker is known, one whose maker is not, and the rows' provider. */
export const markFacets = {
  ...alignmentFacets,
  models: [{ value: 'gpt-5', requests: 7 }, { value: LONG_MODEL, requests: 5 }],
  providers: [{ value: 'gemini', requests: 12 }],
};

/** Rows from a provider with artwork of its own, so a mark resolved from the wrong key is a different picture. */
export const markRecords = alignmentRecords.map((record) => ({ ...record, provider: 'gemini' }));

/**
 * A filter option carries the mark its rows carry.
 *
 * The claim is about two renders agreeing - the option in a popup and the row in
 * the list - which only the page can show: the same provider resolved through a
 * second path would still type-check and still draw *a* picture.
 */
export async function facetMarks({ base, page, check }) {
  await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

  const markOf = (scope) => scope.evaluate((node) => {
    const image = node.querySelector('img');
    if (image) return `img:${image.getAttribute('src')}`;
    // A mark with no colour artwork is a masked silhouette, not an image.
    const silhouette = Array.from(node.querySelectorAll('span')).find((span) => span.style.mask || span.style.webkitMask);
    if (silhouette) return `mask:${silhouette.style.mask || silhouette.style.webkitMask}`;
    const glyph = node.querySelector('svg');
    return glyph ? `svg:${glyph.getAttribute('class') ?? ''}:${glyph.innerHTML.length}` : 'none';
  });
  const optionMark = async (control, text) => {
    await page.locator(`.request-filters .req-facet-select:has([aria-label="${control}"])`).click();
    const option = page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: text });
    await option.waitFor();
    const mark = await markOf(option.locator('.req-facet-option-mark'));
    await page.keyboard.press('Escape');
    return mark;
  };

  const known = await optionMark('Model', 'gpt-5');
  const unknown = await optionMark('Model', LONG_MODEL);
  check("a model option shows its maker's mark", /openai/i.test(known), known);
  check('a model nobody made a mark for shows the generic glyph, not a blank', unknown.startsWith('svg:') && unknown !== known, unknown);

  const rowMark = await markOf(page.locator('.request-row').last().locator('.req-col-provider'));
  const providerOption = await optionMark('Provider', /./);
  check('a provider option shows the mark its rows show', rowMark !== 'none' && providerOption === rowMark,
    JSON.stringify({ rowMark, providerOption }));
}
