import { sleep } from '../probe.mjs';

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
  await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

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
    generate: true,
    latency_ms: 1830 + index * 3,
    ttft_ms: 284,
    endpoint: '/v1/responses',
    tokens: { input: 2150, output: 485, reasoning: 120, cached: 400, cache_read: 400, cache_creation: 0, total: 2635 },
    has_request_log: true,
  }));
})();


export async function requestListInteractions({ base, page, check }) {
  const downloads = [];
  page.on('request', (request) => {
    if (request.url().includes('/request-log')) downloads.push(request.url());
  });

  await page.goto(`${base}/usage/events?preset=24h&limit=100`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

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
  }

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
      const fulfill = (body) => route.fulfill({ status: 200, json: body });
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
    await page.locator('.ant-message').getByText(/Fetched and stored 2 new record/).waitFor({ timeout: 10_000 });
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
