/**
 * The dashboard's provider rows: the rate meter carries the band its rate falls in.
 *
 * A provider row prints a rate and draws it as one meter, coloured by the console's published
 * success-rate band. The claim that it *does* is not reachable by any logic test: it is a property
 * of what the browser computed for an element whose colour comes from a theme token, and a token
 * wired to the wrong name reads correctly on the dark page and wrong on the light one. So the
 * probe compares the painted colour against the token the band names, in both themes.
 *
 * Four rates are asserted, one per verdict plus the absent case: a healthy row, a degraded one, a
 * measured total outage, and a fresh row with no traffic at all. The last two are the pair a band
 * implementation is most likely to conflate - a rate defaulted to zero would paint the idle row as
 * an outage - so they are asserted to differ from each other and from the healthy row.
 *
 * The row also has to render its numbers at all: a panel that failed to aggregate still paints an
 * empty meter, and a probe that only read colours would call that a pass.
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
 * Reads, per row, the rate it printed, the token-quoted colour its meter painted, and how far the
 * meter's fill actually reached.
 *
 * The meter is read from the element itself rather than from the row's style attribute, so what is
 * compared is the colour the browser resolved. The width is read as a rendered box, not as the
 * percentage in the style: a meter with a width and no paint, or one collapsed by its flex parent,
 * is a meter the reader cannot see.
 */
const READ_MARKS = `(() => {
  const rows = [...document.querySelectorAll('.provider-row-enhanced')];
  return rows.map((row) => {
    const meter = row.querySelector('.dashboard-meter span');
    const track = row.querySelector('.dashboard-meter');
    return {
      name: row.querySelector('.provider-title')?.textContent ?? '',
      rate: row.querySelector('.provider-rate')?.textContent ?? '',
      total: row.querySelector('.provider-total')?.textContent ?? '',
      rateColor: row.querySelector('.provider-rate') ? getComputedStyle(row.querySelector('.provider-rate')).color : null,
      meterFill: meter ? getComputedStyle(meter).backgroundColor : null,
      meterOpacity: meter ? getComputedStyle(meter).opacity : null,
      meterBox: meter ? meter.getBoundingClientRect().width : 0,
      trackBox: track ? track.getBoundingClientRect().width : 0,
    };
  });
})()`;

/** The mode the console actually applied, which is what the colour assertions are about. */
const READ_THEME_MODE = `document.documentElement.getAttribute('data-theme-mode')`;

export async function providerRateMarks({ base, page, check }) {
  // The fixture has to describe a window the endpoint could actually have produced. The server
  // derives `success` and `failure` from the rows it scanned, so a fixture whose parts contradict
  // its own rate - 92 of 100 at 92.44% - is a fixture that would let a client which recomputed the
  // rate from the counts diverge from one which trusted the wire, with the probe still green.
  const inconsistent = providerRateTraffic.providers.filter((row) => {
    const derived = row.total > 0 ? (row.success / row.total) * 100 : null;
    return row.success + row.failure !== row.total || (derived !== null && Math.abs(derived - row.success_rate) > 1e-9);
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

    // The rows arrive from a second query, so the page is painted before they exist.
    await page
      .locator('.provider-row-enhanced')
      .first()
      .waitFor({ timeout: 20_000 });

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
        // And its meter draws nothing, because there is no rate to draw. A zero-width fill is the
        // honest mark here; a full one would claim a rate the window never measured.
        check(
          `${theme}: the ${id} row's meter draws nothing rather than a full bar`,
          row.meterBox === 0,
          `meterWidth=${row.meterBox} trackWidth=${row.trackBox}`,
        );
      } else {
        // A row with traffic must print its numbers and draw a fill the reader can see.
        check(
          `${theme}: the ${id} row printed its rate and volume`,
          row.rate.includes(rate.toFixed(2)) && row.total.trim() !== '' && row.total.trim() !== '0',
          `rate=${JSON.stringify(row.rate)} total=${JSON.stringify(row.total)}`,
        );
        // The meter's width tracks the rate, so its length is asserted rather than assumed: a
        // panel that failed to aggregate would draw nothing at all, and a row whose fill overran
        // its track would be a layout defect the colour checks cannot see. At exactly 0% the
        // expected width is 0 - the fill *is* the rate - which is why the band is also carried by
        // the number (asserted below) rather than by this mark alone.
        const low = (rate / 100) * row.trackBox;
        check(
          `${theme}: the ${id} row's meter spans its rate`,
          row.trackBox > 0 && Math.abs(row.meterBox - low) <= 2,
          `rate=${rate} meter=${row.meterBox} expected=${low.toFixed(1)} track=${row.trackBox}`,
        );
      }
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
      check(
        `${theme}: the ${id} row's meter carries its band's colour`,
        row.meterFill === token,
        `painted=${row.meterFill} token=${token}`,
      );
      // The number carries it too, and that is what makes the band reachable at a measured 0%:
      // the meter's fill *is* the rate, so the worst row on the page has no width to paint.
      check(
        `${theme}: the ${id} row's rate number carries its band's colour`,
        row.rateColor === token,
        `painted=${row.rateColor} token=${token}`,
      );
    }

    // A window with no traffic is unknowable, not failing: it carries the neutral ink on both
    // marks, and must not take the alarm end, which is what an implementation defaulting the rate
    // to zero would paint. Asserted against the token rather than against "not danger": the
    // weaker form would also pass for a row painted in the accent, which is not the neutral state
    // this row is supposed to be in.
    const empty = marks.find((candidate) => candidate.name === 'no-traffic-rate');
    if (empty) {
      check(
        `${theme}: a window with no traffic is painted neutral on both marks`,
        empty.meterFill === tokens.meta && empty.rateColor === tokens.meta,
        `meter=${empty.meterFill} rate=${empty.rateColor} expected=${tokens.meta}`,
      );
    }

    // The three verdicts must be three different colours, or the band is not a band.
    const painted = ['healthy-rate', 'degraded-rate', 'outage-rate']
      .map((id) => marks.find((candidate) => candidate.name === id)?.meterFill)
      .filter((fill) => fill !== undefined);
    check(
      `${theme}: the three bands are three distinct colours`,
      painted.length === 3 && new Set(painted).size === 3,
      `painted=${JSON.stringify(painted)}`,
    );
  }
}

