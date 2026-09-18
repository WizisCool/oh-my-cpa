import { until } from '../harness.mjs';
import { sleep } from '../probe.mjs';

/**
 * Probes for the dashboard's model panels: the token trend and the usage ring,
 * their window and refresh states, a first-load failure and an empty window.
 */

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
export async function dashboardModelPanels({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-models').waitFor({ timeout: 20_000 });
  // The marks are behind a lazy import, so the first frame after the panel appears is the Suspense
  // fallback rather than a canvas.
  await page.locator('.model-trend canvas').first().waitFor({ timeout: 20_000 });
  await page.locator('.model-ring canvas').first().waitFor({ timeout: 20_000 });

  const usageHeader = await page.evaluate(() => {
    const card = document.querySelector('.model-usage-card');
    const head = card?.querySelector('.ant-card-head');
    const title = card?.querySelector('.ant-card-head-title');
    const toggle = card?.querySelector('.model-view-toggle');
    const bodyTitle = card?.querySelector('.ant-card-body .tile-label');
    if (!head || !title || !toggle) return { error: 'missing model usage header elements' };
    const headBox = head.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const toggleBox = toggle.getBoundingClientRect();
    return {
      title: title.textContent?.trim() ?? '',
      bodyTitle: Boolean(bodyTitle),
      sameRow: Math.abs((titleBox.top + titleBox.height / 2) - (toggleBox.top + toggleBox.height / 2)) <= 2,
      headContainsToggle: head.contains(toggle),
      headHeight: headBox.height,
    };
  });
  check(
    'model usage is the card header title beside its view control',
    usageHeader.title === 'Model usage'
      && usageHeader.bodyTitle === false
      && usageHeader.sameRow === true
      && usageHeader.headContainsToggle === true,
    JSON.stringify(usageHeader),
  );

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
      // Sample on a circular path scaled to the smaller dimension, matching the pie's geometry.
      const span = Math.min(probe.width, probe.height);
      for (const radius of [0.36, 0.40, 0.44]) {
        const x = Math.round(cx + Math.cos(angle) * span * radius);
        const y = Math.round(cy + Math.sin(angle) * span * radius);
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
      tokensTitle: row.querySelector('.model-usage-tokens').getAttribute('title'),
      share: row.querySelector('.model-usage-share').textContent,
      cost: row.querySelector('.model-usage-cost').textContent,
      // The cells' own left edges, so the reading order can be asserted as geometry rather than by
      // trusting the markup order - a row whose columns were reordered by CSS would still serialise
      // in DOM order, and the operator reads the painted positions.
      lefts: {
        name: Math.round(row.querySelector('.model-usage-name').getBoundingClientRect().left),
        cost: Math.round(row.querySelector('.model-usage-cost').getBoundingClientRect().left),
        tokens: Math.round(row.querySelector('.model-usage-tokens').getBoundingClientRect().left),
        share: Math.round(row.querySelector('.model-usage-share').getBoundingClientRect().left),
      },
      color: getComputedStyle(row.querySelector('.model-usage-swatch')).backgroundColor,
    })),
  );
  check('the usage list ranks every group', list.length === 6, `rows=${list.length}`);
  // The volume cell is abbreviated so the row scans; the exact count has to remain reachable, and
  // the format is what proves the title is the full number rather than a repeat of the
  // abbreviation: grouped digits with the unit word, never a `K`/`M` suffix. The pattern accepts a
  // small value too, because a genuinely small group is exact without a separator.
  check(
    'every abbreviated volume keeps its exact count in the accessible name',
    list.every((row) => typeof row.tokensTitle === 'string' && /^(\d{1,3}(,\d{3})+|\d{1,3}) tokens$/.test(row.tokensTitle)),
    JSON.stringify(list.map((row) => `${row.tokens} => ${row.tokensTitle}`)),
  );
  check(
    'every row states a name, a volume and a share',
    list.every((row) => row.name.length > 0 && /[\d.]/.test(row.tokens) && /%/.test(row.share)),
    JSON.stringify(list.map((row) => `${row.name}=${row.tokens}/${row.share}`)),
  );
  // Every row carries the cost cell, including the folded remainder: a spend column that appeared
  // only on some rows would make the column's presence depend on what happened to be priced.
  check(
    'every row states a cost',
    list.every((row) => typeof row.cost === 'string' && row.cost.trim().length > 0),
    JSON.stringify(list.map((row) => `${row.name}=${row.cost}`)),
  );
  // The reading order is name, cost, volume, share. Asserted as painted geometry: the columns must
  // advance left to right in that order on every row, which is what a reader's eye follows and what
  // a CSS reorder could break without touching the markup order.
  const misordered = list.filter((row) => !(row.lefts.name < row.lefts.cost && row.lefts.cost < row.lefts.tokens && row.lefts.tokens < row.lefts.share));
  check(
    'the columns read name, cost, volume, share',
    misordered.length === 0,
    JSON.stringify(list.map((row) => row.lefts)),
  );
  // Each numeric column starts on one edge down the whole list. The tracks are declared once on the
  // list, so this is what proves the rows share them: with a track set per row instead, a row whose
  // cost happens to be a character wider shifts its own volume and share cells and the column edges
  // scatter - which is invisible on a fixture whose costs all share a width, and which is why the
  // spread is asserted as zero rather than as "close".
  // Sharing the list's tracks must not cost the row its own box. Dissolving the row to inherit them
  // also dissolves its gap and its separator: the swatch ends up against the name and the rule under
  // the row withdraws into the column gaps, drawn as fragments. Both are asserted here because both
  // are invisible to a markup-order check and to the column-edge check above.
  const rowBoxes = await page.evaluate(() =>
    [...document.querySelectorAll('.model-usage-row')].map((row) => {
      const swatch = row.querySelector('.model-usage-swatch').getBoundingClientRect();
      const name = row.querySelector('.model-usage-name').getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return {
        swatchToName: Math.round(name.left - swatch.right),
        width: Math.round(box.width),
        borderBottom: getComputedStyle(row).borderBottomWidth,
      };
    }),
  );
  check(
    'the swatch is set apart from the name it marks',
    rowBoxes.every((row) => row.swatchToName >= 6),
    JSON.stringify(rowBoxes.map((row) => row.swatchToName)),
  );
  // The separator is the row's, not each cell's: a rule drawn per cell stops at every column gap. All
  // rows therefore share one width, and only the last one drops its border.
  check(
    'the row keeps one box wide enough to carry a single unbroken separator',
    new Set(rowBoxes.map((row) => row.width)).size === 1
      && rowBoxes.slice(0, -1).every((row) => row.borderBottom === '1px')
      && rowBoxes.at(-1).borderBottom === '0px',
    JSON.stringify(rowBoxes.map((row) => [row.width, row.borderBottom])),
  );
  const columnSpread = (key) => {
    const lefts = list.map((row) => row.lefts[key]);
    return Math.max(...lefts) - Math.min(...lefts);
  };
  const spreads = { cost: columnSpread('cost'), tokens: columnSpread('tokens'), share: columnSpread('share') };
  check(
    'every numeric column starts on one edge down the list',
    spreads.cost === 0 && spreads.tokens === 0 && spreads.share === 0,
    JSON.stringify(spreads),
  );
  // The name column is the one part of the row that cannot be abbreviated, so it holds a floor while
  // the ring yields. Asserted across a sweep of widths rather than at the default one: the failure
  // this guards is the shrinking card, and at 1440px the fixture's own name widths already exceed the
  // floor - a single measurement there passes whether or not the floor exists.
  //
  // The viewport is a *proxy* for the card's width and the panel chooses its arrangement by the card's
  // own width, so the sweep is what covers both of the panel's arrangements and the handover between
  // them. It ends by restoring the default, which the checks below still assume.
  const sweepWidths = [1920, 1600, 1460, 1450, 1440, 1360, 1280, 1200, 1120, 1040, 900, 700, 500, 390];
  const sweep = [];
  for (const width of sweepWidths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.model-usage-row').first().waitFor({ state: 'visible', timeout: 10_000 });
    // The panel re-lays-out on a resize; waiting a frame keeps the measurement from reading the
    // arrangement that was on screen before the new width.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    sweep.push(await page.evaluate((viewport) => {
      const list = document.querySelector('.model-usage-list');
      const cardBody = document.querySelector('.model-usage-card .ant-card-body').getBoundingClientRect();
      const frame = document.querySelector('.model-ring-frame').getBoundingClientRect();
      const canvas = document.querySelector('.model-ring canvas');
      const canvasBox = canvas.getBoundingClientRect();
      const share = document.querySelector('.model-usage-share').getBoundingClientRect();
      const name = document.querySelector('.model-usage-name').getBoundingClientRect();
      return {
        viewport,
        // How far the list's own columns reach past the box they were given: a positive value is a
        // cell painted outside the card, which is the clipped-column state.
        listOverflow: Math.round(list.scrollWidth - list.clientWidth),
        sharePastCard: Math.round(share.right - cardBody.right),
        nameWidth: Math.round(name.width),
        frame: { w: Math.round(frame.width), h: Math.round(frame.height) },
        canvas: { w: Math.round(canvasBox.width), h: Math.round(canvasBox.height), backing: `${canvas.width}x${canvas.height}` },
      };
    }, width));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  check(
    'no column is painted outside the card at any width',
    sweep.every((entry) => entry.listOverflow <= 0 && entry.sharePastCard <= 0),
    JSON.stringify(sweep.filter((entry) => entry.listOverflow > 0 || entry.sharePastCard > 0)),
  );
  check(
    'the name column stays readable at every width',
    sweep.every((entry) => entry.nameWidth >= 140),
    JSON.stringify(sweep.map((entry) => [entry.viewport, entry.nameWidth])),
  );
  // The ring gives width to the list, so it must stay a ring: a drawing whose frame is clamped in one
  // axis while its canvas keeps the other draws an ellipse and misplaces the readout. The canvas's
  // *backing* store is included because the library sizes it from the container - a square CSS box
  // over a non-square backing would still paint an ellipse.
  check(
    'the ring stays square at every width',
    sweep.every((entry) => Math.abs(entry.frame.w - entry.frame.h) <= 1
      && Math.abs(entry.canvas.w - entry.canvas.h) <= 1
      && entry.canvas.backing.split('x')[0] === entry.canvas.backing.split('x')[1]),
    JSON.stringify(sweep.map((entry) => [entry.viewport, entry.frame, entry.canvas])),
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

  // ── the readout sits on the ring's painted centre ─────────────────────
  //
  // The centre readout is DOM and the ring is canvas paint, so "the number is inside the hole" is a
  // claim about two different rendering stacks agreeing on one point. It shipped misaligned once: the
  // readout centred on a box that could be taller than the drawing, so the total floated above the
  // hole. The observable is geometric: the ink bounding box of the painted ring, and the readout's
  // own box, must share a centre within a couple of device pixels.
  const ringCentring = await page.evaluate(() => {
    const canvas = document.querySelector('.model-ring canvas');
    if (!canvas) return { error: 'no canvas' };
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    const context = probe.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, probe.width, probe.height);
    let minX = Infinity; let maxX = -1; let minY = Infinity; let maxY = -1;
    for (let y = 0; y < probe.height; y += 1) {
      for (let x = 0; x < probe.width; x += 1) {
        if (data[(y * probe.width + x) * 4 + 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { error: 'no ink' };
    const ink = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const canvasRect = canvas.getBoundingClientRect();
    const readoutRect = document.querySelector('.model-ring-center').getBoundingClientRect();
    const readout = {
      x: (readoutRect.left - canvasRect.left + readoutRect.width / 2) * (probe.width / canvasRect.width),
      y: (readoutRect.top - canvasRect.top + readoutRect.height / 2) * (probe.height / canvasRect.height),
    };
    return { ink, readout, drift: { x: Math.abs(ink.x - readout.x), y: Math.abs(ink.y - readout.y) } };
  });
  check(
    'the centre readout sits on the ring\'s painted centre',
    !ringCentring.error && ringCentring.drift.x <= 2 && ringCentring.drift.y <= 2,
    JSON.stringify(ringCentring),
  );

  // ── the ring's hover states what the ranked list states ───────────────────
  //
  // A slice is judged on three things - which group it is, how much it moved, and its share of the
  // window - and the trend's hover already prints exactly that shape of row, so the ring's must too.
  // The hovered point is the *midpoint of the first slice*, taken from the share the list reports:
  // hovering a fixed screen position would depend on the fixture's ranking, and the whole claim here
  // is that the two surfaces agree about the same group.
  const firstShare = Number.parseFloat(list[0].share) / 100;
  const ringCanvas = page.locator('.model-ring canvas').first();
  await ringCanvas.scrollIntoViewIfNeeded();
  const ringBox = await ringCanvas.boundingBox();
  // The band's own mid-radius, measured against the canvas rather than assumed: the ring is inset by
  // its padding, so a fraction taken from the canvas edge can fall inside the hole or outside the
  // outer edge, and either miss lands on no slice at all. The band spans the mark's inner to outer
  // radius, and its midpoint is the point that is inside the arc at every share.
  const ringRadius = Math.min(ringBox.width, ringBox.height) * 0.38;
  // G2 sweeps the ring counterclockwise from twelve o'clock, so the first group occupies the arc from
  // 0 to its share of the circle and its midpoint is half of that. The sign is the observable that
  // decides whether the probe lands on the slice it names: read the wrong way it hovers the group on
  // the other side of twelve o'clock, and the assertion below then fails against a correct tooltip.
  const hoverAngle = -Math.PI / 2 - firstShare * Math.PI;
  const hoverX = ringBox.x + ringBox.width / 2 + Math.cos(hoverAngle) * ringRadius;
  const hoverY = ringBox.y + ringBox.height / 2 + Math.sin(hoverAngle) * ringRadius;
  await page.mouse.move(hoverX, hoverY);
  // A second move lands on a slightly different pixel: the library's pointer tracking subscribes to
  // movement, and a single synthetic move onto an already-hovered pixel can be coalesced away.
  await page.mouse.move(hoverX + 2, hoverY);
  const ringHover = await until(async () => {
    const tip = page.locator('.model-ring .omc-tip').first();
    if ((await tip.count()) === 0) return false;
    const read = async (selector) => tip.locator(selector).first().innerText().catch(() => '');
    const name = await read('.omc-tip-name');
    if (name.length === 0) return false;
    return { name, value: await read('.omc-tip-value'), share: await read('.omc-tip-share') };
  }, { label: 'the ring hover readout to appear' }).catch(() => null);
  check(
    'the ring hover states the model, its volume and its share',
    ringHover !== null
      && ringHover.name === list[0].name
      && ringHover.value.includes(list[0].tokens)
      && ringHover.share === list[0].share,
    `hover=${JSON.stringify(ringHover)} list=${JSON.stringify({ name: list[0].name, tokens: list[0].tokens, share: list[0].share })}`,
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

  // ── both marks are centred in the card at every width ─────────────────────
  //
  // The rings and the trend occupy whatever width the card gives them, so each one's drawing has
  // to sit on that width's centre. Two independent mechanisms put them off it, and this is the
  // check that would have caught both of them:
  //
  //   - the ring is a fixed 220px frame inside a full-width box, and the box's own distribution of
  //     that frame decides where it lands once the row stacks on a phone;
  //   - the trend reserves its own left/right strips for the axis labels, and the library's array
  //     form for that padding is silently ignored, so the plot fell back to insets computed around
  //     a y-axis that is hidden - a strip nothing is painted in, which shifted the plot right by
  //     about 22px at every width rather than only on a phone.
  //
  // Ink, not the element box, is what is measured: the canvas always spans the card, and it is the
  // drawing inside it that was off-centre.
  const centering = async (label) => {
    const measured = await page.evaluate(() => {
      const inkCentre = (selector) => {
        const canvas = document.querySelector(selector);
        if (!canvas) return null;
        const probe = document.createElement('canvas');
        probe.width = canvas.width;
        probe.height = canvas.height;
        const context = probe.getContext('2d');
        context.drawImage(canvas, 0, 0);
        const { data } = context.getImageData(0, 0, probe.width, probe.height);
        let minX = Infinity;
        let maxX = -1;
        for (let y = 0; y < probe.height; y += 1) {
          for (let x = 0; x < probe.width; x += 1) {
            if (data[(y * probe.width + x) * 4 + 3] > 40) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
        }
        if (maxX < 0) return null;
        const rect = canvas.getBoundingClientRect();
        const scale = rect.width / probe.width;
        return {
          inkCentre: rect.left + ((minX + maxX) / 2) * scale,
          canvasCentre: rect.left + rect.width / 2,
          canvasWidth: rect.width,
        };
      };
      const card = document.querySelector('.model-usage-card').getBoundingClientRect();
      const head = document.querySelector('.model-usage-card .ant-card-head').getBoundingClientRect();
      const cardBody = document.querySelector('.model-usage-card .ant-card-body').getBoundingClientRect();
      const usageRow = document.querySelector('.model-usage-body').getBoundingClientRect();
      const ringFrame = document.querySelector('.model-ring-frame').getBoundingClientRect();
      return {
        ringInk: inkCentre('.model-ring canvas'),
        trendInk: inkCentre('.model-trend canvas'),
        ringFrameCentre: ringFrame.left + ringFrame.width / 2,
        cardCentre: cardBody.left + cardBody.width / 2,
        cardWidth: cardBody.width,
        // The grid makes the usage and trend cards the same height. The usage card's own body must
        // spend that height rather than leaving the row marooned above the card's lower edge.
        usageRowCentreY: usageRow.top + usageRow.height / 2,
        sectionCentreY: (head.bottom + card.bottom) / 2,
        cardHeight: card.height,
      };
    });
    const drifts = {
      ringInk: measured.ringInk ? Math.round(measured.ringInk.inkCentre - measured.ringInk.canvasCentre) : null,
      trendInk: measured.trendInk ? Math.round(measured.trendInk.inkCentre - measured.trendInk.canvasCentre) : null,
      ringFrame: Math.round(measured.ringFrameCentre - measured.cardCentre),
      usageRowVertical: Math.round(measured.usageRowCentreY - measured.sectionCentreY),
    };
    check(
      `the ring's drawing is centred in its card (${label})`,
      drifts.ringInk !== null && Math.abs(drifts.ringInk) <= 2,
      `drift=${drifts.ringInk} cardWidth=${Math.round(measured.cardWidth)}`,
    );
    check(
      `the trend's drawing is centred in its canvas (${label})`,
      drifts.trendInk !== null && Math.abs(drifts.trendInk) <= 2,
      `drift=${drifts.trendInk} cardWidth=${Math.round(measured.cardWidth)}`,
    );
    check(
      `the usage row is centred in the card below its header (${label})`,
      Math.abs(drifts.usageRowVertical) <= 2,
      `drift=${drifts.usageRowVertical} cardHeight=${Math.round(measured.cardHeight)}`,
    );
    return drifts;
  };

  const desktopDrift = await centering('desktop');
  // The phone width is where the row stacks, which is the arrangement that exposed the ring's
  // frame being left-aligned rather than centred.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator('.model-usage-row').first().waitFor({ state: 'visible', timeout: 10_000 });
  const phoneDrift = await centering('phone');
  // Only in the stacked layout: on a desktop width the ring is a peer of the list beside it, so its
  // frame sits where that row puts it and *not* on the card's centre - asserting card-centring there
  // would forbid the layout the panel is designed around.
  check(
    'the ring\'s frame is centred in the stacked layout',
    Math.abs(phoneDrift.ringFrame) <= 2 && Math.abs(desktopDrift.ringFrame) > 2,
    `phone=${phoneDrift.ringFrame} desktop=${desktopDrift.ringFrame}`,
  );

  // ── the plot's chrome ink, in both themes ────────────────────────────────
  //
  // The grid rules, the tooltip's crosshair and the axis labels are the part of this mark the console
  // does not paint itself: the runtime draws them from its own theme, which is one of the library's
  // *light* themes unless the mark names the console's mode, and it multiplies the inks it *is* handed
  // by that theme's opacity tokens. So the ink was near-black - legible on the light card and one 8-bit
  // step away from a dark card's background - the palette's own ink did not always reach the canvas at
  // all, and the labels it did reach were drawn at 45% of the step they name.
  //
  // All three are paint, so all three are read from the pixels, and in both themes: a named token in the
  // spec proves the spec, and the light card is exactly the surface on which a wrong ink still looks
  // correct.
  //
  // The ink is matched to the token rather than allowed to sit near it. `--border-soft` and `--border`
  // are neighbours in every palette, and the axis rule is drawn in the second of the two at a coverage of
  // about 110 - so a tolerance wide enough to let that rule stand in for the grid would pass on a mark
  // that never painted a grid at all, which is exactly the state this asserts against. Measured on the
  // canvas, a rule drawn in the token rounds to 0-1 of a channel.
  const CHROME_INK_TOLERANCE = 4;
  // A 0.5px rule reaches an alpha of about 125, and the library's own opacity step leaves about 13: the
  // floor between them rejects the faded ink rather than a particular rule width.
  const CHROME_INK_COVERAGE = 48;
  // Type is matched more loosely than a rule: a 10px glyph's edges are blends, so only its strokes are
  // the token, and they still clear 200. An opacity step of 0.45 caps a glyph pixel at about 115, which
  // is what leaves the floor between the two.
  const LABEL_INK_TOLERANCE = 6;
  const LABEL_INK_COVERAGE = 200;
  // A dashed rule inks 3 of every 7 pixels along its length, so a grid row carries about a third of the
  // canvas width. Counting *rows* rather than pixels is what separates the grid from the incidental
  // near-token pixel - a marker, a label edge - that a whole-canvas maximum would accept as a gridline.
  const GRID_ROW_COVERAGE = 0.15;
  // The y-axis draws about seven rules on this fixture. Two is the floor: it survives a tick-count change
  // and it is still zero for a mark whose grid ink never reached the canvas.
  const GRID_ROWS_MIN = 2;
  const chromeInk = () => page.evaluate(([tolerance, inkCoverage, labelTolerance, labelCoverage, rowCoverage]) => {
    const channels = (value) => {
      const text = String(value).trim();
      const hex = /^#([0-9a-f]{6})$/i.exec(text);
      if (hex) return [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
      return (text.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    };
    const canvas = document.querySelector('.model-trend canvas');
    if (!canvas) return { error: 'no trend canvas' };
    const probe = document.createElement('canvas');
    probe.width = canvas.width;
    probe.height = canvas.height;
    probe.getContext('2d').drawImage(canvas, 0, 0);
    const { data } = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height);
    const styles = getComputedStyle(document.documentElement);
    const gridToken = channels(styles.getPropertyValue('--border-soft'));
    const chromeToken = channels(styles.getPropertyValue('--muted'));
    const labelToken = channels(styles.getPropertyValue('--fg-2'));
    const isToken = (offset, token, within = tolerance) => Math.abs(data[offset] - token[0]) <= within
      && Math.abs(data[offset + 1] - token[1]) <= within
      && Math.abs(data[offset + 2] - token[2]) <= within;
    // The strongest coverage the palette's chrome ink reaches anywhere, which the pointer's rule is the
    // only thing on this mark to draw.
    let crosshair = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3];
      if (alpha > crosshair && alpha >= inkCoverage && isToken(offset, chromeToken)) crosshair = alpha;
    }
    // The axis labels are the canvas's only text, and they are painted below the plot's own bottom edge:
    // the strongest coverage of the label ink is read from that strip, so nothing inside the plot can
    // stand in for a glyph.
    let labels = 0;
    for (let y = Math.round(probe.height * 0.85); y < probe.height; y += 1) {
      for (let x = 0; x < probe.width; x += 1) {
        const offset = (y * probe.width + x) * 4;
        const alpha = data[offset + 3];
        if (alpha > labels && alpha >= labelCoverage && isToken(offset, labelToken, labelTolerance)) labels = alpha;
      }
    }
    // The horizontal rules drawn in the palette's grid ink, one count per row: the floor the check
    // stands on is that a grid whose ink never reached the canvas has no such rows at all.
    let gridRows = 0;
    for (let y = 0; y < probe.height; y += 1) {
      let inked = 0;
      for (let x = 0; x < probe.width; x += 1) {
        const offset = (y * probe.width + x) * 4;
        if (data[offset + 3] >= inkCoverage && isToken(offset, gridToken)) inked += 1;
      }
      if (inked >= probe.width * rowCoverage) gridRows += 1;
    }
    return {
      theme: document.documentElement.dataset.theme,
      gridRows,
      gridInk: gridToken.join('/'),
      chromeInk: chromeToken.join('/'),
      labelInk: labelToken.join('/'),
      crosshair,
      labels,
      card: channels(getComputedStyle(document.querySelector('.model-trend-card')).backgroundColor),
    };
  }, [CHROME_INK_TOLERANCE, CHROME_INK_COVERAGE, LABEL_INK_TOLERANCE, LABEL_INK_COVERAGE, GRID_ROW_COVERAGE]);

  const trendCanvas = page.locator('.model-trend canvas').first();
  const hoverTrend = async () => {
    const box = await trendCanvas.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // A second move lands on a different pixel: the library's pointer tracking subscribes to movement,
    // and one synthetic move onto an already-hovered pixel can be coalesced away.
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
    // The crosshair is drawn in the same interaction update that shows the readout, so the readout
    // appearing is the readiness signal for the rule rather than a pause.
    await page.locator('.model-trend .omc-tip').first().waitFor({ timeout: 10_000 });
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.model-trend canvas').first().waitFor({ timeout: 20_000 });
  // Nothing has put the pointer over the trend yet, so this read is the mark at rest.
  const lightChrome = await chromeInk();
  check(
    'the light trend draws its grid rules in the palette grid ink',
    lightChrome.gridRows >= GRID_ROWS_MIN,
    `gridRows=${lightChrome.gridRows} want>=${GRID_ROWS_MIN} card=${lightChrome.card.join('/')} gridInk=${lightChrome.gridInk}`,
  );
  check(
    'the light trend draws no crosshair while the pointer is elsewhere',
    lightChrome.crosshair === 0,
    `crosshairCoverage=${lightChrome.crosshair} theme=${lightChrome.theme}`,
  );
  check(
    'the light trend paints its axis labels at the palette label ink',
    lightChrome.labels >= LABEL_INK_COVERAGE,
    `labelCoverage=${lightChrome.labels} want>=${LABEL_INK_COVERAGE} labelInk=${lightChrome.labelInk}`,
  );
  await hoverTrend();
  const lightHover = await chromeInk();
  check(
    'the light trend draws its crosshair in the palette chrome ink',
    lightHover.crosshair >= CHROME_INK_COVERAGE,
    `crosshairCoverage=${lightHover.crosshair} want>=${CHROME_INK_COVERAGE} chromeInk=${lightHover.chromeInk}`,
  );

  // The dark card is the one that cannot hide a wrong ink: the same mark, the same rules, read again
  // from the pixels after the theme is switched.
  await page.evaluate(() => localStorage.setItem('omc-theme', 'omc-dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => document.documentElement.dataset.theme === 'omc-dark'), {
    label: 'the stored dark theme to be applied before reading the mark',
  });
  await page.locator('.model-trend canvas').first().waitFor({ timeout: 20_000 });
  await hoverTrend();
  const darkChrome = await chromeInk();
  check(
    'the dark trend draws its grid rules in the palette grid ink',
    darkChrome.gridRows >= GRID_ROWS_MIN,
    `gridRows=${darkChrome.gridRows} want>=${GRID_ROWS_MIN} card=${darkChrome.card.join('/')} gridInk=${darkChrome.gridInk}`,
  );
  check(
    'the dark trend draws its crosshair in the palette chrome ink',
    darkChrome.crosshair >= CHROME_INK_COVERAGE,
    `crosshairCoverage=${darkChrome.crosshair} want>=${CHROME_INK_COVERAGE} chromeInk=${darkChrome.chromeInk}`,
  );
  check(
    'the dark trend paints its axis labels at the palette label ink',
    darkChrome.labels >= LABEL_INK_COVERAGE,
    `labelCoverage=${darkChrome.labels} want>=${LABEL_INK_COVERAGE} labelInk=${darkChrome.labelInk}`,
  );
  // A second pass that silently re-rendered the light theme would satisfy every check above, so the
  // two surfaces are required to differ.
  check(
    'the two passes drew different card surfaces',
    lightChrome.card.join() !== darkChrome.card.join(),
    `light=${lightChrome.card.join('/')} dark=${darkChrome.card.join('/')}`,
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

  // ── the grouping toggle re-reads with its own view ────────────────────────
  // The two groupings are two different rankings; a toggle that only re-labelled the existing series
  // would present upstream-model rows as call points. The request URL is the observable, and so is
  // the persisted write: the choice has to survive a reload like every other console preference.
  const beforeToggle = calls.length;
  await page.locator('.model-usage-card .ant-segmented-item').filter({ hasText: /By upstream model|按上游模型/ }).first().click();
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
  await page.locator('.model-usage-card .ant-segmented-item').filter({ hasText: /By call point|按调用点/ }).first().click();
  let callViewPersisted = false;
  await until(async () => {
    callViewPersisted = preferenceWrites.some((entry) => entry.key === 'omc_models_view' && entry.value === 'call');
    return callViewPersisted;
  }, { label: 'the call-point view to be persisted' }).catch(() => {});
  check(
    'switching back selects the call-point view and persists it',
    (
      (await page.locator('.model-usage-card .ant-segmented-item-selected').innerText()).trim().length > 0
      && /By call point|按调用点/.test(await page.locator('.model-usage-card .ant-segmented-item-selected').innerText())
      && callViewPersisted
    ),
    `selected=${JSON.stringify(await page.locator('.model-usage-card .ant-segmented-item-selected').innerText())} writes=${JSON.stringify(preferenceWrites)}`,
  );

  // ── a refused preference write puts the control back ──────────────────────
  // The view toggle is optimistic: the panel switches on the click, then the write settles. When the
  // write is refused the control must return to the value the server still holds - otherwise the
  // console keeps showing a setting that was never saved, because these preferences never refetch on
  // their own. This is the failure mode a toast alone cannot fix.
  //
  // The refusal is *delayed* on purpose. An immediate 500 rolls the control back inside the click
  // handler, so the optimistic paint would either be missed by the poll or, worse, the whole check
  // would pass on a control that never moved at all. Holding the write open makes the intermediate
  // state a real, observable one - and then the rollback after the refusal is a change from it.
  await context.route('**/omc/api/**/preferences/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    await sleep(600);
    return route.fulfill({ status: 500, json: { error: 'preference write refused' } });
  });
  await page.locator('.model-usage-card .ant-segmented-item').filter({ hasText: /By upstream model|按上游模型/ }).first().click();
  let optimisticShown = false;
  await until(async () => {
    optimisticShown = /By upstream model|按上游模型/.test(await page.locator('.model-usage-card .ant-segmented-item-selected').innerText());
    return optimisticShown;
  }, { label: 'the optimistic switch to appear while the write is still in flight' }).catch(() => {});
  check('a write still in flight shows the operator\'s choice immediately', optimisticShown);
  let rolledBack = false;
  await until(async () => {
    rolledBack = /By call point|按调用点/.test(await page.locator('.model-usage-card .ant-segmented-item-selected').innerText());
    return rolledBack;
  }, { label: 'the control to fall back to the persisted view after the refusal' }).catch(() => {});
  check(
    'a refused preference write falls the control back to the persisted view',
    rolledBack,
    `selected=${JSON.stringify(await page.locator('.model-usage-card .ant-segmented-item-selected').innerText())}`,
  );
  await context.unroute('**/omc/api/**/preferences/*');

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

