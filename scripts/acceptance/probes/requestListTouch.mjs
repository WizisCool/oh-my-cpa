import { until } from '../harness.mjs';

/**
 * The request list under a finger.
 *
 * On a phone the list is the page's only scroller, and the browser scrolls it: the list is an
 * ordinary overflowing element there, not a virtualized one redrawn by script. A drag moves the list
 * and nothing around it, the header stays where it is, and at either end there is nothing else to
 * scroll and nothing to bounce.
 *
 * The drags are real touch input through the DevTools protocol, so the browser decides what scrolls,
 * exactly as it does for a finger. The probe waits on state or on frames, never on time.
 */
const STEP_PX = 10;
/** Frames a finger rests before lifting, so the release carries no speed. */
const REST_FRAMES = 8;

async function nextFrames(page, count = 1) {
  await page.evaluate((frames) => new Promise((resolve) => {
    const tick = (left) => (left === 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
    tick(frames);
  }), count);
}

/** Drags one finger from (x, fromY) to (x, toY), one step per frame, and lifts it at rest. */
async function drag(page, cdp, { x, fromY, toY }) {
  const touchAt = (y) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchAt(fromY) });
  const steps = Math.max(1, Math.round(Math.abs(toY - fromY) / STEP_PX));
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchAt(fromY + ((toY - fromY) * step) / steps) });
    await nextFrames(page);
  }
  await nextFrames(page, REST_FRAMES);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function tap(cdp, { x, y }) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The scroll offsets that matter, read in one go: the list's, the content pane's and the document's. */
function readScroll(page) {
  return page.evaluate(() => {
    const holder = document.querySelector('.request-list');
    const pane = document.querySelector('.app-content');
    return {
      list: Math.round(holder.scrollTop),
      listEnd: Math.round(holder.scrollHeight - holder.clientHeight),
      pane: Math.round(pane.scrollTop),
      paneOverflow: Math.round(pane.scrollHeight - pane.clientHeight),
      documentTop: Math.round(document.scrollingElement.scrollTop),
      isCollapsed: document.querySelector('.request-collapsible-header.is-collapsed') !== null,
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

export async function requestListTouch({ base, page, check }) {
  await page.goto(`${base}/usage/events?preset=24h&limit=100`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });
  await settle(page, () => page.evaluate(() => document.querySelector('.request-list-host')?.getBoundingClientRect().height), 'the request list to lay out');
  check('under a finger the list is an element the browser scrolls', await page.evaluate(() => {
    const holder = document.querySelector('.request-list');
    return getComputedStyle(holder).overflowY === 'auto' && holder.scrollHeight > holder.clientHeight;
  }));
  await page.evaluate(() => {
    window.__probeClicks = 0;
    window.addEventListener('click', () => { window.__probeClicks += 1; }, { capture: true });
  });
  const cdp = await page.context().newCDPSession(page);
  const box = await page.locator('.request-list-host').boundingBox();
  const x = box.x + box.width / 2;

  let state = await readScroll(page);
  check('on a phone the page fits the screen, so the list is its only scroller', state.paneOverflow <= 1 && state.documentTop === 0, JSON.stringify(state));

  // The first drag up scrolls the list, as any drag does: the header does not take it to fold.
  await drag(page, cdp, { x, fromY: box.y + box.height - 40, toY: box.y + box.height - 240 });
  await settle(page, () => readScroll(page), 'the dragged list to come to rest');
  state = await readScroll(page);
  check('a drag up moves the list and nothing around it, and leaves the header open',
    state.list > 100 && !state.isCollapsed && state.pane === 0 && state.documentTop === 0, JSON.stringify(state));

  const restingClicks = await page.evaluate(() => window.__probeClicks);
  await tap(cdp, { x, y: box.y + box.height / 2 });
  await until(async () => (await page.evaluate(() => window.__probeClicks)) > restingClicks, { label: 'the tap to arrive as a click' });
  const isDrawerOpen = () => page.evaluate(() => document.querySelector('.request-detail.ant-drawer-open, .ant-drawer-open .request-detail') !== null);
  await until(isDrawerOpen, { label: 'a tap on a resting row to open it' });
  check('a tap on a resting list opens the row', await isDrawerOpen());
  await page.keyboard.press('Escape');
  await until(async () => !(await isDrawerOpen()), { label: 'the request detail to close' });

  // Past either end there is nothing left to scroll and nothing to bounce.
  await page.evaluate(() => {
    const holder = document.querySelector('.request-list');
    holder.scrollTop = holder.scrollHeight;
  });
  await settle(page, () => readScroll(page), 'the list to reach its bottom');
  await drag(page, cdp, { x, fromY: box.y + box.height - 40, toY: box.y + 40 });
  await settle(page, () => readScroll(page), 'the list to rest at its bottom');
  state = await readScroll(page);
  check('a drag past the bottom of the list moves nothing around it', state.listEnd - state.list <= 1 && state.pane === 0 && state.documentTop === 0, JSON.stringify(state));

  await page.evaluate(() => { document.querySelector('.request-list').scrollTop = 0; });
  await until(async () => (await readScroll(page)).list === 0, { label: 'the list to return to its top' });
  await drag(page, cdp, { x, fromY: box.y + 40, toY: box.y + 240 });
  await settle(page, () => readScroll(page), 'the list to rest at its top');
  state = await readScroll(page);
  check('a pull down at the top moves nothing around the list and leaves the header open',
    state.list === 0 && !state.isCollapsed && state.pane === 0 && state.documentTop === 0, JSON.stringify(state));
}
