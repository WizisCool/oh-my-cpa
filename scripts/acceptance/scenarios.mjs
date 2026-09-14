/**
 * The browser probe scenarios, as a registry rather than a script.
 *
 * Each scenario is a claim only a real engine can establish - geometry, stacking,
 * hit-testing, paint or virtualization - so none of them can move to the pure
 * suite. What they can share is their setup and their fixtures, which is why they
 * live here as data: `verify:probes` runs all of them against the built SPA in the
 * release gate, and `check:ui` runs the relevant subset against the dev server
 * during development.
 *
 * Nothing in this module runs on import. That is deliberate: `check:ui --list` and
 * `--plan` must be able to answer without starting a browser, and a module that
 * spawned a server at import time could not support that.
 */
import { until } from './harness.mjs';
import { sleep } from './probe.mjs';

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

export const pickerProvider = {
  id: 'openai-compat-0',
  family: 'openai-compatibility',
  name: 'CommandCode GOAT',
  protocol: 'OpenAI Compatible Chat Completions',
  base_url: 'https://api.example.test/v1',
  disabled: false,
  key_configured: true,
  models: ['deepseek-v4.1-flash'],
};

/**
 * Portals are antd's, so only the engine can say which one is on top. A computed
 * `z-index` cannot prove it either: an ancestor stacking context can trap a high
 * value, which is why the assertion asks `elementFromPoint` what is really there.
 *
 * The first open also has to *render* the catalog. antd mounts the dialog panel
 * asynchronously, so the effect that attaches the lazy-loading observer runs once
 * against a panel node that does not exist yet and never re-runs. Nothing is then
 * observed, every tile paints as an empty box, and the second open looks correct
 * because the panel is already mounted by then. That makes the first open the only
 * one that can catch it, and the assertion below has to run before the reopen loop.
 */
