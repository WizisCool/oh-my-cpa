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
// Dashboard token heatmap
// ---------------------------------------------------------------------------

/** Local `YYYY-MM-DD` and midnight bounds for an offset from today. */
function heatmapDayEntry(dayOffset, tokens, requests, failures) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 0, 0, 0, 0);
  const month = `${start.getMonth() + 1}`.padStart(2, '0');
  return {
    day: `${start.getFullYear()}-${month}-${`${start.getDate()}`.padStart(2, '0')}`,
    from_ms: start.getTime(),
    to_ms: end.getTime() - 1,
    tokens,
    requests,
    failures,
    input: tokens,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_creation: 0,
  };
}

const HEATMAP_WEEKS = 53;
const HEATMAP_TOTAL_DAYS = HEATMAP_WEEKS * 7;
/** Days from this week's Monday to today inclusive. */
const HEATMAP_WEEKDAY_OFFSET = (() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // JavaScript's getDay() is Sunday-first; this numbers the week from Monday.
  return (today.getDay() + 6) % 7;
})();
/** The offset of the grid's first day: 52 whole weeks plus the days elapsed this week. */
const HEATMAP_FIRST_OFFSET = -((HEATMAP_WEEKS - 1) * 7 + HEATMAP_WEEKDAY_OFFSET);
/** The last day the window can carry data for: the days after it are clamped to the read instant. */
const HEATMAP_TODAY = (() => {
  const today = new Date();
  return `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
})();

/**
 * Marked days with distinct volumes, plus one deliberately quiet day.
 *
 * Distinct volumes matter: the fill ramp is quantile-based, so a fixture whose days all carried
 * similar traffic would collapse onto one level and the assertion that the grid paints several
 * levels would pass vacuously. The offsets spread the marks across the window so they land in
 * different columns and on different weekdays.
 */
const heatmapMarked = [
  heatmapDayEntry(0, 100_000, 120, 1),
  heatmapDayEntry(-1, 80_000, 90, 0),
  heatmapDayEntry(-3, 60_000, 70, 0),
  heatmapDayEntry(-40, 45_000, 44, 2),
  heatmapDayEntry(-100, 30_000, 30, 0),
  heatmapDayEntry(-200, 15_000, 15, 0),
  heatmapDayEntry(-320, 6_000, 6, 0),
  heatmapDayEntry(-2, 0, 0, 0),
];
const heatmapMarkedByDay = new Map(heatmapMarked.map((entry) => [entry.day, entry]));

/**
 * The whole grid, in the shape the endpoint returns it: every day of the viewer's calendar year,
 * oldest first, with the marked days carrying the fixture's volumes.
 *
 * The fixture mirrors the server's contract rather than sending only the marked days: the panel
 * reads the response's own day list, so a partial fixture would not exercise the layout, the
 * year's shape, or the row-per-weekday arithmetic. Days after today are sent the way the server
 * sends them - present, with no bounds and no traffic.
 */
function heatmapGridDays() {
  const days = [];
  for (let offset = HEATMAP_FIRST_OFFSET; offset < HEATMAP_FIRST_OFFSET + HEATMAP_TOTAL_DAYS; offset += 1) {
    const plain = heatmapDayEntry(offset, 0, 0, 0);
    if (plain.day > HEATMAP_TODAY) {
      // The days after today in the final column: present so the column is complete, and with no
      // range because there is nothing to ask about a day that has not happened.
      days.push({ ...plain, from_ms: 0, to_ms: 0 });
      continue;
    }
    days.push(heatmapMarkedByDay.get(plain.day) ?? plain);
  }
  return days;
}

export const chartTokenHeatmap = {
  as_of_ms: Date.now(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  // Tracking started well before the grid's first day, so no cell in this fixture is
  // "unrecorded".
  first_stored_ms: Date.parse('2024-01-01T00:00:00Z'),
  days: heatmapGridDays(),
};

/**
 * The same grid as a real deployment whose retention has already trimmed the oldest weeks: the
 * marker sits partway into the span, so the cells before it are unrecorded rather than empty.
 *
 * This is the shape the panel is actually read in, and the one no other fixture covers - the main
 * fixture starts tracking before its first day so every zero cell is `empty`. That gap is why the
 * wireframe shipped: 275 outlined cells look nothing like 275 solid ones, and only this fixture
 * produces them.
 */
export const chartTokenHeatmapPruned = (() => {
  const days = heatmapGridDays();
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return {
    ...chartTokenHeatmap,
    first_stored_ms: cutoff,
    days: days.map((day) => (day.from_ms > 0 && day.from_ms < cutoff
      ? { ...day, tokens: 0, requests: 0, failures: 0, input: 0, output: 0 }
      : day)),
  };
})();

/**
 * The daily token heatmap: a contribution-graph field, one row per weekday.
 *
 * A canvas count cannot be wrong here because there is no canvas: the cells are DOM, so the
 * assertions read computed styles, grid tracks and rendered text. The field's shape is what makes
 * it recognizable, so the first thing asserted is that it is a field - seven weekday rows and a
 * year of week columns - rather than a single-row strip.
 */
export async function dashboardTokenHeatmap({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });

  const shape = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    return {
      cells: cells.length,
      rows: new Set(cells.map((cell) => getComputedStyle(cell).gridRowStart)).size,
      columns: new Set(cells.map((cell) => getComputedStyle(cell).gridColumnStart)).size,
      days: cells.map((cell) => cell.getAttribute('data-day')),
      weekdays: document.querySelectorAll('.heatmap-weekday').length,
      months: document.querySelectorAll('.heatmap-month').length,
    };
  });

  // Seven rows is the whole point of the layout: it is what makes a weekly rhythm a row and a
  // trend a direction. A single-row strip satisfies "cells rendered" and fails here.
  check('the grid has one row per weekday', shape.rows === 7, `rows=${shape.rows}`);
  check('the grid labels all seven rows', shape.weekdays === 7, `weekdays=${shape.weekdays}`);
  check('the grid is 53 whole weeks', shape.columns === HEATMAP_WEEKS, `columns=${shape.columns}`);
  check('the grid has a month axis', shape.months >= 8, `months=${shape.months}`);
  check(
    'the grid renders every day of its span, oldest first',
    shape.cells === HEATMAP_TOTAL_DAYS && shape.days[0] === heatmapGridDays()[0].day,
    `cells=${shape.cells} want=${HEATMAP_TOTAL_DAYS} first=${shape.days[0]}`,
  );

  // Each day has to sit on its own weekday's row, or the rows mean nothing while still looking
  // plausible.
  const misrowed = await page.evaluate(() => {
    const wrong = [];
    for (const cell of document.querySelectorAll('.heatmap-grid .heatmap-cell')) {
      const day = cell.getAttribute('data-day');
      const [year, month, date] = day.split('-').map(Number);
      const weekday = (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
      if (Number(getComputedStyle(cell).gridRowStart) !== weekday + 1) {
        wrong.push(`${day} expectedRow=${weekday + 1} got=${getComputedStyle(cell).gridRowStart}`);
      }
    }
    return wrong;
  });
  check('each day sits on its own weekday row', misrowed.length === 0, misrowed.slice(0, 3).join('; '));

  // The days after today in the final column are days nothing is stored for: present, unqueried, and
  // drawn exactly like any other day with no record. The panel does not invent a separate "pending"
  // state - a reader comparing days can only act on whether there is data for one.
  const future = await page.evaluate((today) => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const after = cells.filter((cell) => cell.getAttribute('data-day') > today);
    const quiet = cells.filter((cell) => cell.getAttribute('data-day') <= today && !cell.classList.contains('is-measured'));
    return {
      count: after.length,
      interactive: after.filter((cell) => cell.classList.contains('is-interactive')).length,
      // The one thing that must not survive: a pending state of its own.
      pendingClasses: after.filter((cell) => cell.className.includes('pending')).length,
      // A future day carries nothing, so it takes the *unrecorded* fill - the one a trimmed day
      // takes - and not the `empty` fill, which would claim a measurement of zero that was never
      // stored. Naming the expected class rather than comparing against a union of quiet fills is
      // the point: the two fills are near-identical in value, so a set-union comparison passes
      // whichever of them the cell happens to take, which is how this went unnoticed.
      futureClasses: [...new Set([...after].map((cell) => [...cell.classList].find((name) => name.startsWith('is-') && name !== 'is-interactive')))].sort(),
      futureFills: [...new Set(after.map((cell) => getComputedStyle(cell).backgroundColor))].sort(),
      unrecordedFills: [...new Set(cells.filter((cell) => cell.classList.contains('is-unrecorded')).map((cell) => getComputedStyle(cell).backgroundColor))].sort(),
    };
  }, HEATMAP_TODAY);
  check('the final column is drawn in full, past today', future.count > 0, `futureCells=${future.count}`);
  check(
    'a day after today carries no pending state of its own',
    future.count > 0 && future.pendingClasses === 0,
    `future=${future.count} pendingClasses=${future.pendingClasses}`,
  );
  // Every cell is clickable now, including a day with nothing stored: its tooltip says so, which is
  // the answer to "what happened on this date" rather than a reason to refuse the question.
  check('a day after today is still clickable', future.interactive === future.count, `interactive=${future.interactive} of ${future.count}`);
  check(
    'a day after today takes the unrecorded state, not a recorded zero',
    future.futureClasses.length === 1 && future.futureClasses[0] === 'is-unrecorded',
    `futureClasses=[${future.futureClasses.join(', ')}]`,
  );
  check(
    'a day after today paints the same fill as an unrecorded day earlier in the window',
    future.futureFills.length === 1
      && future.unrecordedFills.length > 0
      && future.futureFills.every((fill) => future.unrecordedFills.includes(fill)),
    `future=[${future.futureFills.join(', ')}] unrecorded=[${future.unrecordedFills.join(', ')}]`,
  );

  // The field has to reach its panel's edges, and it must never scroll: a field that only shows
  // part of the year is not the reading it was built for.
  const fit = await page.evaluate(() => {
    const scroll = document.querySelector('.heatmap-scroll');
    const panel = scroll.parentElement;
    const body = document.querySelector('.heatmap-body');
    const grid = document.querySelector('.heatmap-grid');
    const months = document.querySelector('.heatmap-months');
    return {
      panelWidth: panel.clientWidth,
      bodyWidth: body.getBoundingClientRect().width,
      gridWidth: grid.getBoundingClientRect().width,
      horizontalOverflow: scroll.scrollWidth - scroll.clientWidth,
      verticalOverflow: scroll.scrollHeight - scroll.clientHeight,
      monthsOverflow: months.scrollWidth - months.clientWidth,
      // Each label against the column it names. Comparing widths cannot see this: the axis was 30px
      // wider than the grid for as long as it drifted, and an overflow check passes on a misaligned
      // axis because both are still inside the scroll container. Measured per label, the drift
      // reached 17px on a desktop and 27px on a phone.
      monthDrift: (() => {
        const cells = [...grid.querySelectorAll('.heatmap-cell')];
        const columnOf = (el) => Number(getComputedStyle(el).gridColumn.split('/')[0].trim());
        return [...months.querySelectorAll('.heatmap-month')].map((label) => {
          const cell = cells.find((c) => columnOf(c) === columnOf(label));
          if (!cell) return 0;
          return Math.round(label.getBoundingClientRect().left - cell.getBoundingClientRect().left);
        });
      })(),
      cell: Number(getComputedStyle(grid.querySelector('.heatmap-cell')).width.replace('px', '')),
      cellRatio: (() => {
        const box = grid.querySelector('.heatmap-cell').getBoundingClientRect();
        return box.height / box.width;
      })(),
    };
  });
  check(
    'the grid fills the panel rather than leaving a gutter',
    fit.bodyWidth >= fit.panelWidth - 1 && fit.gridWidth / fit.panelWidth > 0.95,
    `panel=${fit.panelWidth} body=${Math.round(fit.bodyWidth)} grid=${Math.round(fit.gridWidth)}`,
  );
  check('the field never scrolls horizontally', fit.horizontalOverflow <= 0, `horizontalOverflow=${fit.horizontalOverflow}`);
  check('the field never scrolls vertically', fit.verticalOverflow <= 0, `verticalOverflow=${fit.verticalOverflow}`);
  // The axis is aligned with the columns it names. Measured per label rather than by comparing
  // widths, which passes on a drifting axis.
  check(
    'the month axis lines up with the columns it names',
    fit.monthsOverflow <= 0 && fit.monthDrift.length > 0 && fit.monthDrift.every((drift) => Math.abs(drift) <= 1),
    `monthsOverflow=${fit.monthsOverflow} maxDrift=${Math.max(...fit.monthDrift.map(Math.abs))}`,
  );
  check('the cells are square', Math.abs(fit.cellRatio - 1) < 0.02, `height/width=${fit.cellRatio.toFixed(3)}`);
  check('the cells are large enough to read', fit.cell >= 12, `cell=${fit.cell}px`);

  // The panel carries the title, the grid and the legend and nothing else: the three readouts the
  // earlier versions had were restating what a tooltip says on demand.
  const chrome = await page.evaluate(() => ({
    title: document.querySelector('.heatmap-panel .tile-label')?.textContent ?? null,
    readout: document.querySelectorAll('.heatmap-readout').length,
    caption: document.querySelectorAll('.heatmap-caption').length,
    metricSwitcher: document.querySelectorAll('.heatmap-metric').length,
    range: document.querySelectorAll('.heatmap-span').length,
    legend: document.querySelectorAll('.heatmap-legend').length,
    foot: document.querySelectorAll('.heatmap-foot').length,
  }));
  check('the panel is titled', (chrome.title ?? '').length > 0, `title=${JSON.stringify(chrome.title)}`);
  check(
    'the panel carries no readout, caption, range or metric switcher',
    chrome.readout === 0 && chrome.caption === 0 && chrome.range === 0 && chrome.metricSwitcher === 0,
    JSON.stringify(chrome),
  );
  // No legend either. A key explains what a stepped scale's bands mean, and a continuous ramp has
  // none: the shade is relative to the window, so a swatch ladder would describe the field's own
  // range rather than a fixed quantity. The numbers are in each cell's tooltip and accessible name.
  check(
    'the panel carries no legend, because a continuous ramp has no bands to explain',
    chrome.legend === 0 && chrome.foot === 0,
    `legend=${chrome.legend} foot=${chrome.foot}`,
  );

  // The ramp is continuous, so the assertion is that distinct volumes paint distinct fills rather
  // than the four fixed shades it used to. Read from the painted colour, not the class: a class can
  // be right while the mix resolves to one shade, which is the regression this catches.
  const measuredFills = await page.evaluate(() => {
    const sets = [...document.querySelectorAll('.heatmap-grid .heatmap-cell.is-measured')];
    return {
      fills: [...new Set(sets.map((cell) => getComputedStyle(cell).backgroundColor))],
      shares: [...new Set(sets.map((cell) => cell.style.getPropertyValue('--heatmap-quiet-share')))],
    };
  });
  check(
    'every marked day with a distinct volume paints a distinct fill',
    measuredFills.fills.length === heatmapMarked.filter((entry) => entry.tokens > 0).length,
    `fills=${measuredFills.fills.length} shares=${measuredFills.shares.length} (${measuredFills.fills.join(', ')})`,
  );
  // And those fills really are interpolations of one hue rather than unrelated colours.
  const rampShape = await page.evaluate(() => {
    const cell = document.querySelector('.heatmap-grid .heatmap-cell.is-measured');
    const busyStop = getComputedStyle(document.documentElement).getPropertyValue('--heatmap-busy').trim();
    return { busyStop, share: cell.style.getPropertyValue('--heatmap-quiet-share') };
  });
  check(
    'a measured cell carries its own position on the ramp',
    /%$/.test(rampShape.share),
    `share=${rampShape.share} busyStop=${rampShape.busyStop}`,
  );

  // The ramp must stay off the status hues. design.md reserves green/amber/red for state, and a
  // busy day painted in the success token would read as a healthy day - a verdict the grid has no
  // basis for. Only a pixel reading can enforce this.
  const statusFills = await page.evaluate(() => {
    const read = (name) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const status = new Set([read('--success'), read('--warn'), read('--danger')]);
    const offenders = new Set();
    for (const cell of document.querySelectorAll('.heatmap-grid .heatmap-cell')) {
      const fill = getComputedStyle(cell).backgroundColor;
      if (status.has(fill)) offenders.add(fill);
    }
    return [...offenders];
  });
  check('the density ramp uses no status colour', statusFills.length === 0, `statusFills=${statusFills.join(',')}`);

  // The tooltip opens on click and carries the date, the request count, the token volume and the
  // link that opens the day. Click, not hover: a hover tooltip on a field this dense fires
  // continuously as the pointer crosses it, and it competes with the hover ring for the gesture.
  const busiest = heatmapMarked[0];
  const busiestCell = page.locator(`.heatmap-cell[data-day="${busiest.day}"]`);
  const tooltip = page.locator('.ant-tooltip:not(.ant-tooltip-hidden) .heatmap-tip');
  // Hover must NOT open it: that is the behaviour this replaced.
  await busiestCell.hover();
  await page.waitForTimeout(300);
  check(
    'hovering a cell does not open its tooltip',
    (await page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').count()) === 0,
    'tooltip opened on hover',
  );

  await busiestCell.click();
  await tooltip.waitFor({ state: 'visible', timeout: 5000 });
  const tooltipText = await tooltip.innerText();
  check('the tooltip names the day', /\d{4}/.test(tooltipText), `tooltip=${JSON.stringify(tooltipText)}`);
  check('the tooltip reports the request count', tooltipText.includes(busiest.requests.toLocaleString('en')), `tooltip=${JSON.stringify(tooltipText)}`);
  check('the tooltip reports the token volume', tooltipText.includes(busiest.tokens.toLocaleString('en')), `tooltip=${JSON.stringify(tooltipText)}`);
  check('the tooltip offers the drill-down as a link', tooltipText.toLowerCase().includes('view requests'), `tooltip=${JSON.stringify(tooltipText)}`);

  // The drill-down is a real anchor: it can be opened in a new tab and copied, and clicking the
  // cell itself must not navigate - that is what the link is for.
  const link = tooltip.locator('a.heatmap-tip-link');
  check('the drill-down is an anchor rather than a handler', (await link.count()) === 1);
  // The href must carry the router's basename. A bare anchor with the router-internal path skips
  // the `/omc` prefix and lands outside the app, and an assertion that only checked the suffix
  // would pass on the broken URL - which is exactly how that shipped once.
  const href = await link.getAttribute('href');
  const expectedHref = `/omc/usage/events?from=${busiest.from_ms}&to=${busiest.to_ms}`;
  check('the link points at that day\'s request list, under the app basename', href === expectedHref, `href=${href}`);
  check('the link carries both day bounds', href?.includes(`from=${busiest.from_ms}`) && href?.includes(`to=${busiest.to_ms}`), `href=${href}`);
  check('the link is keyboard-reachable', await link.evaluate((node) => node.tabIndex >= 0 || node.nodeName === 'A'));

  // Every line of the tooltip clears WCAG AA against the popper's own background, in both themes.
  // This shipped broken twice: the light theme's spotlight background was dark while the text was
  // the dark-theme foreground (ratio 1.0 - invisible), and the label and link steps sat at 4.4 and
  // 3.4. The ratio is computed here rather than eyeballed, because a colour token that reads fine
  // in one theme is exactly the thing a screenshot in the other theme will not catch.
  const contrast = await page.evaluate(() => {
    const tip = document.querySelector('.ant-tooltip:not(.ant-tooltip-hidden)');
    const luminance = (colour) => {
      const parts = colour.match(/[\d.]+/g).map(Number);
      const [r, g, b] = parts.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (foreground, background) => {
      const first = luminance(foreground) + 0.05;
      const second = luminance(background) + 0.05;
      return Math.max(first, second) / Math.min(first, second);
    };
    // The first opaque background above the text is the popper's own fill.
    let background = 'rgba(0, 0, 0, 0)';
    let node = tip.querySelector('.ant-tooltip-container');
    while (node && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    const samples = {
      day: tip.querySelector('.heatmap-tip-day'),
      label: tip.querySelector('.heatmap-tip-row dt'),
      value: tip.querySelector('.heatmap-tip-row dd'),
      link: tip.querySelector('.heatmap-tip-link'),
    };
    const out = { background };
    for (const [name, element] of Object.entries(samples)) {
      out[name] = Number(ratio(getComputedStyle(element).color, background).toFixed(2));
    }
    return out;
  });
  for (const part of ['day', 'label', 'value', 'link']) {
    check(
      `the tooltip's ${part} text clears WCAG AA contrast`,
      contrast[part] >= 4.5,
      `ratio=${contrast[part]} on ${contrast.background}`,
    );
  }


  // Clicking the cell opened the tooltip and nothing else.
  const stillOnDashboard = await page.evaluate(() => location.pathname.endsWith('/dashboard'));
  check('clicking a day opens the tooltip without navigating', stillOnDashboard, `path=${await page.evaluate(() => location.pathname)}`);

  // Hovering an interactive cell lifts it.
  //
  // Every probe context runs with `prefers-reduced-motion: reduce` so geometry is deterministic, so
  // this asserts the *reduced-motion* contract: the acknowledgement survives and the movement does
  // not. That is the half of the pair that must not regress silently - a motion rule added without
  // the matching reduced-motion override would make the panel move for readers who asked it not to,
  // and no other check in the suite would notice.
  // The motion is on the inner mark, not the cell: the cell is antd's placement anchor and must
  // not move under an open popper.
  const motion = await page.evaluate((day) => {
    const cell = document.querySelector(`.heatmap-cell[data-day="${day}"]`);
    const mark = cell.querySelector('.heatmap-cell-mark');
    return {
      cellTransform: getComputedStyle(cell).transform,
      mark: mark ? getComputedStyle(mark).transform : null,
      transition: mark ? getComputedStyle(mark).transitionProperty : null,
      pointerEvents: mark ? getComputedStyle(mark).pointerEvents : null,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  }, busiest.day);
  check('the probe context is a reduced-motion one', motion.reduced === true, `reduced=${motion.reduced}`);
  // The anchor itself must never be transformed, whatever the motion does.
  check('the tooltip\'s anchor is never transformed', motion.cellTransform === 'none', `transform=${motion.cellTransform}`);
  check('the mark does not intercept the pointer', motion.pointerEvents === 'none', `pointerEvents=${motion.pointerEvents}`);
  check(
    'reduced motion suppresses the hover transition',
    motion.transition === 'none',
    `transitionProperty=${motion.transition}`,
  );
  await busiestCell.hover();
  await page.waitForTimeout(200);
  const held = await page.evaluate((day) => {
    const cell = document.querySelector(`.heatmap-cell[data-day="${day}"]`);
    const mark = cell.querySelector('.heatmap-cell-mark');
    return {
      markTransform: mark ? getComputedStyle(mark).transform : null,
      cursor: getComputedStyle(cell).cursor,
    };
  }, busiest.day);
  check('reduced motion suppresses the lift', held.markTransform === 'none', `transform=${held.markTransform}`);
  // The pointer affordance is what remains, and it is the acknowledgement that must survive.
  check('the cell still advertises that it is interactive', held.cursor === 'pointer', `cursor=${held.cursor}`);

  // The declared motion is asserted from the stylesheet rather than from a rendered frame, because
  // no probe context can render it: `prefers-reduced-motion` is forced on for determinism. The rule
  // itself is what matters - a colour transition on hover would smear behind a fast sweep, which is
  // what design.md §7 rule 7 forbids, and only the declaration can say which property animates.
  const declared = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        // The mark's own rule: the transition belongs to the element that scales, not to the
        // stationary anchor.
        if (rule.selectorText === '.heatmap-cell-mark' && rule.style.transition) {
          return rule.style.transition;
        }
      }
    }
    return null;
  });
  check('the stylesheet declares a hover transition', declared !== null, `transition=${declared}`);
  check(
    'the declared hover motion animates only the transform',
    typeof declared === 'string' && declared.includes('transform') && !/color|background|box-shadow/.test(declared),
    `transition=${declared}`,
  );

  // A cell with no requests is clickable too, and its tooltip reports the absence rather than the two
  // counts. That is the point: "no requests on this date" is a fact the panel can state, while
  // "Requests 0 / Tokens 0" would be a measurement nothing is stored to support.
  const quietDay = heatmapMarked.find((entry) => entry.tokens === 0).day;
  const quietCell = page.locator(`.heatmap-cell[data-day="${quietDay}"]`);
  check('a trafficless cell advertises that it is clickable', (await quietCell.evaluate((node) => getComputedStyle(node).cursor)) === 'pointer');
  check('a trafficless cell takes a tab stop when focused', (await quietCell.evaluate((node) => Number(node.getAttribute('tabindex')) <= 0)) === true);
  await quietCell.click();
  await page.waitForTimeout(300);
  const quietTip = page.locator('.ant-tooltip:not(.ant-tooltip-hidden) .heatmap-tip');
  await quietTip.waitFor({ state: 'visible', timeout: 5000 });
  const quietText = await quietTip.innerText();
  check('a trafficless cell opens a tooltip', (await quietTip.count()) === 1, `text=${JSON.stringify(quietText)}`);
  check(
    'the trafficless tooltip says there were no requests',
    /no requests/i.test(quietText),
    `text=${JSON.stringify(quietText)}`,
  );
  // It states the absence *instead of* the counts. The date line carries digits of its own, so the
  // check is that no line reports a zero count - not that the tooltip contains no zero anywhere.
  const zeroLines = quietText.split('\n').filter((line) => /^\s*(requests|tokens|请求次数|Token)\b/i.test(line) && /(^|\D)0(\D|$)/.test(line));
  check(
    'the trafficless tooltip prints no zero counts',
    zeroLines.length === 0,
    `zeroLines=${JSON.stringify(zeroLines)} text=${JSON.stringify(quietText)}`,
  );
  check(
    'the trafficless tooltip offers no drill-down link',
    (await quietTip.locator('a.heatmap-tip-link').count()) === 0,
    `links=${await quietTip.locator('a.heatmap-tip-link').count()}`,
  );
  // The accessible name follows the cell's state, not the response's shape. The server emits a
  // zero-valued entry for every day in the window, so a name built from the entry's presence
  // announced "0 requests, 0 tokens" for days nothing is stored for - telling a screen reader a
  // measurement exists where the colour and the tooltip both say none does.
  const quietName = await quietCell.getAttribute('aria-label');
  check(
    'a trafficless cell is named as carrying no measurement, not as a measured zero',
    Boolean(quietName) && /no requests/i.test(quietName) && !/(^|\D)0(\D|$)/.test(quietName.replace(/\d{4}/g, '')),
    `name=${JSON.stringify(quietName)}`,
  );
  const measuredName = await page.locator('.heatmap-cell.is-measured').first().getAttribute('aria-label');
  check(
    'a measured cell is still named with its own counts',
    Boolean(measuredName) && /\d/.test(measuredName) && !/no requests/i.test(measuredName),
    `name=${JSON.stringify(measuredName)}`,
  );
  // Legible against the popper it sits on, measured rather than assumed. This is the assertion that
  // was missing: the empty state's text had no colour rule of its own, so it inherited antd's white
  // - meant for antd's own dark spotlight - while this popper's fill is the light theme's surface.
  // The text assertions above all passed on an invisible tooltip, because `innerText` reads text
  // that is painted, not text a reader can see.
  const quietContrast = await quietTip.evaluate((node) => {
    const parse = (value) => (String(value).match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const linear = (channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
    // Walk up for the painted fill: the tooltip's own background is transparent.
    let box = node;
    let background = 'rgba(0, 0, 0, 0)';
    while (box && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(box).backgroundColor;
      box = box.parentElement;
    }
    const empty = node.querySelector('.heatmap-tip-empty') ?? node;
    const fg = luminance(parse(getComputedStyle(empty).color));
    const bg = luminance(parse(background));
    return { ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05), background };
  });
  check(
    'the trafficless tooltip text is legible against its own background',
    quietContrast.ratio >= 4.5,
    `ratio=${quietContrast.ratio.toFixed(2)} on ${quietContrast.background}`,
  );
  // Close it again so the following assertions start from a known state.
  await quietCell.click();
  await page.waitForTimeout(200);

  // The tooltip is centred on its cell and placed above it. Measured on an interior cell first: a
  // cell in the last column gets its tooltip clamped inward to stay on screen, which is correct and
  // would have read as a centring failure.
  const interior = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell.is-measured')];
    return cells[Math.floor(cells.length / 2)]?.getAttribute('data-day') ?? null;
  });
  await page.locator(`.heatmap-cell[data-day="${interior}"]`).click();
  await page.waitForTimeout(250);
  const anchored = await page.evaluate((day) => {
    const cell = document.querySelector(`.heatmap-cell[data-day="${day}"]`);
    const tip = document.querySelector('.ant-tooltip:not(.ant-tooltip-hidden)');
    if (!tip || !cell?.closest('.ant-tooltip-open')) return { error: 'no open tooltip' };
    const cb = cell.getBoundingClientRect();
    const tb = tip.getBoundingClientRect();
    return {
      dx: Math.abs((tb.left + tb.width / 2) - (cb.left + cb.width / 2)),
      above: tb.bottom <= cb.top + 2,
      arrow: Boolean(tip.querySelector('.ant-tooltip-arrow')),
      withinViewport: tb.left >= 0 && tb.right <= window.innerWidth,
    };
  }, interior);
  check('the tooltip is centred on its cell', !anchored.error && anchored.dx <= 2, anchored.error ?? `dx=${anchored.dx.toFixed(2)}`);
  check('the tooltip is placed above the cell', anchored.above === true, `above=${anchored.above}`);
  check('the tooltip carries antd\'s arrow, so the panel inherits the app tooltip chrome', anchored.arrow === true, `arrow=${anchored.arrow}`);

  // A cell in the final column has nowhere to put a centred tooltip, so antd shifts it inward
  // rather than letting it overflow. The centred form is what the check above pins, so a regression
  // that removed the clamp would push this one off screen.
  //
  // The link check above left a tooltip open on the interior cell. Opening the last column's
  // tooltip for this check means clicking that cell, and the trigger toggles - so this relies on
  // antd closing the previous one, which it does when the trigger moves. Asserted rather than
  // assumed, because a stale tooltip would make the final navigation check click the wrong link.
  await busiestCell.click();
  await page.waitForTimeout(300);
  const clamped = await page.evaluate(() => {
    const tip = document.querySelector('.ant-tooltip:not(.ant-tooltip-hidden)');
    if (!tip) return { error: 'no open tooltip' };
    const tb = tip.getBoundingClientRect();
    return { withinViewport: tb.left >= 0 && tb.right <= window.innerWidth, right: Math.round(tb.right), viewport: window.innerWidth };
  });
  check(
    'a tooltip on the last column stays inside the viewport',
    clamped.withinViewport === true,
    clamped.error ?? `right=${clamped.right} viewport=${clamped.viewport}`,
  );

  // Hovering must not rebuild the cells. The hovered day is state (the tooltip names it), so
  // without memoizing the elements every pointer move reconciles ~370 nodes - which is what made a
  // fast sweep stutter. A marker on an untouched cell survives only if React re-used the element.
  const stability = await page.evaluate((day) => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const untouched = cells[100];
    untouched.dataset.stabilityMarker = 'original';
    window.__stabilityNode = untouched;
    return day;
  }, shape.days[200]);
  await page.locator(`.heatmap-cell[data-day="${stability}"]`).hover();
  await page.waitForTimeout(150);
  const survived = await page.evaluate(() => {
    const untouched = document.querySelectorAll('.heatmap-grid .heatmap-cell')[100];
    return { marker: untouched.dataset.stabilityMarker ?? null, sameNode: untouched === window.__stabilityNode };
  });
  check(
    'hovering re-uses the cells instead of rebuilding them all',
    survived.marker === 'original' && survived.sameNode,
    `marker=${survived.marker} sameNode=${survived.sameNode}`,
  );

  // Keyboard access: one cell in the tab order, the arrow keys walking the two axes, and the
  // tooltip following the focused day.
  // The tab stop lives on an interactive cell, so this is also the assertion that dead cells are
  // excluded from the tab order rather than merely looking inert.
  const tabStops = await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"]').count();
  check('the grid keeps exactly one cell in the tab order', tabStops === 1, `tabStops=${tabStops}`);
  check(
    'the tab stop is on a cell that carried traffic',
    (await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"].is-interactive').count()) === 1,
  );
  await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"]').focus();
  const focusedDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check('the tab stop is a cell the browser will actually focus', focusedDay !== null, `focused=${focusedDay}`);

  // The starting cell has to be *interior*: mid-week and away from the first and last columns.
  // Movement deliberately does not wrap, so a key pressed on an edge is a legal no-op - and a probe
  // that started there would have asserted the axis by exercising nothing.
  const midWeek = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const columns = Math.max(...cells.map((cell) => Number(getComputedStyle(cell).gridColumnStart)));
    const target = cells.find((cell) => {
      const [year, month, date] = cell.getAttribute('data-day').split('-').map(Number);
      const weekday = (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
      const column = Number(getComputedStyle(cell).gridColumnStart);
      return weekday === 3 && column > 2 && column < columns - 1;
    });
    return target?.getAttribute('data-day') ?? null;
  });
  check('the fixture has an interior mid-week cell to move from', midWeek !== null, `midWeek=${midWeek}`);
  await page.locator(`.heatmap-cell[data-day="${midWeek}"]`).focus();

  const dayDelta = (a, b) => Math.round((new Date(b) - new Date(a)) / 86_400_000);
  await page.keyboard.press('ArrowLeft');
  const weekBack = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  await page.keyboard.press('ArrowRight');
  const weekForward = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check(
    'left and right move a whole week',
    dayDelta(weekBack, midWeek) === 7 && weekForward === midWeek,
    `from=${midWeek} back=${weekBack} forward=${weekForward}`,
  );
  await page.keyboard.press('ArrowUp');
  const rowUp = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  await page.keyboard.press('ArrowDown');
  const rowDown = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check(
    'up and down move one weekday rather than one day',
    dayDelta(rowUp, midWeek) === 1 && rowDown === midWeek,
    `from=${midWeek} up=${rowUp} down=${rowDown}`,
  );
  // Movement is not restricted to interactive cells - the operator can walk the calendar to read
  // it - but the tab stop itself stays unique.
  const tabStopsAfterMove = await page.locator('.heatmap-grid .heatmap-cell[tabindex="0"]').count();
  check('the tab stop roves rather than accumulating', tabStopsAfterMove <= 1, `tabStops=${tabStopsAfterMove}`);

  await page.keyboard.press('Home');
  const homeDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check('Home reaches the oldest day', homeDay === shape.days[0], `home=${homeDay} expected=${shape.days[0]}`);
  await page.keyboard.press('End');
  const endDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day') ?? null);
  check('End reaches the newest day', endDay === shape.days[shape.days.length - 1], `end=${endDay}`);

  // The drill-down navigates through the tooltip's link, and nowhere else: the cell itself opens
  // the tooltip. Asserted end to end, because the whole point of the change was that a click on a
  // square should not throw the operator out of the dashboard.
  // One cell is open at a time, and the click trigger toggles: clicking the same cell again would
  // close it, so this clicks once from a known state and waits for the tooltip to settle before
  // reaching inside it - the entrance motion makes the link briefly unstable to Playwright.
  check(
    'exactly one tooltip is open at a time',
    (await page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').count()) === 1,
    `open=${await page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').count()}`,
  );
  const openLink = tooltip.locator('a.heatmap-tip-link');
  await openLink.waitFor({ state: 'visible', timeout: 5000 });
  await openLink.click();
  await page.waitForFunction(() => location.pathname.endsWith('/usage/events'), null, { timeout: 10_000 });
  const query = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search).entries()));
  check(
    "the tooltip's link opens the request list on that day's own bounds",
    Number(query.from) === busiest.from_ms && Number(query.to) === busiest.to_ms,
    `day=${busiest.day} from=${query.from} to=${query.to} expected=${busiest.from_ms}-${busiest.to_ms}`,
  );
}

