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

import { until } from '../harness.mjs';

/** The context is genuinely coarse, or every claim below is vacuous. */
const MEDIA = `({
  pointerCoarse: matchMedia('(pointer: coarse)').matches,
  hoverNone: matchMedia('(hover: none)').matches,
})`;

/**
 * How far a finger still hits each dense control, measured outward from its drawn box.
 *
 * A measurement rather than a boundary sample, and the difference is not academic. The first
 * version probed a fixed 3px or 4px outside the control and asked whether the point hit it, which
 * tests the exact edge of the hit area: the rule expands a control by 4px measured from its padding
 * box, a 1px border makes that 3px beyond the drawn box, and a point on exactly that boundary is
 * inside it on the top and left edges and outside it on the bottom and right ones. The result was
 * four controls reported as unreachable while the rule was working perfectly.
 *
 * Reading the reach instead removes the edge question entirely - "at least 3px" is a claim about
 * what a finger gets, and a boundary is not - and it reports the number it measured, so a failure
 * says how much slop the control actually has.
 *
 * Two things keep it honest, both of which the first version got wrong:
 *
 *   - **Off-screen is not a pass.** A point outside the viewport used to count as a hit, so a
 *     control 664px to the right of a 390px screen - the exact defect this adaptation exists to
 *     remove - passed the check that exists to catch it: all of its probes were off-screen, so all
 *     of them counted.
 *   - **Only the control and its descendants count.** An ancestor used to count too, which is what
 *     a point just outside the drawn box lands on when no hit area has been expanded at all - so the
 *     check passed precisely for the controls that had not been fixed. Tightening this is what found
 *     `.config-key-action`: the console's own dense controls are plain buttons rather than antd's
 *     icon-only variant, so the touch rule had never reached them.
 *
 * It measures controls that are **small in both dimensions**, which is the scope `docs/design.md` §8
 * states: a control that is wide - a labelled button, or any of the console's 32px-tall buttons - is
 * aimable even when it is short, so requiring 40px of height from it would be asserting a change the
 * design system deliberately does not make.
 *
 * A control that is not painted is skipped, and that is not a loophole: an affordance the reader is
 * not being offered cannot be unreachable. It is what one measured case turned out to be - antd's
 * clear affordance is `visibility: hidden` while its field has nothing to clear, so at those moments
 * it is not a control at all. It is skipped only when it is genuinely not hit-testable at its own
 * centre *and* hidden; a control that is merely covered by something else still fails, which is how
 * the ancestor-acceptance hole above was found.
 */

/**
 * The hit slop every dense control must have beyond its drawn box, in pixels.
 *
 * The rule's inset is 4px measured from the padding box, and a 1px border makes that 3px beyond the
 * drawn box - so 3 is the nominal figure and the floor is set one below it, because the measurement
 * walks outward in whole pixels from a fractional edge: a 32px control with a 3px nominal slop
 * measured 3px up and left and 2px down and right, which is the pixel grid rather than the rule.
 * The floor still distinguishes the two states it has to: a control whose hit area was never
 * expanded measures 0, and one whose expansion was shrunk to 2px measures 1.
 */
const MIN_HIT_SLOP = 2;

/** How far outward the measurement looks before it stops caring. */
const MAX_HIT_SLOP = 12;

