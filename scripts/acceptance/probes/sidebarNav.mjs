import { until } from '../harness.mjs';

/**
 * The rail visibility setting: the console hides the entries an operator does not use, and every
 * page stays reachable.
 *
 * The console ships one fixed rail, and a deployment that never opens the Agent, the Playground or
 * the audit trail still sees all of them. Turning them off is a setting on the OMC settings page -
 * one row there, and the panel that row opens lists the rail - and what makes it worth a browser is
 * that four separate things have to agree about it: the panel the settings row opens, the rail that
 * draws them, the group headings that must not be left empty, and the shell reading of the route the
 * operator is on. None of those is reachable from a per-component test, because three of them are
 * the shell the panel lives inside.
 *
 * The claims asserted here: the row on the settings page states what is hidden without the panel
 * being opened, the rail answers on the same frame as the switch, the choice is stored as the set of
 * hidden routes, a group whose every entry is hidden goes with them, the groups that still have
 * entries keep their headings, a hidden page names itself in the document title when it is opened
 * directly, a reload keeps the choice, the entry that owns the setting cannot be hidden or clicked
 * away, Show all puts everything back, and the phone sheet - at that width the rail's only
 * rendering - draws the same set.
 *
 * Two readings this probe has to get right rather than assume. The rail uppercases its group
 * headings through the stylesheet, so the rendered text is `OPERATE` while the copy says `Operate`;
 * the comparisons normalise case and say so. And the phone half comes last, and closes the panel
 * before it narrows the viewport, because reaching the rail there means opening a sheet - a scenario
 * that leaves an overlay for the next step to close is measuring the overlay instead of the rail.
 */