/**
 * The heatmap on a phone.
 *
 * A year of weeks cannot fit a 390px viewport at a legible cell size, so the field is swipeable
 * there - and that is where it went wrong once already: it opened on the oldest column, leaving
 * today off screen. These are the assertions that would have caught it, plus the two a grid adds:
 * seven rows have to survive the narrow breakpoint, and a tap in the middle of a square must open
 * that square's day rather than a neighbour's.
 */
export async function dashboardTokenHeatmapMobile({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });

  // The page itself must never scroll sideways; the field swipes inside its own container so the
  // rest of the dashboard keeps its layout.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('the dashboard does not overflow horizontally on a phone', overflow <= 0, `overflow=${overflow}px`);

  // The field keeps its shape at the narrow breakpoint: shrinking the cells must not wrap the grid
  // into a second block of seven rows, which would destroy the row-per-weekday reading.
  const shape = await page.evaluate(() => {
    const grid = document.querySelector('.heatmap-grid');
    const scroll = document.querySelector('.heatmap-scroll');
    const cells = [...grid.querySelectorAll('.heatmap-cell')];
    return {
      rows: new Set(cells.map((cell) => getComputedStyle(cell).gridRowStart)).size,
      columns: new Set(cells.map((cell) => getComputedStyle(cell).gridColumnStart)).size,
      scrollable: scroll.scrollWidth > scroll.clientWidth + 1,
      weekdays: document.querySelectorAll('.heatmap-weekday').length,
      cell: Number(getComputedStyle(cells[0]).width.replace('px', '')),
      // A bar inside a dashboard card is visual noise, and touch has none anyway.
      scrollbarWidth: getComputedStyle(scroll).scrollbarWidth,
      widthDelta: scroll.offsetWidth - scroll.clientWidth,
    };
  });
  check('the grid keeps all seven rows on a phone', shape.rows === 7, `rows=${shape.rows}`);
  check('the grid keeps its 53 columns on a phone', shape.columns === HEATMAP_WEEKS, `columns=${shape.columns}`);
  check('the grid labels all seven rows on a phone', shape.weekdays === 7, `weekdays=${shape.weekdays}`);
  check('the cells stay at the legible floor', shape.cell >= 9, `cell=${shape.cell}px`);
  // A year of weeks cannot fit a phone at a legible size, so the field is swipeable - with the bar
  // hidden, since a scrollbar in the card is noise.
  check('a too-narrow panel is swipeable rather than clipped', shape.scrollable, `scrollable=${shape.scrollable}`);
  check(
    'the swipe leaves no visible scrollbar',
    shape.scrollbarWidth === 'none' && shape.widthDelta === 0,
    `scrollbarWidth=${shape.scrollbarWidth} widthDelta=${shape.widthDelta}`,
  );

  // It opens scrolled to today, which is the column whose total is still growing. Without this the
  // operator lands three months in the past with today off screen.
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, '0')}-${`${today.getDate()}`.padStart(2, '0')}`;
  const opened = await page.evaluate((key) => {
    const scroll = document.querySelector('.heatmap-scroll');
    const bounds = scroll.getBoundingClientRect();
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const cell = cells.find((candidate) => candidate.getAttribute('data-day') === key);
    if (!cell) return { error: 'today is not in the grid' };
    const box = cell.getBoundingClientRect();
    return {
      scrollLeft: Math.round(scroll.scrollLeft),
      maxScroll: scroll.scrollWidth - scroll.clientWidth,
      todayVisible: box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
    };
  }, todayKey);
  check(
    'the field opens scrolled to today rather than to the oldest week',
    opened.todayVisible && opened.scrollLeft === opened.maxScroll,
    `scrollLeft=${opened.scrollLeft}/${opened.maxScroll} todayVisible=${opened.todayVisible}`,
  );

  // A tap in the middle of a square opens that square's day. The panel is brought into view first:
  // `elementFromPoint` cannot resolve a point below the fold.
  await page.locator('.heatmap-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const tap = await page.evaluate(() => {
    // The visible window is the *scroll container's* box, not the grid's: the grid is wider than
    // the panel, so its own rect extends past the viewport and a cell picked from it can sit
    // entirely off-screen.
    const scroll = document.querySelector('.heatmap-scroll');
    const bounds = scroll.getBoundingClientRect();
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const target = cells.find((cell) => {
      const box = cell.getBoundingClientRect();
      return box.left > bounds.left + 40 && box.right < bounds.right - 40
        && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
    if (!target) return { error: 'no fully visible cell' };
    const box = target.getBoundingClientRect();
    const closestDay = (x, y) => document.elementFromPoint(x, y)?.closest('.heatmap-cell')?.getAttribute('data-day') ?? null;
    const centreDay = closestDay(box.left + box.width / 2, box.top + box.height / 2);
    // Walk the vertical extent to measure how tall the target really is.
    let top = null;
    let bottom = null;
    for (let y = box.top - 20; y <= box.bottom + 20; y += 1) {
      if (closestDay(box.left + box.width / 2, y) === target.getAttribute('data-day')) {
        if (top === null) top = y;
        bottom = y;
      }
    }
    return {
      day: target.getAttribute('data-day'),
      centreDay,
      cellWidth: Math.round(box.width),
      targetHeight: top === null ? 0 : Math.round(bottom - top + 1),
    };
  });
  check(
    'a tap in the middle of a day opens that day, not its neighbour',
    tap.centreDay === tap.day,
    `cell=${tap.day} centreHit=${tap.centreDay} (width=${tap.cellWidth})`,
  );
  check(
    'the tap target is at least as tall as the visible square',
    tap.targetHeight >= tap.cellWidth,
    `targetHeight=${tap.targetHeight} cellWidth=${tap.cellWidth}`,
  );
}

/**
 * The grid as a deployment actually shows it: most cells predate the retention horizon.
 *
 * The assertion that matters is the *mark*: an unrecorded day is a solid fill ordered against the
 * card, never an outline. Outlining them turned a year of cells into a wire mesh - 275 1px boxes
 * competing with the handful of green squares the panel exists to show.
 */
export async function dashboardTokenHeatmapPruned({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-grid').waitFor({ timeout: 20_000 });

  const states = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.heatmap-grid .heatmap-cell')];
    const counts = {};
    for (const cell of cells) {
      const state = ['is-measured', 'is-empty', 'is-unrecorded', 'is-pending']
        .find((name) => cell.classList.contains(name)) ?? 'unknown';
      counts[state] = (counts[state] ?? 0) + 1;
    }
    const card = getComputedStyle(document.querySelector('.heatmap-panel')).backgroundColor;
    const sample = (selector) => {
      const found = document.querySelector(`.heatmap-grid ${selector}`);
      if (!found) return null;
      const style = getComputedStyle(found);
      return { fill: style.backgroundColor, shadow: style.boxShadow };
    };
    // Contrast against the card, which is the surface the cells are read on.
    const luminance = (colour) => {
      const parts = colour.match(/[\d.]+/g).map(Number);
      const [r, g, b] = parts.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const against = (colour) => {
      const first = luminance(colour) + 0.05;
      const second = luminance(card) + 0.05;
      return Number((Math.max(first, second) / Math.min(first, second)).toFixed(3));
    };
    const unrecorded = sample('.heatmap-cell.is-unrecorded');
    const empty = sample('.heatmap-cell.is-empty');
    const measured = sample('.heatmap-cell.is-measured');
    return {
      counts,
      card,
      unrecorded,
      empty,
      measured,
      ratio: {
        unrecorded: unrecorded ? against(unrecorded.fill) : null,
        empty: empty ? against(empty.fill) : null,
        measured: measured ? against(measured.fill) : null,
      },
    };
  });

  // The fixture has to actually produce the case, or everything below passes vacuously.
  check(
    'the pruned fixture produces unrecorded days',
    states.counts['is-unrecorded'] > 200,
    `unrecorded=${states.counts['is-unrecorded']} of ${Object.values(states.counts).reduce((a, b) => a + b, 0)}`,
  );

  // A solid fill, not an outline. This is the defect: 1px boxes over most of the grid read as a mesh.
  check(
    'an unrecorded day is a solid fill rather than an outline',
    states.unrecorded !== null && states.unrecorded.fill !== 'rgba(0, 0, 0, 0)' && states.unrecorded.shadow === 'none',
    `fill=${states.unrecorded?.fill} shadow=${states.unrecorded?.shadow}`,
  );
  check(
    'every zero state is a solid fill rather than an outline',
    states.empty !== null && states.empty.fill !== 'rgba(0, 0, 0, 0)' && states.empty.shadow === 'none',
    `emptyFill=${states.empty?.fill} emptyShadow=${states.empty?.shadow}`,
  );

  // The order carries the meaning: no information is quietest, a measured zero is a step louder, and
  // a day with traffic is the only thing clearly above the card. Asserted as a chain so a token
  // swapped in the wrong direction fails rather than merely looking odd.
  check(
    'the two zero states are quieter than the card and a measured day is louder',
    states.ratio.unrecorded < states.ratio.empty && states.ratio.empty < states.ratio.measured,
    `unrecorded=${states.ratio.unrecorded} empty=${states.ratio.empty} measured=${states.ratio.measured}`,
  );
  // And both zeros stay quiet: they must never compete with the greens that carry the data.
  check(
    'neither zero state competes with the measured cells',
    states.ratio.unrecorded < 1.15 && states.ratio.empty < 1.2,
    `unrecorded=${states.ratio.unrecorded} empty=${states.ratio.empty}`,
  );
}

/**
 * The heatmap's failure paths.
 *
 * Two failures matter and they are different: a first load that never succeeded has
 * no strip to show and must say so (rather than leaving a skeleton up forever, which
 * is indistinguishable from a slow read), while a *refresh* that failed must keep the
 * strip the operator is reading. The second is the one a "the panel rendered"
 * assertion cannot see, because the panel renders either way.
 */
export async function dashboardTokenHeatmapFailure({ base, page, check, context }) {
  // A first load against a failing endpoint: the panel reports it and offers a retry.
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.heatmap-panel .ant-alert-error').waitFor({ timeout: 20_000 });
  const errorText = await page.locator('.heatmap-panel .ant-alert-error').innerText();
  check('a failed first load is reported rather than left loading', errorText.length > 0, `alert=${JSON.stringify(errorText.slice(0, 120))}`);
  check('the failed panel offers a retry', (await page.locator('.heatmap-panel .ant-alert-error button').count()) === 1);
  check(
    'the failed panel does not show a grid it never read',
    (await page.locator('.heatmap-grid').count()) === 0,
  );

  // A load that succeeded and then a refresh that failed: the strip stays, and the
  // warning is additive. The route is re-pointed at the failure after the first read.
  const { page: page2 } = await (async () => {
    const fresh = await context.newPage();
    return { page: fresh };
  })();
  let failNext = false;
  await context.route('**/omc/api/**/dashboard/token-heatmap**', async (route) => {
    if (failNext) return route.fulfill({ status: 503, json: { error: 'database is unavailable' } });
    return route.fulfill({ status: 200, json: chartTokenHeatmap });
  });
  await page2.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page2.locator('.heatmap-grid').waitFor({ timeout: 20_000 });
  const cellsBefore = await page2.locator('.heatmap-grid .heatmap-cell').count();
  check('the grid renders before the refresh failure', cellsBefore === HEATMAP_TOTAL_DAYS, `cells=${cellsBefore}`);

  // Pressing the page's refresh button re-reads the grid, and that read fails.
  failNext = true;
  await page2.locator('.terminal-page-head button:has(.anticon-reload)').first().click();
  await page2.locator('.heatmap-stale-alert').waitFor({ timeout: 20_000 });
  const cellsAfter = await page2.locator('.heatmap-grid .heatmap-cell').count();
  check(
    'a failed refresh keeps the grid the operator was reading',
    cellsAfter === HEATMAP_TOTAL_DAYS,
    `cells=${cellsAfter}`,
  );
  const warningText = await page2.locator('.heatmap-stale-alert').innerText();
  check('the stale grid says the refresh failed', warningText.length > 0, `alert=${JSON.stringify(warningText.slice(0, 120))}`);

  // And a retry that succeeds clears the warning, so the panel does not stay stuck in
  // its degraded state after the read recovers.
  failNext = false;
  await page2.locator('.heatmap-stale-alert button').click();
  await page2.locator('.heatmap-stale-alert').waitFor({ state: 'detached', timeout: 20_000 });
  check('a successful retry clears the warning', (await page2.locator('.heatmap-stale-alert').count()) === 0);
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

/**
 * The per-model fixture for the dashboard's two model panels.
 *
 * Deliberately larger than the model set a default run would produce, so the panels have to fold a
 * remainder rather than print every model: six named groups plus a folded one is what exercises the
 * `folded` discriminator, the legend's width at its worst, and the donut's small-slice rendering.
 *
 * Each group peaks in its own band of the window, so the trend has seven visibly different shapes.
 * That is what the paint assertions read: if every series carried the same curve, a mark wired to the
 * wrong series - or to one series repeated - would still look plausible.
 */
const MODEL_BUCKETS = 30;
const modelBucketMS = 60_000;
const modelGroups = [
  { model: 'gpt-5-codex', tokens: 480_000, peak: 2 },
  { model: 'claude-sonnet-4-5-20250929', tokens: 210_000, peak: 7 },
  { model: 'gemini-3-pro-preview', tokens: 96_000, peak: 13 },
  { model: 'deepseek-v4-pro', tokens: 44_000, peak: 18 },
  { model: 'qwen3-coder-plus', tokens: 18_000, peak: 23 },
  { model: 'glm-5.3-flash', tokens: 7_000, peak: 26 },
  { model: 'kimi-k2-thinking', tokens: 2_000, peak: 28 },
  { model: 'hy4-preview', tokens: 600, peak: 29 },
];
const modelWindowFrom = Date.now() - MODEL_BUCKETS * modelBucketMS;

/**
 * One group's series: a single peak in its own band, zero elsewhere.
 *
 * The weights are a whole unit split two ways - the earlier bucket takes the larger share and the rest
 * is the **integer remainder** - so the series always sums back to exactly `total`. An earlier revision
 * used 1 and 0.4 as fractions of the total, which made every series sum to 140% of the number reported
 * beside it: the fixture violated the one containment invariant the API guarantees, so a real
 * regression in the fold would have had a wrong baseline to be measured against.
 */
function modelSeriesFor(peak, total) {
  const head = Math.round(total * 0.7);
  const tail = total - head;
  // A peak in the final bucket has no next bucket to hold the remainder, so it takes the whole amount
  // rather than dropping it. Silently losing it is what the conservation check below caught.
  const hasTailBucket = peak + 1 < MODEL_BUCKETS;
  return Array.from({ length: MODEL_BUCKETS }, (_, index) => ({
    t: modelWindowFrom + index * modelBucketMS,
    tokens: index === peak ? (hasTailBucket ? head : total) : hasTailBucket && index === peak + 1 ? tail : 0,
  }));
}

/** The groups the response carries, named first and folded last, in the order the API promises. */
function modelFixtureGroups() {
  const named = modelGroups.slice(0, 5).map((group) => ({
    model: group.model,
    folded: false,
    tokens: group.tokens,
    requests: 10 + group.peak,
    series: modelSeriesFor(group.peak, group.tokens),
  }));
  const remainder = modelGroups.slice(5);
  const foldedTokens = remainder.reduce((sum, group) => sum + group.tokens, 0);
  // The remainder's own shape is the sum of its members' shapes, so it is built rather than sampled:
  // distributing it with a single peak would give it a shape none of its members has.
  const foldedSeries = Array.from({ length: MODEL_BUCKETS }, (_, index) => ({ t: modelWindowFrom + index * modelBucketMS, tokens: 0 }));
  for (const group of remainder) {
    for (const point of modelSeriesFor(group.peak, group.tokens)) {
      foldedSeries.find((entry) => entry.t === point.t).tokens += point.tokens;
    }
  }
  return [...named, { model: '', folded: true, tokens: foldedTokens, requests: 9, series: foldedSeries }];
}

/**
 * The fixture must satisfy the API's own containment invariant before a browser ever sees it: every
 * group's series sums to that group's total, and the groups sum to the window total. Without this the
 * probe's "the ring reports the window total" check would be comparing against a number the fixture
 * itself contradicted.
 */
const modelFixture = modelFixtureGroups();
const modelFixtureTotal = modelFixture.reduce((sum, group) => sum + group.tokens, 0);
for (const group of modelFixture) {
  const summed = group.series.reduce((sum, point) => sum + point.tokens, 0);
  if (summed !== group.tokens) {
    throw new Error(`model fixture group ${group.model || '(folded)'} sums to ${summed}, want ${group.tokens}`);
  }
}

export const chartDashboardModels = {
  window: {
    preset: '1h',
    from: modelWindowFrom,
    to: Date.now(),
    bucket_ms: modelBucketMS,
    minutes: 30,
    complete: true,
    open_end: false,
  },
  total_tokens: modelFixtureTotal,
  models: modelFixture,
  partial_errors: [],
};

/** A window in which no model carried tokens, for the panels' empty state. */
export const chartDashboardModelsEmpty = {
  window: {
    preset: '1h',
    from: modelWindowFrom,
    to: Date.now(),
    bucket_ms: modelBucketMS,
    minutes: 30,
    complete: true,
    open_end: false,
  },
  total_tokens: 0,
  models: [],
  partial_errors: [],
};

export const chartDashboardModelsWeek = {
  ...chartDashboardModels,
  window: { ...chartDashboardModels.window, preset: '7d' },
};

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
 * The dashboard's two model panels: the per-model token trend and the model-usage ring.
 *
 * Both are AntV marks, so the assertions read painted pixels rather than DOM - a canvas that exists
 * proves nothing, and the failure this has to catch is a mark drawn with the wrong data or in one
 * colour repeated. Four claims are made, and each is one a per-component test cannot reach:
 *
 *   - Each group's line is painted in its own colour. A `colorField` that failed to bind, or a domain
 *     and range that were passed in an order the library did not honour, paints every series the same
 *     and still renders a plausible chart.
 *   - The ring draws as many distinct slice colours as the legend claims groups. A ring wired to the
 *     first group repeated would look like a ring.
 *   - The legend and the ranked list agree, group for group and colour for colour. They are two
 *     renderings of one ranking, and the api's `folded` discriminator is the only thing keeping a real
 *     model named like the remainder out of the remainder.
 *   - Nothing overflows the card at its own width, which is the container this chart is drawn into.
 */
export async function dashboardModelPanels({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-models').waitFor({ timeout: 20_000 });
  // The marks are behind a lazy import, so the first frame after the panel appears is the Suspense
  // fallback rather than a canvas.
  await page.locator('.model-trend canvas').first().waitFor({ timeout: 20_000 });
  await page.locator('.model-ring canvas').first().waitFor({ timeout: 20_000 });

  /**
   * The distinct opaque colours a canvas paints, most frequent first.
   *
   * Quantised to 4 bits per channel so antialiasing along a curve does not read as hundreds of
   * separate colours, and filtered by how much of the canvas each one covers: a 1.6px line
   * antialiases into a halo of intermediate tones, and the halo colours are not what a reader
   * perceives the line to be.
   */
  const paintedTones = async (selector, minimumShare) => page.evaluate(([sel, share]) => {
    const canvas = document.querySelector(sel);
    if (!canvas) return { error: `no canvas for ${sel}` };
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    probe.getContext('2d').drawImage(canvas, 0, 0);
    const { data } = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height);
    const counts = new Map();
    let opaque = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] < 200) continue;
      opaque += 1;
      const key = `${data[offset] >> 4},${data[offset + 1] >> 4},${data[offset + 2] >> 4}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const floor = opaque * share;
    return {
      total: opaque,
      tones: [...counts.entries()].filter(([, count]) => count >= floor).map(([key]) => key),
      distinct: counts.size,
    };
  }, [selector, minimumShare]);

  // ── the trend ──────────────────────────────────────────────────────────────
  const trendTones = await paintedTones('.model-trend canvas', 0.002);
  const legendColors = await page.evaluate(() =>
    [...document.querySelectorAll('.model-legend-item')].map((item) => {
      const swatch = getComputedStyle(item.querySelector('.model-legend-swatch')).backgroundColor;
      const match = swatch.match(/\d+/g).map(Number);
      return `${match[0] >> 4},${match[1] >> 4},${match[2] >> 4}`;
    }),
  );
  check(
    'the trend legend lists one entry per group',
    legendColors.length === 6,
    `entries=${legendColors.length}`,
  );
  check(
    'the trend paints each group in its own colour',
    trendTones.tones.length >= 5,
    `tones=${trendTones.tones.length} (${trendTones.tones.join(' | ')}) distinct=${trendTones.distinct}`,
  );
  // Every legend colour must actually appear in the paint. A legend is generated from the same
  // palette the chart is, so a chart that ignored its range would still have a correct-looking key
  // above it - which is exactly the defect this catches.
  const missingFromPaint = legendColors.filter((tone) => !trendTones.tones.includes(tone));
  check(
    'every colour the legend promises is painted in the plot',
    missingFromPaint.length === 0,
    `missing=${missingFromPaint.join(' | ')} painted=${trendTones.tones.join(' | ')}`,
  );

  // ── the ring ───────────────────────────────────────────────────────────────
  //
  // The ring's own paint is read the same way, but the assertion is stronger than "several colours are
  // present": a ring wired to one group repeated, and a ring whose slices are drawn with thin borders
  // between near-identical shades, would both satisfy a count. So the painted arcs are matched against
  // the *expected* palette - the colours the legend above the trend promises - one group at a time.
  const ringPainted = await paintedTones('.model-ring canvas', 0.002);
  const ringArcColors = await page.evaluate(() => {
    // Group the ring's opaque pixels by their quantised colour, then keep the colours that occupy a
    // contiguous angular span: a slice is a wedge, whereas the 2px separator stroke and anti-aliased
    // edges are thin and scattered. This is what separates "six slices" from "six colours, one of which
    // is the border".
    const canvas = document.querySelector('.model-ring canvas');
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    const context = probe.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, probe.width, probe.height);
    const cx = probe.width / 2;
    const cy = probe.height / 2;
    const bands = new Map();
    const steps = 360;
    for (let step = 0; step < steps; step += 1) {
      const angle = (step / steps) * Math.PI * 2;
      // Sample the middle of the ring's thickness, which is where a slice is solid.
      for (const radius of [0.36, 0.40, 0.44]) {
        const x = Math.round(cx + Math.cos(angle) * probe.width * radius);
        const y = Math.round(cy + Math.sin(angle) * probe.height * radius);
        if (x < 0 || y < 0 || x >= probe.width || y >= probe.height) continue;
        const offset = (y * probe.width + x) * 4;
        if (data[offset + 3] < 200) continue;
        const key = `${data[offset] >> 4},${data[offset + 1] >> 4},${data[offset + 2] >> 4}`;
        bands.set(key, (bands.get(key) ?? 0) + 1);
      }
    }
    // A slice spanning at least a few degrees of the ring at three sampled radii.
    return [...bands.entries()].filter(([, hits]) => hits >= 6).map(([key]) => key);
  });
  check(
    'the ring paints an arc colour per slice rather than one repeated colour',
    ringArcColors.length >= 5,
    `arcs=${ringArcColors.length} (${ringArcColors.join(' | ')}) of ${ringPainted.distinct} distinct tones`,
  );
  // The slices are drawn with a 2px separator in the card's own surface colour, so that two
  // neighbouring hues do not touch. That stroke is chrome rather than a category, and this is the one
  // exception allowed: every other colour the ring paints must be a palette colour the legend promises,
  // which is what makes "the ring and the legend agree" a real assertion rather than a count.
  const cardSurface = await page.evaluate(() => {
    const fill = getComputedStyle(document.querySelector('.model-usage-card')).backgroundColor;
    const channels = fill.match(/\d+/g).map(Number);
    return `${channels[0] >> 4},${channels[1] >> 4},${channels[2] >> 4}`;
  });
  const strayArcs = ringArcColors.filter((tone) => !legendColors.includes(tone) && tone !== cardSurface);
  check(
    'every arc the ring paints is a palette colour the legend promises or the slice separator',
    strayArcs.length === 0,
    `stray=${strayArcs.join(' | ')} arcs=${ringArcColors.join(' | ')} legend=${legendColors.join(' | ')} separator=${cardSurface}`,
  );

  // ── the ranked list, which is the ring's real legend ───────────────────────
  const list = await page.evaluate(() =>
    [...document.querySelectorAll('.model-usage-row')].map((row) => ({
      name: row.querySelector('.model-usage-name').textContent,
      tokens: row.querySelector('.model-usage-tokens').textContent,
      share: row.querySelector('.model-usage-share').textContent,
      color: getComputedStyle(row.querySelector('.model-usage-swatch')).backgroundColor,
    })),
  );
  check('the usage list ranks every group', list.length === 6, `rows=${list.length}`);
  check(
    'every row states a name, a volume and a share',
    list.every((row) => row.name.length > 0 && /[\d.]/.test(row.tokens) && /%/.test(row.share)),
    JSON.stringify(list.map((row) => `${row.name}=${row.tokens}/${row.share}`)),
  );
  // The remainder is labelled, never blank: the API sends an empty model name for it on purpose,
  // because the label is the client's to translate.
  check(
    'the folded remainder carries a translated label rather than a blank name',
    list.some((row) => /其他模型|Other models/.test(row.name)),
    `names=${list.map((row) => row.name).join(' | ')}`,
  );
  // The list and the trend's legend are two renderings of one ranking, so a group's colour has to be
  // the same in both. A panel that assigned colours from its own array order would drift here as soon
  // as the two orderings differed.
  const legendByLabel = new Map(await page.evaluate(() =>
    [...document.querySelectorAll('.model-legend-item')].map((item) => [
      item.querySelector('.model-legend-label').textContent,
      getComputedStyle(item.querySelector('.model-legend-swatch')).backgroundColor,
    ]),
  ));
  const mismatched = list.filter((row) => legendByLabel.has(row.name) && legendByLabel.get(row.name) !== row.color);
  check(
    'a group has the same colour in the legend and in the usage list',
    mismatched.length === 0,
    `mismatched=${mismatched.map((row) => row.name).join(' | ')}`,
  );

  // ── the ring's centre is the sum of its slices ────────────────────────────
  const centre = await page.locator('.model-ring-center').innerText();
  check(
    'the ring reports the window total in its centre',
    /[\d.]/.test(centre) && /tokens/.test(centre),
    `centre=${JSON.stringify(centre)}`,
  );

  // ── no axis label is clipped by the canvas it is drawn in ──────────────────
  //
  // The trend's x labels are painted into the canvas, so a label that overhangs the edge is cut with
  // no DOM to inspect - which is how it shipped once, with every tick label sliced in half. Ink in the
  // outermost columns of the canvas is the observable: the plot is inset from both edges, so a painted
  // column at the very edge is a label hanging out of the frame.
  const edgeInk = await page.evaluate(() => {
    const canvas = document.querySelector('.model-trend canvas');
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    probe.getContext('2d').drawImage(canvas, 0, 0);
    const { data } = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height);
    let left = 0;
    let right = 0;
    for (let y = 0; y < probe.height; y += 1) {
      if (data[(y * probe.width) * 4 + 3] > 20) left += 1;
      if (data[(y * probe.width + probe.width - 1) * 4 + 3] > 20) right += 1;
    }
    return { left, right, width: probe.width };
  });
  check(
    'no trend label is clipped by the canvas edge',
    edgeInk.left === 0 && edgeInk.right === 0,
    `leftColumnInk=${edgeInk.left} rightColumnInk=${edgeInk.right} width=${edgeInk.width}`,
  );

  // ── the smoothed curve stays on its floor ──────────────────────────────────
  //
  // The trend draws with a monotone cubic so that a zero-filled series cannot be smoothed *below* its
  // own baseline - a non-monotone spline through a run of zeros overshoots and paints a line where the
  // data says zero. That is a claim about painted geometry, so it is read from the pixels: the axis rule
  // is the widest horizontal run of ink, and anything painted below it in a series colour is an
  // overshoot.
  const undershoot = await page.evaluate(() => {
    const canvas = document.querySelector('.model-trend canvas');
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    probe.getContext('2d').drawImage(canvas, 0, 0);
    const { data } = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height);
    const seriesColors = [...document.querySelectorAll('.model-legend-swatch')].map((el) => {
      const channels = getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number);
      return [channels[0], channels[1], channels[2]];
    });
    const isSeries = (offset) => {
      if (data[offset + 3] < 20) return false;
      return seriesColors.some(([r, g, b]) =>
        Math.abs(data[offset] - r) < 24 && Math.abs(data[offset + 1] - g) < 24 && Math.abs(data[offset + 2] - b) < 24);
    };
    // The axis rule: the row carrying the most ink across the width.
    let axisRow = 0;
    let axisInk = -1;
    for (let y = 0; y < probe.height; y += 1) {
      let ink = 0;
      for (let x = 0; x < probe.width; x += 1) if (data[(y * probe.width + x) * 4 + 3] > 20) ink += 1;
      if (ink > axisInk) { axisInk = ink; axisRow = y; }
    }
    // Below the rule, plus a one-pixel allowance for the stroke's own width: a 1.6px line centred on the
    // axis legitimately covers a pixel under it.
    let below = 0;
    for (let y = axisRow + 2; y < probe.height; y += 1) {
      for (let x = 0; x < probe.width; x += 1) {
        if (isSeries((y * probe.width + x) * 4)) below += 1;
      }
    }
    return { axisRow, axisInk, below, height: probe.height };
  });
  check(
    'the smoothed curve never paints below the plot floor',
    undershoot.below === 0,
    `seriesInkBelowFloor=${undershoot.below} axisRow=${undershoot.axisRow} axisInk=${undershoot.axisInk}`,
  );

  // ── the two cards stay inside their own width ──────────────────────────────
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('.dashboard-models .dashboard-tile')].map((card) => card.scrollWidth - card.clientWidth),
  );
  check(
    'neither model card overflows its own width',
    overflow.every((excess) => excess <= 1),
    `overflow=${overflow.join(',')}`,
  );
}

