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
 *
 * On the request list the frames also say whether the glide feels like the reader's hand: it starts
 * moving on the frame the list's own jump would have, and a wheel that keeps turning moves the list on
 * every frame until it lands. A glide that waits a frame per notch, or loses the list's frame to the
 * next notch, reads as a stutter and a lag even though it lands in the right place.
 */
const NOTCH = 100;
const SAMPLE_FRAMES = 40;
/** Notches in a turning-wheel run, and the frames sampled to see all of them land. */
const TURNED_NOTCHES = 6;
const TURNED_SAMPLE_FRAMES = 80;
/** How far a virtualized list may re-anchor as it measures rows during a turn of several notches. */
const REMEASURE_PX = 4;
/** The shortest gap after which a frame is presented on its own: three quarters of a 60Hz frame. */
const SHOWN_FRAME_MS = 12;

/** Waits for the page to run `count` animation frames: the spacing of a wheel the reader keeps turning. */
async function nextFrames(page, count) {
  await page.evaluate((frames) => new Promise((resolve) => {
    const tick = (left) => (left === 0 ? resolve() : requestAnimationFrame(() => tick(left - 1)));
    tick(frames);
  }), count);
}

/** Marks the scroll node `findScroller` picks for sampling, so later steps address the same element. */
async function markScroller(page, findScroller, argument) {
  return page.evaluate(findScroller, argument);
}

/** Runs `act` and returns the offsets the marked scroller passed through over the next frames. */
async function sampleScroll(page, act, sampleFrames = SAMPLE_FRAMES) {
  await page.evaluate((frames) => {
    const node = document.querySelector('[data-probe-scroller]');
    window.__scrollSamples = [node.scrollTop];
    window.__scrollSampleTimes = [performance.now()];
    window.__scrollInputAt = null;
    window.__scrollHanded = 0;
    // A glide drives a virtualized list with wheel events of its own; their deltas are what it asked
    // the list to travel, apart from anything the list adds while it measures rows.
    const noteInput = (event) => {
      if (!event.isTrusted && event.type === 'wheel') window.__scrollHanded += event.deltaY;
      if (event.isTrusted && window.__scrollInputAt === null) window.__scrollInputAt = performance.now();
    };
    window.addEventListener('wheel', noteInput, { capture: true });
    window.addEventListener('keydown', noteInput, { capture: true });
    const record = () => {
      window.__scrollSamples.push(node.scrollTop);
      window.__scrollSampleTimes.push(performance.now());
      if (window.__scrollSamples.length <= frames) {
        requestAnimationFrame(record);
      } else {
        window.removeEventListener('wheel', noteInput, { capture: true });
        window.removeEventListener('keydown', noteInput, { capture: true });
      }
    };
    requestAnimationFrame(record);
  }, sampleFrames);
  await act();
  await until(
    () => page.evaluate((frames) => window.__scrollSamples.length > frames, sampleFrames),
    { label: 'scroll samples' },
  );
  const { samples, times, framesBeforeMove, handed } = await page.evaluate(() => {
    const samples = window.__scrollSamples;
    const times = window.__scrollSampleTimes;
    // Frames that ran after the input and before the scroller first moved.
    const firstMove = samples.findIndex((value, index) => index > 0 && Math.abs(value - samples[index - 1]) > 0.5);
    const framesBeforeMove = firstMove < 0 || window.__scrollInputAt === null
      ? null
      : times.slice(1, firstMove).filter((time) => time > window.__scrollInputAt).length;
    return { samples, times, framesBeforeMove, handed: window.__scrollHanded };
  });
  return Object.assign(samples, { framesBeforeMove, times, handed });
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
  // Frames between the first move and the landing on which the scroller stood still. Two kinds of
  // frame are not a stall the reader could see: one that ran within a few milliseconds of the frame
  // before is the browser catching up after a busy main thread (a first render on the dev server) and
  // is never shown on its own, and the last pixels of a glide move by fractions an integer offset
  // does not show.
  const { times } = samples;
  const moved = samples.map((value, index) => index > 0 && Math.abs(value - samples[index - 1]) > 0.5);
  const firstMove = moved.indexOf(true);
  const lastMove = moved.lastIndexOf(true);
  let stalledFrames = 0;
  for (let index = firstMove; firstMove >= 0 && index <= lastMove; index += 1) {
    const isShown = times[index] - times[index - 1] >= SHOWN_FRAME_MS;
    if (!moved[index] && isShown && Math.abs(end - samples[index]) > 2) stalledFrames += 1;
  }
  return {
    travelled: end - start,
    intermediateFrames: intermediate.size,
    stalledFrames,
    framesBeforeMove: samples.framesBeforeMove,
    handed: samples.handed,
    detail: `samples=${samples.map(Math.round).join(',')} framesBeforeMove=${samples.framesBeforeMove}`
      + ` handed=${Math.round(samples.handed * 10) / 10}`
      + ` frameMs=${times.slice(1).map((time, index) => Math.round(time - times[index])).join(',')}`,
  };
}

