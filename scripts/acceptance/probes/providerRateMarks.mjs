/**
 * The dashboard's provider rows: the rate number and the activity strip carry the band.
 *
 * A provider row prints its window rate in its band's colour and draws the window as a strip of
 * blocks, one per bucket, each coloured by the band of that bucket's own rate. The claim that they
 * *do* is not reachable by any logic test: it is a property of what the browser computed for an
 * element whose colour comes from a theme token, and a token wired to the wrong name reads
 * correctly on the dark page and wrong on the light one. So the probe compares the painted colour
 * against the token the band names, in both themes.
 *
 * Four rates are asserted, one per verdict plus the absent case: a healthy row, a degraded one, a
 * measured total outage, and a fresh row with no traffic at all. The last two are the pair a band
 * implementation is most likely to conflate - a rate defaulted to zero would paint the idle row as
 * an outage - so they are asserted to differ from each other and from the healthy row. Each row's
 * traffic sits in the window's newest bucket, so the strip must paint that block and leave every
 * other one as the idle track.
 *
 * A fleet past the panel's preview limit is also asserted to fold behind its toggle, and a phone
 * is asserted to keep the rate and request count while omitting the strip.
 *
 * The row also has to render its numbers at all: a panel that failed to aggregate still paints an
 * idle strip, and a probe that only read colours would call that a pass.
 */

/** The rates the fixture publishes, and what each is meant to prove. */
const ROWS = [
  // 92.44% - above the healthy boundary.
  { id: 'healthy-rate', rate: 92.44 },
  // 70.91% - between the two boundaries.
  { id: 'degraded-rate', rate: 70.91 },
  // A numeric zero with traffic is not the same thing as no traffic: it is a measured total
  // outage, and it must paint the alarm end rather than the neutral ink.
  { id: 'outage-rate', rate: 0 },
  { id: 'no-traffic-rate', rate: null },
  // The boundaries themselves, because each is inclusive of the *upper* band and the code makes
  // that decision with a `>=`. An off-by-one comparison would move these two rows a band down -
  // 80% would read degraded and 50% would read broken - while every rate above and below them
  // still looked right. They are the rates an operator is most likely to argue about, so they are
  // asserted rather than inferred from their neighbours.
  { id: 'healthy-boundary-rate', rate: 80 },
  { id: 'degraded-boundary-rate', rate: 50 },
];

/**
 * Reads, per row, the rate it printed, the colour that number painted, and the colour and width of
 * every block of its activity strip, oldest first.
 *
 * The blocks are read from the elements themselves, so what is compared is the colour the browser
 * resolved; their width is read as a rendered box, because a block collapsed by its flex parent is
 * a block the reader cannot see.
 */
const READ_MARKS = `(() => {
  const rows = [...document.querySelectorAll('.provider-row-enhanced')];
  return rows.map((row) => {
    const blocks = [...row.querySelectorAll('.provider-activity-block')];
    return {
      name: row.querySelector('.provider-title')?.textContent ?? '',
      rate: row.querySelector('.provider-rate')?.textContent ?? '',
      total: row.querySelector('.provider-total')?.textContent ?? '',
      rateColor: row.querySelector('.provider-rate') ? getComputedStyle(row.querySelector('.provider-rate')).color : null,
      blocks: blocks.map((block) => getComputedStyle(block).backgroundColor),
      narrowest: blocks.length ? Math.min(...blocks.map((block) => block.getBoundingClientRect().width)) : 0,
      activityLabel: row.querySelector('.provider-activity')?.getAttribute('aria-label') ?? '',
      activityFocusable: row.querySelector('.provider-activity')?.tabIndex === 0,
    };
  });
})()`;

/** The mode the console actually applied, which is what the colour assertions are about. */
const READ_THEME_MODE = `document.documentElement.getAttribute('data-theme-mode')`;

/** Wait for both queries behind a row: its configured identity and its windowed traffic. */
async function waitForProviderWindow(page, hasActivity) {
  await page.waitForFunction(({ rowCount, healthyRate, hasActivity }) => {
    const rows = [...document.querySelectorAll('.provider-row-enhanced')];
    if (rows.length !== rowCount) return false;
    const healthy = rows.find((row) => row.querySelector('.provider-title')?.textContent === 'healthy-rate');
    if (!healthy || !(healthy.querySelector('.provider-rate')?.textContent ?? '').includes(healthyRate.toFixed(2))) {
      return false;
    }
    return !hasActivity || healthy.querySelectorAll('.provider-activity-block').length > 0;
  }, { rowCount: ROWS.length, healthyRate: ROWS[0].rate, hasActivity }, { timeout: 20_000 });
}

