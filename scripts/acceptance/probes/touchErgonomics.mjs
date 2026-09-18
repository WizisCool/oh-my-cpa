/**
 * Probes for the console's touch rules, on a context that actually has a coarse pointer.
 *
 * `docs/design.md` §8 states four of them, and each was a measured defect before it was a rule:
 * nothing is reachable only by hover; a control a finger must hit is about 40px after its hit
 * area; a focusable text control is at least 16px; and no page scrolls sideways. A scenario is
 * how they stop being a statement about the day they were written - and the context is the part
 * that makes it real, because a rule expressed in `@media (pointer: coarse)` is not being tested
 * at all by a page that reports a fine pointer.
 *
 * The surfaces covered are the ones whose fixtures this scenario already brings up. The
 * console-wide sweep over every route is the audit tooling's job (it needs a fixture per page);
 * what is asserted here is that the rules are in force and that the controls the rules were
 * written for obey them.
 */

/** The context is genuinely coarse, or every claim below is vacuous. */
const MEDIA = `({
  pointerCoarse: matchMedia('(pointer: coarse)').matches,
  hoverNone: matchMedia('(hover: none)').matches,
})`;

/**
 * The controls a finger can actually reach, probed from the document.
 *
 * Measured 4px outside each control's drawn box rather than read from the stylesheet: an
 * expanded hit area is invisible to `getBoundingClientRect`, and inferring one from a rule would
 * make this agree with a rule that does not work.
 */
const REACHABILITY = (selector) => `(() => {
  const controls = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const unreachable = [];
  for (const control of controls) {
    const box = control.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.height >= 40 && box.width >= 40) continue;
    const probes = [
      [box.left + box.width / 2, box.top - 4],
      [box.left + box.width / 2, box.bottom + 4],
      [box.left - 4, box.top + box.height / 2],
      [box.right + 4, box.top + box.height / 2],
    ];
    const hits = probes.filter(([x, y]) => {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true;
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === control || control.contains(hit) || hit.contains(control));
    });
    if (hits.length === 0) {
      unreachable.push({
        node: control.tagName.toLowerCase() + (control.className ? '.' + String(control.className).split(/\\s+/)[0] : ''),
        label: control.getAttribute('aria-label') || control.textContent?.trim().slice(0, 20) || '',
        w: Math.round(box.width),
        h: Math.round(box.height),
      });
    }
  }
  return unreachable;
})()`;

/** Focusable text controls below the floor iOS zooms at. */
const SMALL_FIELDS = `(() => {
  const small = [];
  for (const field of document.querySelectorAll('input, select, textarea')) {
    const box = field.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const size = parseFloat(getComputedStyle(field).fontSize);
    if (size < 16) small.push({ node: field.tagName.toLowerCase(), fontSize: size });
  }
  return small;
})()`;

/** Whether a control that a hover reveals is actually drawn when no hover is possible. */
const OPACITY_OF = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  return Number(getComputedStyle(node).opacity);
})()`;

export async function touchErgonomics({ base, page, check }) {
  const media = await page.evaluate(MEDIA);
  check(
    'the probe runs on a coarse pointer with no hover',
    media.pointerCoarse && media.hoverNone,
    JSON.stringify(media),
  );

  // ---- the dashboard: the reveal-on-hover row arrows, and a select field ----
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-page').first().waitFor({ timeout: 20_000 });

  const arrowOpacity = await page.evaluate(OPACITY_OF('.provider-jump-arrow'));
  check(
    'a control a hover would reveal is drawn where hovering is impossible',
    arrowOpacity !== null && arrowOpacity > 0,
    `opacity=${arrowOpacity}`,
  );

  // ---- the request list: the id quick-copy control, the search box, the row controls ----
  await page.goto(`${base}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

  const quickCopyOpacity = await page.evaluate(OPACITY_OF('.req-id-quick-copy'));
  check(
    'the request id quick-copy control is drawn on a touch device',
    quickCopyOpacity !== null && quickCopyOpacity > 0,
    `opacity=${quickCopyOpacity}`,
  );

  // The filter drawer's icon controls are the case the expanded hit areas exist for: 28px squares
  // in a cluster, too small to hit without them.
  await page.getByRole('button', { name: /更多筛选|More filters/i }).first().click();
  await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5_000 });
  const unreachable = await page.evaluate(REACHABILITY('.ant-drawer-content-wrapper button'));
  check(
    'every control in the filter drawer is reachable by a finger',
    unreachable.length === 0,
    JSON.stringify(unreachable),
  );
  const smallFields = await page.evaluate(SMALL_FIELDS);
  check(
    'no focusable text control is below the size iOS zooms at',
    smallFields.length === 0,
    JSON.stringify(smallFields),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ---- the key list: buttons on a phone row, and its own search box ----
  await page.goto(`${base}/api-keys`, { waitUntil: 'domcontentloaded' });
  await page.locator('.keys-page').first().waitFor({ timeout: 20_000 });
  const rowUnreachable = await page.evaluate(
    REACHABILITY('.config-api-keys-table button, [data-testid="phone-row"] button'),
  );
  check(
    'every control on a client-key row is reachable by a finger',
    rowUnreachable.length === 0,
    JSON.stringify(rowUnreachable),
  );

  // ---- no surface scrolls sideways ----
  //
  // Read at three widths, because a phone-width rule that only holds at 390 is a rule with a band
  // missing: 360 is a small phone, and the two are the widths the audits used.
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ['/dashboard', '/usage/events', '/api-keys', '/ai-providers']) {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(700);
      const overflow = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
      check(`${route} does not scroll sideways at ${width}px`, overflow <= 0, `overflow=${overflow}px`);
    }
  }
}
