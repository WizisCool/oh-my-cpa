import { expect } from '@playwright/test';
import { settleLayout, until } from '../harness.mjs';
/**
 * Probes for the Insights page: what only a laid-out, painted page can show.
 *
 * The pivot itself - filters, rankings, folding, the comparison - is the logic suite's claim
 * (`scripts/test-insights-cube.ts`) and the page's wiring is the component suite's. Here: the
 * tiles stand in one row, the trend's marks are painted in the theme's series tokens in both
 * modes, a drag across the trend commits a custom window, a ranked row narrows the URL, and a
 * phone gets the rankings without the flow figure and without a sideways scroll.
 */

const DAY_MS = 86_400_000;
const TODAY = Date.UTC(2026, 9, 21);
const BUCKETS = Array.from({ length: 7 }, (_, index) => TODAY - (6 - index) * DAY_MS);
const COLUMNS = [
  'bucket', 'key', 'call_point', 'model', 'provider', 'credential',
  'requests', 'failures', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'latency_sum_ms', 'ttft_sum_ms',
  'ttft_count', 'cost_nanos', 'priced_requests', 'costed_requests',
];

function cubeRow(bucket, key, model, provider, requests) {
  const tokens = requests * 1000;
  const failures = (bucket + model) % 4 === 0 ? Math.max(1, Math.floor(requests / 8)) : 0;
  const cacheRead = Math.floor(tokens * (0.12 + ((bucket + model) % 6) * 0.11));
  return [bucket, key, model, model, provider, provider, requests, failures, tokens * 0.8, tokens * 0.2, 0, 0, cacheRead, 0, tokens,
    requests * (620 + bucket * 80 + model * 210), 0, 0, requests * 2_000_000, requests, requests];
}

const ROWS = BUCKETS.flatMap((_, bucket) => [
  cubeRow(bucket, 0, 0, 0, 20 + bucket * 3),
  cubeRow(bucket, 1, 1, 1, 12 + (bucket % 3) * 4),
  cubeRow(bucket, 2, 2, 1, 6 + bucket),
  cubeRow(bucket, 0, 1, 1, 4),
]);

const CUBE = {
  window: { preset: '7d', from: BUCKETS[0], to: TODAY + DAY_MS - 1, open_end: true, bucket: 'day', timezone: 'UTC', widened: false },
  compare_window: { from: BUCKETS[0] - 7 * DAY_MS, to: BUCKETS[0] - 1 },
  bucket_starts: BUCKETS,
  dims: {
    keys: [
      { id: 'hmac:design', alias: 'design-team', mask: 'sk-…d3s1', is_client_key: true },
      { id: 'hmac:ci', alias: 'ci-pipelines', mask: 'sk-…c1c1', is_client_key: true },
      { id: 'hmac:laptop', mask: 'sk-…l4p7', is_client_key: true },
    ],
    call_points: ['gpt-5', 'claude-sonnet', 'glm-flash'],
    models: ['gpt-5', 'claude-sonnet', 'glm-flash'],
    providers: ['codex', 'claude'],
    credentials: [{ auth_index: 'a1', auth_type: 'oauth' }, { auth_index: 'a2', auth_type: 'oauth' }],
  },
  columns: COLUMNS,
  rows: ROWS,
  previous_rows: [cubeRow(0, 0, 0, 0, 100).slice(1), cubeRow(0, 1, 1, 1, 60).slice(1)],
  coverage: { fact_requests: 400, detail_requests: 0 },
};

const RHYTHM = {
  window: CUBE.window,
  cells: Array.from({ length: 168 }, (_, index) => ({
    weekday: Math.floor(index / 24), hour: index % 24,
    requests: index % 24 >= 9 && index % 24 <= 18 ? 4 + (index % 5) : 0, total_tokens: 0, cost_nanos: 0,
  })),
};

export function insightsFixtures() {
  return [
    [(url) => url.pathname.endsWith('/management/insights/cube'), () => CUBE],
    [(url) => url.pathname.endsWith('/management/insights/rhythm'), () => RHYTHM],
  ];
}

/**
 * A latency line's most isolated segment. Moving along a painted line is the interaction under test;
 * choosing the segment furthest from every other line keeps another series' hit area out of it.
 */
