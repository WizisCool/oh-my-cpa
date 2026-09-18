/**
 * The filter dimensions with policy of their own: the preset menu, the cost filter
 * that must travel as one parameter, and the caller alias as an exact match.
 */
export async function filterDimensionsSection(context) {
  const {
    page,
    check,
    checkEventually,
    until,
    appURL,
    clickSettled,
    filterSuffix,
  } = context;


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
}