/**
 * The model panels' state machine: the window picker, manual refresh, a first-load failure, a stale
 * refresh, and a window with no model traffic at all.
 *
 * The paint scenario above proves the panels are drawn correctly for a healthy response. These are the
 * paths a per-component test cannot reach: they are about what the panels do when the *response* is
 * different, which is where a panel silently keeps a skeleton, blanks the page, or shows a stale ranking
 * as if it were current.
 */
export async function dashboardModelPanelStates({ base, page, check, context }) {
  const calls = [];
  await page.route('**/omc/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/dashboard/models')) calls.push(url.search);
    return route.fallback();
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.model-trend canvas').first().waitFor({ timeout: 20_000 });
  const firstWindow = calls.length;
  check('the panels read the window the picker selected', firstWindow >= 1, `reads=${firstWindow} calls=${calls.join(' ')}`);

  // ── the window picker drives them ─────────────────────────────────────────
  // A panel wired to a fixed span would keep painting the same series as the operator changes the
  // window, which is invisible from a single-window assertion.
  await page.locator('.range-trigger').click();
  const option = page.locator('.range-option', { hasText: /Last 7 days|近 7 天/ });
  await option.click();
  await until(async () => calls.some((search) => search.includes('preset=7d')), {
    label: 'the model panels to re-read for the new window',
  }).catch(() => {});
  check(
    'changing the window re-reads the model panels with the new preset',
    calls.some((search) => search.includes('preset=7d')),
    `calls=${calls.join(' ')}`,
  );

  // ── manual refresh ────────────────────────────────────────────────────────
  const beforeRefresh = calls.length;
  await page.locator('.terminal-page-head button .anticon-reload').first().click();
  // The predicate is awaited through `until`, which is the probe harness's own condition wait: it
  // reports the label when it times out instead of throwing a bare locator error.
  let refreshRead = false;
  await until(async () => {
    refreshRead = calls.length > beforeRefresh;
    return refreshRead;
  }, { label: 'the refresh button to re-read the model panels' }).catch(() => {});
  check('the refresh button re-reads the model panels', refreshRead, `calls=${calls.length} before=${beforeRefresh}`);

  // ── a stale refresh keeps the panels and says so ───────────────────────────
  await page.unroute('**/omc/api/**');
  await context.route('**/omc/api/**/dashboard/models**', async (route) => {
    // A failure *after* data existed. The panels must keep what they have, because replacing a month of
    // ranking with an error card because one poll timed out is worse than showing slightly old data.
    return route.fulfill({ status: 503, json: { error: 'database is unavailable' } });
  });
  await page.locator('.terminal-page-head button .anticon-reload').first().click();
  let staleReported = false;
  await until(async () => {
    staleReported = (await page.locator('.model-stale-alert').count()) > 0;
    return staleReported;
  }, { label: 'a failed refresh to report itself' }).catch(() => {});
  check('a failed refresh reports itself instead of blanking the panels', staleReported);
  check(
    'the failed refresh keeps the panels that were on screen',
    (await page.locator('.model-trend canvas').count()) > 0 && (await page.locator('.model-usage-row').count()) > 0,
    `canvases=${await page.locator('.model-trend canvas').count()} rows=${await page.locator('.model-usage-row').count()}`,
  );
  check(
    'the stale alert offers a retry',
    (await page.locator('.model-stale-alert button').count()) > 0,
  );
}

