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
 * Ordering is the second half of the same panel: a drag by the handle is a real HTML5 drag through
 * Playwright's mouse, so the handle arming its row is part of the claim, and the step buttons write
 * the same document for the keyboards and touch screens a native drag does not reach. A move is
 * stored per group, the rail follows it, a reload keeps it, a drop across a group heading writes
 * nothing, and Reset order puts the model's own order back without touching what is hidden.
 *
 * Two readings this probe has to get right rather than assume. The rail uppercases its group
 * headings through the stylesheet, so the rendered text is `OPERATE` while the copy says `Operate`;
 * the comparisons normalise case and say so. And the phone half closes the panel before it narrows
 * the viewport, because reaching the rail there means opening a sheet - a scenario that leaves an
 * overlay for the next step to close is measuring the overlay instead of the rail. The panel is then
 * opened once more at that width in the longest translated language, where its two header actions and
 * three controls per row have to fit the dialog rather than be clipped by it.
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

  const collapsedWrites = () => writes.filter((write) => write.key === 'omc_sidebar_collapsed');
  await page.goto(base + '/omc-settings', { waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await until(() => collapsedWrites().length === 1, { label: 'the collapsed sidebar preference to be stored' });
  check('collapsing the desktop rail stores a boolean', bodyOf(collapsedWrites()[0]) === 'true');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor();
  check('a reload keeps the desktop rail collapsed',
    (await page.locator('.app-sider').boundingBox()).width === 58);
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.locator('.mobile-nav-drawer .app-menu').waitFor();
  check('a fresh phone sheet keeps full navigation groups with a collapsed desktop preference',
    await page.locator('.mobile-nav-drawer .ant-menu-item-group-title').count() > 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).waitFor();
  check('the phone sheet reopens closed without rewriting the desktop preference',
    await page.locator('.mobile-nav-drawer .app-menu').count() === 0
      && collapsedWrites().length === 1 && preferences.omc_sidebar_collapsed === true);
  await page.setViewportSize(desktopViewport);
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await until(() => collapsedWrites().length === 2, { label: 'the expanded sidebar preference to be stored' });
  check('expanding the desktop rail stores false', bodyOf(collapsedWrites()[1]) === 'false');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor();
  check('a reload keeps the desktop rail expanded',
    (await page.locator('.app-sider').boundingBox()).width > 58);

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
    await page.getByRole('dialog', { name: 'Sidebar' }).getByRole('button', { name: 'Close' }).click();
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
  const observeRoutes = ['/insights', '/usage/events', '/pricing', '/logs', '/audit'];
  const hideObserve = async () => {
    for (const route of observeRoutes) await rowToggle(route).click();
    await until(() => hiddenWrites().some((write) => observeRoutes.every((route) => JSON.parse(write.body).includes(route))), {
      label: 'every Observe entry to be hidden',
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
  // The clicks reach the cache before they reach the wire, so waiting for the last write
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
    (await rowSummary().innerText()).includes('6 hidden'), await rowSummary().innerText());

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

  // Ordering. The rail lists its entries in the same DOM order it draws them, so the order is read
  // from the attribute the shell already uses to preload a route.
  const navRow = (route) => page.locator('[data-nav-row=' + JSON.stringify(route) + ']');
  const railRoutes = () => page.locator('.app-menu [data-route-path]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-route-path')));
  const operateRoutes = ['/dashboard', '/agent', '/playground', '/model-square'];
  const operateOrder = async () => (await railRoutes()).filter((route) => operateRoutes.includes(route)).join(',');
  const orderWrites = () => writes.filter((write) => write.key === 'omc_nav_order');
  check('the rail starts in the model order',
    await operateOrder() === '/dashboard,/agent,/playground,/model-square', await operateOrder());

  // A drag is a drag: the handle arms its row, and the drop lands on the side the pointer is on.
  // The target position is the row's lower half, so the entry lands after it.
  const agentBox = await navRow('/agent').boundingBox();
  await page.locator('[data-nav-handle="/dashboard"]').dragTo(navRow('/agent'), { targetPosition: { x: 40, y: agentBox.height - 4 } });
  await until(async () => await operateOrder() === '/agent,/dashboard,/playground,/model-square',
    { label: 'the dashboard entry to be dragged after the agent' });
  check('a drag places the entry where it is dropped',
    await operateOrder() === '/agent,/dashboard,/playground,/model-square', await operateOrder());
  await until(() => orderWrites().length === 1, { label: 'the order write to arrive' });
  const draggedOrder = JSON.parse(orderWrites()[0].body);
  check('the move is stored as its group\'s order',
    bodyOf(orderWrites()[0]) === JSON.stringify({ operate: ['/agent', '/dashboard', '/playground', '/model-square'] }),
    JSON.stringify(draggedOrder));

  // A drop across a group heading is not an ordering choice. It is proved by the next write: if the
  // refused drop had stored anything, the step that follows would carry it, and it does not.
  const orderWritesBeforeCrossGroup = orderWrites().length;
  await page.locator('[data-nav-handle="/playground"]').dragTo(navRow('/ai-providers'), { targetPosition: { x: 40, y: 20 } });
  await page.getByRole('button', { name: 'Move earlier · Playground' }).click();
  await until(() => orderWrites().length > orderWritesBeforeCrossGroup, { label: 'the step write to arrive' });
  check('a drop across a group heading writes nothing',
    orderWrites().length === orderWritesBeforeCrossGroup + 1, orderWrites().length + ' order writes');
  check('the step buttons write the same group order',
    bodyOf(orderWrites()[orderWrites().length - 1]).includes(JSON.stringify(['/agent', '/playground', '/dashboard', '/model-square'])),
    bodyOf(orderWrites()[orderWrites().length - 1]));
  await until(async () => await operateOrder() === '/agent,/playground,/dashboard,/model-square',
    { label: 'the stepped order in the rail' });
  check('the step buttons move the entry in the rail too',
    await operateOrder() === '/agent,/playground,/dashboard,/model-square', await operateOrder());

  // The stored document is what the next page load reads, not a draft kept on this page.
  await closePanel();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(async () => await operateOrder() === '/agent,/playground,/dashboard,/model-square',
    { label: 'the stored order after a reload' });
  check('a reloaded console keeps the order',
    await operateOrder() === '/agent,/playground,/dashboard,/model-square', await operateOrder());
  await openPanel();

  const orderWritesBeforeOrderReset = orderWrites().length;
  await page.getByRole('button', { name: 'Reset order' }).click();
  await until(() => orderWrites().length > orderWritesBeforeOrderReset, { label: 'the order reset write' });
  check('Reset order writes the empty document',
    bodyOf(orderWrites()[orderWrites().length - 1]) === '{}', bodyOf(orderWrites()[orderWrites().length - 1]));
  await until(async () => await operateOrder() === '/dashboard,/agent,/playground,/model-square',
    { label: 'the model order back in the rail' });
  check('Reset order puts the model order back',
    await operateOrder() === '/dashboard,/agent,/playground,/model-square', await operateOrder());
  check('Reset order leaves visibility alone',
    await page.locator('[data-nav-toggle] button[aria-checked=true]').count() === 17,
    await page.locator('[data-nav-toggle] button[aria-checked=true]').count() + ' shown');

  // A non-default order has to reach the phone sheet too: at that width the sheet is the rail's
  // only rendering, and it is built from the same ordered model rather than a fresh copy.
  await page.getByRole('button', { name: 'Move earlier · Playground' }).click();
  await until(async () => await operateOrder() === '/dashboard,/playground,/agent,/model-square',
    { label: 'the reordered entries in the rail before the phone check' });

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
  check('the phone sheet draws the order the operator arranged',
    await operateOrder() === '/dashboard,/playground,/agent,/model-square', await operateOrder());

  // The panel itself at a phone width, in the longest language the console ships: two header
  // actions and three controls per row have to fit the dialog rather than being clipped by it.
  // The language is the browser's stored preference, so seeding it and reloading is the same path
  // the operator's own switch takes; the reload also proves the panel reads the stored order.
  await page.evaluate(() => window.localStorage.setItem('omc-lang', 'ms'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.omc-settings-page').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Urus entri' }).click();
  await panel().waitFor({ timeout: 20_000 });
  const malayOverflow = await panel().evaluate((node) => node.scrollWidth - node.clientWidth);
  check('the phone dialog fits the long Malay labels', malayOverflow <= 0, 'overflow ' + malayOverflow + 'px');
  check('both header actions stay usable in the phone dialog',
    await page.getByRole('button', { name: 'Tetapkan semula susunan' }).isVisible()
      && await page.getByRole('button', { name: 'Tunjuk semua' }).isVisible());
  check('opening the phone sheet does not change the desktop rail preference',
    collapsedWrites().length === 2 && preferences.omc_sidebar_collapsed === false);
}
