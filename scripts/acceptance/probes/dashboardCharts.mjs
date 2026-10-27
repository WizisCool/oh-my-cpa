import { until } from '../harness.mjs';
import { chartDashboard, chartDashboardModels, chartTokenHeatmap } from './dashboardFixtures.mjs';
import { installRoutes } from '../probe.mjs';

/** Geometry belongs in Chromium: DOM text assertions cannot catch a value pushed away by auto margins. */
export async function checkDashboardTooltipRows({ page, check }, selector, label, { hasNames = false, hasShares = false } = {}) {
  const tip = typeof selector === 'string' ? page.locator(selector).first() : selector.first();
  await tip.waitFor({ state: 'visible' });
  const layout = await tip.evaluate((node) => {
    const readBox = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const readTextBox = (element) => {
      if (!element) return null;
      const range = document.createRange();
      range.selectNodeContents(element);
      return readBox(range);
    };
    const rows = [...node.querySelectorAll('.omc-tip-row')].map((row) => {
      const swatch = row.querySelector('.omc-tip-swatch');
      const name = row.querySelector('.omc-tip-name');
      const value = row.querySelector('.omc-tip-value');
      const share = row.querySelector('.omc-tip-share');
      return {
        swatch: readBox(swatch), name: readBox(name), value: readBox(value), share: readBox(share),
        valueText: readTextBox(value), shareText: readTextBox(share),
        exact: value?.getAttribute('title'), nameTitle: name?.getAttribute('title'), nameText: name?.textContent,
        valueColor: value && getComputedStyle(value).color,
        nameColor: name && getComputedStyle(name).color,
      };
    });
    const surface = node.closest('.omc-echart-tip');
    const surfaceStyle = getComputedStyle(surface);
    const probe = document.createElement('span');
    node.append(probe);
    const resolveColor = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
    const palette = { value: resolveColor('--fg-2'), name: resolveColor('--fg'), surface: resolveColor('--surface') };
    probe.remove();
    return { rows, palette, surface: { background: surfaceStyle.backgroundColor, opacity: surfaceStyle.opacity } };
  });
  const closeGap = (left, right) => Boolean(left && right) && Math.abs(right.left - left.right - 6) <= 1;
  check(`${label}: marker, name and value use compact six-pixel gutters`, layout.rows.length > 0 && layout.rows.every((row) =>
    row.swatch?.width === 8 && row.swatch?.height === 8 && row.value?.width > 0
    && (hasNames ? closeGap(row.swatch, row.name) && closeGap(row.name, row.value) : !row.name && closeGap(row.swatch, row.valueText))
    && (hasShares ? closeGap(row.value, row.shareText) : !row.share)), JSON.stringify(layout.rows));
  check(`${label}: row centers and numeric column edges align`, layout.rows.every((row) => {
    if (!row.swatch || !row.valueText || (hasNames && !row.name)) return false;
    const cells = [row.swatch, row.name, row.value, row.share].filter(Boolean);
    const centers = cells.map((cell) => (cell.top + cell.bottom) / 2);
    return Math.max(...centers) - Math.min(...centers) <= 1
      && Math.abs(row.swatch.left - layout.rows[0].swatch.left) <= 1
      && (!row.name || Math.abs(row.name.left - layout.rows[0].name.left) <= 1)
      && Math.abs(row.valueText.right - layout.rows[0].valueText.right) <= 1;
  }), JSON.stringify(layout.rows));
  check(`${label}: exact values and full names stay accessible`, layout.rows.every((row) => Boolean(row.exact)
    && (!hasNames || row.nameTitle === row.nameText)), JSON.stringify(layout.rows));
  check(`${label}: tooltip surface and text retain palette colors`, layout.surface.background === layout.palette.surface
    && layout.surface.opacity === '1' && layout.rows.every((row) => row.valueColor === layout.palette.value
      && (!hasNames || row.nameColor === layout.palette.name)), JSON.stringify(layout));
}

/**
 * Probes for the dashboard's charts: the marks the KPI tiles draw, the rolling
 * readouts they print, and the sweep a revision triggers.
 */