export async function providerRateMarks({ base, page, check }) {
  // The fixture has to describe a window the endpoint could actually have produced. The server
  // derives `success` and `failure` from the rows it scanned, so a fixture whose parts contradict
  // its own rate - 92 of 100 at 92.44% - is a fixture that would let a client which recomputed the
  // rate from the counts diverge from one which trusted the wire, with the probe still green.
  const inconsistent = providerRateTraffic.providers.filter((row) => {
    const derived = row.total > 0 ? (row.success / row.total) * 100 : null;
    const bucketTotal = row.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
    const bucketFailure = row.buckets.reduce((sum, bucket) => sum + bucket.failure, 0);
    return row.success + row.failure !== row.total
      || bucketTotal !== row.total
      || bucketFailure !== row.failure
      || (derived !== null && Math.abs(derived - row.success_rate) > 1e-9);
  });
  check(
    'every traffic fixture describes a window whose counts and rate agree',
    inconsistent.length === 0,
    `inconsistent=${JSON.stringify(inconsistent)}`,
  );

  // Both themes, because the band paints with the active palette's tokens: light mode's `warn` is
  // its darker ochre step, so a token wired to the wrong name can read correctly on the dark page
  // and be wrong on the light one. The theme is stored, so it applies before the first paint of
  // the reload.
  for (const theme of ['omc-light', 'omc-dark']) {
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((stored) => localStorage.setItem('omc-theme', stored), theme);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Configured providers can paint before the windowed read replaces their counts and adds the
    // strips. Wait for that response's visible result instead of racing it after the first row.
    await waitForProviderWindow(page, true);

    // The theme has to have been applied before any colour is read. A stored preference the
    // console ignored would leave every row painted in the other palette, and the comparisons
    // below would pass while asserting nothing about the theme this iteration claims to cover.
    const appliedMode = await page.evaluate(READ_THEME_MODE);
    check(
      `${theme}: the console applied this theme, so the colours below are its own`,
      appliedMode === (theme === 'omc-dark' ? 'dark' : 'light'),
      `stored=${theme} applied=${appliedMode}`,
    );

    const marks = await page.evaluate(READ_MARKS);
    check(
      `${theme}: every fixture provider rendered a row`,
      marks.length === ROWS.length,
      `rows=${marks.length} want=${ROWS.length} ${JSON.stringify(marks)}`,
    );

    for (const { id, rate } of ROWS) {
      const row = marks.find((candidate) => candidate.name === id);
      if (!row) {
        check(`${theme}: the ${id} row rendered`, false, JSON.stringify(marks));
        continue;
      }

      if (rate === null) {
        // No traffic has no rate to print: an em dash, not a fabricated 0%.
        check(
          `${theme}: the ${id} row prints no rate at all`,
          row.rate.includes('—'),
          `rate=${JSON.stringify(row.rate)}`,
        );
      } else {
        check(
          `${theme}: the ${id} row printed its rate and volume`,
          row.rate.includes(rate.toFixed(2)) && row.total.trim() !== '' && row.total.trim() !== '0',
          `rate=${JSON.stringify(row.rate)} total=${JSON.stringify(row.total)}`,
        );
      }
      check(
        `${theme}: the ${id} row exposes its activity history to assistive technology`,
        row.activityFocusable && row.activityLabel.includes(id) && (rate === null || row.activityLabel.includes(`${rate.toFixed(1)}%`)),
        `focusable=${row.activityFocusable} label=${JSON.stringify(row.activityLabel)}`,
      );
      // Every row draws the whole window, idle or not, so the strips line up row to row.
      check(
        `${theme}: the ${id} row draws the window's ${STRIP_BLOCKS} blocks, each wide enough to see`,
        row.blocks.length === STRIP_BLOCKS && row.narrowest >= 2,
        `blocks=${row.blocks.length} narrowest=${row.narrowest}`,
      );
    }

    // The band's tokens, read as `rgb(...)` so they can be compared against what the browser
    // computed for the marks. The custom properties are authored as hex, and a hex string never
    // equals a computed `rgb()` reading even when the two are the same colour.
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const asRgb = (value) => {
        const probe = document.createElement('span');
        probe.style.color = value.trim();
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).color;
        probe.remove();
        return computed;
      };
      return {
        success: asRgb(style.getPropertyValue('--success')),
        warn: asRgb(style.getPropertyValue('--warn')),
        danger: asRgb(style.getPropertyValue('--danger')),
        meta: asRgb(style.getPropertyValue('--meta')),
        idle: asRgb(style.getPropertyValue('--border')),
      };
    });

    // The band itself, asserted on the colours the browser painted: each row must carry the
    // verdict its own rate falls in. This is what a fixed-band rule can get wrong that a ramp
    // could not - a boundary off by one step, or one branch wired to the wrong token.
    const expected = {
      'healthy-rate': tokens.success,
      'degraded-rate': tokens.warn,
      'outage-rate': tokens.danger,
      // The boundaries are inclusive of the band above them: exactly 80% is healthy, and exactly
      // 50% is degraded rather than broken.
      'healthy-boundary-rate': tokens.success,
      'degraded-boundary-rate': tokens.warn,
    };
    for (const [id, token] of Object.entries(expected)) {
      const row = marks.find((candidate) => candidate.name === id);
      if (!row) continue;
      // The traffic sits in the newest bucket: that block carries the band, and every earlier one
      // is the idle track, so a strip that painted the window rate across every block, or put the
      // traffic in the wrong bucket, fails here.
      check(
        `${theme}: the ${id} row's newest block carries its band's colour and the rest are idle`,
        row.blocks.at(-1) === token && row.blocks.slice(0, -1).every((fill) => fill === tokens.idle),
        `blocks=${JSON.stringify(row.blocks)} token=${token} idle=${tokens.idle}`,
      );
      check(
        `${theme}: the ${id} row's rate number carries its band's colour`,
        row.rateColor === token,
        `painted=${row.rateColor} token=${token}`,
      );
    }

    // A window with no traffic is unknowable, not failing: its number is the neutral ink and its
    // strip is all track, and neither may take the alarm end, which is what an implementation
    // defaulting the rate to zero would paint. Asserted against the tokens rather than against
    // "not danger": the weaker form would also pass for a row painted in the accent.
    const empty = marks.find((candidate) => candidate.name === 'no-traffic-rate');
    if (empty) {
      check(
        `${theme}: a window with no traffic is painted neutral, with an idle strip`,
        empty.rateColor === tokens.meta && empty.blocks.length > 0 && empty.blocks.every((fill) => fill === tokens.idle),
        `rate=${empty.rateColor} blocks=${JSON.stringify(empty.blocks)} meta=${tokens.meta} idle=${tokens.idle}`,
      );
    }

    // The three verdicts and the idle track must be four different colours, or the strip cannot be
    // read: an idle block that matched a band would claim traffic nobody sent.
    const painted = ['healthy-rate', 'degraded-rate', 'outage-rate']
      .map((id) => marks.find((candidate) => candidate.name === id)?.blocks.at(-1))
      .filter((fill) => fill !== undefined);
    check(
      `${theme}: the three bands and the idle track are four distinct colours`,
      painted.length === 3 && new Set([...painted, tokens.idle]).size === 4,
      `painted=${JSON.stringify(painted)} idle=${tokens.idle}`,
    );
  }

  // The gaps between blocks belong to the strip. A pointer that crosses one on its way to a block
  // must read that block alone: the strip's whole history answers keyboard focus, and opening it
  // here would stack a viewport-tall list over the reading the operator pointed at.
  const healthyBlocks = page
    .locator('.provider-row-enhanced')
    .filter({ hasText: 'healthy-rate' })
    .locator('.provider-activity-block');
  await healthyBlocks.last().scrollIntoViewIfNeeded();
  const lastBlock = await healthyBlocks.last().boundingBox();
  await page.mouse.move(lastBlock.x - 1, lastBlock.y + lastBlock.height / 2);
  await page.mouse.move(lastBlock.x + lastBlock.width / 2, lastBlock.y + lastBlock.height / 2, { steps: 2 });
  const blockHint = page.locator('.ant-tooltip:not(.ant-tooltip-hidden)').filter({ hasText: '%' });
  await blockHint.first().waitFor({ state: 'visible', timeout: 5_000 });
  const historyShown = await page.locator('.provider-activity-history').evaluateAll(
    (nodes) => nodes.some((node) => node.getClientRects().length > 0),
  );
  check(
    'a pointer crossing the activity strip opens only the block it rests on',
    !historyShown && await blockHint.count() === 1,
    `history=${historyShown} hints=${await blockHint.count()}`,
  );
  await page.mouse.move(0, 0);

  // A block sits inside a row that is itself a link. A click on the reading must not take the
  // operator away from the page before they can use the strip's hint.
  await page
    .locator('.provider-row-enhanced')
    .filter({ hasText: 'healthy-rate' })
    .locator('.provider-activity-block')
    .last()
    .click();
  check(
    'clicking an activity block leaves the dashboard open',
    new URL(page.url()).pathname.endsWith('/dashboard'),
    page.url(),
  );

  await assertProviderFold({ base, page, check });
  await assertPhoneOmitsStrip({ base, page, check });
}