const REACHABILITY = (selector) => `(() => {
  const MIN_SLOP = ${MIN_HIT_SLOP};
  const MAX_SLOP = ${MAX_HIT_SLOP};
  const controls = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const unreachable = [];
  for (const control of controls) {
    const box = control.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (box.width >= 40 || box.height >= 40) continue;
    if (getComputedStyle(control).visibility === 'hidden') continue;

    const hits = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === control || control.contains(hit)));
    };
    // One direction at a time, from the drawn edge outward, stopping at the first point that is not
    // the control or that leaves the viewport. Leaving the viewport stops the measurement rather than
    // failing it: a control against the screen's edge cannot have slop on the side that is off it,
    // and that direction is excluded from the floor below.
    const reach = (axis, sign) => {
      let furthest = 0;
      for (let step = 1; step <= MAX_SLOP; step += 1) {
        const x = axis === 'x'
          ? (sign < 0 ? box.left - step : box.right + step)
          : box.left + box.width / 2;
        const y = axis === 'y'
          ? (sign < 0 ? box.top - step : box.bottom + step)
          : box.top + box.height / 2;
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) break;
        if (!hits(x, y)) break;
        furthest = step;
      }
      return furthest;
    };

    const measured = {
      up: reach('y', -1),
      down: reach('y', 1),
      left: reach('x', -1),
      right: reach('x', 1),
    };
    // A direction is only required where there is room for it on screen.
    const required = [
      box.top >= MIN_SLOP ? measured.up : null,
      box.bottom + MIN_SLOP <= window.innerHeight ? measured.down : null,
      box.left >= MIN_SLOP ? measured.left : null,
      box.right + MIN_SLOP <= window.innerWidth ? measured.right : null,
    ].filter((value) => value !== null);

    if (required.length === 0 || Math.min(...required) < MIN_SLOP) {
      unreachable.push({
        node: control.tagName.toLowerCase() + (control.className ? '.' + String(control.className).split(/\\s+/)[0] : ''),
        label: control.getAttribute('aria-label') || control.textContent?.trim().slice(0, 20) || '',
        w: Math.round(box.width),
        h: Math.round(box.height),
        slop: measured,
        worstRequired: required.length === 0 ? 'off-screen' : Math.min(...required),
        // Whether the control is hit-testable at its own centre at all: a control covered by, or
        // not painted as part of, its own box reports zero slop for a different reason than one
        // whose hit area was never expanded.
        centre: hits(box.left + box.width / 2, box.top + box.height / 2),
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

/**
 * Whether a control that a hover reveals is actually drawn, and reachable, when no hover is possible.
 *
 * Three readings, because opacity alone is satisfied by an element nobody can reach: a node at full
 * opacity but `visibility: hidden` is invisible, and one that is drawn but covered by something is
 * unusable. The claim is that the affordance is offered, so the check has to be about the reader
 * being able to take it.
 */
const AFFORDANCE_STATE = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  const style = getComputedStyle(node);
  const box = node.getBoundingClientRect();
  const centreX = box.left + box.width / 2;
  const centreY = box.top + box.height / 2;
  const onScreen = centreX >= 0 && centreX <= window.innerWidth && centreY >= 0 && centreY <= window.innerHeight;
  const hit = onScreen ? document.elementFromPoint(centreX, centreY) : null;
  return {
    opacity: Number(style.opacity),
    visibility: style.visibility,
    width: Math.round(box.width),
    height: Math.round(box.height),
    hitTestable: onScreen ? Boolean(hit && (hit === node || node.contains(hit))) : null,
  };
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

  // Waited for rather than read immediately: the provider rows arrive from a second query, and
  // `.dashboard-page` is painted long before they do. Reading on the page's own readiness made this
  // check report a missing control for a panel that simply had not answered yet.
  await until(
    async () => (await page.locator('.provider-jump-arrow').count()) > 0,
    { label: "the dashboard's provider rows", timeoutMs: 10_000 },
  ).catch(() => {});
  const arrow = await page.evaluate(AFFORDANCE_STATE('.provider-jump-arrow'));
  check(
    'a control a hover would reveal is drawn and reachable where hovering is impossible',
    arrow !== null && arrow.opacity > 0 && arrow.visibility !== 'hidden',
    JSON.stringify(arrow),
  );

  // ---- the request list: the id quick-copy control, the search box, the row controls ----
  await page.goto(`${base}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });

  await until(
    async () => (await page.locator('.req-id-quick-copy').count()) > 0,
    { label: 'the request row quick-copy control', timeoutMs: 10_000 },
  ).catch(() => {});
  const quickCopy = await page.evaluate(AFFORDANCE_STATE('.req-id-quick-copy'));
  check(
    'the request id quick-copy control is drawn on a touch device',
    quickCopy !== null && quickCopy.opacity > 0 && quickCopy.visibility !== 'hidden',
    JSON.stringify(quickCopy),
  );

  // The filter drawer's icon controls are the case the expanded hit areas exist for: 32px squares
  // in a cluster, too small to hit without them.
  //
  // The drawer is measured only once its box has stopped moving. A drawer read mid-slide has every
  // control off the right edge, which the metric now reports as unreachable - correctly, but as a
  // fact about the instant it was read rather than about the control.
  await page.getByRole('button', { name: /更多筛选|More filters/i }).first().click();
  await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5_000 });
  const drawerBox = () => page.locator('.ant-drawer-content-wrapper').first().boundingBox();
  let previous = await drawerBox();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(50);
    const current = await drawerBox();
    if (current && previous && current.x === previous.x && current.width === previous.width) break;
    previous = current;
  }
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