/** SVG geometry and ink prove the six marks are painted, not merely mounted. */
export async function dashboardChartMarks({ base, page, check }) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.__chartMountFrames = new WeakMap();
    let frame = 0;
    const tick = () => { frame++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const svg of node.matches('svg') ? [node] : node.querySelectorAll('svg')) window.__chartMountFrames.set(svg, frame);
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const partialCost = { ...chartDashboard, metrics: { ...chartDashboard.metrics, cost: 89.72, cost_source: 'partial' } };
  await page.route(/\/management\/dashboard(?:\/tail)?(?:\?|$)/, (route) => route.fulfill({ json: partialCost }));
  await page.route('**/pricing/attention', (route) => route.fulfill({ json: { unpriced: ['unpriced-model'] } }));
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await until(async () => await page.locator('.chart-slot svg path').count() >= 12,
    { label: 'six KPI lines and their areas', timeoutMs: 20_000 });
  const marks = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    const tones = ['--accent', '--accent', '--success', '--warn', '--muted', '--muted'];
    return [...document.querySelectorAll('.chart-slot')].map((slot, index) => {
      const host = slot.querySelector('.omc-echart');
      const instance = echarts.getInstanceByDom(host);
      const series = instance.getOption().series[0];
      const paths = [...host.querySelectorAll('svg path')];
      const line = paths.find((path) => path.getAttribute('stroke') === series.lineStyle.color);
      const area = paths.find((path) => path.getAttribute('fill')?.startsWith('url('));
      return { tone: getComputedStyle(slot).getPropertyValue(tones[index]).trim(), color: series.lineStyle.color,
        left: line?.getBBox().x ?? 0, bottom: (line?.getBBox().y ?? 0) + (line?.getBBox().height ?? 0),
        width: line?.getBBox().width ?? 0, height: line?.getBBox().height ?? 0, plotWidth: slot.clientWidth, plotHeight: slot.clientHeight,
        hasArea: Boolean(area), frame: window.__chartMountFrames.get(host.querySelector('svg')),
        path: line?.getAttribute('d') };
    });
  });
  check('all six KPI tiles paint a line and gradient area', marks.length === 6 && marks.every((mark) => mark.hasArea && mark.width > mark.plotWidth * 0.8 && mark.height > 0), JSON.stringify(marks));
  check('KPI drawings retain their inset instead of stretching into the card', marks.every((mark) => Math.abs(mark.left - 16) <= 1 && Math.abs(mark.width - (mark.plotWidth - 32)) <= 1 && mark.bottom <= mark.plotHeight - 15), JSON.stringify(marks));
  check('KPI marks use their semantic tones', marks.every((mark) => mark.color.toLowerCase() === mark.tone.toLowerCase()), JSON.stringify(marks));
  check('different KPI series paint different shapes', new Set(marks.map((mark) => mark.path)).size === 6);
  check('KPI chart creation yields a frame between mounts', marks.every((mark) => mark.frame !== undefined) && new Set(marks.map((mark) => mark.frame)).size === 6, JSON.stringify(marks.map((mark) => mark.frame)));
  await page.locator('[data-testid="dashboard-unpriced-link"]').waitFor();
  const alignment = await page.locator('.dashboard-grid > [data-widget-kind="metric"] > .dashboard-tile').evaluateAll((tiles) => {
    const rows = new Map();
    for (const tile of tiles) {
      const top = Math.round(tile.getBoundingClientRect().top);
      const bottom = tile.querySelector('.chart-slot').getBoundingClientRect().bottom;
      rows.set(top, [...(rows.get(top) ?? []), bottom]);
    }
    return [...rows.values()].every((bottoms) => Math.max(...bottoms) - Math.min(...bottoms) < 2);
  });
  check('same-row KPI plots share a baseline despite wrapped cost notes', alignment);
  for (let index = 0; index < 6; index++) {
    const slot = page.locator('.chart-slot').nth(index);
    const box = await slot.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const tip = slot.locator('.omc-tip');
    await tip.waitFor({ state: 'visible' });
    check(`KPI ${index + 1} tooltip states a real bucket`, /\d{2}-\d{2} \d{2}:\d{2}/.test(await tip.innerText()));
    const tipBox = await tip.boundingBox();
    if (index === 0) check('the KPI tooltip hugs its content', tipBox.width < box.width * 0.5);
    await checkDashboardTooltipRows({ page, check }, tip, `KPI ${index + 1}`);
  }
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    window.__kpiInstances = [...document.querySelectorAll('.chart-slot .omc-echart')].map((host) => echarts.getInstanceByDom(host));
    window.__kpiResizeCount = 0;
    for (const chart of window.__kpiInstances) {
      const resize = chart.resize;
      chart.resize = (...args) => { window.__kpiResizeCount++; return resize.apply(chart, args); };
    }
  });
  const answered = page.waitForResponse((response) => /\/management\/dashboard(?:\?|$)/.test(response.url()));
  await page.locator('.terminal-page-head button:has(.anticon-reload)').click();
  await answered;
  await until(async () => await page.locator('.terminal-page-head button:has(.anticon-reload)[aria-busy="false"]').count() === 1,
    { label: 'identical dashboard refresh to settle' });
  const unchanged = await page.evaluate(async () => {
    const { echarts } = await import('/omc/src/charts/echarts/core.ts');
    return { same: [...document.querySelectorAll('.chart-slot .omc-echart')].every((host, index) => echarts.getInstanceByDom(host) === window.__kpiInstances[index]), resized: window.__kpiResizeCount };
  });
  check('an identical refresh preserves chart instances without remeasurement', unchanged.same && unchanged.resized === 0, JSON.stringify(unchanged));
}