/**
 * A phone keeps the rate and the request count but omits the strip.
 *
 * The strip is a React decision, not a stylesheet rule: below the phone breakpoint the component
 * does not render it at all, so this is the layer where the omission is observable. The row and its
 * rate must remain, or the narrower layout would have removed the verdict along with the detail.
 */
async function assertPhoneOmitsStrip({ base, page, check }) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await waitForProviderWindow(page, false);
  const marks = await page.evaluate(READ_MARKS);
  const healthy = marks.find((candidate) => candidate.name === 'healthy-rate');
  check(
    'a phone keeps the provider rate and request count but omits the activity strip',
    marks.length === ROWS.length
      && marks.every((row) => row.blocks.length === 0)
      && Boolean(healthy?.rate.includes('92.44') && healthy.total.trim() !== ''),
    JSON.stringify(marks.map(({ name, rate, total, blocks }) => ({ name, rate, total, blocks: blocks.length }))),
  );
}

/** A fleet past the panel's preview limit, so the fold has rows to hide. */
const FOLD_FLEET_SIZE = 12;
const FOLD_PREVIEW_LIMIT = 8;

const READ_FOLD = `(() => ({
  rows: document.querySelectorAll('.provider-row-enhanced').length,
  toggle: document.querySelector('.provider-list-toggle')?.getAttribute('aria-expanded') ?? null,
}))()`;