/**
 * Opens the request list, marks its virtualized holder for sampling and folds the header with the
 * first notch, which the list claims (§7 live tail). Returns where to point the wheel and that
 * first notch.
 */
async function openRequestList(page, base) {
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
  // The wheel points at a row's provider cell, whose hints are native titles. A cell with an antd
  // tooltip would open it as rows glide under the pointer, and the popup, a portal outside the list,
  // would take the next notch.
  const pointAt = async () => {
    const box = await page.locator('.request-row').nth(2).locator('.req-col-provider').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const foldingNotch = describeNotch(await sampleNotch(page, await pointAt()));
  return { hasHolder, foldingNotch, listAt: await pointAt() };
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

  // The request list's own jump, unsmoothed and sampled the same way: the frame a glide must not
  // start later than.
  let list = await openRequestList(page, base);
  const ownJump = describeNotch(await sampleNotch(page, list.listAt));
  check('Off leaves the request list its own jump', list.hasHolder && ownJump.intermediateFrames === 0 && ownJump.framesBeforeMove !== null, ownJump.detail);

  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await row.scrollIntoViewIfNeeded();
  await row.getByText('On', { exact: true }).click();
  await until(
    () => page.evaluate(() => fetch('/omc/api/v1/preferences').then((response) => response.json()))
      .then((body) => body.preferences?.omc_scroll_smoothing === 'on'),
    { label: 'the scroll smoothing preference to be stored' },
  );

  // ---- the virtualized request list ----
  // The first notch from the top collapses the header instead of scrolling; the list claims that
  // notch, and the glide must respect the claim rather than scroll underneath it.
  list = await openRequestList(page, base);
  check('the request list has a virtualized holder to drive', list.hasHolder);
  check('the first notch collapses the header and leaves row one in place', list.foldingNotch.travelled === 0, list.foldingNotch.detail);
  check('the first notch collapsed the header', (await page.locator('.request-collapsible-header.is-collapsed').count()) === 1);

  notch = describeNotch(await sampleNotch(page, list.listAt));
  check('a notch over the virtualized list glides instead of jumping', notch.intermediateFrames >= 2, notch.detail);
  check('the list lands exactly one notch further', Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);
  // A glide that waits for a frame of its own before handing the list its first step is a frame of
  // added lag on every notch.
  check('the list starts moving as soon as its own jump would have', notch.framesBeforeMove !== null && notch.framesBeforeMove <= ownJump.framesBeforeMove, `${notch.detail} ownJump=${ownJump.framesBeforeMove}`);
  notch = describeNotch(await sampleNotch(page, list.listAt));
  check('the next notch continues from where the first landed', notch.intermediateFrames >= 2 && Math.abs(notch.travelled - NOTCH) <= 1, notch.detail);

  // A turning wheel: notches arrive while the list is still catching up with the glide. The list
  // applies each step only once React commits it, frames behind the glide, and that lag must not
  // read as someone else moving the list - which would stop the glide a few pixels in.
  notch = describeNotch(await sampleScroll(page, async () => {
    for (let turned = 0; turned < TURNED_NOTCHES; turned += 1) await page.mouse.wheel(0, NOTCH);
  }, TURNED_SAMPLE_FRAMES));
  // The list re-anchors its offset as it replaces estimated row heights with measured ones, and may
  // shift by a few pixels doing so, as it does on its own jumps. The glide itself must hand over
  // exactly the notches turned.
  check('a wheel turned several notches glides the list through all of them', notch.intermediateFrames >= 2 && Math.abs(notch.travelled - NOTCH * TURNED_NOTCHES) <= REMEASURE_PX, notch.detail);
  check('the glide hands the list exactly the notches turned', Math.abs(notch.handed - NOTCH * TURNED_NOTCHES) <= 0.5, notch.detail);

  // Each notch the reader turns reaches the list too, and the list would let it cancel the frame that
  // was about to apply the glide's last step: two frames without movement at every notch, then a
  // jump. The notches are two frames apart, as a turning wheel delivers them, so each one lands while
  // the glide is moving. Measured over rows the list has already rendered once, so a first mount's
  // render on the dev server cannot pass for a stalled glide. A dev-server render can still miss one
  // frame now and then; the defect misses two at every notch.
  for (const [label, direction] of [['turned back', -1], ['turned down again', 1]]) {
    notch = describeNotch(await sampleScroll(page, async () => {
      for (let turned = 0; turned < TURNED_NOTCHES; turned += 1) {
        await page.mouse.wheel(0, NOTCH * direction);
        await nextFrames(page, 2);
      }
    }, TURNED_SAMPLE_FRAMES));
    check(`${label}, a turning wheel keeps the list moving from notch to notch`, notch.stalledFrames < TURNED_NOTCHES / 2, notch.detail);
    check(`${label}, the glide hands the list exactly the notches turned`, Math.abs(notch.handed - NOTCH * TURNED_NOTCHES * direction) <= 0.5, notch.detail);
    check(`${label}, the list lands ${TURNED_NOTCHES} notches further`, Math.abs(notch.travelled - NOTCH * TURNED_NOTCHES * direction) <= REMEASURE_PX, notch.detail);
  }
}
