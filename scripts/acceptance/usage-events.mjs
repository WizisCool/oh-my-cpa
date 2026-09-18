import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pastDeadline, sleep } from './harness.mjs';
import {
  EVENT_AUTO_REFRESH_MS,
  EVENT_SEARCH_DEBOUNCE_MS,
} from '../../web/src/types/usageEventView.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Request-record release acceptance: ordering, live-tail/Hold behaviour, filter
 * and pagination races, and responsive layout. The top-level runner owns the
 * browser and fake CPA; this module owns the request-record domain flow.
 */
export async function runUsageEventsAcceptance({
  auditPage,
  appURL,
  page,
  check,
  checkEventually,
  checkHoldsFor,
  responseBodies,
  providerSecrets,
  until,
  measureStable,
  settleLayout,
  smokeOnly,
  consoleErrors,
  pageErrors,
  onSmokeComplete,
}) {
  await auditPage(page, responseBodies, '/usage/events', '.usage-events-page', { pageSecrets: providerSecrets });

  // ---- request list: verdict colours, ordering, and the live tail ----
  // These four behaviours were each reported as a bug, so each gets a browser
  // check rather than only a unit test.
  // Find the scroll holder by behaviour rather than by class: the list is
  // virtualized and the scrolling element is Listy's own holder nested inside
  // the wrapper, so naming it by class couples the check to component internals.
  /**
   * Clicks a toolbar control once the filter row has stopped re-flowing.
   *
   * `.request-filters` is a wrapping flex row, so adding or removing a filter re-wraps it, which moves
   * the controls and the list beneath them. A click issued straight after a filter change can therefore
   * land on geometry that has already changed: measured, Playwright retried for its full 30s and reported
   * a table header covering the button's centre, because the point it had computed belonged to the
   * previous layout.
   *
   * Two conditions, both real rather than a sleep: the control's own box has stopped changing, and the
   * control is the element at its own centre. The second is the property a click needs, and stating it
   * here turns a genuine overlap into a named diagnostic instead of an opaque "intercepts pointer
   * events" after thirty seconds.
   */
  const clickSettled = async (selector, label) => {
    const control = page.locator(selector);
    await control.waitFor({ state: 'visible', timeout: 15_000 });
    await measureStable(
      async () => {
        const box = await control.boundingBox();
        return box
          ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`
          : 'absent';
      },
      { page, label: `${label} to stop moving`, settleMs: 50 },
    );
    const covering = await page.evaluate((target) => {
      const element = document.querySelector(target);
      if (!element) return 'nothing (the control is gone)';
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top) return 'nothing (the point is outside the viewport)';
      return top === element || element.contains(top) || top.contains(element)
        ? null
        : `${top.tagName.toLowerCase()}.${String(top.className)}`;
    }, selector);
    if (covering) throw new Error(`${label} is covered by ${covering} at its own centre`);
    await control.click();
  };

  const listScroller = async () => {
    const handle = await page.evaluateHandle(() => {
      const root = document.querySelector('.request-list-host');
      if (!root) return null;
      const candidates = [root, ...root.querySelectorAll('*')];
      // A virtualized holder reports `overflow: hidden` yet still carries the
      // full content height and accepts programmatic scrolling, so the test is
      // geometry, not the overflow property.
      return (
        candidates.find((node) => {
          const style = getComputedStyle(node);
          return (
            /auto|scroll|hidden/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 20
          );
        }) ?? null
      );
    });
    return handle.asElement();
  };
  const describeListTree = async () =>
    page.evaluate(() => {
      const root = document.querySelector('.request-list-host');
      if (!root) return 'no .request-list-host';
      return [root, ...root.querySelectorAll('*')]
        .slice(0, 6)
        .map((node) => {
          const style = getComputedStyle(node);
          return `${node.className || node.tagName}|overflowY=${style.overflowY}|h=${node.clientHeight}/${node.scrollHeight}`;
        })
        .join(' :: ');
    });
  const rowTimestamps = async () => {
    const values = await page.locator('.request-row .req-col-time time').evaluateAll((nodes) =>
      nodes.map((node) => Date.parse(node.getAttribute('datetime') ?? '')),
    );
    return values.filter((value) => Number.isFinite(value));
  };

  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // The list is virtualized, so only the visible window of rows is in the DOM;
  // the footer reports the real page size.
  const visibleRows = await page.locator('.request-row').count();
  const footerText = await page.locator('.request-pagination span').first().innerText();
  check('request list renders seeded records', visibleRows >= 2, `visibleRows=${visibleRows}`);
  check('the whole seeded page is loaded', /50/.test(footerText), `footer="${footerText}"`);

  if (smokeOnly) {
    check('browser console has no errors in the smoke path', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('browser has no page errors in the smoke path', pageErrors.length === 0, pageErrors.join(' | '));
    onSmokeComplete();
  }

  // Latency carries no verdict colour. The fixture's slowest row is a nine-minute
  // agent request, and an absolute threshold used to paint it amber. It is located
  // by its own latency rather than by position: the list is ordered by request
  // time, so the slowest request is not the first row.
  const latencyColours = await page
    .locator('.request-row .req-latency-val')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color));
  const warnColour = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--warn)';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  const latencyTexts = await page.locator('.request-row .req-latency-val').allInnerTexts();
  const slowestLatency = latencyTexts.reduce((worst, text) => {
    const seconds = /m /.test(text)
      ? Number.parseFloat(text) * 60
      : Number.parseFloat(text) || 0;
    return Math.max(worst, seconds);
  }, 0);
  check('long agent latency is rendered without a warning colour', !latencyColours.includes(warnColour), `colours=${latencyColours.length}`);
  // Anchored so the assertion above cannot pass vacuously on an empty list.
  check('a long agent request really is on screen', slowestLatency > 60, `slowest=${slowestLatency}s`);

  // The window states no ordering label: the list's order now matches the time
  // column it displays, so there is nothing to explain. The absence is pinned.
  check('the window states no ordering label', (await page.locator('.request-order-hint').count()) === 0);
  // The summary strip is gone, so the request page states no verdict of its own.
  check('no KPI summary strip remains', (await page.locator('.request-summary, .req-kpi-item').count()) === 0);
  check('the removed strip left no dead column of totals', (await page.locator('.req-kpi-val').count()) === 0);

  // ---- the filter panel ----
  // These assertions run before the live-tail section, which toggles
  // auto-refresh on; a filter change here would redefine the view the poll
  // compares against.
  //
  // Scope: what a filter edit writes, what clear-all preserves, how a preset
  // replaces a range and how a reversed range is refused are all decisions about
  // the operator's own input, so they are pinned directly against the modules the
  // page calls (`scripts/test-usage-events-view-policy.ts`) rather than by driving
  // a page through them. What stays here is the React wiring a pure test cannot
  // reach: that a facet reaches the URL *as a chip*, that a chip removes exactly
  // what it names, that the drawer stages a draft and commits it once, and that
  // the panel renders the validation its policy produces.
  const filterSuffix = () => new URL(page.url()).search;
  const initialFilterQuery = filterSuffix();

  // Multi-select is the point of the rewrite, and the chip is where the operator
  // sees what is applied. Both halves are asserted together because a filter that
  // reached the URL without rendering a chip leaves the operator unable to remove
  // it.
  const modelFacet = page.locator('.request-filters .req-facet-select').first();
  const providerFacet = page.locator('.request-filters .req-facet-select').nth(1);
  await modelFacet.click();
  const firstModelOption = page.locator('.ant-select-dropdown:visible .ant-select-item-option').first();
  const firstModel = (await firstModelOption.innerText()).replace(/\s*\(\d+\)\s*$/, '').trim();
  await firstModelOption.click();
  await page.keyboard.press('Escape');
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  await checkEventually(
    'selecting a facet writes the committed filter to the URL',
    () => filterSuffix().includes(`model=${encodeURIComponent(firstModel)}`),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('a committed filter appears as a removable chip', (await page.locator('.req-filter-chip').count()) >= 1);

  // Removing the chip must clear the filter. This is the regression guard for
  // the persistence bug where a cleared filter was written straight back from
  // the stale query and reappeared on the next navigation: the pure test pins the
  // derivation, and this pins that the remove control is wired to it.
  await page.locator('.req-filter-chip-remove').first().click();
  await checkEventually(
    'removing the chip clears the filter from the URL',
    () => !filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('removing the only filter hides the chip strip', (await page.locator('.req-filter-chip').count()) === 0);

  // The advanced drawer is a draft: Apply commits once, Cancel discards. The
  // staging itself is the claim - a range field that committed per keystroke would
  // re-query at 300, 3000 and 30000ms while the operator watched the list empty and
  // refill.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  const drawerGroups = await page.locator('.req-filter-group-title').allInnerTexts();
  check('the advanced panel groups its fields', drawerGroups.length >= 4, `groups=${drawerGroups.join('|')}`);
  const latencyMin = page.locator('#req-range-latency-min');
  await latencyMin.fill('30000');
  // Irreducible window. The claim is that nothing happens, so the only evidence
  // is that nothing happens for as long as the app could still have acted. The
  // drawer commits on Apply, so the app's shortest debounce bounds how late a
  // stray write could arrive.
  await checkHoldsFor(
    'editing a draft field does not change the URL',
    () => !filterSuffix().includes('latency_min'),
    EVENT_SEARCH_DEBOUNCE_MS,
    { detail: () => `url=${filterSuffix()}` },
  );
  const drawerFooterText = await page.locator('.req-filter-drawer-footer').innerText().catch(() => '<no footer>');
  check(
    'the drawer exposes reset, cancel and apply',
    /重置筛选|Reset/.test(drawerFooterText) && /取\s*消|Cancel/.test(drawerFooterText) && /应用筛选|Apply/.test(drawerFooterText),
    `footer=${JSON.stringify(drawerFooterText)}`,
  );
  // Addressed by test id, not by position: the footer carries three buttons and
  // "the first one" is Reset, which deliberately leaves the panel open.
  await page.locator('[data-testid="req-filter-cancel"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  check('cancelling the drawer discards the draft', !filterSuffix().includes('latency_min'), `url=${filterSuffix()}`);

  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#req-range-latency-min').fill('30000');
  await page.locator('[data-testid="req-filter-apply"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  await checkEventually(
    'applying the drawer commits the range once',
    () => filterSuffix().includes('latency_min=30000'),
    { detail: () => `url=${filterSuffix()}` },
  );
  check(
    'an applied range is reported as a chip',
    (await page.locator('.req-filter-chip').allInnerTexts()).some((text) => /30000/.test(text)),
  );

  // The refusal is a policy fact (`validateAbsoluteRange`) but the *wiring* - that
  // the panel renders the message and disables Apply - is not. A pure test proves
  // the range is invalid; only this proves the operator is told and cannot submit.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#req-range-latency-min').fill('500');
  await page.locator('#req-range-latency-max').fill('100');
  await checkEventually(
    'a reversed range is explained inline',
    async () => (await page.locator('.req-filter-error').count()) >= 1,
  );
  await checkEventually(
    'a reversed range blocks Apply',
    () => page.locator('[data-testid="req-filter-apply"]').isDisabled(),
  );
  await page.locator('[data-testid="req-filter-cancel"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 5000 });

  // Clear-all returns the list to the bare window and leaves nothing behind.
  await page.locator('.req-clear-all-chips').click();
  await checkEventually(
    'clear-all removes every filter',
    () => new URL(page.url()).searchParams.toString().split('&').every((pair) => /^(preset|limit)=/.test(pair) || pair === ''),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('clear-all hides the chip strip', (await page.locator('.req-filter-chip').count()) === 0);
  // Clear-all returns the list to the unfiltered page, not merely to a filterless
  // URL: the footer reports the page size the bare window would load. It is asserted
  // here rather than covered by the URL check above because a URL with no filter
  // parameters and a request that had not been re-issued yet are different states.
  //
  // The read is gated on the unfiltered request having settled. Reading the footer
  // immediately after the URL write races the list refetch and reports the previous
  // filter's page size, which is the shape of this check's long-standing intermittent
  // failure under CPU contention (reproduced on the unmodified baseline commit). The
  // wait is for the rows that only an unfiltered window can produce, and the check
  // below still reports a missing footer as a failure.
  await until(
    async () => /50/.test(await page.locator('.request-pagination span').first().innerText().catch(() => '')),
    { label: 'the unfiltered page size to be reported' },
  );
  check(
    'the list is back to the unfiltered page',
    /50/.test(await page.locator('.request-pagination span').first().innerText()),
  );

  // The result verdict is a filter with no URL parameter of its own, so the
  // reset affordance must still appear when it is the only thing narrowing the
  // list. That condition - a filter the URL cannot show - is invisible to the pure
  // layer.
  await page.locator('.request-filters .req-result-segmented .ant-segmented-item').filter({ hasText: /失败|Failed/ }).click();
  await checkEventually(
    'the result verdict is committed to the URL',
    () => filterSuffix().includes('result=failed'),
    { detail: () => `url=${filterSuffix()}` },
  );
  check('a result-only filter still offers Reset', await page.locator('.req-reset-filters').isVisible());

  // A pending debounce must not resurrect a filter that was just cleared, and this
  // is the one such claim that cannot move to the pure layer: it depends on a real
  // timer surviving a real clear, a real React state update and a real URL write.
  // A committed facet is seeded first: without one the chip strip is absent, so
  // clicking "clear all" would have no target and the check could pass vacuously
  // while the debounce wrote `q` back afterwards.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await checkEventually(
    'a facet is committed before the debounce race',
    () => filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  await page.locator('.request-search input').type('gpt', { delay: 20 });
  // Deliberately shorter than the debounce, so the timer is still pending when
  // the clear lands. This window can never become a condition wait: the test has
  // to interrupt the debounce, which means acting before the deadline rather than
  // waiting for something to become true. Derived from the app's own debounce
  // instead of the hand-tuned millisecond it used to be.
  await sleep(EVENT_SEARCH_DEBOUNCE_MS / 3);
  await page.locator('.req-clear-all-chips').click();
  // Past the debounce deadline. The slack is not padding: this is a negative
  // claim, so the window has to outlast every moment at which the queued
  // keystroke could still have landed.
  await pastDeadline(EVENT_SEARCH_DEBOUNCE_MS, { slackMs: 550 });
  check('a pending search debounce cannot revive a cleared filter', !filterSuffix().includes('q='), `url=${filterSuffix()}`);
  check('the clear also removed the committed facet', !filterSuffix().includes('model='), `url=${filterSuffix()}`);
  check('the search box is emptied by the clear', (await page.locator('.request-search input').inputValue()) === '');

  // A filter change must drop the pagination position rather than reusing a
  // cursor that was minted against a different result set.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  // The facet commit is the URL write this claim is about, so it is awaited
  // rather than slept through: without it the "no cursor" assertion could be
  // reading a URL that never changed.
  await until(() => filterSuffix().includes('model='), {
    label: 'the facet commit that drops the cursor',
  });
  check('a filter change drops the cursor', !filterSuffix().includes('cursor='), `url=${filterSuffix()}`);
  await page.locator('.req-clear-all-chips').click();
  await until(() => !filterSuffix().includes('model='), { label: 'clear-all to drop the facet'});
  // Return to the window the rest of the audit expects before it continues.
  await clickSettled('.req-time-button', 'the time-range control');
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /1h/ })
    .first()
    .click();
  await until(() => filterSuffix().includes('preset=1h'), { label: 'the 1h window to be selected' });
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  check('the audit resumed on the default window', filterSuffix() === initialFilterQuery, `before=${initialFilterQuery} after=${filterSuffix()}`);

  // Ordering is a Go regression (`TestListUsageEventsOrdersByRequestTime` in
  // `internal/repository`), and a JavaScript re-check cannot fail for the reason
  // its name gives: it reads whatever the server already ordered. What is left
  // here is the rendered column being monotonic, which is a property of the rows
  // on screen rather than of the query.
  const ordered = await rowTimestamps();
  const strictlyDescending = ordered.every((value, index) => index === 0 || ordered[index - 1] >= value);
  check(
    'the rendered time column is monotonic, newest first',
    ordered.length >= 2 && strictlyDescending,
    `order=${ordered.slice(0, 4).map((value) => new Date(value).toISOString()).join(' > ')}`,
  );
  // The monotonicity above could pass on a fixture where nothing disagrees, so it is
  // anchored to the row that distinguishes the two orderings: the fixture records its
  // slow agent request last but gives it the oldest start time, so recording order
  // would put it first and invert the column. This keeps the browser check honest
  // about what it observed; the ordering guarantee itself is the Go regression.
  check(
    'the last-recorded but earliest-starting request is not the first row',
    ordered.length >= 2 && ordered[0] > ordered[ordered.length - 1],
    `first=${new Date(ordered[0]).toISOString()} last=${new Date(ordered[ordered.length - 1]).toISOString()}`,
  );

  // Live tail: scroll away from the top, let a poll land with a new record, and
  // require that nothing the reader is looking at moves.
  //
  // Auto-refresh is a plain on/off switch with a fixed 10-second cadence, so the
  // test drives the switch rather than picking an interval out of a menu.
  const autoRefreshSwitch = page.locator('#req-auto-refresh');
  check('auto-refresh is an on/off switch, not an interval picker', (await page.locator('.req-auto-refresh-select').count()) === 0);
  check('auto-refresh starts off', !(await autoRefreshSwitch.isChecked()));
  await autoRefreshSwitch.click();
  check('auto-refresh turns on', await autoRefreshSwitch.isChecked());
  check(
    'the enabled switch states no cadence label',
    (await page.locator('.req-auto-refresh-cadence').count()) === 0,
  );

  const scroller = await listScroller();
  check('the request list has a scroll holder, so the scroll checks are meaningful', scroller !== null, await describeListTree());
  if (!scroller) throw new Error(`no scrollable element in the request list: ${await describeListTree()}`);

  // Facets are nine grouped scans of the window, so they must follow the window -
  // not the ten-second list tick. Counting the requests is the only way to prove
  // the poll does not re-issue them.
  const facetRequests = [];
  const countFacet = (request) => {
    if (request.url().includes('/usage/facets')) facetRequests.push(request.url());
  };
  page.on('request', countFacet);
  await scroller.evaluate((node) => {
    node.scrollTop = Math.round(node.scrollHeight / 2);
  });
  // The scroll is what the whole block compares against afterwards, so the check
  // that it registered is also the gate for reading the value.
  await checkEventually(
    'the list actually scrolled away from the top',
    async () => (await scroller.evaluate((node) => node.scrollTop)) > 100,
    {
      detail: async () => `scrollTop=${await scroller.evaluate((node) => node.scrollTop)}`,
    },
  );
  const scrollBefore = await scroller.evaluate((node) => node.scrollTop);
  // What the poll must not disturb is *which* rows are under the cursor, so the
  // comparison below is by row identity rather than by mounted row count. The
  // count is a moving target: the virtualized window keeps filling in for several
  // frames after the scroll, so a count read at any single moment reports a
  // smaller "before" and makes an untouched list look as if the poll had
  // inserted a row above the reader - a real failure that the flat pause this
  // replaces used to hide behind its own latency.
  const visibleRowIdentities = () =>
    page.locator('.request-row .req-col-time time').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('datetime') ?? ''),
    );
  // A virtualized window has no completion event: it keeps filling for an
  // unbounded number of frames after the scroll, and two animation frames can
  // agree on a window that is still growing. Requiring the window to hold across
  // a real gap is the only condition available here. 250 ms is the smallest gap
  // that proved sufficient (two animation frames were not) and stays under the
  // blind 400 ms pause this replaces, with the difference that the read now
  // verifies the window has stopped growing instead of assuming it.
  const windowBefore = await measureStable(
    async () => (await visibleRowIdentities()).join('|'),
    { page, label: 'the visible row window at the scrolled position', settleMs: 250 },
  );
  const rowsBefore = windowBefore.split('|').filter(Boolean);
  const pageLabelBefore = await page.locator('.request-pagination span').first().innerText();

  // The fixture's future-dated row enters the sliding window on a later poll.
  // No separate writer touches the database after the app has opened it, so this
  // remains a live-tail test rather than a WAL cross-process race.
  // The cadence is 10s, so the wait has to clear one full interval plus the request
  // itself. This is the largest wait left in the suite.
  //
  // The bound is derived rather than hand-picked, and it is deliberately generous:
  // three cadences of headroom, not one. Under CPU contention (a 2-CPU constraint,
  // or the probes running beside this suite) a 30s bound - three intervals - was
  // observed to expire while the page was merely slow, so the assertion reported a
  // failure that said nothing about the code. The wait is for a positive event, so
  // a longer bound costs nothing on a healthy machine: it returns as soon as the
  // pill appears.
  //
  // Driving it with `page.clock` was tried and rejected. Installing the clock before
  // the first navigation does make the interval fire early - 11s of app time in
  // ~900ms - but the same mock also covers `requestAnimationFrame` and
  // `performance.now`, which is exactly what `smoothScroll`'s gesture schedule is
  // built from. With the clock installed the back-to-top gesture landed at 37px
  // instead of the top, with no page error, so the one assertion this block exists
  // for was the one it broke. Isolating the interval from the frame clock is not
  // expressible through the Playwright clock API, and the trade was nine seconds
  // against the correctness of a scroll assertion, so the honest wait stays.
  await page
    .locator('.req-back-to-top-btn.is-live')
    .waitFor({ state: 'visible', timeout: EVENT_AUTO_REFRESH_MS * 6 });

  const scrollAfterPoll = await scroller.evaluate((node) => node.scrollTop);
  const rowsAfterPoll = await visibleRowIdentities();
  const pageLabelAfter = await page.locator('.request-pagination span').first().innerText();
  check('a poll does not scroll the reader back to the top', Math.abs(scrollAfterPoll - scrollBefore) <= 4, `before=${scrollBefore} after=${scrollAfterPoll}`);
  check(
    'a poll does not reorder the rows under the cursor',
    rowsAfterPoll.length >= rowsBefore.length &&
      rowsBefore.every((datetime, index) => rowsAfterPoll[index] === datetime),
    `before=${rowsBefore.length} after=${rowsAfterPoll.length} topBefore=${rowsBefore[0] ?? 'none'} topAfter=${rowsAfterPoll[0] ?? 'none'}`,
  );
  check('a poll does not reset pagination or relabel the page', pageLabelAfter === pageLabelBefore, `before="${pageLabelBefore}" after="${pageLabelAfter}"`);
  const pillText = await page.locator('.req-back-to-top-btn.is-live').innerText();
  check('the pill reports the records that arrived', /1/.test(pillText), `pill="${pillText}"`);

  // The evidence for the facet freshness policy: at least one poll landed above
  // (the pill proves it), and none of them spent the facet budget.
  page.off('request', countFacet);
  check(
    'a poll does not re-read the facets',
    facetRequests.length === 0,
    `facetRequests=${facetRequests.length}`,
  );

  await page.locator('.req-back-to-top-btn.is-live').click();
  await checkEventually(
    'applying the backlog returns to the top',
    async () => (await scroller.evaluate((node) => node.scrollTop)) <= 4,
    { detail: async () => `scrollTop=${await scroller.evaluate((node) => node.scrollTop)}` },
  );
  const newestFirst = await rowTimestamps();
  check(
    'the new record is the first row',
    newestFirst.length > 0 && newestFirst[0] >= Math.max(...newestFirst),
    `first=${newestFirst.length ? new Date(newestFirst[0]).toISOString() : 'none'}`,
  );
  // The window survives a reload. Facets and filters were reloaded repeatedly by
  // the checks above, so this is the one place the saved view is exercised end to
  // end: choose an explicit window, a page size and a cost filter, clear the
  // filters, then reopen the bare route.
  await clickSettled('.req-time-button', 'the time-range control');
  await page
    .locator('.ant-dropdown-menu-item')
    .filter({ hasText: /24h/ })
    .first()
    .click();
  // The window is a precondition for the page-size check below, not a claim of
  // its own, so it is awaited without being reported as a check.
  await until(() => filterSuffix().includes('preset=24h'), { label: 'the 24h window to be committed' });
  await page.locator('.request-pagination .ant-select').click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: /250/ })
    .first()
    .click();
  await checkEventually(
    'the page size is committed',
    () => filterSuffix().includes('limit=250'),
    { detail: () => `url=${filterSuffix()}` },
  );

  // Every preset is listed exactly once, including whichever is selected, is pinned
  // by `presetMenuKeys` in the policy suite. What is left here is the wiring the
  // pure test cannot see: that the menu is built from that policy at all, and that a
  // preset chosen from it reaches the URL.
  await page.goto(`${appURL}/usage/events?preset=7d`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  await clickSettled('.req-time-button', 'the time-range control');
  const presetItems = await page.locator('.ant-dropdown-menu-item').allInnerTexts();
  await page.keyboard.press('Escape');
  await page
    .locator('.ant-dropdown:visible')
    .waitFor({ state: 'hidden', timeout: 5000 })
    .catch(() => {});
  check(
    'the window menu lists every preset and not just the unselected ones',
    ['15m', '1h', '6h', '24h', '7d', '30d', '90d'].every(
      (preset) => presetItems.filter((text) => text.includes(preset)).length === 1,
    ),
    `items=${presetItems.join('|')}`,
  );
  check(
    'the preset menu is rendered from the same policy the tests assert',
    presetItems.filter((text) => /自定义时间|Custom range/.test(text)).length === 1,
    `items=${presetItems.join('|')}`,
  );

  // A cost filter is carried as exactly one parameter, and clearing filters must
  // keep the window and page size - in the URL and in what is saved for next time.
  // The serialiser algebra is pinned in the policy suite; what is exercised here is
  // the end-to-end persistence cycle, which is the only way to observe that a
  // cleared filter stays cleared after a real reload.
  await page.goto(`${appURL}/usage/events?preset=24h&limit=250&cost=unpriced&model=gpt-5-codex`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // Rendering the chips is the signal that the page has parsed the navigated URL
  // and normalised it; the checks below read that normalised result rather than
  // the raw link.
  await until(async () => (await page.locator('.req-filter-chip').count()) >= 1, {
    label: 'the navigated filters to render as chips',
  });
  check(
    'the cost state is reported as a chip',
    (await page.locator('.req-filter-chip').allInnerTexts()).some((text) => /未定价|Unpriced/.test(text)),
    `chips=${(await page.locator('.req-filter-chip').allInnerTexts()).join('|')}`,
  );
  await page.locator('.req-clear-all-chips').click();
  await checkEventually(
    'clear-all drops the filters',
    () => !filterSuffix().includes('cost=') && !filterSuffix().includes('model='),
    { detail: () => `url=${filterSuffix()}` },
  );
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // Hydration from the saved view is the event the checks below read, so it is
  // awaited rather than slept through. This is the reload round trip, which is the
  // half of the persistence bug no pure test can reach.
  await checkEventually(
    'the saved window survives a reload',
    () => filterSuffix().includes('preset=24h') && filterSuffix().includes('limit=250'),
    { detail: () => `url=${filterSuffix()}` },
  );
  check(
    'the cleared filters stay cleared after a reload',
    !filterSuffix().includes('cost=') && !filterSuffix().includes('model='),
    `url=${filterSuffix()}`,
  );
  // The duplicate-`cost` bug is a serializer property and is pinned directly in the
  // policy suite, but it is asserted once more on the restored URL because that is
  // the path where it actually bit: hydration reading `cost` from both the top-level
  // field and the filter map writes the parameter twice.
  check(
    'no cost parameter is duplicated in the restored URL',
    (filterSuffix().match(/(^|[&?])cost=/g) ?? []).length <= 1,
    `url=${filterSuffix()}`,
  );
  await page.goto(`${appURL}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });

  // The alias is an exact-match dimension with manual entry. It is the one filter
  // whose control has to accept a value the window does not report - an operator
  // looks up an alias precisely when it has stopped appearing - so it is exercised
  // through the whole cycle: type, apply, reopen, remove. The control must accept
  // the tag, commit it, and show it again when reopened; the "draft is dirty" half
  // of that is `isDraftDirty` in the policy suite.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  const aliasInput = page.locator('#req-multi-model_alias');
  await aliasInput.click();
  // Typed key by key rather than filled: a tag is created by the Select's own
  // keyboard handling, so setting the input value directly does not commit it.
  await page.keyboard.type('retired-alias', { delay: 20 });
  await page.keyboard.press('Enter');
  await checkEventually(
    'typing an alias the window does not report creates a tag',
    async () => (await page.locator('.req-filter-drawer').innerText()).includes('retired-alias'),
  );
  check(
    'typing a value the facets do not report enables Apply',
    !(await page.locator('[data-testid="req-filter-apply"]').isDisabled()),
  );
  await page.locator('[data-testid="req-filter-apply"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  await checkEventually(
    'a typed alias reaches the URL and is reported as a chip',
    async () =>
      filterSuffix().includes('model_alias=retired-alias') &&
      (await page.locator('.req-filter-chip').allInnerTexts()).some((text) => text.includes('retired-alias')),
    { detail: () => `url=${filterSuffix()}` },
  );
  // Reopening must show the value it committed, not an empty control. The row is
  // located by the select it contains, because antd renders the tag in a sibling
  // node rather than inside the input's parent. This is the half a pure test
  // cannot reach: it is antd's own rendering of a controlled tag.
  await page.locator('.req-more-filters').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
  const aliasRowText = await page
    .locator('.req-filter-row')
    .filter({ has: page.locator('#req-multi-model_alias') })
    .innerText();
  check(
    'the committed alias is shown when the drawer reopens',
    aliasRowText.includes('retired-alias'),
    `row=${JSON.stringify(aliasRowText)}`,
  );
  await page.locator('[data-testid="req-filter-cancel"]').click();
  await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });
  await page.locator('.req-clear-all-chips').click();
  await checkEventually(
    'the alias filter can be cleared',
    () => !filterSuffix().includes('model_alias'),
    { detail: () => `url=${filterSuffix()}` },
  );

  // A filter changed while a keystroke is still queued must survive: the queued
  // commit has to patch the newest URL rather than restore the snapshot captured
  // when it was scheduled. The controller's half of this is pinned by the policy
  // suite; what is left here is that the *page's* commit reads the current URL
  // rather than the render it was created in, which is a React-closure property.
  await modelFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  await until(() => filterSuffix().includes('model='), {
    label: 'the committed facet the queued keystroke has to survive',
  });
  const committedModel = new URL(page.url()).searchParams.get('model');
  await page.locator('.request-search input').type('gpt', { delay: 20 });
  // Inside the debounce window: the queued commit has to still be pending when
  // the unrelated dimension changes. Derived from the app's debounce so a change
  // there cannot silently move this test outside the window it needs to be in.
  await sleep(EVENT_SEARCH_DEBOUNCE_MS / 4);
  // Change an unrelated dimension inside the debounce window.
  await providerFacet.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.keyboard.press('Escape');
  // Waiting for the queued commit to land is both faster and stronger than the
  // flat window this replaces: it stops as soon as the debounce fires, and it
  // fails loudly instead of expiring quietly if the commit never arrives.
  await checkEventually(
    'the queued search still lands',
    () => filterSuffix().includes('q=gpt'),
    { detail: () => `url=${filterSuffix()}` },
  );
  const afterRace = new URL(page.url()).searchParams;
  check('a queued search does not erase a filter chosen during the debounce', afterRace.get('model') === committedModel, `url=${filterSuffix()}`);
  check('the provider chosen during the debounce survives', afterRace.get('provider') !== null, `url=${filterSuffix()}`);
  await page.locator('.req-clear-all-chips').click();
  await checkEventually(
    'the race left the view clearable',
    async () => (await page.locator('.req-filter-chip').count()) === 0,
    { detail: () => `url=${filterSuffix()}` },
  );

  // Search text must follow the URL when the operator navigates between two saved
  // search views. A debounce that only listens for its own commits would let the
  // loaded value be overwritten by the one it replaced. One term is enough here:
  // the policy suite covers adopting an external value and a keystroke arriving
  // after it, so the browser only has to establish that the box is wired to it.
  const navigatedTerm = 'alpha-search';
  await page.goto(`${appURL}/usage/events?preset=24h&q=${navigatedTerm}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row, .ant-empty').first().waitFor({ state: 'visible', timeout: 15000 });
  await checkEventually(
    'the search box shows the navigated term',
    async () => (await page.locator('.request-search input').inputValue()) === navigatedTerm,
    { detail: async () => `input=${await page.locator('.request-search input').inputValue()}` },
  );
  // Past the debounce window: a stale timer would rewrite the URL here. Another
  // irreducible window - the claim is that a cancelled timer stays cancelled,
  // so the evidence has to span every moment it could still have fired.
  await pastDeadline(EVENT_SEARCH_DEBOUNCE_MS);
  check(
    'the navigated term survives the debounce window',
    filterSuffix().includes(`q=${navigatedTerm}`) &&
      (await page.locator('.request-search input').inputValue()) === navigatedTerm,
    `url=${filterSuffix()} input=${await page.locator('.request-search input').inputValue()}`,
  );
  await page.locator('.req-clear-all-chips').click();
  await until(() => !filterSuffix().includes('q='), { label: 'clear-all to drop the search term' });

  // A malformed parameter must be reported, not silently dropped: dropping it would
  // show a wider result set than the link asked for while the panel still looked
  // narrowed, which is the failure mode this notice exists to prevent. Which
  // parameters are unusable is `rejectedEventParams`, pinned in the policy suite;
  // what is left here is that the page surfaces the refusal instead of ignoring it.
  await page.goto(`${appURL}/usage/events?preset=24h&latency_min=abc&cost=maybe`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('.usage-events-page .ant-alert').first().waitFor({ state: 'visible', timeout: 10000 });
  const rejectedNotice = await page.locator('.usage-events-page .ant-alert').first().innerText();
  check('an unusable filter parameter is reported', /latency_min/.test(rejectedNotice) && /cost/.test(rejectedNotice), `notice=${JSON.stringify(rejectedNotice)}`);
  // The list must still run on the filters it could apply. The rows are awaited, so
  // the assertion is about the page from which the notice was read rather than about
  // a render that might still be in flight; the assertion itself stays a plain check
  // so an empty list is still reported as the failure it is.
  await until(async () => (await page.locator('.request-row').count()) > 0, {
    label: 'the list to render on the usable filters',
  });
  check('the list still runs on the usable filters', (await page.locator('.request-row').count()) > 0);
  await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });
  // Not a `checkEventually`: the claim is that no notice appears, and waiting for
  // that would pass on the first poll whether or not the page had finished rendering.
  // The rows being visible is what makes the read meaningful - the page has rendered,
  // and it rendered without a notice.
  check('a clean URL shows no notice', (await page.locator('.usage-events-page .ant-alert').count()) === 0);

  // Same-component navigation with a pending keystroke. `page.goto` remounts the
  // page, so it cannot exercise this: the two URLs below share a committed `q`, so
  // only history navigation (not the committed value) distinguishes them.
  await page.goto(`${appURL}/usage/events?preset=24h&q=keep-me&provider=openai`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row, .ant-empty').first().waitFor({ state: 'visible', timeout: 15000 });
  // The rows rendering proves the shell mounted, which is also what registers the
  // popstate listener the two pushes below depend on.
  // Client-side navigation to the same view with a different unrelated dimension.
  await page.evaluate(() => history.pushState({}, '', '/omc/usage/events?preset=24h&q=keep-me&provider=claude'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await page.locator('.request-search input').click();
  await page.keyboard.type('stale-typing', { delay: 20 });
  // Navigate again before the debounce commits.
  await page.evaluate(() => history.pushState({}, '', '/omc/usage/events?preset=24h&q=keep-me&provider=gemini'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  // Negative claim, irreducible window: the queued keystroke has to be given the
  // full debounce deadline to fail to arrive. The slack matches the flat window
  // this replaces, so the evidence is neither weaker nor shorter than before.
  await pastDeadline(EVENT_SEARCH_DEBOUNCE_MS, { slackMs: 550 });
  check(
    'history navigation discards a pending keystroke',
    !filterSuffix().includes('stale-typing'),
    `url=${filterSuffix()}`,
  );
  check(
    'the navigated view keeps its own committed search',
    filterSuffix().includes('q=keep-me') && filterSuffix().includes('provider=gemini'),
    `url=${filterSuffix()}`,
  );
  await page.goto(`${appURL}/usage/events?preset=24h`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().waitFor({ state: 'visible', timeout: 15000 });

  // Switching the poll off again keeps the rest of the audit deterministic.
  await autoRefreshSwitch.click();
  check('auto-refresh turns off again', !(await autoRefreshSwitch.isChecked()));

  // A manual refresh is the other event that re-reads the facets: the operator
  // asked for current data, and stale dropdown counts are on screen too.
  const manualFacets = [];
  const countManualFacet = (request) => {
    if (request.url().includes('/usage/facets')) manualFacets.push(request.url());
  };
  page.on('request', countManualFacet);
  // The evidence is a network event, so the wait is for that event. A flat window
  // could only hope the request had already happened, and would report the count
  // as zero when the machine was merely slow.
  const facetRefresh = page
    .waitForRequest((request) => request.url().includes('/usage/facets'), { timeout: 10000 })
    .catch(() => null);
  await page.locator('.terminal-page-head .request-actions button').last().click();
  const facetRefreshLanded = (await facetRefresh) !== null;
  page.off('request', countManualFacet);
  check('a manual refresh re-reads the facets', facetRefreshLanded && manualFacets.length >= 1, `requests=${manualFacets.length}`);
  await page.screenshot({ path: path.join(root, 'tmp', 'req-page-desktop.png') });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 800 });
    // Measured once it stops moving instead of after a flat pause: the property
    // the old sleep was guessing at is that the responsive reflow has finished.
    const overflow = await measureStable(
      () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)),
      { page, label: 'the request page overflow measurement' },
    );
    check(`request records ${width}px viewport has no overflow`, overflow === 0, `overflow=${overflow}`);
    const actionsFit = await page.evaluate(() => {
      const actions = document.querySelector('.usage-events-page .terminal-page-head .request-actions');
      if (!actions) return -1;
      const box = actions.getBoundingClientRect();
      // The action group must stay inside the viewport it sits in.
      return Math.round(box.right - window.innerWidth);
    });
    check(`request records ${width}px header actions stay in view`, actionsFit <= 1, `rightOverhang=${actionsFit}`);

    // The panel and the time dialog are the two surfaces that only exist while
    // open, so the closed-page overflow check above cannot see them.
    await page.locator('.req-more-filters').click();
    await page.locator('.req-filter-drawer').waitFor({ state: 'visible', timeout: 5000 });
    const drawerOverflow = await measureStable(
      () =>
        page.evaluate(() => {
          const panel = document.querySelector('.req-filter-drawer .ant-drawer-body');
          if (!panel) return -1;
          // Content wider than the panel is the failure mode a narrow viewport
          // exposes: a range pair whose inputs cannot shrink pushes the dialog off
          // screen.
          return Math.round(panel.scrollWidth - panel.clientWidth);
        }),
      { page, label: 'the filter drawer overflow measurement' },
    );
    check(`filter drawer fits at ${width}px`, drawerOverflow <= 1, `drawerOverflow=${drawerOverflow}`);
    const drawerOnScreen = () =>
      page.evaluate(() => {
        const root = document.querySelector('.req-filter-drawer');
        if (!root) return 'no root';
        // The positioning element is not guaranteed to be a fixed class name in
        // antd v6, so the check walks the drawer's own elements and requires that
        // at least one sizing box sits inside the viewport.
        const boxes = [root, ...root.querySelectorAll('*')]
          .map((node) => ({ node, box: node.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 100 && box.height > 100);
        if (boxes.length === 0) {
          return `no sized element; classes=${root.className} inner=${root.innerHTML.slice(0, 200)}`;
        }
        const offender = boxes.find(({ box }) => box.left < -1 || box.right > window.innerWidth + 1);
        if (offender) {
          return `${offender.node.className} left=${Math.round(offender.box.left)} right=${Math.round(offender.box.right)} viewport=${window.innerWidth}`;
        }
        return true;
      });
    // The assertion is also the wait. The drawer slides in from the right, so a
    // fixed pause either samples it mid-slide - reporting an off-screen panel as a
    // failure, which is what a flat 250ms did here - or wastes the rest of the
    // window on a drawer that arrived immediately.
    await checkEventually(
      `filter drawer stays on screen at ${width}px`,
      async () => (await drawerOnScreen()) === true,
      { detail: async () => String(await drawerOnScreen()) },
    );
    await page.locator('[data-testid="req-filter-cancel"]').click();
    await page.locator('.req-filter-drawer').waitFor({ state: 'hidden', timeout: 15000 });

    await clickSettled('.req-time-button', 'the time-range control');
    // The trigger opens the preset menu; the absolute dialog is a menu item, so a
    // click on the trigger alone never opens it.
    await page
      .locator('.ant-dropdown-menu-item')
      .filter({ hasText: /自定义时间|Custom range/ })
      .first()
      .click();
    await page.locator('.req-time-modal').waitFor({ state: 'visible', timeout: 10000 });
    const modalOnScreen = () =>
      page.evaluate(() => {
        const dialog = document.querySelector('.req-time-modal');
        if (!dialog) return 'no dialog';
        const box = dialog.getBoundingClientRect();
        if (box.left < -1 || box.right > window.innerWidth + 1) {
          return `left=${Math.round(box.left)} right=${Math.round(box.right)} viewport=${window.innerWidth}`;
        }
        return true;
      });
    // Same shape as the drawer above: the dialog scales into place, so the
    // placement assertion waits for it rather than sampling a fixed pause after
    // it became nominally visible.
    await checkEventually(
      `custom time dialog stays on screen at ${width}px`,
      async () => (await modalOnScreen()) === true,
      { detail: async () => String(await modalOnScreen()) },
    );
    await page.keyboard.press('Escape');
    await page.locator('.req-time-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The detail drawer's copy control sits inside a container that traps focus, which
  // is exactly what makes it worth a browser assertion: a copy path that attaches its
  // scratch element outside the drawer selects nothing, and `execCommand('copy')`
  // answers `true` for that empty selection - so the console announced a copy that
  // never happened. A toast therefore proves nothing. The value is pasted back out of
  // the browser's own pipeline instead, with the drawer closed, because its focus trap
  // would keep the probe input from taking focus while it is open.
  await page.locator('.request-row').first().click();
  await page.locator('.request-detail-id').waitFor({ state: 'visible', timeout: 10000 });
  const drawerRequestId = (await page.locator('.request-detail-id span').first().innerText()).trim();
  const drawerCopyMessage = page.locator('.ant-message').getByText(/已复制|Copied/);
  // Waited for rather than edited away: the message nodes belong to React, and removing
  // one detaches the holder the next message is rendered into, so the copy below would
  // report itself nowhere. Waiting for a leftover carrying this text also keeps the
  // assertion below from passing on a toast an earlier step left behind.
  await drawerCopyMessage.waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
  await page.locator('.request-detail-id').getByRole('button').first().click();
  // The app's own statement that the copy completed, rather than a fixed pause that
  // only guesses when it did.
  await checkEventually(
    'the request detail copy control reports a copy it made',
    async () => (await drawerCopyMessage.count()) > 0,
    { label: "the drawer's copy success message" },
  );
  await page.keyboard.press('Escape');
  // Waited for rather than tolerated: a drawer still closing leaves a mask over the
  // page, and the probe input below could not take focus through it.
  await page.locator('.request-detail-id').waitFor({ state: 'hidden', timeout: 10000 });
  await page.locator('.ant-drawer-mask').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => undefined);
  await page.evaluate(() => {
    const probe = document.createElement('input');
    probe.setAttribute('data-copy-probe', '');
    probe.style.position = 'fixed';
    probe.style.top = '0';
    probe.style.left = '-9999px';
    probe.value = '';
    document.body.appendChild(probe);
    probe.focus();
  });
  await page.keyboard.press('Control+V');
  const pastedRequestId = await page.evaluate(() => document.querySelector('input[data-copy-probe]')?.value ?? '');
  await page.evaluate(() => document.querySelector('input[data-copy-probe]')?.remove());
  check(
    'the request detail copy control puts the id on the clipboard',
    drawerRequestId.length > 0 && pastedRequestId === drawerRequestId,
    `match=${pastedRequestId === drawerRequestId} pastedLength=${pastedRequestId.length} expectedLength=${drawerRequestId.length}`,
  );

  responseBodies.length = 0;
}