/**
 * A long fleet folds behind a toggle instead of pushing every panel below it off the page.
 *
 * Asserted in the browser because the fold is a rendered property: the aggregation still returns
 * every row, and only the panel decides how many of them reach the page.
 */
async function assertProviderFold({ base, page, check }) {
  // Page routes outrank the scenario's context routes, so this fleet replaces the six-row one.
  await page.route('**/omc/api/v1/management/providers**', (route) => route.fulfill({
    status: 200,
    json: {
      providers: Array.from({ length: FOLD_FLEET_SIZE }, (_, i) => ({
        id: `fold-${i}`, family: 'openai-compatibility', name: `fold-${i}`, upstream_name: `fold-${i}`, disabled: false, key_configured: true,
      })),
      total: FOLD_FLEET_SIZE,
    },
  }));
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  const toggle = page.locator('.provider-list-toggle');
  await toggle.waitFor({ timeout: 20_000 });

  const folded = await page.evaluate(READ_FOLD);
  check(
    'a fleet past the preview limit shows only the preview, behind a collapsed toggle',
    folded.rows === FOLD_PREVIEW_LIMIT && folded.toggle === 'false',
    JSON.stringify(folded),
  );

  await toggle.click();
  await page.waitForFunction((size) => document.querySelectorAll('.provider-row-enhanced').length === size, FOLD_FLEET_SIZE, { timeout: 5_000 }).catch(() => {});
  const expanded = await page.evaluate(READ_FOLD);
  check('the toggle reveals every provider', expanded.rows === FOLD_FLEET_SIZE && expanded.toggle === 'true', JSON.stringify(expanded));

  await toggle.click();
  await page.waitForFunction((limit) => document.querySelectorAll('.provider-row-enhanced').length === limit, FOLD_PREVIEW_LIMIT, { timeout: 5_000 }).catch(() => {});
  const refolded = await page.evaluate(READ_FOLD);
  check('the toggle folds the list again', refolded.rows === FOLD_PREVIEW_LIMIT && refolded.toggle === 'false', JSON.stringify(refolded));

  await page.unroute('**/omc/api/v1/management/providers**');
}

