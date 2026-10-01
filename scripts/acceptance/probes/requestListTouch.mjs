import { until } from '../harness.mjs';

/**
 * The request list under a finger (`web/src/components/usage/requestListTouch.ts`, docs/design.md
 * §7 "A finger moves the list, and folds and unfolds the header").
 *
 * On a phone the list is the page's only scroller. It moves exactly as far as the finger does,
 * coasts after a flick, and stops on a tap. At either end there is nothing else to scroll and
 * nothing to bounce. The header folds away on the first drag up, as it does on the first wheel
 * notch, and a deliberate pull down past the top unfolds it again.
 *
 * The drags are real touch input through the DevTools protocol, so the browser decides what scrolls,
 * exactly as it does for a finger. A drag moves one step per frame, the way a finger reports, and the
 * probe waits on state or on frames, never on time.
 */
const SLOW_STEP_PX = 10;
const FLICK_STEP_PX = 40;
/** Frames a finger rests before lifting: long enough that the release carries no speed. */
const REST_FRAMES = 8;
/** How far the list may stand from the finger's travel: a rounding, and one re-measured row edge. */
const TRACK_PX = 2;

async function nextFrames(page, count = 1) {
  await page.evaluate((frames) => new Promise((resolve) => {
    const tick = (left) => (left === 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
    tick(frames);
  }), count);
}

function listOffset(page) {
  return page.evaluate(() => document.querySelector('[data-probe-holder]').scrollTop);
}

/**
 * Drags one finger from (x, fromY) to (x, toY), one step per frame, and lifts it after `restFrames`
 * still frames. Returns how far the list stood from the finger's travel at its worst, read after
 * every step once the list has started to move: the browser holds back the moves inside its touch
 * slop, so the first step may not have reached the page at all.
 */
async function drag(page, cdp, { x, fromY, toY, stepPx = SLOW_STEP_PX, restFrames = REST_FRAMES }) {
  const touchAt = (y) => [{ x, y, id: 1 }];
  const startOffset = await listOffset(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchAt(fromY) });
  const steps = Math.max(1, Math.round(Math.abs(toY - fromY) / stepPx));
  let worstDrift = 0;
  for (let step = 1; step <= steps; step += 1) {
    const y = fromY + ((toY - fromY) * step) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchAt(y) });
    // A move is delivered with the next frame, as the browser aligns continuous input to frames.
    await nextFrames(page);
    const offset = await listOffset(page);
    if (offset !== startOffset) worstDrift = Math.max(worstDrift, Math.abs(offset - startOffset - (fromY - y)));
  }
  await nextFrames(page, restFrames);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return worstDrift;
}

async function tap(cdp, { x, y }) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The scroll offsets that matter, read in one go: the list's, the content pane's and the document's. */
function readScroll(page) {
  return page.evaluate(() => {
    const holder = document.querySelector('[data-probe-holder]');
    const pane = document.querySelector('.app-content');
    const pagination = document.querySelector('.request-pagination')?.getBoundingClientRect();
    return {
      list: Math.round(holder.scrollTop),
      listEnd: Math.round(holder.scrollHeight - holder.clientHeight),
      pane: Math.round(pane.scrollTop),
      paneOverflow: Math.round(pane.scrollHeight - pane.clientHeight),
      documentTop: Math.round(document.scrollingElement.scrollTop),
      isCollapsed: document.querySelector('.request-collapsible-header.is-collapsed') !== null,
      paginationBottom: pagination ? Math.round(pagination.bottom) : null,
      viewportHeight: innerHeight,
    };
  });
}

/** Waits until `read` returns the same value on consecutive frames. */
async function settle(page, read, label) {
  let previous;
  await until(async () => {
    const current = JSON.stringify(await read());
    const isStable = current === previous;
    previous = current;
    if (!isStable) await nextFrames(page);
    return isStable;
  }, { label });
}

const listGeometry = (page) => page.evaluate(() => {
  const host = document.querySelector('.request-list-host')?.getBoundingClientRect();
  return [host?.top, host?.height];
});