export async function iconPickerStacking({ base, page, check }) {
  const requestedIconAssets = new Set();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/lobe-icons/')) requestedIconAssets.add(url.pathname);
  });

  await page.goto(`${base}/ai-providers`, { waitUntil: 'domcontentloaded' });
  await page.locator('.providers-page').waitFor({ timeout: 20_000 });

  await page.locator('.providers-page').getByRole('button', { name: /Edit|编辑/i }).first().click({ timeout: 10_000 });
  await page.locator('.ant-drawer-open').waitFor({ state: 'visible', timeout: 10_000 });

  const pickerTrigger = page.locator('.ant-drawer-open').getByRole('button', { name: /Change Icon|更改图标/i }).first();
  if (await pickerTrigger.isVisible().catch(() => false)) {
    await pickerTrigger.click();
  } else {
    // The inline icon tile opens the same picker.
    await page.locator('.ant-drawer-open').locator('div[title]').first().click();
  }
  const picker = page.locator('.ant-modal').filter({ hasText: /Select AI Provider Icon|选择 AI 提供商图标/i });
  await picker.waitFor({ state: 'visible', timeout: 10_000 });

  /**
   * Counts tiles that rendered an icon node rather than only their label: either an
   * `<img>` the tile requested, or a masked `<span>`. A tile that shows its label
   * with no icon node is exactly the reported failure, so reading the label back
   * would not distinguish the two states.
   */
  const renderedIconCount = () =>
    page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.ant-modal [data-icon-id]')];
      return tiles.filter((tile) => {
        if (tile.querySelector('img[src*="/lobe-icons/"]')) return true;
        return [...tile.querySelectorAll('span')].some((node) => {
          const style = getComputedStyle(node);
          return (style.maskImage && style.maskImage !== 'none')
            || (style.webkitMaskImage && style.webkitMaskImage !== 'none');
        });
      }).length;
    });

  // A zero rather than a thrown error, so the check reports the count it observed
  // instead of the timeout that revealed it.
  const firstOpenIcons = await until(renderedIconCount, { label: 'the first open to render icons' })
    .catch(() => 0);
  check(
    'the first open renders the icon grid',
    firstOpenIcons > 0,
    `rendered=${firstOpenIcons}`,
  );

  /** 120 is the whole catalog; anything at or above it means the lazy boundary is gone. */
  check(
    'the icon picker loads only nearby assets',
    requestedIconAssets.size > 0 && requestedIconAssets.size < 120,
    `loaded=${requestedIconAssets.size}`,
  );

  const readZ = (selector) =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      return Number.parseInt(window.getComputedStyle(node).zIndex, 10) || 0;
    }, selector);

  const drawerZ = await readZ('.ant-drawer-open');
  const pickerZ = await readZ('.ant-modal-wrap');
  check('the picker is layered above the drawer', pickerZ > drawerZ, `drawer=${drawerZ} picker=${pickerZ}`);

  const hit = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal');
    if (!modal) return { ok: false, reason: 'no modal' };
    const box = modal.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
    if (!target) return { ok: false, reason: 'nothing hit' };
    const insidePicker = Boolean(target.closest('.ant-modal'));
    const insideDrawer = Boolean(target.closest('.ant-drawer'));
    return { ok: insidePicker && !insideDrawer, insidePicker, insideDrawer, tag: target.className };
  });
  check('the picker wins hit-testing against the drawer', hit.ok, `picker=${hit.insidePicker} drawer=${hit.insideDrawer}`);

  // Reopening must not flip the order: this is the reported "sometimes" case.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'hidden', timeout: 10_000 });
    if (await pickerTrigger.isVisible().catch(() => false)) {
      await pickerTrigger.click();
    } else {
      await page.locator('.ant-drawer-open').locator('div[title]').first().click();
    }
    await picker.waitFor({ state: 'visible', timeout: 10_000 });
    const repeatedHit = await page.evaluate(() => {
      const modal = document.querySelector('.ant-modal');
      if (!modal) return false;
      const box = modal.getBoundingClientRect();
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + 12);
      return Boolean(target && target.closest('.ant-modal') && !target.closest('.ant-drawer'));
    });
    check(`reopen ${attempt + 2} keeps the picker on top`, repeatedHit);
  }
}

// ---------------------------------------------------------------------------
// Dashboard sparkline marks
// ---------------------------------------------------------------------------

const chartBuckets = 30;
const chartBucketMS = 60_000;
const chartSeries = Array.from({ length: chartBuckets }, (_, index) => ({
  t: Date.now() - (chartBuckets - 1 - index) * chartBucketMS,
  // A zero bucket is what puts the series on the plot floor, which is where the
  // baseline stroke became visible.
  v: index % 7 === 0 ? 0 : 40 + (index % 5) * 12,
  tokens: index % 7 === 0 ? 0 : 900 + (index % 4) * 250,
  // Each metric gets its own shape. If these all tracked `tokens`, four tiles
  // would paint identical marks and this scenario could not tell that the cache
  // and cost tiles had stopped plotting their own data.
  cache_read: index % 4 === 0 ? 0 : 300 + (index % 6) * 90,
  cost_nanos: index % 6 === 0 ? 0 : 120_000_000 + (index % 5) * 60_000_000,
}));

export const chartDashboard = {
  window: {
    preset: '1h',
    from: Date.now() - chartBuckets * chartBucketMS,
    to: Date.now(),
    bucket_ms: chartBucketMS,
    minutes: 60,
    complete: true,
    open_end: false,
  },
  requests: {
    total: chartSeries.reduce((sum, point) => sum + point.v, 0),
    success: chartSeries.reduce((sum, point) => sum + point.v, 0) - 3,
    failed: 3,
    success_rate: 98.7,
    series: chartSeries,
  },
  tokens: {
    total: chartSeries.reduce((sum, point) => sum + point.tokens, 0),
    input: 120000,
    output: 45000,
    reasoning: 5000,
    cached: 30000,
    cache_read: 30000,
    cache_creation: 2000,
    series: chartSeries,
  },
  metrics: { rpm: 12, tpm: 1234, cache_rate: 42, cost: 0, cost_source: 'none', cost_note: '', avg_latency_ms: 900, avg_ttft_ms: 200 },
  coverage: { rollup_requests: 0, detail_requests: 0, pending_inbox: 0, stored_events: 0 },
  partial_errors: [],
};