/**
 * A rolling readout's value, as the accessibility tree spells it.
 *
 * The digits live in the custom element's own shadow root, so the tile's `innerText` is empty; the
 * snapshot separates each glyph with a space, and removing those gives the reading back. Reading it
 * this way is also the stronger claim: an abbreviation that is only painted would announce as
 * nothing at all.
 */
async function accessibleReadout(host) {
  return (await host.ariaSnapshot()).replace(/^-\s*\w+:\s*/, '').replace(/\s+/g, '');
}

/**
 * The six KPI tiles' numbers: their formats, their sweep, and the two cases where it must not run.
 *
 * Four claims, none of which a component test can reach:
 *
 *   - Each tile prints *its own* format. The six share one component and five different formatters, so
 *     a tile wired to the wrong readout still renders a plausible number - and the numbers chosen
 *     here make that visible: a count with separators, a compact total, a rate, an abbreviation with
 *     two decimals, a percentage and an amount.
 *   - A value change sweeps, and every sweep finishes. Only an engine that allows motion can see
 *     this: `check:ui` and `verify:probes` create their pages with reduced motion, where the sweep is
 *     meant to be absent, so this scenario opens a second context that allows it.
 *   - A unit change prints in place. `31.8K -> 2.1M` is a change of *scale*: rolling 31.8 into 2.1
 *     while the unit word swaps underneath would show digits that never described the window.
 *   - A reader who asked for reduced motion gets the new value without the travel, which is the
 *     `prefers-reduced-motion` override §7 requires reaching the readout as well.
 */