async function readLatencyTargets(page) {
  return page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const host = document.querySelector('[data-testid="insights-trend-chart"]');
    const instance = echarts.getInstanceByDom(host);
    const box = host.getBoundingClientRect();
    const option = instance.getOption();
    const valueAt = (series, index) => {
      const item = series.data[index];
      return item && typeof item === 'object' ? item.value : item;
    };
    const pixelAt = (seriesIndex, index) => {
      const value = valueAt(option.series[seriesIndex], index);
      if (value === null || value === undefined) return undefined;
      return {
        x: box.x + instance.convertToPixel({ xAxisIndex: 0 }, index),
        y: box.y + instance.convertToPixel({ yAxisIndex: 0 }, value),
      };
    };
    let best;
    option.series.forEach((series, seriesIndex) => {
      if (series.name === 'Total') return;
      for (let index = 0; index < series.data.length - 1; index += 1) {
        const left = pixelAt(seriesIndex, index);
        const right = pixelAt(seriesIndex, index + 1);
        if (!left || !right) continue;
        const middle = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
        const clearance = Math.min(...option.series.flatMap((other, otherIndex) => {
          if (otherIndex === seriesIndex) return [];
          const a = pixelAt(otherIndex, index);
          const b = pixelAt(otherIndex, index + 1);
          return a && b ? [Math.abs(middle.y - (a.y + b.y) / 2)] : [];
        }));
        if (!best || clearance > best.clearance) {
          best = {
            clearance,
            seriesName: series.name,
            line: [0.22, 0.48, 0.74].map((t) => ({
              x: left.x + (right.x - left.x) * t,
              y: left.y + (right.y - left.y) * t,
            })),
            point: right,
            background: { x: middle.x, y: box.y + box.height * 0.86 },
            groupNames: option.series.filter((item) => item.name !== 'Total').map((item) => item.name),
          };
        }
      }
    });
    return best;
  });
}

/** Records the stored window as the page writes it, and serves it back on the next read. */
async function recordRangeWrites(page) {
  const writes = [];
  await page.route('**/omc/api/**/preferences/insights_range', async (route) => {
    if (route.request().method() === 'PUT') writes.push(JSON.parse(route.request().postData()));
    return route.fallback();
  });
  return writes;
}

/** The trend's painted fills, and the series tokens they must be, both resolved to rgb(). */
function readTrendPaint(page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    document.body.append(probe);
    const resolve = (value) => { probe.style.color = ''; probe.style.color = value; return getComputedStyle(probe).color; };
    const root = getComputedStyle(document.documentElement);
    const tokens = [1, 2, 3].map((slot) => resolve(root.getPropertyValue(`--series-${slot}`).trim()));
    const fills = [...document.querySelectorAll('[data-testid="insights-trend-chart"] svg path')]
      .map((path) => path.getAttribute('fill'))
      .filter((fill) => fill && fill !== 'none' && !fill.startsWith('url'))
      .map(resolve);
    probe.remove();
    return { tokens, fills: [...new Set(fills)] };
  });
}

async function readSeriesNames(page) {
  return page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const instance = echarts.getInstanceByDom(document.querySelector('[data-testid="insights-trend-chart"]'));
    return instance.getOption().series.filter(Boolean).map((series) => series.name);
  });
}

