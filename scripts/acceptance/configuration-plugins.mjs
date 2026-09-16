/**
 * Configuration and plugin release acceptance: payload-rule structure, source
 * editing, plugin-store/system/quick-start routes, and the structured plugin
 * configuration editor.
 */
export async function runConfigurationPluginsAcceptance({
  auditRoutes,
  appURL,
  page,
  check,
  providerSecrets,
  responseBodies,
}) {
  // Payload section: one heading entry, not the section header followed by a
  // group head restating it. The panel is reached through the section nav.
  await page.goto(`${appURL}/config`, { waitUntil: 'domcontentloaded' });
  await page.locator('.config-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const payloadNav = page.locator('.config-nav-btn').filter({ hasText: /Payload/ });
  await payloadNav.first().waitFor({ state: 'visible', timeout: 10000 });
  await payloadNav.first().click();
  await page.locator('.payload-rules-container').first().waitFor({ state: 'visible', timeout: 10000 });
  const payloadHeadingCount = await page.locator('.payload-builder-group .settings-group-title').count();
  check(
    'the Payload panel prints no second heading under the section header',
    payloadHeadingCount === 0,
    `duplicateHeadings=${payloadHeadingCount}`,
  );
  // Losing the head must not lose the capability: the rule builder is the whole
  // point of the panel, and its five sections must still carry their own
  // titles and explanations.
  const payloadPanels = await page.locator('.payload-collapse .ant-collapse-item').count();
  check('the Payload rule builder still renders its rule panels', payloadPanels >= 5, `panels=${payloadPanels}`);
  const payloadTitles = await page.locator('.payload-panel-title').count();
  const payloadDescs = await page.locator('.payload-panel-desc').count();
  check(
    'the Payload sections keep their own titles and descriptions',
    payloadTitles >= 5 && payloadDescs >= 5,
    `titles=${payloadTitles} descs=${payloadDescs}`,
  );

  // Config Page: Source tab switch requires reauthentication modal
  await page.goto(`${appURL}/config`, { waitUntil: 'domcontentloaded' });
  await page.locator('.config-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const sourceSegment = page.locator('.ant-segmented-item').filter({ hasText: /源码|Source/ });
  // The block below is optional, so it is guarded by `isVisible`. That guard is
  // also the trap: asked before the segmented control has rendered, it answers
  // false and the two checks inside disappear from the run without a failure.
  // Waiting for the control first makes the skip a decision instead of a race.
  await sourceSegment.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (await sourceSegment.isVisible()) {
    await sourceSegment.click();
    // The source view is opened by the session alone: the step-up re-authentication
    // prompt was removed as a deliberate policy change (the reveal grant
    // re-checked the same management key the session already carries). So the
    // observable contract is the opposite of what it used to be - the source
    // editor opens directly, with no modal in the way.
    const sourceToolbar = page.locator('.config-source-toolbar');
    await sourceToolbar.waitFor({ state: 'visible', timeout: 10000 });
    check('source mode opens without re-authentication', await sourceToolbar.isVisible());
    check(
      'no re-authentication modal is raised for the source view',
      (await page.locator('.ant-modal').filter({ hasText: /源码|Source/ }).count()) === 0,
    );
    // Return to the visual view so the rest of the audit starts from the same
    // place it did before this section ran.
    const visualSegment = page.locator('.ant-segmented-item').filter({ hasText: /可视化|Visual/ });
    if (await visualSegment.first().isVisible().catch(() => false)) {
      await visualSegment.first().click();
      await page.locator('.config-workbench').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    }
  }
  await auditRoutes(page, responseBodies, [
    ['/plugins', '.plugins-page', { pageSecrets: providerSecrets }],
    ['/plugin-store', '.plugin-store-page', { pageSecrets: providerSecrets }],
    ['/system', '.system-page', { pageSecrets: providerSecrets }],
    ['/quick-start', '.quick-start-page', { pageSecrets: providerSecrets }],
  ]);

  // Plugin configuration is a structured editing surface, not a bare JSON
  // textarea: the editor must validate before save, expose the object shape, and
  // protect an unsaved draft on close.
  await page.goto(`${appURL}/plugins`, { waitUntil: 'domcontentloaded' });
  await page.locator('.plugins-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const pluginConfigButton = page.locator('.plugins-page .ant-table-row').first().locator('button').filter({ has: page.locator('.anticon-setting') }).first();
  await pluginConfigButton.click();
  const pluginModal = page.locator('.ant-modal:visible').filter({ has: page.locator('[data-plugin-config-source]') });
  await pluginModal.waitFor({ state: 'visible', timeout: 5000 });
  const pluginSource = pluginModal.locator('[data-plugin-config-source]');
  const pluginSummary = pluginModal.locator('[data-plugin-config-summary]');
  check('plugin config exposes a structured preview', (await pluginSummary.locator('li').count()) > 0);
  await pluginSource.fill('{invalid');
  check('invalid plugin JSON is reported before save', await pluginModal.getByText(/valid JSON object|合法的 JSON 对象/).isVisible());
  check('invalid plugin JSON disables save', await pluginModal.locator('.ant-btn-primary').isDisabled());
  await pluginSource.fill('');
  check('empty plugin config is not treated as an implicit clear', await pluginModal.getByText(/valid JSON object|合法的 JSON 对象/).isVisible() && await pluginModal.locator('.ant-btn-primary').isDisabled());
  await pluginSource.fill('{"level":"debug","enabled":true}');
  check('valid plugin JSON is reflected in the preview', (await pluginSummary.getByText('level', { exact: true }).count()) === 1 && (await pluginSummary.getByText('enabled', { exact: true }).count()) === 1);
  await pluginModal.locator('.ant-modal-footer .ant-btn-default').first().click();
  const pluginDiscard = page.locator('.ant-modal-confirm');
  await pluginDiscard.waitFor({ state: 'visible', timeout: 5000 });
  check('plugin configuration discards only after confirmation', await pluginDiscard.isVisible());
  await pluginDiscard.locator('.ant-btn-primary').first().click();
  await pluginModal.waitFor({ state: 'hidden', timeout: 5000 });

}
