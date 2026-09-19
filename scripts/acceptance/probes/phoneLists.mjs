/**
 * Probes for the phone rendering of a list surface.
 *
 * ADR 0012 makes a list one dataset with two renderings, chosen by width: a table on a
 * pointer-fine viewport, labelled rows below 640px. Two claims are worth a real engine, and
 * neither can be made by reading the code:
 *
 *   1. **The phone rendering reaches the controls.** The reason for the change was measured -
 *      the key table is 980px inside a 316px card, which put the reveal, copy and edit buttons
 *      664px off the screen. "The row exists" would not test that; "every control is inside the
 *      viewport" does.
 *   2. **The width decides, and it decides once.** A probe that only looks at 390px cannot tell a
 *      responsive rendering from a layout that lost its table entirely. So each surface is read at
 *      both widths, and the pairing is the claim.
 *
 * The surfaces are listed rather than inlined so a new one is a row in this table and not a
 * second probe.
 */

/** One list surface, and the fixtures its page needs before it can render anything. */
const SURFACES = [
  {
    id: 'key management',
    route: '/api-keys',
    /** Present only while the table is drawn, so it also proves which branch rendered. */
    tableSelector: '.config-api-keys-table',
    rowSelector: '[data-testid="phone-row"]',
    routes: [
      [
        (url) => url.pathname.endsWith('/management/api-keys'),
        () => ({
          keys: [
            { index: 0, key: 'omc-fixture-key-aaaaaaaaaaaaaaaa', fingerprint: 'fp-1', usage_fingerprint: 'ufp-1', length: 30, alias: 'Primary caller', alias_version: 1 },
            { index: 1, key: 'omc-fixture-key-bbbbbbbbbbbbbbbb', fingerprint: 'fp-2', usage_fingerprint: 'ufp-2', length: 30, alias_version: 0 },
          ],
          total: 2,
        }),
      ],
      [
        (url) => url.pathname.endsWith('/management/client-key-usage'),
        () => ({
          window: { from: Date.now() - 86_400_000, to: Date.now() },
          usage: [
            { key_fingerprint: 'ufp-1', requests: 1284, failed: 3, total_tokens: 918_000, last_used_ms: Date.now() - 60_000 },
            { key_fingerprint: 'ufp-2', requests: 12, failed: 0, total_tokens: 4_000, last_used_ms: Date.now() - 3_600_000 },
          ],
        }),
      ],
      [
        (url) => url.pathname.endsWith('/management/config'),
        () => ({ scalars: {}, supported_keys: [], revision: 'fixture-r1', safe_yaml: 'api-keys:\n  - omc-fixture-key-aaaaaaaaaaaaaaaa\n  - omc-fixture-key-bbbbbbbbbbbbbbbb\n' }),
      ],
    ],
  },
  {
    id: 'ai providers',
    route: '/ai-providers',
    tableSelector: '.providers-page .ant-table',
    rowSelector: '[data-testid="phone-row"]',
    routes: [],
  },
  {
    id: 'plugin manager',
    route: '/plugins',
    tableSelector: '.ant-table',
    rowSelector: '[data-testid="phone-row"]',
    routes: [],
  },
  {
    id: 'cost & usage',
    route: '/pricing',
    tableSelector: '.ant-table',
    rowSelector: '[data-testid="phone-row"]',
    routes: [],
  },
  {
    id: 'error log files',
    route: '/logs',
    tableSelector: '.log-files .ant-table',
    rowSelector: '[data-testid="phone-row"]',
    routes: [],
    /** The list lives on the page's second tab, so the tab is part of arriving at it. */
    prepare: async (page) => {
      // Clicked by its tab id rather than its label: the label is localized, and the scenario runs
      // with the console's own stored language.
      const tab = page.locator('#rc-tabs-0-tab-errors');
      if (await tab.count()) await tab.click();
      else await page.locator('.ant-tabs-tab').last().click();
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'plugin store',
    route: '/plugin-store',
    tableSelector: '.ant-table',
    rowSelector: '[data-testid="phone-row"]',
    routes: [],
  },
];

/**
 * Whether an element's box is inside the viewport horizontally.
 *
 * Vertical extent is not part of this: a row below the fold is reachable by scrolling, which is
 * ordinary. A control 664px to the *right* is not reachable at all, and that is the defect the
 * phone rendering exists to remove.
 */
/**
 * Arrives at a surface, including any step inside the page a list is behind.
 *
 * The logs page keeps its error-file list on a tab, so "the route shows the list" is not a claim
 * every surface can make; `prepare` is where a surface says what its own page needs first.
 */
async function openSurface(base, page, surface, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(`${base}${surface.route}`, { waitUntil: 'domcontentloaded' });
  await surface.prepare?.(page);
  await page.locator(surface.rowSelector).first().waitFor({ state: 'visible', timeout: 20_000 });
}

/**
 * The controls a reader cannot actually use, for a reason the reader would experience.
 *
 * Vertical extent is deliberately not part of it: a row below the fold is reachable by scrolling,
 * which is ordinary. A control 664px to the *right* is not reachable at all, and that is the defect
 * the phone rendering exists to remove.
 *
 * Three ways a control is unusable, and the first version tested only the first - so it passed for a
 * control that was hidden, and for one something else was sitting on top of:
 *
 *   - **Outside the viewport horizontally.** The original measurement.
 *   - **Not painted.** `visibility: hidden` leaves a full-size box in the layout, so a geometry check
 *     passes while nothing is on screen. antd's clear affordance is exactly this while its field has
 *     nothing to clear.
 *   - **Not hit-testable at its own centre.** A bounding box says nothing about what a finger
 *     reaches, and a control the row was supposed to make usable cannot fail this one.
 */
const INSIDE_VIEWPORT = (selector) => `(() => {
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const outside = [];
  const unusable = [];
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const label = (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 24);
    if (rect.left < -1 || rect.right > window.innerWidth + 1) {
      outside.push({ text: label, left: Math.round(rect.left), right: Math.round(rect.right) });
      continue;
    }
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.opacity === '0') {
      unusable.push({ text: label, reason: 'not painted' });
      continue;
    }
    // The centre test applies only where the centre is on screen. A row below the fold is reachable
    // by scrolling - which this measurement deliberately does not treat as a defect - and
    // elementFromPoint answers null for a point outside the viewport, so testing it there would
    // report a control as covered by nothing.
    const centreY = rect.top + rect.height / 2;
    if (centreY < 0 || centreY > window.innerHeight) continue;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, centreY);
    if (!(hit && (hit === node || node.contains(hit)))) {
      unusable.push({
        text: label,
        reason: 'covered at its own centre',
        by: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).split(/\\s+/).slice(0, 1) : 'nothing',
      });
    }
  }
  return { total: nodes.length, outside, unusable, viewport: window.innerWidth };
})()`;

export async function phoneListRendering({ base, page, check }) {
  for (const surface of SURFACES) {
    // ---- the phone rendering ----
    await openSurface(base, page, surface, { width: 390, height: 844 });

    check(
      `${surface.id}: a phone renders rows rather than a table`,
      (await page.locator(surface.tableSelector).count()) === 0,
      `tables=${await page.locator(surface.tableSelector).count()} rows=${await page.locator(surface.rowSelector).count()}`,
    );

    // The claim the change was made for: the row is not merely present, its controls are
    // reachable. Checked on the buttons rather than on the row, because a row that fits while
    // its controls hang off the edge is exactly the table's failure with a different class name.
    const buttons = await page.evaluate(INSIDE_VIEWPORT(`${surface.rowSelector} button`));
    check(
      `${surface.id}: every row control is inside the phone's viewport and usable there`,
      buttons.total > 0 && buttons.outside.length === 0 && buttons.unusable.length === 0,
      `buttons=${buttons.total} outside=${JSON.stringify(buttons.outside)} unusable=${JSON.stringify(buttons.unusable)}`,
    );

    // And the page itself does not scroll sideways, which is the user-visible symptom of any
    // element the row left hanging: a page that scrolls horizontally on a phone is one the
    // reader keeps losing their place in.
    const overflow = await page.evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
    check(`${surface.id}: the page does not scroll sideways on a phone`, overflow <= 0, `overflow=${overflow}px`);

    // ---- the same surface on a pointer-fine viewport ----
    //
    // Read last, so a failure above is reported against the rendering it came from rather than
    // against a page whose viewport was moved mid-probe.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}${surface.route}`, { waitUntil: 'domcontentloaded' });
    await surface.prepare?.(page);
    await page.locator(surface.tableSelector).first().waitFor({ state: 'visible', timeout: 20_000 });
    check(
      `${surface.id}: a wide viewport still renders the table`,
      (await page.locator(surface.rowSelector).count()) === 0,
      `tables=${await page.locator(surface.tableSelector).count()} rows=${await page.locator(surface.rowSelector).count()}`,
    );
  }
}