/**
 * The area marks @ant-design/charts paints into each card's .chart-slot.
 *
 * Counting canvases proves almost nothing here: an empty canvas, a mark drawn in
 * the wrong colour, and a mark collapsed onto the plot floor all satisfy it. So the
 * assertions read the painted pixels instead - several distinct tones per tile, ink
 * spanning the plot rather than a stub. That is the check an earlier revision of
 * this probe lacked, which is why it passed on a mark the design never called for.
 */
export async function dashboardChartMarks({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.chart-slot canvas, .chart-slot svg').first().waitFor({ timeout: 20_000 });

  const slots = await page.locator('.chart-slot').count();
  check('all six tiles rendered chart slots', slots === 6, `slots=${slots}`);

  const canvases = await page.locator('.chart-slot canvas').count();
  check('all six tiles painted canvas marks', canvases === 6, `canvases=${canvases}`);

  // Read the painted pixels of the first tile: a non-empty canvas is not evidence
  // that a mark was drawn, let alone drawn correctly.
  const firstCanvas = page.locator('.chart-slot canvas').first();
  const paint = await firstCanvas.evaluate((el) => {
    const probe = document.createElement('canvas');
    probe.width = el.width;
    probe.height = el.height;
    const ctx = probe.getContext('2d');
    ctx.drawImage(el, 0, 0);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    const tones = new Set();
    const colInk = new Array(probe.width).fill(0);
    let ink = 0;
    for (let y = 0; y < probe.height; y += 1) {
      for (let x = 0; x < probe.width; x += 1) {
        const offset = (y * probe.width + x) * 4;
        if (data[offset + 3] > 20) {
          ink += 1;
          colInk[x] += 1;
          // Quantise so antialiasing does not read as hundreds of tones, but keep
          // alpha: the fill and the trend are the same hue at different opacities,
          // so a key built from RGB alone cannot tell the two marks apart.
          tones.add(
            `${data[offset] >> 4},${data[offset + 1] >> 4},${data[offset + 2] >> 4},${data[offset + 3] >> 5}`,
          );
        }
      }
    }
    const firstInked = colInk.findIndex((count) => count > 0);
    const lastInked = colInk.length - 1 - [...colInk].reverse().findIndex((count) => count > 0);
    return { width: el.width, height: el.height, ink, tones: tones.size, firstInked, lastInked };
  });
  check(
    'the first tile painted a mark',
    paint.ink > 0,
    `ink=${paint.ink}`,
  );
  // An area carries both a stroked trend and a translucent fill, so a tile that
  // painted correctly shows more than one tone. A single tone means the fill was
  // lost (or the mark collapsed), which a canvas count cannot detect.
  check(
    'the tile painted both a trend stroke and an area fill',
    paint.tones >= 2,
    `distinctTones=${paint.tones}`,
  );
  // The mark must span the plot: a series that failed to bind renders as a stub at
  // one edge rather than across the bucket grid.
  const spread = paint.width > 0 ? (paint.lastInked - paint.firstInked) / paint.width : 0;
  check(
    'the mark spans the plot rather than collapsing to one edge',
    spread > 0.6,
    `spread=${spread.toFixed(2)} first=${paint.firstInked} last=${paint.lastInked} of ${paint.width}`,
  );

  // Every tile must plot its own metric. This was the defect this probe missed
  // once already: RPM and Requests both plotted request volume, and the cache-rate
  // and cost tiles both plotted token volume, so four of six tiles drew the same
  // shape under different labels. Comparing the painted tiles catches a tile that
  // was wired back to somebody else's series, which no per-tile assertion can.
  const digests = await page.evaluate(() =>
    [...document.querySelectorAll('.chart-slot canvas')].map((el) => {
      const probe = document.createElement('canvas');
      probe.width = el.width;
      probe.height = el.height;
      probe.getContext('2d').drawImage(el, 0, 0);
      const { data } = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height);
      let hash = 2166136261;
      for (let i = 0; i < data.length; i += 7) {
        hash ^= data[i];
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16);
    }),
  );
  const uniqueDigests = new Set(digests);
  check(
    'each tile plots its own series rather than repeating another tile',
    digests.length === 6 && uniqueDigests.size === digests.length,
    `distinct=${uniqueDigests.size} of ${digests.length} (${digests.join(',')})`,
  );

  const firstSlot = page.locator('.chart-slot').first();
  const box = await firstSlot.boundingBox();
  if (!box) throw new Error('no bounding box for the first trend tile');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  const tooltip = page.locator('.chart-tooltip').first();
  await tooltip.waitFor({ state: 'visible', timeout: 5000 });
  const tooltipText = await tooltip.innerText();
  // The tooltip must name a real bucket: at 1h/1-minute resolution the label is
  // "MM-DD HH:mm", and the value is the request count for that minute.
  // The readout must be a small overlay, not a box stretched across the tile. A
  // broad CSS rule once sized every direct div child of the slot, which silently
  // blew the readout up to the full tile.
  const tooltipBox = await tooltip.boundingBox();
  check(
    'the readout hugs its text instead of spanning the tile',
    Boolean(tooltipBox) && tooltipBox.width < box.width * 0.5,
    `tooltipWidth=${tooltipBox ? Math.round(tooltipBox.width) : 'none'} slotWidth=${Math.round(box.width)}`,
  );
  check(
    'the tooltip states a bucket time and a value',
    /\d{2}-\d{2} \d{2}:\d{2}/.test(tooltipText) && /\d/.test(tooltipText),
    `text=${JSON.stringify(tooltipText)}`,
  );

  // Sweep the pointer across the tile, then confirm the chart still reports its
  // data: a rebuild that dropped the series would show here.
  for (let step = 0; step <= 20; step += 1) {
    const x = box.x + Math.min(box.width - 1, (box.width * step) / 20);
    await page.mouse.move(x, box.y + box.height / 2);
  }
  check(
    'the tooltip still reports a bucket after a pointer sweep',
    (await tooltip.innerText().catch(() => '')).trim().length > 0,
  );

  const overlay = await page.evaluate(() => {
    const node = document.querySelector('.chart-tooltip');
    if (!node) return { present: false };
    const style = window.getComputedStyle(node);
    return { present: true, transition: style.transitionDuration, position: style.position };
  });
  check(
    'the hover tooltip does not animate into place',
    overlay.present && overlay.transition === '0s',
    JSON.stringify(overlay),
  );
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
/**
 * Every probe scenario, in the order they run.
 *
 * `shared` marks the fixtures a scenario's route table builds on: a scenario listed
 * against a shared fixture is selected when anything that fixture describes changes.
 * The mapping from a source file to the scenarios it can affect lives in
 * `check-ui-plan.mjs`, which is also where the conservative "unknown frontend path
 * widens the plan" rule is stated.
 *
 * `check` is supplied by the runner rather than imported, so the same registry
 * serves the release gate (which runs all of them) and the development fast path
 * (which runs the relevant subset) without either owning the other's reporting.
 */
export const SCENARIOS = [
  {
    id: 'column-alignment',
    name: 'column alignment',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [(url) => url.pathname.includes('/usage/events'), () => ({ items: alignmentRecords, has_more: false, limit: 50 })],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 12, coverage_gaps: 0 }, stats: { pending: 0 } }),
        ],
      ],
    },
    run: columnAlignment,
  },
  {
    id: 'icon-picker-stacking',
    name: 'icon picker stacking',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/management/providers'), () => ({ providers: [pickerProvider], total: 1 })],
      ],
    },
    run: iconPickerStacking,
  },
  {
    id: 'dashboard-charts',
    name: 'dashboard chart marks',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [
          (url) => url.pathname.endsWith('/management/overview'),
          () => ({
            cpa: { connected: true, version: 'probe', latency_ms: 1 },
            counts: { management_keys: 1, provider_keys: 0, credentials: 0, models: 0 },
            providers: [],
            credentials: { total: 0, active: 0, disabled: 0, unavailable: 0, by_type: [] },
            traffic: { bucket_minutes: 10, window_minutes: 60, buckets: [], total_success: 0, total_failure: 0, total: 0, success_rate: null },
            partial_errors: [],
          }),
        ],
      ],
    },
    run: dashboardChartMarks,
  },
  {
    id: 'refresh-sequencing',
    name: 'refresh sequencing',
    run: refreshRecords(),
  },
  /**
   * The search box, exercised on the **development** server.
   *
   * This scenario exists because the production-bundle suite cannot see the failure
   * it guards. `React.StrictMode` is enabled in `web/src/main.tsx`, and in a
   * development build React runs mount -> unmount -> mount for every component. A
   * hook that creates a disposable controller during render and disposes it in the
   * first cleanup hands the remount a *dead* controller: `change()` returns early
   * forever, so the search box silently stops committing while looking healthy, and
   * every production-bundle check stays green because StrictMode's double-invoke
   * does not run there.
   *
   * That is not hypothetical - it is exactly what happened when the debounce became
   * a controller, and nothing in the suite caught it. So the assertion is made where
   * the failure lives: type into the box, wait past the debounce, and require the
   * committed value to reach the URL. A controller that was replaced by a remount
   * cannot satisfy it, and neither can one that was never installed.
   */
  {
    id: 'search-dev-server',
    name: 'search commits on the dev server',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [(url) => url.pathname.includes('/usage/events'), () => ({ items: alignmentRecords, has_more: false, limit: 50 })],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: false, healthy: false, collector: {}, stats: {} }),
        ],
      ],
    },
    run: async ({ base, page, errors, check: assert }) => {
      await page.goto(`${base}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
      await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

      // The box has to be reachable first: a missing control would make the commit
      // assertion below pass vacuously if it were written as a conditional.
      const input = page.locator('.request-search input');
      assert('the search box is present', (await input.count()) === 1, `inputs=${await input.count()}`);

      const before = new URL(page.url()).search;
      await input.click();
      await page.keyboard.type('gpt', { delay: 20 });
      // A condition wait rather than a flat sleep: it returns as soon as the commit
      // lands and fails loudly - instead of expiring quietly - if it never does.
      await page
        .waitForFunction(() => new URL(location.href).search.includes('q=gpt'), null, { timeout: 5_000 })
        .catch(() => {});
      const after = new URL(page.url()).search;

      assert(
        'a keystroke commits to the URL after the debounce',
        after.includes('q=gpt'),
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      );
      // The failure mode is silent, so a page error is not expected; asserting its
      // absence keeps the check honest about what it observed.
      assert('the search box raises no page error', errors.length === 0, errors.join(' | '));
    },
  },
  {
    id: 'request-list-interactions',
    name: 'request list interactions',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/usage/facets'), () => alignmentFacets],
        [
          (url) => url.pathname.includes('/usage/events'),
          () => ({ items: interactionRecords, has_more: false, limit: 100 }),
        ],
        [
          (url) => url.pathname.endsWith('/usage/ingest-status'),
          () => ({ enabled: true, healthy: true, collector: { mode: 'http_pull', captured: 500, coverage_gaps: 0 }, stats: { pending: 0 } }),
        ],
      ],
    },
    run: requestListInteractions,
  },
];
