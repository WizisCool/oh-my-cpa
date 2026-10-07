import { ARRIVAL_REQUEST_ID } from './arrival-fixture.mjs';

import {
  EVENT_AUTO_REFRESH_MS,
} from '../../../web/src/types/usageEventCadence.ts';

/**
 * The live tail and the poll: ordering, the auto-refresh switch, the hold a reader
 * takes when they scroll away, the arrival pill, and the facets' freshness policy.
 */
export async function liveTailSection(context) {
  const {
    page,
    check,
    checkEventually,
    until,
    measureStable,
    clickSettled,
    listScroller,
    describeListTree,
    rowTimestamps,
    filterSuffix,
    autoRefreshSwitch,
    releaseArrival,
  } = context;


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

  // Release only after the reader's held window is stable. The next ordinary
  // poll receives the real server's ID-based arrival count, independent of how
  // long build, sign-in and the preceding assertions took.
  releaseArrival();
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
  const firstRequestID = () => page.locator('.request-row .req-time-sub').first().getAttribute('title');
  await until(async () => await firstRequestID() === ARRIVAL_REQUEST_ID, { label: 'the released arrival to lead the applied backlog' });
  const newestFirst = await rowTimestamps();
  check(
    'the new record is the first row',
    await firstRequestID() === ARRIVAL_REQUEST_ID && newestFirst.length > 0 && newestFirst[0] >= Math.max(...newestFirst),
    `first=${newestFirst.length ? new Date(newestFirst[0]).toISOString() : 'none'}`,
  );
  // The window survives a reload. Facets and filters were reloaded repeatedly by
  // the checks above, so this is the one place the saved view is exercised end to
  // end: choose an explicit window, a page size and a cost filter, clear the
  // filters, then reopen the bare route.
  await clickSettled('.req-time-button', 'the time-range control');
  await page
    .locator('.time-range-option')
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
}
