/**
 * The filter panel's edits: a chip, the advanced drawer's draft and apply, the
 * irreducible window refusal, clear-all, the result verdict, and the cursor a filter
 * change has to drop.
 */
export async function filterPanelSection(context) {
  const {
    page,
    check,
    checkEventually,
    checkHoldsFor,
    until,
    appURL,
    clickSettled,
    filterSuffix,
    modelFacet,
  } = context;


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


  // Multi-select is the point of the rewrite, and the chip is where the operator
  // sees what is applied. Both halves are asserted together because a filter that
  // reached the URL without rendering a chip leaves the operator unable to remove
  // it.

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
}
