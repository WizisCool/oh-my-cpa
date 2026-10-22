import { until } from './harness.mjs';

/**
 * The configuration source editor's YAML worker, which only a production build can get
 * wrong: its asset path, chunk loading and the native formatter rather than the
 * serializer fallback.
 */
export async function runYamlWorkerAcceptance({ appURL, page, check }) {
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
      (await sourceToolbar.locator('.tag').count()) >= 1 && (await sourceToolbar.locator('button').count()) >= 3,
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
}