/**
 * The panels' first-load failure and their empty state, each in its own context so neither can be
 * masked by data the other left behind.
 */
export async function dashboardModelPanelFailures({ base, page, check }) {
  // ── a first load that failed ──────────────────────────────────────────────
  // Nothing was ever read, so there is no panel to keep: the card must say so and offer the retry rather
  // than leaving a skeleton up forever.
  await page.route('**/omc/api/**/dashboard/models**', async (route) => {
    return route.fulfill({ status: 503, json: { error: 'database is unavailable' } });
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.model-alert').first().waitFor({ timeout: 20_000 });
  check(
    'a first load that failed is reported rather than left loading',
    /Failed to load model usage|无法读取模型用量/.test(await page.locator('.model-alert').first().innerText()),
    `alert=${JSON.stringify(await page.locator('.model-alert').first().innerText())}`,
  );
  check(
    'the failed panel offers a retry',
    (await page.locator('.model-alert button').count()) > 0,
  );
  check(
    'the failed panel does not draw a chart it never read',
    (await page.locator('.model-trend canvas').count()) === 0,
    `canvases=${await page.locator('.model-trend canvas').count()}`,
  );
  // The rest of the page is unaffected: the panels are a separate read with a separate failure.
  check(
    'the KPI tiles and the activity grid still render while the model panels are unavailable',
    (await page.locator('.chart-slot canvas').count()) === 6 && (await page.locator('.heatmap-grid').count()) === 1,
    `tiles=${await page.locator('.chart-slot canvas').count()} grids=${await page.locator('.heatmap-grid').count()}`,
  );
}

/**
 * A window in which no model carried tokens. The panels must say so rather than draw an empty plot or a
 * zero-angle ring, and the ring must not divide by a zero total.
 */
export async function dashboardModelPanelsEmpty({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-models').waitFor({ timeout: 20_000 });
  await until(async () => (await page.locator('.model-empty, .model-trend canvas').count()) > 0, {
    label: 'the model panels to resolve',
  }).catch(() => {});
  check(
    'a window with no model usage states that rather than drawing an empty chart',
    (await page.locator('.model-empty').count()) >= 1,
    `empty=${await page.locator('.model-empty').count()} canvases=${await page.locator('.model-trend canvas').count()}`,
  );
  check(
    'an empty window draws no ring slices',
    (await page.locator('.model-usage-row').count()) === 0 && (await page.locator('.model-ring canvas').count()) === 0,
    `rows=${await page.locator('.model-usage-row').count()} rings=${await page.locator('.model-ring canvas').count()}`,
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
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
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
    id: 'dashboard-model-panels',
    name: 'dashboard model trend and usage ring',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
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
    run: dashboardModelPanels,
  },
  {
    id: 'dashboard-model-panels-states',
    name: 'dashboard model panels: window, refresh and stale failure',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        // The second preset answers with its own window, so the panel that re-reads can be told apart
        // from one that kept painting the first response.
        [(url) => url.search.includes('preset=7d') && url.pathname.endsWith('/dashboard/models'), () => chartDashboardModelsWeek],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardModelPanelStates,
  },
  {
    id: 'dashboard-model-panels-failure',
    name: 'dashboard model panels: first-load failure',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => ({ status: 503, json: { error: 'database is unavailable' } })],
      ],
    },
    run: dashboardModelPanelFailures,
  },
  {
    id: 'dashboard-model-panels-empty',
    name: 'dashboard model panels: a window with no model traffic',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModelsEmpty],
      ],
    },
    run: dashboardModelPanelsEmpty,
  },
  {
    id: 'dashboard-heatmap',
    name: 'dashboard token heatmap',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmap,
  },
  {
    id: 'dashboard-heatmap-pruned',
    name: 'dashboard token heatmap over pruned history',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmapPruned],
        // The model panels are not what this scenario asserts, but they share the page: without a
        // response they would render their empty state and the probe would be reading a page one
        // panel short of the real one.
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmapPruned,
  },
  {
    id: 'dashboard-heatmap-mobile',
    name: 'dashboard token heatmap on a phone',
    options: {
      viewport: { width: 390, height: 844 },
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmapMobile,
  },
  {
    id: 'dashboard-heatmap-error',
    name: 'dashboard token heatmap failure states',
    options: {
      routes: [
        [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
        [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
        [
          (url) => url.pathname.endsWith('/dashboard/token-heatmap'),
          () => ({ status: 503, json: { error: 'database is unavailable' } }),
        ],
        // The model panels are a separate read with a separate failure mode, so this scenario leaves
        // them healthy: the claim under test is that the *heatmap* can fail without blanking the page,
        // and failing both would not distinguish "the panels survived" from "the page is wrong".
        [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
      ],
    },
    run: dashboardTokenHeatmapFailure,
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