/**
 * The dashboard's provider traffic, as the endpoint answers it for this scenario's window.
 *
 * Rates are chosen so each row lands in a different band, and the no-traffic row is supplied only
 * by the configured-provider list - it has no entry here at all, which is how a real deployment
 * looks before a channel is used.
 */
export const providerRateTraffic = {
  window: { preset: '1h', from: Date.now() - 3_600_000, to: Date.now(), bucket_ms: 60_000 },
  // The counts are the decimals' own numerator and denominator, so the fixture cannot describe a
  // window whose parts disagree with its rate. The endpoint derives `total`/`success`/`failure`
  // from the rows it scanned, so a fixture that says 92 of 100 at 92.44% is describing a state the
  // server could never produce.
  providers: [
    { id: 'healthy-rate', total: 10_000, success: 9_244, failure: 756, success_rate: 92.44 },
    { id: 'degraded-rate', total: 10_000, success: 7_091, failure: 2_909, success_rate: 70.91 },
    { id: 'outage-rate', total: 40, success: 0, failure: 40, success_rate: 0 },
    { id: 'healthy-boundary-rate', total: 50, success: 40, failure: 10, success_rate: 80 },
    { id: 'degraded-boundary-rate', total: 50, success: 25, failure: 25, success_rate: 50 },
  ],
  partial_errors: [],
};

/** The configured providers the rows are aggregated from, including the unused channel. */
export const providerRateProviders = {
  providers: [
    { id: 'healthy-rate', family: 'codex-api-key', name: 'healthy-rate', upstream_name: 'healthy-rate', disabled: false, key_configured: true },
    { id: 'degraded-rate', family: 'cline-api-key', name: 'degraded-rate', upstream_name: 'degraded-rate', disabled: false, key_configured: true },
    { id: 'outage-rate', family: 'gemini-api-key', name: 'outage-rate', upstream_name: 'outage-rate', disabled: false, key_configured: true },
    { id: 'no-traffic-rate', family: 'deepseek-api-key', name: 'no-traffic-rate', upstream_name: 'no-traffic-rate', disabled: false, key_configured: true },
    { id: 'healthy-boundary-rate', family: 'openai-api-key', name: 'healthy-boundary-rate', upstream_name: 'healthy-boundary-rate', disabled: false, key_configured: true },
    { id: 'degraded-boundary-rate', family: 'moonshot-api-key', name: 'degraded-boundary-rate', upstream_name: 'degraded-boundary-rate', disabled: false, key_configured: true },
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