export async function dashboardRollingReadouts({ base, page, context, check }) {
  const hosts = () => page.locator('.dashboard-tile .tile-value number-flow-react');
  const readings = async () => {
    const out = [];
    for (const host of await hosts().all()) out.push(await accessibleReadout(host));
    return out;
  };
  const refresh = () => page.locator('.terminal-page-head button:has(.anticon-reload)').click();
  const dashboardResponse = (target) =>
    target.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.includes('/omc/api/') && url.pathname.endsWith('/dashboard');
    });

  /** The dashboard fixture with the six tile readings replaced, so each case names what it changes. */
  const bodyWith = ({ requests, tokens, rpm, tpm, cacheRate, cost }) => {
    const body = JSON.parse(JSON.stringify(chartDashboard));
    body.requests.total = requests;
    body.requests.success = requests - 3;
    body.tokens.total = tokens;
    body.tokens.input = Math.round(tokens / 4);
    body.tokens.output = Math.round(tokens / 8);
    body.tokens.cache_read = Math.round(tokens / 12);
    body.metrics.rpm = rpm;
    body.metrics.tpm = tpm;
    body.metrics.cache_rate = cacheRate;
    body.metrics.cost = cost;
    return body;
  };
  /**
   * Serves the two dashboard endpoints from one body.
   *
   * `BrowserContext.route()` registers the handler locally and then tells the browser process to
   * intercept the pattern, so it is asynchronous: a caller that drives a refresh or a navigation
   * without awaiting it can have the request answered by the previous fixture while the new pattern
   * is still in flight. Every registration is therefore awaited, here and at the call sites.
   */
  const serveDashboard = async (target, body) => {
    // The API path, not the SPA route: `/omc/dashboard` is also the document URL, and a glob would
    // answer the page request with JSON.
    await target.route(
      (url) => url.pathname.includes('/omc/api/') && url.pathname.endsWith('/dashboard'),
      (route) => route.fulfill({ json: body }),
    );
    await target.route(
      (url) => url.pathname.includes('/omc/api/') && url.pathname.endsWith('/dashboard/tail'),
      (route) => route.fulfill({ json: body }),
    );
  };

  // ── one component, six formats ───────────────────────────────────────────────
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await hosts().first().waitFor({ timeout: 20_000 });
  const fixtureReadings = await readings();
  const expectedFixture = ['1,600', '31.8K', '12', '1.23K', '42.0%', '$0.00'];
  check(
    'every KPI tile prints its own format',
    JSON.stringify(fixtureReadings) === JSON.stringify(expectedFixture),
    JSON.stringify(fixtureReadings),
  );

  // ── reduced motion keeps the value and drops the travel ─────────────────────
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async () => {
    const { setReducedMotionPreference } = await import('/omc/src/utils/motionPreference.ts');
    setReducedMotionPreference('on');
  });
  // A same-unit change on purpose: nothing here may be attributed to the unit freeze, so the only
  // reason this frame can be still is the reader's own preference.
  await page.evaluate(() => {
    window.__readoutSweeps = 0;
    for (const host of document.querySelectorAll('.dashboard-tile .tile-value number-flow-react')) {
      host.addEventListener('animationsstart', () => { window.__readoutSweeps += 1; });
    }
  });
  await serveDashboard(context, bodyWith({ requests: 2_400, tokens: 45_200, rpm: 30, tpm: 2_400, cacheRate: 42, cost: 12.5 }));
  await refresh();
  const reducedArrival = await until(
    async () => (await readings())[1] === '45.2K',
    { label: 'the reduced-motion readouts to update' },
  ).then(() => true, () => false);
  const reducedReadings = await readings();
  const reducedSweeps = await page.evaluate(() => window.__readoutSweeps);
  check('a reduced-motion readout still updates', reducedArrival, JSON.stringify(reducedReadings));
  check(
    'a reduced-motion readout lands on its new reading',
    JSON.stringify(reducedReadings) === JSON.stringify(['2,400', '45.2K', '30', '2.4K', '42.0%', '$12.50']),
    JSON.stringify(reducedReadings),
  );
  check('a reduced-motion readout does not sweep', reducedSweeps === 0, `sweeps=${reducedSweeps}`);

  // ── motion allowed: what sweeps, and what must not ──────────────────────────
  const motionContext = await context.browser().newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    await motionContext.addInitScript(() => {
      localStorage.setItem('omc-theme', 'omc-light');
      localStorage.setItem('omc-lang', 'en');
    });
    // The scenario's own routes are installed per context, so the second context needs the same
    // fixtures before its two endpoints are overridden.
    await installRoutes(motionContext, [
      [(url) => url.pathname.endsWith('/dashboard'), () => chartDashboard],
      [(url) => url.pathname.endsWith('/dashboard/tail'), () => chartDashboard],
      [(url) => url.pathname.endsWith('/dashboard/token-heatmap'), () => chartTokenHeatmap],
      [(url) => url.pathname.endsWith('/dashboard/models'), () => chartDashboardModels],
    ]);
    await serveDashboard(motionContext, bodyWith({ requests: 1_600, tokens: 31_750, rpm: 12, tpm: 1_234, cacheRate: 42, cost: 12.5 }));
    const motionPage = await motionContext.newPage();
    await motionPage.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await motionPage.locator('.dashboard-tile .tile-value number-flow-react').first().waitFor({ timeout: 20_000 });
    await motionPage.evaluate(async () => {
      const { setReducedMotionPreference } = await import('/omc/src/utils/motionPreference.ts');
      setReducedMotionPreference('off');
    });
    await motionPage.evaluate(() => {
      window.__readoutEvents = { started: [], finished: [] };
      document.querySelectorAll('.dashboard-tile .tile-value number-flow-react').forEach((host, index) => {
        host.addEventListener('animationsstart', () => { window.__readoutEvents.started.push(index); });
        host.addEventListener('animationsfinish', () => { window.__readoutEvents.finished.push(index); });
      });
    });

    // Requests, RPM, TPM and cost stay inside their unit; the token total crosses from K to M, and
    // the cache rate does not change at all. Tile order is the grid's: requests, tokens, rpm, tpm,
    // cache, cost.
    const sweepBody = bodyWith({ requests: 14_400, tokens: 2_100_000, rpm: 108, tpm: 11_110, cacheRate: 42, cost: 112.5 });
    await serveDashboard(motionContext, sweepBody);
    const swept = dashboardResponse(motionPage);
    await motionPage.locator('.terminal-page-head button:has(.anticon-reload)').click();
    await swept;
    await until(
      async () => {
        const events = await motionPage.evaluate(() => window.__readoutEvents);
        return events.finished.length === 4;
      },
      { label: 'the sweeps to finish' },
    ).catch(() => {});
    const events = await motionPage.evaluate(() => window.__readoutEvents);
    const motionReadings = [];
    for (const host of await motionPage.locator('.dashboard-tile .tile-value number-flow-react').all()) {
      motionReadings.push(await accessibleReadout(host));
    }
    check(
      'a value change sweeps each readout that changed',
      JSON.stringify([...events.started].sort()) === JSON.stringify([0, 2, 3, 5]),
      JSON.stringify(events.started),
    );
    check(
      'the unit-change frame prints the token tile in place',
      !events.started.includes(1),
      JSON.stringify(events.started),
    );
    check(
      'an unchanged readout does not sweep',
      !events.started.includes(4),
      JSON.stringify(events.started),
    );
    check(
      'every sweep finishes',
      JSON.stringify([...events.finished].sort()) === JSON.stringify([0, 2, 3, 5]),
      JSON.stringify(events.finished),
    );
    check(
      'the swept readouts landed on the new values',
      JSON.stringify(motionReadings) === JSON.stringify(['14,400', '2.1M', '108', '11.11K', '42.0%', '$112.50']),
      JSON.stringify(motionReadings),
    );
  } finally {
    await motionContext.close().catch(() => {});
  }
}