/**
 * The window the fixture describes: an hour on five-minute blocks. It is aligned to the grid so the
 * strip has exactly one block per bucket, which is what lets the probe name the block count.
 */
const STRIP_BUCKET_MS = 300_000;
const STRIP_BLOCKS = 12;
const STRIP_TO_MS = Math.floor(Date.now() / STRIP_BUCKET_MS) * STRIP_BUCKET_MS;
const STRIP_FROM_MS = STRIP_TO_MS - STRIP_BLOCKS * STRIP_BUCKET_MS;
const NEWEST_BUCKET_MS = STRIP_TO_MS - STRIP_BUCKET_MS;

/** A row's whole window, served inside the newest bucket. */
function trafficRow(id, total, success) {
  const failure = total - success;
  return {
    id,
    total,
    success,
    failure,
    success_rate: (success / total) * 100,
    buckets: [{ start_ms: NEWEST_BUCKET_MS, total, failure }],
  };
}

/**
 * The dashboard's provider traffic, as the endpoint answers it for this scenario's window.
 *
 * Rates are chosen so each row lands in a different band, and the no-traffic row is supplied only
 * by the configured-provider list - it has no entry here at all, which is how a real deployment
 * looks before a channel is used. The counts are each rate's own numerator and denominator, so the
 * fixture cannot describe a window whose parts disagree with its rate.
 */
export const providerRateTraffic = {
  window: { preset: '1h', from: STRIP_FROM_MS, to: STRIP_TO_MS, bucket_ms: 60_000 },
  bucket_ms: STRIP_BUCKET_MS,
  providers: [
    trafficRow('healthy-rate', 10_000, 9_244),
    trafficRow('degraded-rate', 10_000, 7_091),
    trafficRow('outage-rate', 40, 0),
    trafficRow('healthy-boundary-rate', 50, 40),
    trafficRow('degraded-boundary-rate', 50, 25),
  ],
  partial_errors: [],
};

/** The configured providers the rows are aggregated from, including the unused channel. They are
 *  OpenAI-compatible because CPA labels those by their own name, which is the window's row id. */
export const providerRateProviders = {
  providers: [
    { id: 'healthy-rate', family: 'openai-compatibility', name: 'healthy-rate', upstream_name: 'healthy-rate', disabled: false, key_configured: true },
    { id: 'degraded-rate', family: 'openai-compatibility', name: 'degraded-rate', upstream_name: 'degraded-rate', disabled: false, key_configured: true },
    { id: 'outage-rate', family: 'openai-compatibility', name: 'outage-rate', upstream_name: 'outage-rate', disabled: false, key_configured: true },
    { id: 'no-traffic-rate', family: 'openai-compatibility', name: 'no-traffic-rate', upstream_name: 'no-traffic-rate', disabled: false, key_configured: true },
    { id: 'healthy-boundary-rate', family: 'openai-compatibility', name: 'healthy-boundary-rate', upstream_name: 'healthy-boundary-rate', disabled: false, key_configured: true },
    { id: 'degraded-boundary-rate', family: 'openai-compatibility', name: 'degraded-boundary-rate', upstream_name: 'degraded-boundary-rate', disabled: false, key_configured: true },
  ],
  total: 6,
};

/** The overview the panel falls back to, with no traffic of its own. */
export const providerRateOverview = {
  cpa: { connected: true, version: 'probe', latency_ms: 1 },
  counts: { management_keys: 1, provider_keys: 6, credentials: 6, models: 1 },
  providers: [],
  credentials: { total: 6, active: 6, disabled: 0, unavailable: 0, by_type: [] },
  traffic: { bucket_minutes: 10, window_minutes: 60, buckets: [], total_success: 0, total_failure: 0, total: 0, success_rate: null },
  partial_errors: [],
};
