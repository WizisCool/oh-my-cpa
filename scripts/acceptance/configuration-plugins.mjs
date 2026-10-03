import { until } from './harness.mjs';

/**
 * Configuration and plugin release acceptance: payload-rule structure, source
 * editing, the plugin store/settings, system and quick-start routes, and the
 * structured plugin configuration editor.
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

  // Adding a rule must leave the page savable. The symptom this guards is not an error
  // message but the absence of one: a write that throws inside the React handler leaves
  // the document untouched, so nothing reads as dirty and the save bar - the only save
  // control on this page - never appears at all. The section is opened here on a fresh
  // fixture config, which has no `requests.payload`, and that is exactly the state the write
  // used to fail in.
  const overrideRawPanel = page
    .locator('.payload-builder-group .ant-collapse-item')
    .filter({ hasText: /覆盖 Raw 规则|Override Raw Rules/ })
    .first();
  let payloadRuleAdded = false;
  try {
    await overrideRawPanel.locator('.ant-collapse-header').first().click();
    await overrideRawPanel
      .locator('.payload-empty-box button, .payload-add-rule-footer button')
      .filter({ hasText: /添加规则|Add Rule/ })
      .first()
      .click();
    payloadRuleAdded = true;
  } catch (error) {
    check(
      'adding a payload rule makes the configuration savable',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (payloadRuleAdded) {
    await page.locator('.config-dirty-bar').waitFor({ state: 'visible', timeout: 10000 }).catch(() => undefined);
    check(
      'adding a payload rule makes the configuration savable',
      await page.locator('.config-dirty-btn-save').isVisible(),
      `dirtyBar=${await page.locator('.config-dirty-bar').count()} ruleCards=${await overrideRawPanel.locator('.payload-rule-card').count()}`,
    );
    // Discarded rather than saved, so the rest of the audit starts from the document
    // the page loaded with. Tolerated rather than required: the bar is missing exactly
    // when the write regressed, which the assertion above has already recorded, and a
    // click that throws would take the rest of the release audit down with it.
    await page.locator('.config-dirty-btn-discard').click({ timeout: 5000 }).catch(() => undefined);
    await page.locator('.config-dirty-bar').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => undefined);
  }

  // Config Page: Source tab switch requires reauthentication modal
  await page.goto(`${appURL}/config`, { waitUntil: 'domcontentloaded' });
  await page.locator('.config-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const sourceSegment = page.locator('.ant-segmented-item').filter({ hasText: /源码|Source/ });
  // A missing control is a failed assertion, not a reason to abandon the rest
  // of the release audit. Record the failure and continue so later domains still
  // produce their own evidence.
  let sourceModeClicked = false;
  let sourceModeOpened = false;
  try {
    await sourceSegment.first().waitFor({ state: 'visible', timeout: 15000 });
    await sourceSegment.click();
    sourceModeClicked = true;
    await page.locator('.config-source-toolbar').waitFor({ state: 'visible', timeout: 10000 });
    sourceModeOpened = true;
  } catch (error) {
    check('source mode opens without re-authentication', false, error instanceof Error ? error.message : String(error));
  }
  // The source view is opened by the session alone: the step-up re-authentication
  // prompt was removed as a deliberate policy change (the reveal grant
  // re-checked the same management key the session already carries). So the
  // observable contract is the opposite of what it used to be - the source
  // editor opens directly, with no modal in the way.
  const sourceToolbar = page.locator('.config-source-toolbar');
  if (sourceModeClicked) {
    check(
      'no re-authentication modal is raised for the source view',
      (await page.locator('.ant-modal').filter({ hasText: /源码|Source/ }).count()) === 0,
    );
  }
  if (sourceModeOpened) {
    check(
      'source mode opens without re-authentication',
      (await sourceToolbar.locator('.ant-tag').count()) >= 1 && (await sourceToolbar.locator('button').count()) >= 3,
    );
    // Only built-artifact acceptance can catch worker asset paths or chunk loading defects.
    try {
      await page.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible' });
      // The native provider and serializer fallback have different flow delimiter spacing.
      await page.locator('.monaco-editor .view-lines').first().click();
      await page.keyboard.press('Control+Home');
      await page.keyboard.insertText('native-format-proof: [1,2,3]\n');
      await sourceToolbar.getByRole('button', { name: /^(格式化|Format)$/ }).click();
      await page.locator('.omc-toast').filter({ hasText: /YAML 已格式化|YAML formatted/ }).waitFor({ state: 'visible' });
      await until(async () => (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll('\u00a0', ' ').includes('native-format-proof: [1, 2, 3]'), { label: 'built native YAML worker formatting, not serializer fallback' });
      check('the built YAML worker formats a source document without relying on fallback', true);
      const discard = page.locator('.config-dirty-btn-discard');
      if (await discard.isVisible()) {
        await discard.click();
        await page.locator('.config-dirty-bar').waitFor({ state: 'hidden' });
      }
    } catch (error) {
      check('the built YAML worker formats a source document without relying on fallback', false, error instanceof Error ? error.message : String(error));
    }
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
    ['/plugins?tab=store', '[data-plugin-panel="store"]', { pageSecrets: providerSecrets }],
    ['/plugins?tab=settings', '[data-plugin-panel="settings"]', { pageSecrets: providerSecrets }],
    ['/system', '.system-page', { pageSecrets: providerSecrets }],
    ['/quick-start', '.quick-start-page', { pageSecrets: providerSecrets }],
  ]);

  // Plugin configuration is a structured editing surface: the declared fields are
  // typed controls, the JSON view validates before save and exposes the object
  // shape, and an unsaved draft is protected on close.
  await page.goto(`${appURL}/plugins`, { waitUntil: 'domcontentloaded' });
  await page.locator('.plugins-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const loggerRow = page.locator('article[data-plugin-id="fixture-logger"]');
  await loggerRow.waitFor({ state: 'visible', timeout: 15000 });
  await loggerRow.getByRole('button', { name: /配置|Configure/ }).click();
  const drawer = page.locator('[data-plugin-config="fixture-logger"]');
  await drawer.waitFor({ state: 'visible', timeout: 5000 });
  await drawer.locator('[data-plugin-config-field]').first().waitFor({ state: 'visible', timeout: 5000 });
  check('plugin config renders each declared field as a control', (await drawer.locator('[data-plugin-config-field]').count()) === 4);
  const levelText = await drawer.locator('[data-plugin-config-field="level"]').innerText();
  check('plugin config reads the stored value into its control', levelText.includes('info'), levelText);

  await page.locator('.ant-drawer .ant-segmented-item').filter({ hasText: 'JSON' }).click();
  const pluginSource = drawer.locator('[data-plugin-config-source]');
  const pluginSummary = drawer.locator('[data-plugin-config-summary]');
  await pluginSource.waitFor({ state: 'visible', timeout: 5000 });
  check('plugin config exposes a structured preview', (await pluginSummary.locator('li').count()) > 0);
  const saveButton = page.locator('[data-plugin-config-save]');
  await pluginSource.fill('{invalid');
  check('invalid plugin JSON is reported before save', await drawer.getByText(/valid JSON object|合法的 JSON 对象/).first().isVisible());
  await saveButton.click();
  check('invalid plugin JSON is not saved', await drawer.isVisible());
  await pluginSource.fill('');
  check('empty plugin config is not treated as an implicit clear', await drawer.getByText(/valid JSON object|合法的 JSON 对象/).first().isVisible());
  await pluginSource.fill('{"level":"debug","enabled":true}');
  check('valid plugin JSON is reflected in the preview', (await pluginSummary.getByText('level', { exact: true }).count()) === 1 && (await pluginSummary.getByText('enabled', { exact: true }).count()) === 1);
  await page.locator('.ant-drawer-footer .ant-btn-default').first().click();
  const pluginDiscard = page.locator('.ant-modal-confirm');
  await pluginDiscard.waitFor({ state: 'visible', timeout: 5000 });
  check('plugin configuration discards only after confirmation', await pluginDiscard.isVisible());
  await pluginDiscard.locator('.ant-btn-primary').first().click();
  await drawer.waitFor({ state: 'hidden', timeout: 5000 });
}
