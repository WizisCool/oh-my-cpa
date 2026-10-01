import { until } from '../harness.mjs';

/**
 * Console-wide wheel smoothing (`web/src/utils/scrollSmoothing.ts`).
 *
 * The logic suite decides what a notch is and where a glide lands; only a real engine shows that the
 * glide reaches the scroller the reader is pointing at. Two scrollers matter and they are reached
 * differently: an ordinary `overflow: auto` region (the console's content pane), and the request
 * list, whose virtualizer clips its overflow and applies every wheel delta itself in one jump - the
 * surface that stepped on every Windows desk. A Select's option popup is the same virtualizer, inline
 * in a portal, and is checked as well.
 *
 * A glide is recognised by its frames: sampled once per animation frame after one notch, the offset
 * passes through intermediate values and settles exactly one notch further. A jump has no
 * intermediate frame. Each sample run is bounded by a frame count rather than a fixed wait.
 */
const NOTCH = 100;
const SAMPLE_FRAMES = 40;

/** Marks the scroll node `findScroller` picks for sampling, so later steps address the same element. */
async function markScroller(page, findScroller, argument) {
  return page.evaluate(findScroller, argument);
}

/** Runs `act` and returns the offsets the marked scroller passed through over the next frames. */
async function sampleScroll(page, act) {
  await page.evaluate((frames) => {
    const node = document.querySelector('[data-probe-scroller]');
    window.__scrollSamples = [node.scrollTop];
    const record = () => {
      window.__scrollSamples.push(node.scrollTop);
      if (window.__scrollSamples.length <= frames) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  }, SAMPLE_FRAMES);
  await act();
  await until(
    () => page.evaluate((frames) => window.__scrollSamples.length > frames, SAMPLE_FRAMES),
    { label: 'scroll samples' },
  );
  return page.evaluate(() => window.__scrollSamples);
}

/** Turns the wheel one notch over (x, y) and returns the offsets the marked scroller passed through. */
async function sampleNotch(page, { x, y, deltaY = NOTCH }) {
  await page.mouse.move(x, y);
  return sampleScroll(page, () => page.mouse.wheel(0, deltaY));
}

/** How a notch moved the scroller: the travelled distance and how many frames sat strictly in between. */
function describeNotch(samples) {
  const start = samples[0];
  const end = samples[samples.length - 1];
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const intermediate = new Set(samples.filter((value) => value > low + 0.5 && value < high - 0.5).map(Math.round));
  return { travelled: end - start, intermediateFrames: intermediate.size, detail: `samples=${samples.map(Math.round).join(',')}` };
}

export async function scrollSmoothing({ base, page, check }) {
  // ---- an ordinary scroller: the content pane ----
  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  const hasPane = await markScroller(page, (notchPx) => {
    const pane = document.querySelector('.app-content');
    if (!pane || pane.scrollHeight - pane.clientHeight < notchPx * 3) return false;
    pane.setAttribute('data-probe-scroller', '');
    return true;
  }, NOTCH);
  check('the settings page overflows its content pane at this viewport', hasPane);
  const paneBox = await page.locator('.app-content').boundingBox();
  const paneAt = { x: paneBox.x + paneBox.width / 2, y: paneBox.y + paneBox.height / 2 };

  let notch = describeNotch(await sampleNotch(page, paneAt));
  check('a wheel notch over the content pane glides through intermediate frames', notch.intermediateFrames >= 2, notch.detail);
  check('the glide lands exactly one notch further', Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);

  notch = describeNotch(await sampleNotch(page, { ...paneAt, deltaY: -NOTCH }));
  check('an upward notch glides back to where it started', notch.intermediateFrames >= 2 && Math.abs(notch.travelled + NOTCH) <= 1, notch.detail);

  // A scrolling key glides too. Nothing is focused, so the key scrolls the content pane, as the
  // browser's own keyboard scroll would.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  notch = describeNotch(await sampleScroll(page, () => page.keyboard.press('ArrowDown')));
  check('an arrow key glides the content pane by one 40px line', notch.intermediateFrames >= 2 && Math.abs(notch.travelled - 40) <= 1, notch.detail);
  notch = describeNotch(await sampleScroll(page, () => page.keyboard.press('ArrowUp')));
  check('the opposite arrow glides back', notch.intermediateFrames >= 2 && Math.abs(notch.travelled + 40) <= 1, notch.detail);

  // A Select's virtualized option popup glides like the request list does.
  await page.getByRole('combobox', { name: 'Time zone' }).click();
  const option = page.locator('.ant-select-dropdown .ant-select-item-option').nth(1);
  await option.waitFor({ timeout: 10_000 });
  const hasPopupHolder = await markScroller(page, (notchPx) => {
    document.querySelector('[data-probe-scroller]')?.removeAttribute('data-probe-scroller');
    const holder = document.querySelector('.ant-select-dropdown .ant-select-dropdown-list-holder');
    if (!holder || holder.scrollHeight - holder.clientHeight < notchPx * 2) return false;
    holder.setAttribute('data-probe-scroller', '');
    return true;
  }, NOTCH);
  check('the time zone popup is a virtualized list long enough to scroll', hasPopupHolder);
  const optionBox = await option.boundingBox();
  notch = describeNotch(await sampleNotch(page, { x: optionBox.x + optionBox.width / 2, y: optionBox.y + optionBox.height / 2 }));
  check('a notch over a virtualized Select popup glides and lands one notch further', notch.intermediateFrames >= 2 && Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);
  await page.keyboard.press('Escape');
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  await markScroller(page, () => {
    document.querySelector('[data-probe-scroller]')?.removeAttribute('data-probe-scroller');
    document.querySelector('.app-content').setAttribute('data-probe-scroller', '');
  });

  // Windows' "Animation effects" switch reports reduced motion; the default still glides, because
  // that switch is also what turns the browser's own wheel animation off (ADR 0046).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  notch = describeNotch(await sampleNotch(page, paneAt));
  check('the default glides even when the system reports reduced motion', notch.intermediateFrames >= 2, notch.detail);

  // `Follow system` hands the decision to that switch: the same notch now jumps.
  const row = page.locator('.settings-toggle-row').filter({ hasText: 'Smooth scrolling' });
  await row.scrollIntoViewIfNeeded();
  await row.getByText('Follow system', { exact: true }).click();
  await until(
    () => page.evaluate(() => fetch('/omc/api/v1/preferences').then((response) => response.json()))
      .then((body) => body.preferences?.omc_scroll_smoothing === 'system'),
    { label: 'the scroll smoothing preference to be stored' },
  );
  await page.evaluate(() => { document.querySelector('[data-probe-scroller]').scrollTop = 0; });
  notch = describeNotch(await sampleNotch(page, paneAt));
  check('Follow system defers to reduced motion and the notch jumps', notch.intermediateFrames === 0 && Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  notch = describeNotch(await sampleNotch(page, paneAt));
  check('Follow system glides again once the system allows motion', notch.intermediateFrames >= 2, notch.detail);

  await row.getByText('Off', { exact: true }).click();
  await until(
    () => page.evaluate(() => fetch('/omc/api/v1/preferences').then((response) => response.json()))
      .then((body) => body.preferences?.omc_scroll_smoothing === 'off'),
    { label: 'the scroll smoothing preference to be stored' },
  );
  await page.evaluate(() => { document.querySelector('[data-probe-scroller]').scrollTop = 0; });
  notch = describeNotch(await sampleNotch(page, paneAt));
  check('Off leaves the native step', notch.intermediateFrames === 0 && Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);
  await row.getByText('On', { exact: true }).click();
  await until(
    () => page.evaluate(() => fetch('/omc/api/v1/preferences').then((response) => response.json()))
      .then((body) => body.preferences?.omc_scroll_smoothing === 'on'),
    { label: 'the scroll smoothing preference to be stored' },
  );

  // ---- the virtualized request list ----
  await page.goto(`${base}/usage/events?preset=24h&limit=100`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });
  const hasHolder = await markScroller(page, () => {
    const root = document.querySelector('.request-list-host') ?? document.body;
    const holder = [...root.querySelectorAll('*')].find(
      (node) => node.scrollHeight > node.clientHeight + 1_000 && getComputedStyle(node).overflowY === 'hidden',
    );
    holder?.setAttribute('data-probe-scroller', '');
    return Boolean(holder);
  });
  check('the request list has a virtualized holder to drive', hasHolder);
  const rowBox = await page.locator('.request-row').nth(2).boundingBox();
  const listAt = { x: rowBox.x + rowBox.width / 2, y: rowBox.y + rowBox.height / 2 };

  // The first notch from the top collapses the header instead of scrolling (§7 live tail); the list
  // claims that notch, and the glide must respect the claim rather than scroll underneath it.
  notch = describeNotch(await sampleNotch(page, listAt));
  check('the first notch collapses the header and leaves row one in place', notch.travelled === 0, notch.detail);
  check('the first notch collapsed the header', (await page.locator('.request-collapsible-header.is-collapsed').count()) === 1);

  const nextRow = await page.locator('.request-row').nth(2).boundingBox();
  notch = describeNotch(await sampleNotch(page, { x: nextRow.x + nextRow.width / 2, y: nextRow.y + nextRow.height / 2 }));
  check('a notch over the virtualized list glides instead of jumping', notch.intermediateFrames >= 2, notch.detail);
  check('the list lands exactly one notch further', Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);
  notch = describeNotch(await sampleNotch(page, { x: nextRow.x + nextRow.width / 2, y: nextRow.y + nextRow.height / 2 }));
  check('the next notch continues from where the first landed', notch.intermediateFrames >= 2 && Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);

  // A turning wheel: notches arrive while the list is still catching up with the glide. The list
  // applies each step only once React commits it, frames behind the glide, and that lag must not
  // read as someone else moving the list - which would stop the glide a few pixels in.
  notch = describeNotch(await sampleScroll(page, async () => {
    for (let turned = 0; turned < 3; turned += 1) await page.mouse.wheel(0, NOTCH);
  }));
  check('a wheel turned several notches glides the list through all of them', notch.intermediateFrames >= 2 && Math.abs(notch.travelled - NOTCH * 3) <= 1, notch.detail);
}