export async function sidebarNavCustomization({ base, page, check }) {
  const preferences = {};
  const writes = [];
  const hiddenWrites = () => writes.filter((write) => write.key === 'omc_nav_hidden');
  const bodyOf = (write) => JSON.stringify(JSON.parse(write.body));
  await page.route('**/omc/api/**/preferences', (route) => route.fulfill({
    json: { preferences, time_zone: { server_timezone: 'UTC' } },
  }));
  await page.route('**/omc/api/**/preferences/*', async (route) => {
    if (route.request().method() === 'PUT') {
      const key = new URL(route.request().url()).pathname.split('/').pop();
      writes.push({ key, body: route.request().postData() });
      preferences[key] = JSON.parse(route.request().postData());
    }
    return route.fallback();
  });

  // Every row lives in the panel, so each journey to a row opens the panel first and closes it
  // before doing anything the overlay would sit in front of. What the page itself carries is one row
  // whose description says how many entries are out of the rail.
  const panel = () => page.locator('[data-testid="sidebar-nav-dialog"]');
  const rowSummary = () => page.locator('[data-testid="sidebar-nav-settings"] .settings-toggle-desc');
  const openPanel = async () => {
    await page.getByRole('button', { name: 'Manage entries' }).click();
    await panel().waitFor({ timeout: 20_000 });
  };
  const closePanel = async () => {
    await page.keyboard.press('Escape');
    await panel().waitFor({ state: 'hidden', timeout: 20_000 });
  };
  const settingsPage = async () => {
    await page.goto(base + '/omc-settings', { waitUntil: 'domcontentloaded' });
    await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
    await openPanel();
  };
  await settingsPage();

  // The rail names each destination by the attribute the shell also preloads a route from, and
  // heads each run of entries with the menu's own group title.
  const railEntry = (route) => page.locator('.app-menu [data-route-path=' + JSON.stringify(route) + ']');
  const railGroups = () => page.locator('.app-menu .ant-menu-item-group-title').allInnerTexts();
  const hasGroup = (headings, name) => headings.some((heading) => heading.trim().toUpperCase() === name.toUpperCase());
  // The panel addresses each switch by the route it governs, so a row cannot be confused with the
  // rail entry it changes; the row around a locked switch is what an operator presses, because the
  // switch itself refuses the click.
  const rowToggle = (route) => page.locator('[data-nav-toggle=' + JSON.stringify(route) + '] button');
  const rowOf = (route) => panel().locator('.settings-toggle-row').filter({ has: rowToggle(route) });
  const showAll = () => page.getByRole('button', { name: 'Show all' });
  const observeRoutes = ['/usage/events', '/pricing', '/logs', '/audit'];
  const hideObserve = async () => {
    for (const route of observeRoutes) await rowToggle(route).click();
    await until(() => hiddenWrites().some((write) => observeRoutes.every((route) => JSON.parse(write.body).includes(route))), {
      label: 'the four Observe entries to be hidden',
    });
  };

  await until(async () => (await railEntry('/agent').count()) === 1, { label: 'the Agent entry in the rail' });
  check('the rail starts with every entry',
    await railEntry('/agent').count() === 1 && await railEntry('/audit').count() === 1,
    (await railGroups()).join(' | '));
  check('the settings row says nothing is out of the rail yet',
    (await rowSummary().innerText()).includes('Every entry is shown'), await rowSummary().innerText());
  check('the panel lists an entry per rail destination, the locked one among them',
    await rowToggle('/agent').count() === 1 && await rowToggle('/omc-settings').count() === 1);
  check('a fresh console hides nothing, so the reset has nothing to put back', await showAll().isDisabled());

  // Hiding one entry: the rail answers immediately, and the stored document is the hidden set.
  await rowToggle('/agent').click();
  await until(async () => (await railEntry('/agent').count()) === 0, { label: 'the Agent entry to leave the rail' });
  check('hiding an entry takes it out of the rail and leaves the rest',
    await railEntry('/agent').count() === 0 && await railEntry('/playground').count() === 1);
  await until(() => hiddenWrites().length === 1, { label: 'the hidden set write' });
  check('the choice is stored as the set of hidden routes',
    bodyOf(hiddenWrites()[0]) === JSON.stringify(['/agent']), bodyOf(hiddenWrites()[0]));
  check('the row stays in the panel, so the entry can be put back',
    await rowToggle('/agent').count() === 1 && await showAll().isEnabled());

  // A heading with nothing under it reads as a section that failed to load, so it goes as well.
  await hideObserve();
  // The four clicks reach the cache before they reach the wire, so waiting for the last write
  // still leaves the drawn menu a frame behind it: the heading has to be gone from the rail
  // itself before its absence is asserted. A sheet opened after the fact renders the new state
  // on its own, which is why the phone half of this scenario does not need the same wait.
  await until(async () => hasGroup(await railGroups(), 'Observe') === false,
    { label: 'the emptied Observe group to leave the rail' });
  const groupsAfterHiding = await railGroups();
  check('a group whose every entry is hidden goes with them',
    hasGroup(groupsAfterHiding, 'Observe') === false, groupsAfterHiding.join(' | '));
  check('the groups that still have entries keep their headings',
    hasGroup(groupsAfterHiding, 'Operate'), groupsAfterHiding.join(' | '));

  // A hidden entry is a rail preference, not a deleted page: the shell reads the full model, so a
  // page opened by URL still names itself. The panel closes first, because this step is about the
  // page the URL names and not about the overlay it would otherwise leave in front of it.
  await closePanel();
  await page.goto(base + '/logs', { waitUntil: 'domcontentloaded' });
  await until(async () => (await page.title()).includes('Logs'), { label: 'the document title of a hidden page' });
  check('a hidden page is still reachable by URL and still names itself', (await page.title()).includes('Logs'), await page.title());

  await settingsPage();
  await until(async () => (await railEntry('/agent').count()) === 0, { label: 'the hidden entry after a reload' });
  check('a reloaded console keeps the hidden set',
    await railEntry('/agent').count() === 0 && hasGroup(await railGroups(), 'Observe') === false,
    (await railGroups()).join(' | '));
  // The setting reads without the panel being opened: the row states what the panel holds.
  check('the settings row states how many entries are out of the rail',
    (await rowSummary().innerText()).includes('5 hidden'), await rowSummary().innerText());

  // The page that owns the setting is not hideable: a preference that could remove its own surface
  // would leave the operator unable to undo it from the console.
  check('the entry that owns the rail is shown switched on and inert',
    await rowToggle('/omc-settings').isDisabled()
      && (await rowToggle('/omc-settings').getAttribute('aria-checked')) === 'true');
  // A disabled switch is inert in the browser rather than through a handler, so the press happens on
  // the row around it. It is a plain click on purpose: a forced one skips the stability wait and can
  // dispatch at a point the dialog's opening animation has already moved past, landing on the mask
  // behind it - which closes the panel and takes every claim after this one with it.
  const writesBeforeLockedClick = writes.length;
  await rowOf('/omc-settings').locator('.settings-toggle-title').click();
  await until(async () => (await panel().isVisible()), { label: 'the panel to stay open' });
  await until(async () => (await railEntry('/omc-settings').count()) === 1, { label: 'the settings entry to stay in the rail' });
  check('clicking the locked row leaves the rail, the panel and the stored set unchanged',
    await panel().isVisible()
      && await railEntry('/omc-settings').count() === 1
      && writes.slice(writesBeforeLockedClick).filter((write) => String(write.body).includes('/omc-settings')).length === 0,
    writes.slice(writesBeforeLockedClick).map((write) => write.body).join(' '));

  // Everything back, and the write that says so. The rail answers on the click frame from the
  // optimistic cache, so the write is waited for in its own right: the payload assertion below
  // reads the wire, and the wire can trail the UI by a round trip.
  const writesBeforeReset = hiddenWrites().length;
  await showAll().click();
  await until(async () => (await railEntry('/audit').count()) === 1, { label: 'every entry back after Show all' });
  await until(() => hiddenWrites().length > writesBeforeReset, { label: 'the reset write to arrive' });
  check('Show all puts every entry back',
    await railEntry('/audit').count() === 1 && await railEntry('/agent').count() === 1 && hasGroup(await railGroups(), 'Observe'),
    (await railGroups()).join(' | '));
  check('nothing in the panel is left switched off',
    await page.locator('[data-nav-toggle] button[aria-checked=false]').count() === 0);
  check('showing everything writes the empty hidden set',
    bodyOf(hiddenWrites()[hiddenWrites().length - 1]) === '[]', bodyOf(hiddenWrites()[hiddenWrites().length - 1]));

  // At a phone width the rail exists only in the sheet, so what the sheet draws is what the
  // operator has. The choice is made while the panel is still laid out for the width it was opened
  // at; the panel then closes, and the sheet is opened on the page underneath.
  await hideObserve();
  await closePanel();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app-header-left button').first().click();
  await page.locator('.mobile-nav-drawer:visible').waitFor({ timeout: 10_000 });
  await until(async () => (await railEntry('/dashboard').count()) === 1, { label: 'the phone sheet to draw the rail' });
  const sheetGroups = await railGroups();
  check('the phone sheet draws the same set the rail does',
    await railEntry('/dashboard').count() === 1 && await railEntry('/agent').count() === 1 && await railEntry('/audit').count() === 0,
    await railEntry('/dashboard').count() + ' dashboard, ' + await railEntry('/agent').count() + ' agent, '
      + await railEntry('/audit').count() + ' audit');
  check('the phone sheet leaves out the group its hidden entries emptied',
    hasGroup(sheetGroups, 'Operate') && hasGroup(sheetGroups, 'Observe') === false, sheetGroups.join(' | '));
}
