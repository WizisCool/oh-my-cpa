/**
 * The search box against everything else: a keystroke queued while another filter
 * changes, the term following navigation, and the parameters that cannot be applied.
 */
export async function searchAndRejectionsSection(context) {
  const {
    page,
    check,
    checkEventually,
    until,
    appURL,
    filterSuffix,
    modelFacet,
    providerFacet,
  } = context;


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
}
