import { fulfillFixture } from '../browser-guard.mjs';
import { until } from '../harness.mjs';
import { checkDashboardTooltipRows } from './dashboardCharts.mjs';

/** Painted SVG marks, DOM readings and the instance must agree on the same ranked response. */
export async function dashboardModelPanels({ base, page, check }) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await until(async () => await page.locator('.model-trend svg path').count() > 0 && await page.locator('.model-ring svg path').count() >= 6,
    { label: 'both model charts to paint', timeoutMs: 20_000 });
  const header = await page.locator('.model-usage-card').evaluate((card) => ({
    title: card.querySelector('.ant-card-head-title')?.textContent,
    hasToggle: Boolean(card.querySelector('.ant-card-head .model-view-toggle')),
  }));
  check('model usage is the header title beside its view control', header.title === 'Model usage' && header.hasToggle, JSON.stringify(header));
  const list = await page.locator('.model-usage-row').evaluateAll((rows) => rows.map((row) => {
    const cell = (name) => row.querySelector(`.model-usage-${name}`);
    const box = (name) => { const rect = cell(name).getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; };
    return { name: cell('name').textContent, tokens: cell('tokens').textContent, share: cell('share').textContent,
      cost: cell('cost').textContent, exact: cell('tokens').title, color: getComputedStyle(cell('swatch')).backgroundColor,
      swatch: box('swatch'), label: box('name'), spend: box('cost'), volume: box('tokens'), fraction: box('share'),
      width: row.getBoundingClientRect().width };
  }));
  const legend = await page.locator('[data-testid="model-trend-legend"] li').evaluateAll((rows) => rows.map((row) => ({
    name: row.querySelector('.model-series-text').textContent,
    color: getComputedStyle(row.querySelector('i')).backgroundColor,
  })));
  check('both DOM rankings show all six groups in the same colors', list.length === 6 && legend.length === 6 && list.every((row, index) => row.name === legend[index].name && row.color === legend[index].color), JSON.stringify({ list, legend }));
  const namedGroups = list.filter((row) => !/其他模型|Other models/.test(row.name)).length;
  const legendMarks = await page.locator('[data-testid="model-trend-legend"] .model-series-mark').count();
  const usageMarks = await page.locator('.model-usage-name-button .model-series-mark').count();
  check('both model rankings draw a maker mark for every named model', namedGroups === 5 && legendMarks === namedGroups && usageMarks === namedGroups,
    JSON.stringify({ namedGroups, legendMarks, usageMarks }));
  check('each group states name, cost, volume, share and an exact count', list.every((row) => row.name && row.cost.trim() && /[\d.]/.test(row.tokens) && /%/.test(row.share) && /^(\d{1,3}(,\d{3})+|\d{1,3}) tokens$/.test(row.exact)), JSON.stringify(list));
  check('the folded remainder has a translated label', list.some((row) => /其他模型|Other models/.test(row.name)));
  check('usage columns read name, cost, volume, share with a separate swatch', list.every((row) => row.label.left - row.swatch.right >= 6 && row.label.right <= row.spend.left && row.spend.right <= row.volume.left && row.volume.right <= row.fraction.left));
  check('numeric columns align down one full-width list', ['spend', 'volume', 'fraction'].every((name) => Math.max(...list.map((row) => row[name].left)) - Math.min(...list.map((row) => row[name].left)) <= 1) && new Set(list.map((row) => row.width)).size === 1);
  const paint = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const host = document.querySelector('.model-trend .omc-echart');
    const ring = document.querySelector('.model-ring .omc-echart');
    const trend = echarts.getInstanceByDom(host);
    const pie = echarts.getInstanceByDom(ring);
    const arcs = [...ring.querySelectorAll('svg path')].map((path) => path.getBBox());
    const ringWidth = Math.max(...arcs.map((arc) => arc.x + arc.width)) - Math.min(...arcs.map((arc) => arc.x));
    const option = trend.getOption();
    const paths = [...host.querySelectorAll('svg path')];
    const colors = option.series.map((series) => series.lineStyle.color);
    const lineBoxes = colors.map((color) => paths.filter((path) => path.getAttribute('stroke') === color).map((path) => ({ d: path.getAttribute('d'), bottom: path.getBBox().y + path.getBBox().height })));
    return { colors, names: option.series.map((series) => series.name), rgb: colors.map((color) => echarts.color.parse(color).slice(0, 3).join(',')), lineBoxes, ringWidth, frameWidth: ring.clientWidth, bottom: trend.getHeight() - option.grid[0].bottom,
      ringColors: [...ring.querySelectorAll('svg path')].map((path) => path.getAttribute('fill')).filter((color) => color && color !== 'none'),
      sliceColors: pie.getOption().series[0].data.map((item) => item.itemStyle.color) };
  });
  check('every trend group paints a distinct line', new Set(paint.colors).size === 6 && paint.lineBoxes.every((boxes) => boxes.some((box) => box.d?.length > 20)), JSON.stringify(paint));
  check('painted series preserve the DOM legend color assignment and draw rank one last', paint.names.every((name, index) => name === legend[legend.length - 1 - index].name && paint.rgb[index] === legend[legend.length - 1 - index].color.match(/\d+/g).slice(0, 3).join(',')), JSON.stringify(paint));
  check('every ring slice paints its assigned palette color', paint.sliceColors.every((color) => paint.ringColors.includes(color)) && paint.ringColors.every((color) => paint.sliceColors.includes(color)), JSON.stringify(paint));
  check('the ring preserves its drawing inset within the square frame', Math.abs(paint.ringWidth - (paint.frameWidth - 32) * 0.92) <= 2, JSON.stringify(paint));
  check('the smoothed trend stays above the zero floor', paint.lineBoxes.flat().every((box) => box.bottom <= paint.bottom + 1), JSON.stringify(paint));

  const widths = [1920, 1600, 1460, 1450, 1440, 1360, 1280, 1200, 1120, 1040, 900, 700, 500, 390];
  const layouts = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    // ResizeObserver sizes the SVG before ZRender commits its labels on the following frame.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.waitForFunction((width) => {
      const hasRefit = [...document.querySelectorAll('.omc-echart')].every((host) => Math.abs(Number(host.querySelector('svg')?.getAttribute('width')) - host.clientWidth) < 1);
      const frameBox = document.querySelector('.model-ring-frame').getBoundingClientRect();
      const svgBox = document.querySelector('.model-ring svg').getBoundingClientRect();
      if (innerWidth !== width || !hasRefit || Math.abs(frameBox.width - svgBox.width) >= 1 || Math.abs(frameBox.height - svgBox.height) >= 1) return false;
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const frame = box('.model-ring-frame');
      const svg = box('.model-ring svg');
      const total = box('.model-ring-total');
      const unit = box('.model-ring-unit');
      const list = document.querySelector('.model-usage-list');
      const card = box('.model-usage-card .ant-card-body');
      const trend = box('.model-trend');
      const labels = [...document.querySelectorAll('.model-trend svg text')].map((node) => node.getBoundingClientRect());
      return { width, frame: { width: frame.width, height: frame.height }, svg: { width: svg.width, height: svg.height },
        drift: Math.abs((total.left + total.right) / 2 - (frame.left + frame.right) / 2),
        verticalDrift: Math.abs((total.top + unit.bottom) / 2 - (frame.top + frame.bottom) / 2),
        insideHole: total.width < frame.width * 0.66 && unit.width < frame.width * 0.66 && unit.bottom - total.top < frame.height * 0.66,
        listOverflow: list.scrollWidth - list.clientWidth, pastCard: box('.model-usage-share').right - card.right,
        nameWidth: box('.model-usage-name').width,
        labelsInside: labels.every((label) => label.left >= trend.left - 1 && label.right <= trend.right + 1 && label.bottom <= trend.bottom + 1),
        pageOverflow: document.documentElement.scrollWidth - innerWidth };
    }, width);
    layouts.push(await layout.jsonValue());
  }
  check('model columns remain readable without card or page overflow across widths', layouts.every((entry) => entry.listOverflow <= 1 && entry.pastCard <= 1 && entry.nameWidth >= 140 && entry.pageOverflow <= 1), JSON.stringify(layouts));
  check('the ring SVG stays square and the DOM readout stays inside its hole', layouts.every((entry) => Math.abs(entry.frame.width - entry.frame.height) <= 1 && Math.abs(entry.svg.width - entry.svg.height) <= 1 && entry.drift <= 1 && entry.verticalDrift <= 1 && entry.insideHole), JSON.stringify(layouts));
  check('trend labels stay inside their plot container', layouts.every((entry) => entry.labelsInside), JSON.stringify(layouts));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.model-ring-frame').evaluate((frame) => frame.style.width = '180px');
  await page.waitForFunction(() => Math.abs(document.querySelector('.model-ring svg').getBoundingClientRect().width - 180) < 1);
  check('the ring refits its frame without a window resize', await page.locator('.model-ring svg').evaluate((svg) => Math.abs(svg.getBoundingClientRect().height - 180) < 1));
  await page.locator('.model-ring-frame').evaluate((frame) => frame.style.removeProperty('width'));

  const totalLabel = await page.locator('.model-ring').getAttribute('aria-label');
  const firstRow = page.locator('.model-usage-row').first();
  await firstRow.hover();
  check('hovering a ranked model name does not change the ring or its centre', (await page.locator('.model-ring').getAttribute('aria-label')) === totalLabel
    && await firstRow.locator('.model-usage-name-button').getAttribute('aria-pressed') === 'false');
  await page.locator('.model-ring').scrollIntoViewIfNeeded();
  const target = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const host = document.querySelector('.model-ring .omc-echart');
    const chart = echarts.getInstanceByDom(host);
    const data = chart.getOption().series[0].data;
    const angle = -Math.PI / 2 - Math.PI * data[0].value / data.reduce((sum, item) => sum + item.value, 0);
    const box = host.getBoundingClientRect();
    return { x: box.left + box.width / 2 + Math.cos(angle) * (box.width - 32) * 0.395,
      y: box.top + box.height / 2 + Math.sin(angle) * (box.height - 32) * 0.395 };
  });
  await page.mouse.move(target.x, target.y);
  await page.locator('.model-ring .omc-tip').waitFor({ state: 'visible' });
  check('hovering a slice reports its tooltip without pinning the centre', (await page.locator('.model-ring').getAttribute('aria-label')) === totalLabel);
  await checkDashboardTooltipRows({ page, check }, '.model-ring .omc-tip', 'Model usage ring', { hasNames: true, hasShares: true });
  await page.mouse.move(0, 0);
  await until(async () => await page.locator('.model-ring').getAttribute('aria-label') === totalLabel, { label: 'ring total restored after slice leave' });

  await firstRow.locator('.model-usage-name-button').click();
  await until(async () => (await page.locator('.model-ring').getAttribute('aria-label')).includes(list[0].name), { label: 'the usage name to focus one ring slice' });
  const focusedRing = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const data = echarts.getInstanceByDom(document.querySelector('.model-ring .omc-echart')).getOption().series[0].data;
    return { count: data.length, opacities: data.map((item) => item.itemStyle.opacity) };
  });
  check('clicking a usage name highlights its slice without hiding the other slices', focusedRing.count === 6
    && focusedRing.opacities.filter((opacity) => opacity === 1).length === 1
    && focusedRing.opacities.filter((opacity) => opacity < 1).length === 5
    && await firstRow.locator('.model-usage-name-button').getAttribute('aria-pressed') === 'true'
    && await page.locator('.model-ring-unit').innerText() === list[0].share, JSON.stringify(focusedRing));
  await firstRow.locator('.model-usage-name-button').click();
  await until(async () => await page.locator('.model-ring').getAttribute('aria-label') === totalLabel, { label: 'the usage selection to restore the centre' });
  const restoredRing = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const data = echarts.getInstanceByDom(document.querySelector('.model-ring .omc-echart')).getOption().series[0].data;
    return { count: data.length, opacities: data.map((item) => item.itemStyle.opacity) };
  });
  check('clearing the usage highlight restores every slice at full opacity', restoredRing.count === 6 && restoredRing.opacities.every((opacity) => opacity === 1)
    && await firstRow.locator('.model-usage-name-button').getAttribute('aria-pressed') === 'false', JSON.stringify(restoredRing));

  const selectedLegend = page.locator('[data-testid="model-trend-legend"] button').nth(1);
  await selectedLegend.hover();
  const hoveredTrend = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    return echarts.getInstanceByDom(document.querySelector('.model-trend .omc-echart')).getOption().series
      .map((series) => ({ width: series.lineStyle.width, opacity: series.lineStyle.opacity }));
  });
  check('hovering a trend legend entry does not highlight a line', hoveredTrend.every((series) => series.width === 1.75 && series.opacity === 1), JSON.stringify(hoveredTrend));
  await selectedLegend.click();
  await until(async () => await selectedLegend.getAttribute('aria-pressed') === 'true', { label: 'the trend legend to pin one line' });
  const focusedTrend = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const option = echarts.getInstanceByDom(document.querySelector('.model-trend .omc-echart')).getOption();
    return {
      count: option.series.length,
      lines: option.series.map((series) => ({ name: series.name, color: series.lineStyle.color, width: series.lineStyle.width, opacity: series.lineStyle.opacity })),
      label: document.querySelector('.model-trend .omc-echart').getAttribute('aria-label'),
    };
  });
  check('clicking a trend legend entry highlights one line while every line stays painted',
    focusedTrend.count === 6
      && focusedTrend.lines.filter((series) => series.width === 2.75 && series.opacity === 1).length === 1
      && focusedTrend.lines.filter((series) => series.opacity === 0.35).length === 5
      && focusedTrend.label === [...await page.locator('[data-testid="model-trend-legend"] button').allTextContents()].join(', '),
    JSON.stringify(focusedTrend));
  await page.locator('.model-trend').scrollIntoViewIfNeeded();
  const hoverSeries = focusedTrend.lines.find((series) => series.name !== legend[1].name);
  const capturePaintedTrend = () => page.evaluate(async (legendItems) => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const chart = echarts.getInstanceByDom(document.querySelector('.model-trend .omc-echart'));
    const names = chart.getOption().series.map((series) => series.name);
    const lines = chart.getZr().storage.getDisplayList().filter((element) => element.type === 'ec-polyline');
    const colorKey = (color) => echarts.color.parse(color).slice(0, 3).join(',');
    const colors = new Map(legendItems.map((item) => [item.name, colorKey(item.color)]));
    window.__omcTrendPaint = names.map((name) => {
      const line = lines.find((element) => colorKey(element.style.stroke) === colors.get(name));
      return { name, line };
    });
    const displayed = new Set(chart.getZr().storage.getDisplayList());
    return window.__omcTrendPaint.map(({ name, line }) => ({
      name, width: line?.style.lineWidth, opacity: line?.style.opacity, isDisplayed: Boolean(line && displayed.has(line)),
    }));
  }, legend);
  const readPaintedTrend = () => page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const displayed = new Set(echarts.getInstanceByDom(document.querySelector('.model-trend .omc-echart')).getZr().storage.getDisplayList());
    return window.__omcTrendPaint.map(({ name, line }) => ({
      name, width: line?.style.lineWidth, opacity: line?.style.opacity, isDisplayed: Boolean(line && displayed.has(line)),
    }));
  });
  const beforeHoverPaint = await capturePaintedTrend();
  const otherLineTarget = await page.evaluate((color) => {
    const path = [...document.querySelectorAll('.model-trend svg path')]
      .find((candidate) => candidate.getAttribute('stroke') === color && candidate.getTotalLength() > 20);
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f };
  }, hoverSeries.color);
  await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    window.__omcHoveredTrendSeries = null;
    echarts.getInstanceByDom(document.querySelector('.model-trend .omc-echart')).on('mouseover', (params) => {
      if (params.componentSubType === 'line' && params.seriesName) window.__omcHoveredTrendSeries = params.seriesName;
    });
  });
  await page.mouse.move(otherLineTarget.x, otherLineTarget.y);
  await until(() => page.evaluate(() => window.__omcHoveredTrendSeries ?? null), { label: 'a non-pinned trend line to receive the pointer' });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hoveredName = await page.evaluate(() => window.__omcHoveredTrendSeries);
  const duringHoverPaint = await readPaintedTrend();
  const beforePinned = beforeHoverPaint.find((series) => series.name === legend[1].name);
  const duringPinned = duringHoverPaint.find((series) => series.name === legend[1].name);
  const beforeHovered = beforeHoverPaint.find((series) => series.name === hoveredName);
  const duringHovered = duringHoverPaint.find((series) => series.name === hoveredName);
  const samePaint = (before, during) => before && during && before.width === during.width && before.opacity === during.opacity;
  const everyLineUnchanged = beforeHoverPaint.every((before) => {
    const during = duringHoverPaint.find((series) => series.name === before.name);
    return before.isDisplayed && during?.isDisplayed && samePaint(before, during);
  });
  check('hovering another trend line keeps the pinned highlight and faded context unchanged',
    hoveredName !== legend[1].name
      && beforeHoverPaint.length === 6 && duringHoverPaint.length === 6
      && everyLineUnchanged
      && samePaint(beforePinned, duringPinned) && samePaint(beforeHovered, duringHovered)
      && duringPinned?.width === 2.75 && duringPinned.opacity === 1
      && duringHovered?.width === 1.75 && duringHovered.opacity === 0.35
      && await page.locator('[data-testid="model-trend-legend"] button[aria-pressed="true"]').innerText() === legend[1].name,
  JSON.stringify({ hoveredName, beforeHoverPaint, duringHoverPaint }));
  await page.mouse.move(0, 0);
  const trendBox = await page.locator('.model-trend').boundingBox();
  await page.mouse.move(trendBox.x + trendBox.width / 2, trendBox.y + trendBox.height / 2);
  await page.locator('.model-trend .omc-tip').waitFor({ state: 'visible' });
  const selectedTooltip = await page.locator('.model-trend .omc-tip').evaluate((tip) => ({
    names: [...tip.querySelectorAll('.omc-tip-name')].map((name) => name.textContent),
    color: getComputedStyle(tip.querySelector('.omc-tip-swatch')).backgroundColor,
  }));
  check('the highlighted trend keeps the full tooltip ranking',
    selectedTooltip.names.length === 6 && selectedTooltip.names.includes(legend[1].name),
    JSON.stringify(selectedTooltip));
  await page.mouse.move(0, 0);
  await selectedLegend.click();
  await until(async () => await selectedLegend.getAttribute('aria-pressed') === 'false', { label: 'the trend highlight to clear' });
  const restoredTrend = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    return echarts.getInstanceByDom(document.querySelector('.model-trend .omc-echart')).getOption().series
      .map((series) => ({ width: series.lineStyle.width, opacity: series.lineStyle.opacity }));
  });
  check('clearing the trend highlight restores every line to its resting weight', restoredTrend.every((series) => series.width === 1.75 && series.opacity === 1), JSON.stringify(restoredTrend));
  const lineTarget = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const host = document.querySelector('.model-trend .omc-echart');
    const chart = echarts.getInstanceByDom(host);
    const series = chart.getOption().series[0];
    const values = series.data.map(Number);
    const dataIndex = values.indexOf(Math.max(...values));
    const point = chart.convertToPixel({ seriesIndex: 0 }, [dataIndex, values[dataIndex]]);
    const box = host.getBoundingClientRect();
    return { x: box.left + point[0], y: box.top + point[1] };
  });
  await page.mouse.click(lineTarget.x, lineTarget.y);
  await until(async () => await page.locator('[data-testid="model-trend-legend"] button[aria-pressed="true"]').count() === 1, {
    label: 'a painted trend line to pin its legend entry',
  });
  const lineFocus = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    return echarts.getInstanceByDom(document.querySelector('.model-trend .omc-echart')).getOption().series
      .map((series) => series.lineStyle.opacity);
  });
  check('clicking a painted trend line pins one legend entry without hiding the other lines', lineFocus.length === 6
    && lineFocus.filter((opacity) => opacity === 1).length === 1 && lineFocus.filter((opacity) => opacity < 1).length === 5,
  JSON.stringify(lineFocus));
  await page.locator('[data-testid="model-trend-legend"] button[aria-pressed="true"]').click();
  const surfaces = [];
  for (const theme of ['omc-light', 'omc-dark']) {
    await page.evaluate((theme) => localStorage.setItem('omc-theme', theme), theme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.model-trend svg path').first().waitFor({ state: 'attached', timeout: 20_000 });
    await page.locator('.model-trend').scrollIntoViewIfNeeded();
    const box = await page.locator('.model-trend').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await checkDashboardTooltipRows({ page, check }, '.model-trend .omc-tip', `${theme} trend`, { hasNames: true });
    const chrome = await page.evaluate(() => {
      const host = document.querySelector('.model-trend');
      const styles = getComputedStyle(host);
      const border = styles.getPropertyValue('--border').trim();
      const muted = styles.getPropertyValue('--muted').trim();
      const fg = styles.getPropertyValue('--fg-2').trim();
      const paths = [...host.querySelectorAll('svg path')];
      const labels = [...host.querySelectorAll('svg text')];
      return { grid: paths.filter((path) => path.getAttribute('stroke') === border).length,
        pointer: paths.some((path) => path.getAttribute('stroke') === muted),
        labels: labels.filter((label) => label.getAttribute('fill') === fg).length,
        text: labels.map((label) => label.textContent),
        surface: getComputedStyle(document.querySelector('.model-trend-card')).backgroundColor };
    });
    check(`${theme} paints grid, pointer and four readable axis labels in palette ink`, chrome.grid >= 3 && chrome.pointer && chrome.labels === 4, JSON.stringify(chrome));
    const tooltipRows = await page.locator('.model-trend .omc-tip-name').allTextContents();
    check(`${theme} trend tooltip keeps legend order including quiet groups`, JSON.stringify(tooltipRows) === JSON.stringify(legend.map((row) => row.name)), JSON.stringify(tooltipRows));
    surfaces.push(chrome.surface);
    await page.mouse.move(0, 0);
  }
  check('both theme passes paint different surfaces', surfaces[0] !== surfaces[1], JSON.stringify(surfaces));
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
  // Preference writes, so the toggle's persistence can be asserted rather than inferred from a
  // read that a warm cache legitimately skips.
  const preferenceWrites = [];
  await page.route('**/omc/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/dashboard/models')) calls.push(url.search);
    const preferenceMatch = url.pathname.match(/\/preferences\/([^/]+)$/);
    if (preferenceMatch && route.request().method() === 'PUT') {
      let value;
      try {
        value = JSON.parse(route.request().postData() ?? 'null');
      } catch {
        value = undefined;
      }
      preferenceWrites.push({ key: preferenceMatch[1], value });
    }
    return route.fallback();
  });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.model-trend svg').first().waitFor({ timeout: 20_000 });
  const firstWindow = calls.length;
  check('the panels read the window the picker selected', firstWindow >= 1, `reads=${firstWindow} calls=${calls.join(' ')}`);

  // ── the window picker drives them ─────────────────────────────────────────
  // A panel wired to a fixed span would keep painting the same series as the operator changes the
  // window, which is invisible from a single-window assertion.
  await page.locator('.range-trigger').click();
  const option = page.locator('.time-range-option', { hasText: /Last 7 days|近 7 天/ });
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

  // ── the grouping toggle re-reads with its own view ────────────────────────
  // The two groupings are two different rankings; a toggle that only re-labelled the existing series
  // would present upstream-model rows as call points. The request URL is the observable, and so is
  // the persisted write: the choice has to survive a reload like every other console preference.
  const beforeToggle = calls.length;
  const modelOption = page.locator('.model-usage-card .ant-segmented-item').filter({ hasText: /By requested model|按请求模型/ }).first();
  const callPointOption = page.locator('.model-usage-card .ant-segmented-item').filter({ hasText: /By call model|按调用模型|按呼叫模型/ }).first();
  // The thumb owns the selected CSS class during motion; the radio owns the actual value.
  const modelRadio = modelOption.getByRole('radio');
  const callPointRadio = callPointOption.getByRole('radio');
  await modelOption.click();
  let modelViewRead = false;
  await until(async () => {
    modelViewRead = calls.slice(beforeToggle).some((search) => !search.includes('group_by=call'));
    return modelViewRead;
  }, { label: 'the model panels to re-read in the upstream-model grouping' }).catch(() => {});
  check(
    'switching the grouping re-reads the panels without the call parameter',
    modelViewRead,
    `calls=${calls.join(' ')}`,
  );
  check(
    'switching the grouping persists the upstream-model view',
    preferenceWrites.some((entry) => entry.key === 'omc_models_view' && entry.value === 'model'),
    `writes=${JSON.stringify(preferenceWrites)}`,
  );
  // Switching back is a *view* change, not a re-read: react-query holds the call-grouped entry
  // from moments ago, so the switch repaints from cache rather than issuing another window scan.
  // The claims that matter are therefore the control's own state and the persisted write - a
  // reader who reloads must land back in the call view.
  await callPointOption.click();
  let callViewPersisted = false;
  await until(async () => {
    callViewPersisted = preferenceWrites.some((entry) => entry.key === 'omc_models_view' && entry.value === 'call');
    return callViewPersisted;
  }, { label: 'the call-point view to be persisted' }).catch(() => {});
  await until(() => callPointRadio.isChecked(), { label: 'the call-point radio to be selected' });
  check(
    'switching back selects the call-point view and persists it',
    await callPointRadio.isChecked() && !await modelRadio.isChecked() && callViewPersisted,
    `writes=${JSON.stringify(preferenceWrites)}`,
  );

  // Hold only this preference write until the optimistic selection has been observed. A timer
  // could refuse it before a busy runner sees the intermediate state, or outlive a fast render.
  const preferenceRoute = '**/omc/api/**/preferences/omc_models_view';
  let releasePreferenceWrite;
  const preferenceWriteGate = new Promise((resolve) => { releasePreferenceWrite = resolve; });
  let hasPreferenceWriteStarted = false;
  const refusePreferenceWrite = async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    hasPreferenceWriteStarted = true;
    await preferenceWriteGate;
    return fulfillFixture(route, { status: 500, json: { error: 'preference write refused' } });
  };
  // Page routes precede context routes, so the held response owns the request before the shared mock.
  await page.route(preferenceRoute, refusePreferenceWrite);
  try {
    const refusedResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/preferences/omc_models_view')
      && response.request().method() === 'PUT' && response.status() === 500);
    try {
      await modelOption.click();
      await until(() => hasPreferenceWriteStarted, { label: 'the model-view write to reach the held route' });
      await until(() => modelRadio.isChecked(), { label: 'the optimistic model-view radio while its write is held' });
      check('a write still in flight shows the operator\'s choice immediately',
        await modelRadio.isChecked() && !await callPointRadio.isChecked());
    } finally {
      releasePreferenceWrite();
    }
    await refusedResponse;
    await until(() => callPointRadio.isChecked(), { label: 'the control to fall back to the persisted view after the refusal' });
    check('a refused preference write falls the control back to the persisted view',
      await callPointRadio.isChecked() && !await modelRadio.isChecked());
  } finally {
    await page.unroute(preferenceRoute, refusePreferenceWrite);
  }

  // ── a stale refresh keeps the panels and says so ───────────────────────────
  await page.unroute('**/omc/api/**');
  await context.route('**/omc/api/**/dashboard/models**', async (route) => {
    // A failure *after* data existed. The panels must keep what they have, because replacing a month of
    // ranking with an error card because one poll timed out is worse than showing slightly old data.
    return fulfillFixture(route, { status: 503, json: { error: 'database is unavailable' } });
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
    (await page.locator('.model-trend svg').count()) > 0 && (await page.locator('.model-usage-row').count()) > 0,
    `svges=${await page.locator('.model-trend svg').count()} rows=${await page.locator('.model-usage-row').count()}`,
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
    return fulfillFixture(route, { status: 503, json: { error: 'database is unavailable' } });
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
    (await page.locator('.model-trend svg').count()) === 0,
    `svges=${await page.locator('.model-trend svg').count()}`,
  );
  // The independent KPI renderer is lazy and can settle after the failed model read.
  await until(async () => (await page.locator('.chart-slot svg').count()) === 6
    && (await page.locator('.heatmap-grid').count()) === 1, { label: 'independent dashboard visualizations rendered' });
  check(
    'the KPI tiles and the activity grid still render while the model panels are unavailable',
    (await page.locator('.chart-slot svg').count()) === 6 && (await page.locator('.heatmap-grid').count()) === 1,
    `tiles=${await page.locator('.chart-slot svg').count()} grids=${await page.locator('.heatmap-grid').count()}`,
  );
}

/**
 * A window in which no model carried tokens. The panels must say so rather than draw an empty plot or a
 * zero-angle ring, and the ring must not divide by a zero total.
 */
export async function dashboardModelPanelsEmpty({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.model-trend-card').waitFor({ timeout: 20_000 });
  await until(async () => (await page.locator('.model-empty, .model-trend svg').count()) > 0, {
    label: 'the model panels to resolve',
  }).catch(() => {});
  check(
    'a window with no model usage states that rather than drawing an empty chart',
    (await page.locator('.model-empty').count()) >= 1,
    `empty=${await page.locator('.model-empty').count()} svges=${await page.locator('.model-trend svg').count()}`,
  );
  check(
    'an empty window draws no ring slices',
    (await page.locator('.model-usage-row').count()) === 0 && (await page.locator('.model-ring svg').count()) === 0,
    `rows=${await page.locator('.model-usage-row').count()} rings=${await page.locator('.model-ring svg').count()}`,
  );
}

