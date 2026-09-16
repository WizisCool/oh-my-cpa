/**
 * Auth-file release acceptance: the credential list, provider filters,
 * lifecycle controls, safe field editing and verified persistence readback.
 * The top-level file owns process/browser lifecycle; this module owns the
 * domain flow and receives only the shared harness handles it needs.
 */
export async function runAuthFilesAcceptance({
  auditPage,
  appURL,
  page,
  check,
  checkEventually,
  responseBodies,
  providerSecrets,
  until,
  measureStable,
  settleLayout,
  lobeIconSignature,
  lobeIconImageState,
  path,
  root,
}) {
    await auditPage(page, responseBodies, '/auth-files', '.auth-files-page', { pageSecrets: providerSecrets });

    // Auth Files Page Flow & Behavioral Checks
    await page.goto(`${appURL}/auth-files`, { waitUntil: 'domcontentloaded' });
    await page.locator('.auth-files-page').first().waitFor({ state: 'visible', timeout: 15000 });

    // 1. Initial card count
    const authCardCount = await page.locator('.auth-files-page .ant-card').count();
    check('auth-files page renders credential cards', authCardCount >= 5, `cards=${authCardCount}`);

    // 2. Search filtering
    const searchInput = page.locator('.auth-files-page input[placeholder*="Search"], .auth-files-page input[placeholder*="搜索"]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('claude');
      await checkEventually(
        'auth-files search filters to matching file',
        async () => (await page.locator('.auth-files-page .ant-card').count()) === 1,
        { detail: async () => `count=${await page.locator('.auth-files-page .ant-card').count()}` },
      );
      await searchInput.fill('');
      // Clearing is a precondition for the tab checks below, so the list is awaited
      // rather than slept through.
      await until(async () => (await page.locator('.auth-files-page .ant-card').count()) > 1, {
        label: 'the cleared search box to restore the card list',
      });
    }

    // 3. Provider tabs & brand icons verification. Tab filtering and the correct
    // brand drawing are pinned together: the failure this guards is a tab that
    // filters correctly while wearing another provider's mark, which is why the icon
    // is read from the rendered asset rather than from the catalog.
    const codexTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Codex/i }).first();
    await codexTab.waitFor({ state: 'visible', timeout: 5000 });
    await codexTab.click();
    await checkEventually(
      'auth-files provider tab filters to Codex',
      async () => (await page.locator('.auth-files-page .ant-card').count()) === 2,
      { detail: async () => `count=${await page.locator('.auth-files-page .ant-card').count()}` },
    );
    const allTab = page.locator('.auth-files-page .ant-tabs-tab').first();
    await allTab.click();
    await until(async () => (await page.locator('.auth-files-page .ant-card').count()) > 2, {
      label: 'the unfiltered card list to come back',
    });

    // The embedded static asset is the part that matters: a mark that resolves in the
    // catalog but never loads is invisible to every presence assertion, so the image's
    // own decoded size is what is read.
    const antigravityTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }).first();
    await checkEventually(
      'Antigravity tab icon loads from the embedded static asset',
      async () => {
        const state = await lobeIconImageState(antigravityTab);
        return state?.complete === true
          && state.naturalWidth > 0
          && state.naturalHeight > 0
          && /antigravity-color\.svg$/i.test(state.src);
      },
      { detail: async () => JSON.stringify(await lobeIconImageState(antigravityTab)) },
    );

    const xaiTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /xAI|Xai/i }).first();
    const xaiIcon = await lobeIconSignature(xaiTab);
    check('xAI tab icon is not OpenAI', /xai/i.test(xaiIcon) && !/openai/i.test(xaiIcon), xaiIcon);

    const kimiTab = page.locator('.auth-files-page .ant-tabs-tab').filter({ hasText: /Kimi/i }).first();
    const kimiIcon = await lobeIconSignature(kimiTab);
    check('Kimi tab icon is not OpenAI', /kimi/i.test(kimiIcon) && !/openai/i.test(kimiIcon), kimiIcon);

    // Verify tab hover stability
    await codexTab.hover();
    // Read once the hover transition has settled: a mid-transition read would
    // compare an interpolated colour against the transparent check below.
    const hoverBackground = await measureStable(
      () => codexTab.evaluate((el) => window.getComputedStyle(el).backgroundColor),
      { page, label: 'the tab hover background' },
    );
    await page.screenshot({ path: path.join(root, 'tmp', 'auth-files-hover-desktop.png') });
    check('tab hover has valid background', hoverBackground !== 'transparent' && hoverBackground !== 'rgba(0, 0, 0, 0)', `bg=${hoverBackground}`);

    // 4. Drawer: the dirty-close confirmation is the one auth-files interaction whose
    // failure loses operator work, so it is exercised through both answers - cancel
    // keeps the drawer, confirm discards it. The quick-models modal and the batch
    // selection bar are dropped: both are presence checks on controls whose real
    // behaviour (the model list, the batch action) is not asserted here at all, so
    // they cost a navigation and a click without adding evidence.
    const editBtn = page.locator('.auth-files-page button').filter({ hasText: /编辑|Edit/i }).first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      const drawer = page.locator('.ant-drawer');
      await drawer.waitFor({ state: 'visible', timeout: 5000 });
      check('auth-files drawer opens', await drawer.isVisible());

      // Modify a field to dirty the form
      const noteArea = drawer.locator('#note');
      await noteArea.fill('new dirty test note');

      // Attempt close while dirty -> triggers confirm modal
      const drawerCloseBtn = drawer.locator('.ant-drawer-close');
      await drawerCloseBtn.click();
      const confirmModal = page.locator('.ant-modal-confirm');
      await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
      check('auth-files drawer dirty close prompts confirmation', await confirmModal.isVisible());

      // Cancel keeping it open
      const cancelConfirm = confirmModal.locator('.ant-btn').filter({ hasText: /取\s*消|Cancel/i }).first();
      await cancelConfirm.click();
      await confirmModal.waitFor({ state: 'hidden', timeout: 5000 });
      check('auth-files cancel keeps drawer open', await drawer.isVisible());

      // Confirm discard
      await drawerCloseBtn.click();
      await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
      const okConfirm = confirmModal.locator('.ant-btn').filter({ hasText: /确\s*定|Confirm/i }).first();
      await okConfirm.click();
      await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
      check('auth-files discard closes drawer', (await page.locator('.ant-drawer-open').count()) === 0);
    }

    // 5. Actual status toggle on card. A credential that cannot be turned off is the
    // failure that keeps routing traffic into a retired account, so both directions
    // are asserted.
    const kimiCard = page.locator('.auth-files-page .ant-card').filter({ hasText: 'kimi-fixture.json' }).first();
    check('auth-files kimi card found', await kimiCard.isVisible());
    const kimiSwitch = kimiCard.locator('.ant-switch');
    await kimiSwitch.click();
    await checkEventually(
      'auth-files single toggle disables card',
      () => kimiCard.getByText(/DISABLED|已禁用/).first().isVisible(),
    );
    await kimiSwitch.click();
    await checkEventually(
      'auth-files single toggle re-enables card',
      () => kimiCard.getByText(/ACTIVE|正常/).first().isVisible(),
    );

    // 6. Runtime-only card guard
    const runtimeCard = page.locator('.auth-files-page .ant-card').filter({ hasText: 'virtual-runtime.json' }).first();
    check('auth-files runtime card renders VIRTUAL badge', await runtimeCard.getByText(/VIRTUAL|虚拟/).first().isVisible());
    check('auth-files runtime card has no selection checkbox', (await runtimeCard.locator('input[type="checkbox"]').count()) === 0);
    check('auth-files runtime card switch is disabled', await runtimeCard.locator('.ant-switch-disabled').isVisible());

    // 9. Drawer save submits patch and updates UI
    const xaiCard = page.locator('.auth-files-page .ant-card').filter({ hasText: 'xai-fixture.json' }).first();
    const xaiEditBtn = xaiCard.locator('button').filter({ hasText: /编辑|Edit/i });
    await xaiEditBtn.click();
    const saveDrawer = page.locator('.ant-drawer');
    await saveDrawer.waitFor({ state: 'visible', timeout: 5000 });
    const noteInput = saveDrawer.locator('#note');
    await noteInput.fill('persisted note by acceptance test');
    const saveBtn = saveDrawer.locator('button').filter({ hasText: /保存|Save/i }).first();
    await saveBtn.click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
    const updatedNote = xaiCard.getByText('persisted note by acceptance test');
    await updatedNote.waitFor({ state: 'visible', timeout: 5000 });
    check('auth-files card displays updated note after save', await updatedNote.isVisible());

    // Priority and weight must survive a write, a server-side readback and the
    // list refresh. The fake CPA stores the patch, so this exercises the same
    // draw-close-reopen path as a real credential rather than only the toast.
    await xaiEditBtn.click();
    await saveDrawer.waitFor({ state: 'visible', timeout: 5000 });
    await saveDrawer.locator('#priority').fill('42');
    await saveDrawer.locator('#weight').fill('7');
    await saveDrawer.locator('#expired').fill('2028-04-05T06:07:08Z');
    await saveDrawer.locator('button').filter({ hasText: /保存|Save/i }).first().click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
    await checkEventually(
      'auth-files priority and weight survive save and verified readback',
      async () => (await xaiCard.getByText('P:42').count()) === 1 && (await xaiCard.getByText('W:7').count()) === 1,
      { detail: async () => `priority=${await xaiCard.getByText(/^P:/).count()} weight=${await xaiCard.getByText(/^W:/).count()}` },
    );
    await xaiEditBtn.click();
    await saveDrawer.waitFor({ state: 'visible', timeout: 5000 });
    check('auth-files reopened drawer shows persisted priority', (await saveDrawer.locator('#priority').inputValue()) === '42');
    check('auth-files reopened drawer shows persisted weight', (await saveDrawer.locator('#weight').inputValue()) === '7');
    check('auth-files reopened drawer shows persisted expiry', (await saveDrawer.locator('#expired').inputValue()) === '2028-04-05T06:07:08Z');
    await saveDrawer.locator('.ant-drawer-close').click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });

    // 10. Viewports at 390px and 320px for auth-files
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await measureStable(
        () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)),
        { page, label: 'the auth-files page overflow measurement' },
      );
      check(`auth-files ${width}px viewport has no overflow`, overflow === 0, `overflow=${overflow}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
}