async function openInsights(page, base) {
  await page.goto(`${base}/insights?group=key`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('insights-tiles').waitFor({ state: 'visible' });
  await page.locator('[data-testid="insights-trend-chart"] svg path').first().waitFor({ state: 'attached', timeout: 20_000 });
  await settleLayout(page);
}

export async function insights({ base, page, check }) {
  const writes = await recordRangeWrites(page);
  await openInsights(page, base);

  const tops = await page.locator('[data-testid^="insights-tile-"]').evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)));
  check('the four metric tiles stand in one row on a desktop', tops.length === 4 && new Set(tops).size === 1, JSON.stringify(tops));
  check('the retired cache-rate and success-rate metrics have no tiles', await page.getByTestId('insights-tile-cache_rate').count() === 0 && await page.getByTestId('insights-tile-success_rate').count() === 0);

  for (const mode of ['dark', 'light']) {
    await page.evaluate((theme) => localStorage.setItem('omc-theme', JSON.stringify({ mode: theme, dirty: true })), mode);
    await openInsights(page, base);
    // The three keys are the three top groups, so their bars carry the first three series tokens.
    const paint = await until(async () => {
      const read = await readTrendPaint(page);
      return read.tokens.every((token) => read.fills.includes(token)) ? read : undefined;
    }, { label: 'insights', timeoutMs: 5_000 }).catch(() => readTrendPaint(page));
    check(`the trend paints its groups in the ${mode} theme's series tokens`, paint.tokens.every((token) => paint.fills.includes(token)), JSON.stringify(paint));
  }

  const targets = await page.getByTestId('insights-trend-chart').evaluate((chart) => {
    const swatch = document.createElement('span');
    swatch.style.color = getComputedStyle(document.documentElement).getPropertyValue('--series-1');
    document.body.append(swatch);
    const color = getComputedStyle(swatch).color;
    swatch.remove();
    const bars = [...chart.querySelectorAll('svg path')]
      .filter((path) => getComputedStyle(path).fill === color)
      .map((path) => path.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .sort((left, right) => left.x - right.x);
    const box = chart.getBoundingClientRect();
    return {
      background: { x: bars[0].x + bars[0].width / 2, y: box.y + box.height * 0.15 },
      segments: bars.slice(0, 2).map((bar) => ({ x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 })),
    };
  });
  const tip = page.locator('.omc-insights-trend-tip');
  await page.mouse.move(targets.background.x, targets.background.y);
  await expect(tip.locator('.omc-tip-name')).toHaveText(['design-team', 'ci-pipelines', 'sk-…l4p7', 'Total']);
  await page.mouse.move(targets.segments[0].x, targets.segments[0].y);
  await expect(tip.locator('.omc-tip-name')).toHaveText(['design-team', 'Total']);
  const tipBox = await tip.boundingBox();
  check('the tooltip lets the plot receive pointer events underneath it', await page.evaluate(({ x, y }) => {
    return !document.elementFromPoint(x, y)?.closest('.omc-insights-trend-tip');
  }, { x: tipBox.x + tipBox.width / 2, y: tipBox.y + tipBox.height / 2 }));
  await expect(tip.locator('.omc-tip-time')).toHaveText('2026-10-15');
  await page.mouse.move(targets.segments[1].x, targets.segments[1].y);
  await expect(tip.locator('.omc-tip-name')).toHaveText(['design-team', 'Total']);
  await expect(tip.locator('.omc-tip-time')).toHaveText('2026-10-16');
  await page.mouse.move(targets.background.x, targets.background.y);
  await expect(tip.locator('.omc-tip-name')).toHaveText(['design-team', 'ci-pipelines', 'sk-…l4p7', 'Total']);

  // A painted bar pins its series; an empty plot click returns the default stack.
  await page.mouse.move(targets.segments[0].x, targets.segments[0].y);
  await page.mouse.click(targets.segments[0].x, targets.segments[0].y);
  await until(async () => (await readSeriesNames(page)).join() === 'design-team', { label: 'insights bar selection', timeoutMs: 5_000 });
  const selectedLegend = page.getByTestId('insights-trend-legend').locator('button[aria-pressed="true"]');
  await expect(selectedLegend).toHaveCount(1);
  const selectedFill = await until(async () => {
    const fill = await selectedLegend.evaluate((button) => {
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--selected-inset').trim();
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      const actual = getComputedStyle(button).backgroundColor;
      return actual === expected ? actual : undefined;
    });
    return fill;
  }, { label: 'insights selected legend fill', timeoutMs: 2_000 }).catch(() => undefined);
  check('a selected legend takes the theme selection fill', selectedFill !== undefined, selectedFill ?? 'not selected-inset');
  await page.mouse.click(targets.background.x, targets.background.y);
  await until(async () => (await readSeriesNames(page)).length === 3, { label: 'insights bar selection clear', timeoutMs: 5_000 });

  // A latency line carries two finer targets than the bucket background: the whole series and one point.
  // Moving along the painted line must not let the axis pointer take the tooltip back to every series.
  await page.getByTestId('insights-tile-latency').click();
  await expect(page.getByTestId('insights-legend-total')).toBeVisible();
  const latency = await readLatencyTargets(page);
  for (const at of latency.line) await page.mouse.move(at.x, at.y, { steps: 3 });
  await expect(tip.locator('.omc-tip-name')).toHaveText([latency.seriesName]);
  await page.mouse.move(latency.point.x, latency.point.y, { steps: 2 });
  await expect(tip.locator('.omc-tip-name')).toHaveText([latency.seriesName]);
  await page.mouse.move(latency.background.x, latency.background.y);
  await expect(tip.locator('.omc-tip-name')).toHaveText([...latency.groupNames, 'Total']);
  check('a latency line and its points keep the tooltip on that series until the pointer returns to the plot', true);

  await page.mouse.move(latency.point.x, latency.point.y);
  await page.mouse.click(latency.point.x, latency.point.y);
  await until(async () => (await readSeriesNames(page)).length === 2, { label: 'insights latency selection', timeoutMs: 5_000 });
  await page.mouse.click(latency.background.x, latency.background.y);
  await until(async () => (await readSeriesNames(page)).length === latency.groupNames.length + 1, { label: 'insights latency selection clear', timeoutMs: 5_000 });

  const legendButtons = page.getByTestId('insights-trend-legend').getByRole('button');
  await legendButtons.first().click();
  await expect(legendButtons.first()).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(latency.background.x, latency.background.y);
  await expect(tip.locator('.omc-tip-name')).toHaveCount(2);
  await expect(tip.locator('.omc-tip-name').last()).toHaveText('Total');
  await legendButtons.first().click();
  await expect(legendButtons.first()).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(latency.background.x, latency.background.y);
  await expect(tip.locator('.omc-tip-name')).toHaveText([...latency.groupNames, 'Total']);
  check('clicking a latency legend item isolates its line, and clearing the selection restores every line', true);
  await page.getByTestId('insights-tile-tokens').click();

  check('the flow figure is drawn on a desktop', await page.getByTestId('insights-flow-chart').locator('svg').count() === 1);

  const plot = await page.getByTestId('insights-trend-chart').boundingBox();
  const y = plot.y + plot.height * 0.5;
  await page.mouse.move(plot.x + plot.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.5, y, { steps: 6 });
  await page.mouse.move(plot.x + plot.width * 0.7, y, { steps: 6 });
  await page.mouse.up();
  const committed = await until(() => writes.find((write) => typeof write.from === 'number'), { label: 'insights', timeoutMs: 5_000 }).catch(() => undefined);
  check('dragging across the trend commits a custom window inside the shown one',
    Boolean(committed) && committed.from > CUBE.window.from && typeof committed.to === 'number' && committed.to < CUBE.window.to,
    JSON.stringify(writes));

  await openInsights(page, base);
  await page.getByTestId('insights-ranking-key').getByText('design-team').click();
  await until(() => new URL(page.url()).searchParams.getAll('key').includes('hmac:design'), { label: 'insights', timeoutMs: 5_000 }).catch(() => undefined);
  check('a ranked row narrows the page through the URL', new URL(page.url()).searchParams.getAll('key').join() === 'hmac:design', page.url());
  // A ranking reads every filter but its own: narrowing to one key keeps the other keys listed,
  // stepped back, so the reader sees the choice against what it was chosen from.
  const keyRows = await until(async () => {
    const read = await page.getByTestId('insights-ranking-key').locator('li').evaluateAll((items) => items.map((item) => ({
      isPressed: item.querySelector('[aria-pressed]')?.getAttribute('aria-pressed') === 'true',
      isDimmed: item.getAttribute('data-dimmed') === 'true',
    })));
    return read.filter((row) => row.isPressed).length === 1 ? read : undefined;
  }, { label: 'insights narrowed key ranking', timeoutMs: 5_000 });
  check('a narrowed ranking keeps its other rows, the chosen one pressed and the rest dimmed',
    keyRows.length > 1 && keyRows.every((row) => row.isPressed !== row.isDimmed), JSON.stringify(keyRows));
}

export async function insightsPhone({ base, page, check }) {
  await openInsights(page, base);
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    tileColumns: new Set([...document.querySelectorAll('[data-testid^="insights-tile-"]')].map((tile) => Math.round(tile.getBoundingClientRect().left))).size,
    flow: document.querySelectorAll('[data-testid="insights-flow-chart"]').length,
    rankings: document.querySelectorAll('[data-testid^="insights-ranking-"]').length,
  }));
  check('a phone has no sideways scroll on Insights', layout.overflow <= 0, `overflow=${layout.overflow}`);
  check('a phone keeps two tiles per row', layout.tileColumns === 2, `columns=${layout.tileColumns}`);
  check('a phone omits the flow figure and keeps the rankings', layout.flow === 0 && layout.rankings === 4, JSON.stringify(layout));
  check('a phone leaves the key table and the key by model matrix to the key ranking and its detail',
    await page.getByTestId('insights-keys').count() === 0 && await page.getByTestId('insights-matrix').count() === 0);
}
