import { until } from '../harness.mjs';
import { chartDashboard, chartDashboardModels, chartTokenHeatmap } from './dashboardFixtures.mjs';
import { installRoutes } from '../probe.mjs';

/**
 * Probes for the dashboard's charts: the marks the KPI tiles draw, the rolling
 * readouts they print, and the sweep a revision triggers.
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
  const motionContext = await context.browser().newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
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

/**
 * The three AntV marks sweep between two revisions, and paint no intermediate frame when the reader
 * asked for reduced motion.
 *
 * This is the one claim about chart motion that no per-component test can reach. A logic test can read
 * the `animate` spec a chart passes (`test-chart-marks`), but only an engine that allows motion can
 * show that the spec produces painted movement, and only one that refuses it can show the override
 * actually reaches the canvas - which matters because AntV has no reduced-motion handling of its own,
 * so the switch is ours and a regression in it would be invisible.
 *
 * The measurement reads the painted pixels once per animation frame rather than screenshotting from
 * Node: a 240ms sweep can end between two harness round trips, and a probe that misses it would fail
 * on a fast machine and pass on a slow one. Sampling inside the page observes the frames the browser
 * actually painted, so "there was an intermediate frame" is asserted rather than hoped for.
 */

export async function dashboardChartMotion({ base, page, context, check }) {
  /** The mark each panel paints into, which is what a canvas readout has to address. */
  const MARKS = [
    ['the requests sparkline', '.dashboard-tile .chart-slot canvas'],
    ['the model token trend', '.model-trend canvas'],
    ['the model usage ring', '.model-ring-frame canvas'],
  ];

  /**
   * Starts sampling one canvas's ink, one frame in two, and never two marks at once.
   *
   * The cost is a deliberate constraint rather than an optimisation. Reading a canvas means pulling
   * its pixels back out of the compositor, so three concurrent samplers at 60fps would move a few
   * hundred kilobytes a frame - and this scenario runs *concurrently* with the cross-stack acceptance
   * suite, whose own timing-sensitive reads are documented as failing under CPU contention. One
   * sampler at a time, every other frame, leaves the sweep plainly visible (240ms is around fourteen
   * frames) while keeping the probe's footprint off that suite's critical path.
   *
   * The whole canvas is read with a stride rather than a single row: a line whose values sit near its
   * baseline paints its ink in the lower few rows, so one row through the middle would find only
   * background and report that nothing moved.
   */
  const startSampler = (target, selector) =>
    target.evaluate((markSelector) => {
      const canvas = document.querySelector(markSelector);
      if (!canvas) return 'missing';
      const drawing = canvas.getContext('2d');
      if (!drawing) return 'not-a-2d-canvas';
      const sampler = { samples: [], running: true };
      window.__paintSampler = sampler;
      const signature = () => {
        const pixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
        let value = 0;
        for (let index = 0; index < pixels.length; index += 28) {
          value = (value * 31 + pixels[index] + pixels[index + 3]) % 2147483647;
        }
        return value;
      };
      let frame = 0;
      const tick = () => {
        if (frame % 2 === 0) sampler.samples.push(signature());
        frame += 1;
        if (sampler.running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 'sampling';
    }, selector);

  const stopSampler = (target) =>
    target.evaluate(() => {
      const sampler = window.__paintSampler;
      if (!sampler) return [];
      sampler.running = false;
      return sampler.samples;
    });

  /**
   * Summarises one mark's frames.
   *
   * `strays` is the claim this scenario exists for: frames that are neither the reading before the
   * revision nor the one after it. A hard cut paints none; a sweep paints several. Comparing against
   * this mark's own first and last frame - rather than against a fixed count - keeps the claim
   * independent of how many frames the machine managed to paint.
   */
  const summarise = (samples) => ({
    frames: samples.length,
    distinct: new Set(samples).size,
    strays: samples.filter((value) => value !== samples[0] && value !== samples[samples.length - 1]).length,
  });

  /**
   * The dashboard fixture with the spike at a different bucket on each revision.
   *
   * Two things about this mutation are load bearing. It changes the plot's *shape*, because the
   * sparkline has no axis and its y domain is normalized to the window's own maximum - scaling every
   * bucket by one factor repaints the canvas pixel for pixel, so a uniform level change is invisible
   * here with or without animation. And it moves the spike rather than growing it, because raising one
   * spike and letting it dominate the domain makes every later revision paint the same picture: a
   * frozen canvas that would be read as a chart that stopped updating.
   */
  const spikedDashboard = (revision) => {
    const body = JSON.parse(JSON.stringify(chartDashboard));
    const bucket = revision % 2 === 0 ? 7 : 22;
    body.requests.series = body.requests.series.map((point, index) => (index === bucket ? { ...point, v: 999_999 } : point));
    return body;
  };

  /**
   * The models fixture with a different group tripled on each revision, so both panels change shape
   * and not just level: the ring redraws its shares and the trend lifts another line.
   */
  const shiftedModels = (revision) => {
    const body = JSON.parse(JSON.stringify(chartDashboardModels));
    const group = body.models[revision % Math.max(1, body.models.length)];
    if (group) {
      group.tokens *= 3;
      group.series = group.series.map((point) => ({ ...point, tokens: point.tokens * 3 }));
    }
    body.total_tokens = body.models.reduce((sum, item) => sum + item.tokens, 0);
    return body;
  };

  // Both preference states are measured on ONE page, by switching the preference rather than by
  // opening a second browser context. Two contexts would each mount the dashboard, and the second
  // mount's marks can come up with a chart instance the library never re-renders - a frozen canvas
  // that says nothing about motion - so a two-lane probe reports the harness rather than the app.
  // Switching in place is also the stronger claim: §7's override has to hold when the preference
  // changes while the console is open, not only when it was set before the page loaded.
  const bodies = {
    dashboard: JSON.parse(JSON.stringify(chartDashboard)),
    models: JSON.parse(JSON.stringify(chartDashboardModels)),
  };
  // Awaited before anything is driven: `BrowserContext.route()` is asynchronous, and a navigation
  // that starts before the registration lands is answered by the previous fixture.
  await context.route(
    (url) => url.pathname.includes('/omc/api/') && url.pathname.endsWith('/dashboard'),
    (route) => route.fulfill({ json: bodies.dashboard }),
  );
  await context.route(
    (url) => url.pathname.includes('/omc/api/') && url.pathname.endsWith('/dashboard/tail'),
    (route) => route.fulfill({ json: bodies.dashboard }),
  );
  await context.route(
    (url) => url.pathname.includes('/omc/api/') && url.pathname.endsWith('/dashboard/models'),
    (route) => route.fulfill({ json: bodies.models }),
  );

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  for (const [, selector] of MARKS) {
    await page.locator(selector).first().waitFor({ timeout: 20_000 });
  }
  // `enter` is enabled, so the first paint animates too. Sampling before it ends would count those
  // frames as a revision's intermediates.
  await page.waitForTimeout(700);

  /**
   * Drives one revision, sampling the named mark, and reports its frames.
   *
   * The mutation has to change the plot's *shape*: the sparkline has no axis and its y domain is
   * normalized to the window's own maximum, so scaling every bucket by the same factor repaints the
   * canvas pixel for pixel - a uniform level change is invisible here with or without animation.
   * It also has to *move* rather than grow, or later revisions repaint the same picture.
   */
  let revision = 0;
  const measureRevision = async (markSelector) => {
    bodies.dashboard = spikedDashboard(revision);
    bodies.models = shiftedModels(revision);
    revision += 1;
    const started = await startSampler(page, markSelector);
    // The canvas node is captured before the revision lands. A morph keeps it - the library hands the
    // new spec to the runtime it already has - while a remount mints a new canvas, and a remount is
    // exactly what would turn this sweep into a draw-in. Painted intermediates cannot tell the two
    // apart, which is why the identity is asserted rather than inferred from frames.
    const canvasPresent = await page.evaluate((selector) => {
      window.__canvasUnderTest = document.querySelector(selector);
      return Boolean(window.__canvasUnderTest);
    }, markSelector);
    const answered = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.includes('/omc/api/') && url.pathname.endsWith('/dashboard/models');
    });
    await page.locator('.terminal-page-head button:has(.anticon-reload)').click();
    await answered;
    await page.waitForTimeout(700);
    const identity = await page.evaluate(
      (selector) => ({
        painted: Boolean(window.__canvasUnderTest),
        // The same selector, resolved after the revision: a morph hands the new spec to the runtime
        // that owns this node, a remount replaces it.
        preserved: Boolean(window.__canvasUnderTest) && document.querySelector(selector) === window.__canvasUnderTest,
      }),
      markSelector,
    );
    return { started, samples: await stopSampler(page), canvasPresent, identity };
  };

  // ── a reader who allows motion sees the marks move ─────────────────────────
  // One revision per mark, and only one mark sampled at a time: each revision serves a different
  // shape, so every claim below is made about a change that really happened.
  for (const [name, selector] of MARKS) {
    const measured = await measureRevision(selector);
    check(`${name} paints into a canvas this probe can read`, measured.started === 'sampling', `${measured.started}`);
    check(`${name} has a canvas to hold its chart`, measured.canvasPresent, JSON.stringify(measured.identity));
    check(
      `${name} keeps its chart instance across a revision, so the sweep is a morph and not a draw-in`,
      measured.identity.preserved,
      JSON.stringify(measured.identity),
    );
    const summary = summarise(measured.samples);
    check(`${name} reaches its new reading on a revision`, summary.distinct >= 2 && summary.frames > 0, JSON.stringify(summary));
    check(`${name} sweeps instead of hard-cutting`, summary.strays > 0, JSON.stringify(summary));
  }

  // ── the same page, once the reader asks for reduced motion ─────────────────
  // A fresh revision is driven after the switch, so the frames measured here belong to the
  // preference that was in force when the data arrived.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(120);

  // A reduced-motion override has to remove the motion without removing the surface. antd's floating
  // panels are the case that proves it is not free: they enter with a zoom, rc-motion leaves the enter
  // state inline until the animation ends, and `animation: none` alone therefore left the panel at
  // scale 0 and opacity 0 - measured. This asserts the panel still arrives, at the geometry it would
  // have settled at anyway.
  await page.locator('.range-trigger').click();
  await page.waitForTimeout(600);
  const openedPanel = await page.evaluate(() => {
    const node = [...document.querySelectorAll('.ant-popover, .ant-dropdown, .ant-picker-dropdown')].find(
      (candidate) => getComputedStyle(candidate).visibility === 'visible',
    );
    if (!node) return { present: false };
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return { present: true, opacity: style.opacity, width: Math.round(box.width), height: Math.round(box.height) };
  });
  check(
    'a floating panel still arrives under reduced motion, without its zoom',
    openedPanel.present && openedPanel.opacity === '1' && openedPanel.width > 0 && openedPanel.height > 0,
    JSON.stringify(openedPanel),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  for (const [name, selector] of MARKS) {
    const measured = await measureRevision(selector);
    const summary = summarise(measured.samples);
    check(`${name} still reaches its new reading under reduced motion`, summary.distinct >= 2, JSON.stringify(summary));
    check(`${name} paints no intermediate frame under reduced motion`, summary.strays === 0, JSON.stringify(summary));
  }
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
 *   - The plot's chrome - the grid rules, the tooltip's crosshair and the axis labels - is painted in
 *     the palette's ink, in both themes. That is the one part of the mark the runtime draws from its own
 *     theme rather than from ours, and the dark card is the one that shows when it does: a near-black rule
 *     there is one 8-bit step from the background it is drawn on. All three are read from the canvas, so
 *     what is asserted is the paint rather than the spec that asked for it.
 */
