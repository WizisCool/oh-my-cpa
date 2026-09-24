/**
 * Auth-file release acceptance: the credential list, provider filters,
 * lifecycle controls, safe field editing and verified persistence readback.
 * The top-level runner owns process/browser lifecycle; this module owns the
 * domain flow and receives only the shared harness handles it needs.
 */
import { FAKE_PLUGIN_LOGO_DATA_URL } from '../fake-cpa.mjs';

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
  lobeIconSignature,
  lobeIconImageState,
  providerMarkImage,
  path,
  root,
}) {
    let oauthStarts = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/management/oauth/start')) oauthStarts += 1;
    });

    await auditPage(page, responseBodies, '/oauth-management', '.oauth-management-page', { pageSecrets: providerSecrets });

    // Legacy URL migration: documented intent survives, callback/session material
    // never enters the new query string, and one-shot actions are consumed before
    // the overlay opens.
    await page.goto(`${appURL}/auth-files?provider=codex&q=fixture&code=secret`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/oauth-management**', { timeout: 15000 });
    let migrated = new URL(page.url());
    check('legacy auth-files URL redirects to the canonical workspace', migrated.pathname.endsWith('/oauth-management'));
    check(
      'legacy auth-files URL preserves provider and search but drops callback material',
      migrated.searchParams.get('provider') === 'codex'
        && migrated.searchParams.get('q') === 'fixture'
        && !migrated.searchParams.has('code'),
      migrated.search,
    );

    await page.goto(`${appURL}/oauth?provider=codex&state=old-state&code=old-code`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/oauth-management**', { timeout: 15000 });
    await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5000 });
    migrated = new URL(page.url());
    check(
      'legacy OAuth URL opens Connect for the requested provider without starting it',
      migrated.pathname.endsWith('/oauth-management')
        && migrated.searchParams.get('provider') === 'codex'
        && !migrated.searchParams.has('action')
        && !migrated.searchParams.has('connect_provider')
        && !migrated.searchParams.has('state')
        && !migrated.searchParams.has('code'),
      migrated.search,
    );
    check(
      'Connect shows the provider details without starting an authorization request',
      (await page.locator('[data-testid="oauth-connect-panel"]').getByText(/Codex/i).count()) > 0
        && oauthStarts === 0
        && (await page.getByText(/等待.*授权|Waiting for browser authorization/i).count()) === 0,
      `starts=${oauthStarts}`,
    );
    await page.keyboard.press('Escape');
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });

    await page.goto(`${appURL}/quota?provider=codex&session_id=old-session`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/oauth-management**', { timeout: 15000 });
    await until(
      () => !new URL(page.url()).searchParams.has('focus'),
      { label: 'the one-shot quota focus intent to be consumed', timeoutMs: 5000 },
    );
    migrated = new URL(page.url());
    check(
      'legacy quota URL maps to expanded quota emphasis without forwarding session state',
      migrated.pathname.endsWith('/oauth-management')
        && migrated.searchParams.get('provider') === 'codex'
        && migrated.searchParams.get('density') === 'expanded'
        && !migrated.searchParams.has('focus')
        && !migrated.searchParams.has('session_id'),
      migrated.search,
    );

    // Auth Files Page Flow & Behavioral Checks
    await page.goto(`${appURL}/oauth-management`, { waitUntil: 'domcontentloaded' });
    await page.locator('.oauth-management-page').first().waitFor({ state: 'visible', timeout: 15000 });

    // 1. Initial card count
    await checkEventually(
      'oauth-management page renders credential records',
      async () => (await page.locator('[data-testid="oauth-credential-record"]').count()) >= 5,
      { detail: async () => `cards=${await page.locator('[data-testid="oauth-credential-record"]').count()}` },
    );

    // The unified surface owns one shared quota snapshot. Every visible body
    // belongs to its own row's exact auth index, and expanded density exposes the
    // full returned window set rather than a two-window preview.
    await checkEventually(
      'oauth-management renders shared quota bodies for matching credentials',
      async () => (await page.locator('[data-quota-body]').count()) > 0,
      { detail: async () => `bodies=${await page.locator('[data-quota-body]').count()}` },
    );
    const joinAudit = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="oauth-credential-record"]')];
      const mismatches = [];
      let bodies = 0;
      for (const row of rows) {
        const authIndex = row.getAttribute('data-auth-index') || '';
        for (const body of row.querySelectorAll('[data-quota-body]')) {
          bodies += 1;
          if ((body.getAttribute('data-quota-body') || '') !== authIndex) {
            mismatches.push({ authIndex, body: body.getAttribute('data-quota-body') });
          }
        }
      }
      return {
        rows: rows.length,
        bodies,
        globalBodies: document.querySelectorAll('[data-quota-body]').length,
        mismatches,
      };
    });
    check(
      'oauth-management joins quota by the row auth index only',
      joinAudit.mismatches.length === 0 && joinAudit.bodies === joinAudit.globalBodies,
      JSON.stringify(joinAudit),
    );
    const expandedBody = page.locator('[data-quota-density="expanded"]').first();
    await expandedBody.waitFor({ state: 'visible', timeout: 10000 });
    const expandedAudit = await expandedBody.evaluate((body) => ({
      declared: Number(body.getAttribute('data-quota-window-count') || '0'),
      rendered: body.querySelectorAll('.ant-progress').length,
    }));
    check(
      'expanded quota body renders every returned window',
      expandedAudit.rendered === expandedAudit.declared,
      JSON.stringify(expandedAudit),
    );
    const duplicateIndexRows = page.locator('[data-testid="oauth-credential-record"]').filter({ hasText: /duplicate-provider-/ });
    check('duplicate auth indexes remain visible as distinct credential records', (await duplicateIndexRows.count()) === 2);
    check(
      'duplicate auth indexes are reported as ambiguous rather than joined or written',
      (await duplicateIndexRows.filter({ hasText: /认证索引重复|Duplicate auth index/i }).count()) === 2
        && (await duplicateIndexRows.locator('[data-quota-body]').count()) === 0,
      `ambiguous=${await duplicateIndexRows.filter({ hasText: /认证索引重复|Duplicate auth index/i }).count()} bodies=${await duplicateIndexRows.locator('[data-quota-body]').count()}`,
    );
    const missingIndexRow = page.locator('[data-testid="oauth-credential-record"]').filter({ hasText: 'runtime-no-index.json' });
    check(
      'a missing auth index stays visible without fabricating quota ownership',
      (await missingIndexRow.count()) === 1
        && (await missingIndexRow.getByText(/缺少认证索引|Missing auth index/i).count()) > 0
        && (await missingIndexRow.locator('[data-quota-body]').count()) === 0,
    );

    // 2. Search filtering
    const searchInput = page.locator('.oauth-management-page input[placeholder*="Search"], .oauth-management-page input[placeholder*="搜索"]').first();
    await searchInput.waitFor({ state: 'visible', timeout: 5000 });
    await searchInput.fill('claude');
    await checkEventually(
      'oauth-management search filters to matching credential',
      async () => (await page.locator('[data-testid="oauth-credential-record"]').count()) === 1,
      { detail: async () => `count=${await page.locator('[data-testid="oauth-credential-record"]').count()}` },
    );
    await searchInput.fill('');
    // Clearing is a precondition for the tab checks below, so the list is awaited
    // rather than slept through.
    await until(async () => (await page.locator('[data-testid="oauth-credential-record"]').count()) > 1, {
      label: 'the cleared search box to restore the card list',
    });

    // 3. Provider tabs & brand icons verification. Tab filtering and the correct
    // brand drawing are pinned together: the failure this guards is a tab that
    // filters correctly while wearing another provider's mark, which is why the icon
    // is read from the rendered asset rather than from the catalog.
    const codexTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Codex/i }).first();
    await codexTab.waitFor({ state: 'visible', timeout: 5000 });
    await codexTab.click();
    await checkEventually(
      'oauth-management provider tab filters to Codex',
      // Three fixture credentials are Codex: two real seats plus the runtime-only one.
      async () => (await page.locator('[data-testid="oauth-credential-record"]').count()) === 3,
      { detail: async () => `count=${await page.locator('[data-testid="oauth-credential-record"]').count()}` },
    );
    const allTab = page.locator('.oauth-management-page .ant-tabs-tab').first();
    await allTab.click();
    await until(async () => (await page.locator('[data-testid="oauth-credential-record"]').count()) > 2, {
      label: 'the unfiltered card list to come back',
    });

    // The embedded static asset is the part that matters: a mark that resolves in the
    // catalog but never loads is invisible to every presence assertion, so the image's
    // own decoded size is what is read.
    const antigravityTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }).first();
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

    const xaiTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /xAI|Xai/i }).first();
    const xaiIcon = await lobeIconSignature(xaiTab);
    check('xAI tab icon is not OpenAI', /xai/i.test(xaiIcon) && !/openai/i.test(xaiIcon), xaiIcon);

    const kimiTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Kimi/i }).first();
    const kimiIcon = await lobeIconSignature(kimiTab);
    check('Kimi tab icon is not OpenAI', /kimi/i.test(kimiIcon) && !/openai/i.test(kimiIcon), kimiIcon);

    // The brand marks that used to render as a neutral placeholder while their
    // artwork sat unused in the bundle: a catalog brand the display table had not
    // been taught (Devin), and a provider whose mark only its plugin can supply.
    const devinTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Devin/i }).first();
    await checkEventually(
      'Devin tab draws the Devin brand mark',
      async () => {
        const mark = await providerMarkImage(devinTab);
        return Boolean(mark)
          && mark.complete === true
          && mark.naturalWidth > 0
          && /devin/i.test(mark.src)
          && !/openai/i.test(mark.src);
      },
      { detail: async () => JSON.stringify(await providerMarkImage(devinTab)) },
    );

    const pluginTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Iflow/i }).first();
    await checkEventually(
      'a plugin-owned provider tab draws the plugin\u2019s own logo',
      async () => {
        const mark = await providerMarkImage(pluginTab);
        // The fixture's own artwork, not merely "an image loaded": a catalog mark, a
        // neighbouring plugin's logo and the console's fallback would all satisfy a
        // weaker check while answering a different question.
        return Boolean(mark)
          && mark.complete === true
          && mark.naturalWidth > 0
          && mark.src === FAKE_PLUGIN_LOGO_DATA_URL;
      },
      { detail: async () => JSON.stringify(await providerMarkImage(pluginTab)) },
    );

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
    const editBtn = page.locator('.oauth-management-page button').filter({ hasText: /编辑|Edit/i }).first();
    await editBtn.waitFor({ state: 'visible', timeout: 5000 });
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

    // 5. Actual status toggle on card. A credential that cannot be turned off is the
    // failure that keeps routing traffic into a retired account, so both directions
    // are asserted.
    const kimiCard = page.locator('[data-testid="oauth-credential-record"]').filter({ hasText: 'kimi-fixture.json' }).first();
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
      () => kimiCard.getByText(/ACTIVE|Enabled|正常|已启用/).first().isVisible(),
    );

    // 6. Runtime-only card guard
    const runtimeCard = page.locator('[data-testid="oauth-credential-record"]').filter({ hasText: 'virtual-runtime.json' }).first();
    check('auth-files runtime card renders VIRTUAL badge', await runtimeCard.getByText(/VIRTUAL|虚拟/).first().isVisible());
    check('auth-files runtime card has no selection checkbox', (await runtimeCard.locator('input[type="checkbox"]').count()) === 0);
    check('auth-files runtime card switch is disabled', await runtimeCard.locator('.ant-switch-disabled').isVisible());

    // 7. Drawer save submits patch and updates UI
    const xaiCard = page.locator('[data-testid="oauth-credential-record"]').filter({ hasText: 'xai-fixture.json' }).first();
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
      async () => (await xaiCard.getByText(/(P:42|Priority 42|优先级 42|優先級 42|Keutamaan 42)/).count()) === 1 && (await xaiCard.getByText(/(W:7|Weight 7|权重 7|權重 7|Pemberat 7)/).count()) === 1,
      { detail: async () => `priority=${await xaiCard.getByText(/Priority|优先级|優先級|P:/).count()} weight=${await xaiCard.getByText(/Weight|权重|權重|W:/).count()}` },
    );
    await xaiEditBtn.click();
    await saveDrawer.waitFor({ state: 'visible', timeout: 5000 });
    check('auth-files reopened drawer shows persisted priority', (await saveDrawer.locator('#priority').inputValue()) === '42');
    check('auth-files reopened drawer shows persisted weight', (await saveDrawer.locator('#weight').inputValue()) === '7');
    check('auth-files reopened drawer shows persisted expiry', (await saveDrawer.locator('#expired').inputValue()) === '2028-04-05T06:07:08Z');
    await saveDrawer.locator('.ant-drawer-close').click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });

    // OAuth model aliases are global CPA configuration. Exercise the complete
    // save -> readback -> close/reopen path, then the provider deletion action.
    const aliasOpen = page.getByTestId('oauth-management-model-alias-open');
    await aliasOpen.click();
    const aliasDrawer = page.getByTestId('oauth-model-alias-drawer').last();
    await aliasDrawer.waitFor({ state: 'visible', timeout: 5000 });
    check('oauth model alias drawer selects a mapped provider', (await aliasDrawer.getByTestId('oauth-model-alias-provider').innerText()) === 'claude');
    const aliasInput = aliasDrawer.locator('[data-alias-field="alias"]').first();
    await aliasInput.waitFor({ state: 'visible', timeout: 5000 });
    check('oauth model alias drawer loads the CPA mapping', (await aliasInput.inputValue()) === 'sonnet-latest');
    await aliasInput.fill('sonnet-preview');
    await aliasDrawer.getByTestId('oauth-model-alias-save').click();
    await checkEventually(
      'oauth model alias save settles after verified readback',
      async () => aliasDrawer.getByTestId('oauth-model-alias-save').isDisabled(),
      { detail: async () => `disabled=${await aliasDrawer.getByTestId('oauth-model-alias-save').isDisabled()}` },
    );
    await aliasDrawer.locator('.ant-drawer-close').click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
    await aliasOpen.click();
    await aliasDrawer.waitFor({ state: 'visible', timeout: 5000 });
    check(
      'oauth model alias survives close and reopen',
      (await aliasDrawer.locator('[data-alias-field="alias"]').first().inputValue()) === 'sonnet-preview',
    );

    await aliasDrawer.getByTestId('oauth-model-alias-delete-provider').click();
    const aliasDeleteConfirm = page.locator('.ant-modal-confirm').last();
    await aliasDeleteConfirm.waitFor({ state: 'visible', timeout: 5000 });
    await aliasDeleteConfirm.locator('.ant-btn-primary').click();
    await checkEventually(
      'oauth model alias deletion is persisted and read back',
      async () => (await aliasDrawer.locator('[data-alias-field="alias"]').count()) === 0,
    );
    await aliasDrawer.locator('.ant-drawer-close').click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });

    // 8. Viewports at 390px and 320px for the unified workspace
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await measureStable(
        () => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)),
        { page, label: 'the OAuth management page overflow measurement' },
      );
      check(`oauth-management ${width}px viewport has no overflow`, overflow === 0, `overflow=${overflow}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
}