export async function requestListTouch({ base, page, check }) {
  await page.goto(`${base}/usage/events?preset=24h&limit=100`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });
  await settle(page, () => listGeometry(page), 'the request list to lay out');
  // The virtualizer's holder is the element that scrolls: it clips its overflow and holds far more
  // than it shows. Found by that shape rather than by the library's class names.
  const hasHolder = await page.evaluate(() => {
    const holder = [...document.querySelector('.request-list-host').querySelectorAll('*')].find(
      (node) => node.scrollHeight > node.clientHeight + 1_000 && getComputedStyle(node).overflowY === 'hidden',
    );
    holder?.setAttribute('data-probe-holder', '');
    return Boolean(holder);
  });
  check('the request list has a virtualized holder', hasHolder);
  await page.evaluate(() => {
    window.__probeClicks = 0;
    window.addEventListener('click', () => { window.__probeClicks += 1; }, { capture: true });
  });
  const cdp = await page.context().newCDPSession(page);
  const hostBox = async () => page.locator('.request-list-host').boundingBox();

  let state = await readScroll(page);
  check('on a phone the page fits the screen, so the list is its only scroller', state.paneOverflow <= 1 && state.documentTop === 0, JSON.stringify(state));

  // The first drag up folds the header and leaves row one where it is, as the first wheel notch does.
  let box = await hostBox();
  const x = box.x + box.width / 2;
  await drag(page, cdp, { x, fromY: box.y + Math.min(box.height - 10, 90), toY: box.y + 10 });
  await until(async () => (await readScroll(page)).isCollapsed, { label: 'the first drag up to fold the header' });
  await settle(page, () => listGeometry(page), 'the header to fold');
  state = await readScroll(page);
  check('the first drag up folds the header and leaves row one in place', state.isCollapsed && state.list === 0 && state.pane === 0, JSON.stringify(state));
  check('with the header folded the page still fits, footer included', state.paneOverflow <= 1 && state.paginationBottom !== null && state.paginationBottom <= state.viewportHeight, JSON.stringify(state));

  // The list moves exactly as far as the finger, on every step, and a finger that rests before
  // lifting leaves it there. Running ahead of the finger is what the list's own touch emulation did.
  box = await hostBox();
  const drift = await drag(page, cdp, { x, fromY: box.y + box.height - 60, toY: box.y + box.height - 260 });
  state = await readScroll(page);
  check('a drag moves the list exactly as far as the finger, and nothing around it', drift <= TRACK_PX && Math.abs(state.list - 200) <= TRACK_PX && state.pane === 0 && state.documentTop === 0, `drift=${Math.round(drift)} ${JSON.stringify(state)}`);

  // A flick coasts on after the finger lifts, and comes to rest by itself.
  const beforeFlick = state.list;
  await drag(page, cdp, { x, fromY: box.y + box.height - 60, toY: box.y + box.height - 260, stepPx: FLICK_STEP_PX, restFrames: 0 });
  await settle(page, () => listOffset(page), 'a flicked list to come to rest');
  state = await readScroll(page);
  check('a flick coasts on after the finger lifts', state.list - beforeFlick > 200 + 100, `travelled=${state.list - beforeFlick} ${JSON.stringify(state)}`);

  // A tap on a coasting list stops it and only stops it; a tap on a resting list opens the row.
  await drag(page, cdp, { x, fromY: box.y + box.height - 60, toY: box.y + box.height - 260, stepPx: FLICK_STEP_PX, restFrames: 0 });
  const coastingFrom = await listOffset(page);
  await nextFrames(page, 3);
  const isCoasting = (await listOffset(page)) !== coastingFrom;
  const clicksBefore = await page.evaluate(() => window.__probeClicks);
  await tap(cdp, { x, y: box.y + box.height / 2 });
  await until(async () => (await page.evaluate(() => window.__probeClicks)) > clicksBefore, { label: 'the tap to arrive as a click' });
  const stoppedAt = await listOffset(page);
  await nextFrames(page, 3);
  const afterStop = await listOffset(page);
  const isDrawerOpen = () => page.evaluate(() => document.querySelector('.request-detail.ant-drawer-open, .ant-drawer-open .request-detail') !== null);
  check('a tap on a coasting list stops it without opening a row', isCoasting && afterStop === stoppedAt && !(await isDrawerOpen()), `isCoasting=${isCoasting} stoppedAt=${stoppedAt} after=${afterStop}`);
  const restingClicks = await page.evaluate(() => window.__probeClicks);
  await tap(cdp, { x, y: box.y + box.height / 2 });
  await until(async () => (await page.evaluate(() => window.__probeClicks)) > restingClicks, { label: 'the tap to arrive as a click' });
  await until(isDrawerOpen, { label: 'a tap on a resting row to open it' });
  check('a tap on a resting list opens the row', await isDrawerOpen());
  await page.keyboard.press('Escape');
  await until(async () => !(await isDrawerOpen()), { label: 'the request detail to close' });

  // Past the bottom of the list there is nothing left to scroll and nothing to bounce. The list
  // grows as it measures the rows it reaches, so it is sent to its end until it stays there.
  await until(async () => {
    await page.evaluate(() => {
      const holder = document.querySelector('[data-probe-holder]');
      holder.scrollTop = holder.scrollHeight;
    });
    await nextFrames(page, 2);
    const current = await readScroll(page);
    return current.listEnd - current.list <= 1;
  }, { label: 'the list to reach its bottom' });
  box = await hostBox();
  await drag(page, cdp, { x, fromY: box.y + box.height - 40, toY: box.y + 40 });
  state = await readScroll(page);
  check('a drag past the bottom of the list moves nothing around it', state.listEnd - state.list <= 1 && state.pane === 0 && state.documentTop === 0, JSON.stringify(state));

  // Back at the top, a short pull is a drag that arrived; only a deliberate pull unfolds the header.
  await page.evaluate(() => {
    document.querySelector('[data-probe-holder]').scrollTop = 0;
  });
  await until(async () => (await readScroll(page)).list === 0, { label: 'the list to return to its top' });
  await drag(page, cdp, { x, fromY: box.y + 40, toY: box.y + 70 });
  state = await readScroll(page);
  check('a short pull at the top leaves the header folded', state.isCollapsed && state.pane === 0, JSON.stringify(state));
  await drag(page, cdp, { x, fromY: box.y + 40, toY: box.y + 140 });
  await until(async () => !(await readScroll(page)).isCollapsed, { label: 'a pull down past the top to unfold the header' });
  await settle(page, () => listGeometry(page), 'the header to unfold');
  state = await readScroll(page);
  check('a pull down past the top of the list unfolds the header', !state.isCollapsed && state.list === 0 && state.pane === 0 && state.documentTop === 0, JSON.stringify(state));
}