/** Revisions morph in place; reduced motion swaps geometry without intermediate frames. */
export async function dashboardChartMotion({ base, page, context, check }) {
  const marks = [
    ['requests sparkline', '.chart-slot .omc-echart'],
    ['model token trend', '.model-trend .omc-echart'],
    ['model usage ring', '.model-ring-frame .omc-echart'],
  ];
  const bodies = { dashboard: chartDashboard, models: chartDashboardModels };
  await installRoutes(context, [
    [(url) => /\/management\/dashboard(?:\/tail)?$/.test(url.pathname), () => bodies.dashboard],
    [(url) => url.pathname.endsWith('/management/dashboard/models'), () => bodies.models],
    [(url) => url.pathname.endsWith('/management/dashboard/token-heatmap'), () => chartTokenHeatmap],
  ]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await until(async () => await page.locator('.omc-echart svg').count() === 8, { label: 'dashboard charts', timeoutMs: 20_000 });
  await page.evaluate(async () => { window.__echartsRuntime = (await import('/omc/src/charts/echarts/core.ts')).echarts; });
  await page.waitForFunction(() => [...document.querySelectorAll('.omc-echart')].every((host) => window.__echartsRuntime.getInstanceByDom(host)?.getZr().animation.isFinished()));
  const timing = await page.evaluate(() => [...document.querySelectorAll('.omc-echart')].flatMap((host) => {
    const chart = window.__echartsRuntime.getInstanceByDom(host);
    return chart.getModel().getSeries().map((series) => ({ type: series.subType,
      initial: series.get('animationDuration'), update: series.get('animationDurationUpdate'), hover: series.get(['stateAnimation', 'duration']) }));
  }));
  check('chart revisions and hover obey the console motion budgets', timing.every((item) => item.update === 240 && item.hover <= 120 && (item.type === 'pie' ? item.initial === 0 : item.initial <= 240)), JSON.stringify(timing));
  // The list can change its numeric width on a revision and resize the ring in a second layout.
  // Keep geometry fixed here; the model-panel scenario independently verifies container refitting.
  await page.locator('.model-ring-frame').evaluate((frame) => {
    frame.style.width = `${frame.getBoundingClientRect().width}px`;
    frame.style.maxWidth = 'none';
  });
  let revision = 0;
  for (const { preference, system, isReduced } of [
    { preference: 'system', system: 'no-preference', isReduced: false },
    { preference: 'on', system: 'no-preference', isReduced: true },
    { preference: 'off', system: 'reduce', isReduced: false },
  ]) {
    await page.emulateMedia({ reducedMotion: system });
    await page.evaluate(async preference => {
      const { setReducedMotionPreference } = await import('/omc/src/utils/motionPreference.ts');
      setReducedMotionPreference(preference);
    }, preference);
    await page.waitForFunction((reduced) => {
      const echarts = window.__echartsRuntime;
      return [...document.querySelectorAll('.omc-echart')].every((host) => echarts.getInstanceByDom(host)?.getOption().animation === !reduced);
    }, isReduced);
    for (const [name, selector] of marks) {
      revision++;
      bodies.dashboard = structuredClone(chartDashboard);
      bodies.dashboard.requests.series = bodies.dashboard.requests.series.map((point, index) => index === (revision % 2 ? 7 : 22) ? { ...point, v: 999_999 } : point);
      bodies.models = structuredClone(chartDashboardModels);
      const group = bodies.models.models[revision % bodies.models.models.length];
      group.tokens *= 3;
      group.series = group.series.map((point) => ({ ...point, tokens: point.tokens * 3 }));
      bodies.models.total_tokens = bodies.models.models.reduce((sum, item) => sum + item.tokens, 0);
      await page.evaluate(async (selector) => {
        const { echarts } = await import('/omc/src/charts/echarts/core.ts');
        const host = document.querySelector(selector);
        const instance = echarts.getInstanceByDom(host);
        const signature = () => [...host.querySelectorAll('svg path')].map((path) => path.getAttribute('d')).join('|');
        const sampler = { instance, host, signature, option: JSON.stringify(instance.getOption().series), samples: [signature()], running: true };
        window.__chartSampler = sampler;
        const tick = () => { sampler.samples.push(signature()); if (sampler.running) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }, selector);
      const answered = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/dashboard/models'));
      await page.locator('.terminal-page-head button:has(.anticon-reload)').click();
      await answered;
      await page.waitForFunction(() => {
        const sampler = window.__chartSampler;
        return JSON.stringify(sampler.instance.getOption().series) !== sampler.option && sampler.instance.getZr().animation.isFinished();
      });
      const measured = await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        const sampler = window.__chartSampler;
        sampler.running = false;
        sampler.samples.push(sampler.signature());
        const first = sampler.samples[0];
        const last = sampler.samples.at(-1);
        return { distinct: new Set(sampler.samples).size,
          intermediate: sampler.samples.filter((sample) => sample !== first && sample !== last).length,
          same: !sampler.instance.isDisposed() && sampler.host.isConnected };
      });
      check(`${name} keeps its instance across a revision`, measured.same);
      check(`${name} reaches its new reading${isReduced ? ' under reduced motion' : ''}`, measured.distinct >= 2, JSON.stringify(measured));
      check(`${name} ${isReduced ? 'paints no intermediate frame' : 'morphs through intermediate frames'}`, isReduced ? measured.intermediate === 0 : measured.intermediate > 0, JSON.stringify(measured));
    }
  }
  await page.evaluate(async () => {
    const { setReducedMotionPreference } = await import('/omc/src/utils/motionPreference.ts');
    setReducedMotionPreference('system');
  });
  await page.locator('.range-trigger').click();
  const popover = page.locator('.ant-popover:visible').first();
  await popover.waitFor({ state: 'visible' });
  const surface = await popover.evaluate((node) => ({ opacity: getComputedStyle(node).opacity, width: node.getBoundingClientRect().width }));
  check('a floating panel still arrives under reduced motion', surface.opacity === '1' && surface.width > 0, JSON.stringify(surface));
  await page.keyboard.press('Escape');
}
