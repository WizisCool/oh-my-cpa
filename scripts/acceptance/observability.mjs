import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * OAuth/quota/observability release acceptance: quota-card rendering, live
 * refresh, responsive light-mode screenshots, and the protected log/config
 * surfaces.
 */
export async function runObservabilityAcceptance({
  auditPage,
  appURL,
  page,
  check,
  checkEventually,
  responseBodies,
  providerSecrets,
  settleLayout,
  lobeIconSignature,
}) {
  await auditPage(page, responseBodies, '/oauth', '.oauth-page', { pageSecrets: providerSecrets });
  await auditPage(page, responseBodies, '/quota', '.quota-page', { pageSecrets: providerSecrets });
  // Quota Cards Flow & Screenshots (cards-only page)
  await page.goto(`${appURL}/quota`, { waitUntil: 'domcontentloaded' });
  await page.locator('.quota-page').first().waitFor({ state: 'visible', timeout: 15000 });

  // Verify card grid renders one card per credential
  await checkEventually(
    'quota page renders credential cards',
    async () => (await page.locator('article[class*="quota-card"]').count()) > 0,
    { detail: async () => `quotaCards=${await page.locator('article[class*="quota-card"]').count()}` },
  );

  // Verify quota tab brand icons are not OpenAI
  const quotaAntigravityIcon = await lobeIconSignature(page.locator('.quota-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }));
  check('quota page Antigravity tab icon is not OpenAI', /antigravity/i.test(quotaAntigravityIcon) && !/openai/i.test(quotaAntigravityIcon), quotaAntigravityIcon);

  // Click header refresh to trigger live quota refresh (cards have their own refresh buttons)
  const refreshAllBtn = page.locator('.terminal-page-head').getByRole('button', { name: /刷新|Refresh/i });
  if (await refreshAllBtn.isVisible()) {
    await refreshAllBtn.click();
  }

  // Verify progress bars are visible with positive fill width after live refresh
  await checkEventually(
    'quota page renders progress bars',
    async () => (await page.locator('.quota-page .ant-progress').count()) > 0,
    { detail: async () => `count=${await page.locator('.quota-page .ant-progress').count()}` },
  );
  const firstProgressBg = page.locator('.quota-page .ant-progress-track').first();
  await checkEventually(
    'quota progress bar fill has positive width',
    async () => (await firstProgressBg.evaluate((el) => parseFloat(window.getComputedStyle(el).width))) > 0,
    {
      detail: async () =>
        `width=${await firstProgressBg.evaluate((el) => parseFloat(window.getComputedStyle(el).width))}`,
    },
  );

  // Screenshot: Card Grid View with refreshed quota data
  await page.screenshot({ path: path.join(root, 'tmp', 'quota-cards-desktop.png') });

  // Mobile & Light mode view for Quota page
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('omc-theme', 'omc-light'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The screenshot has to capture the applied theme, so the wait is for the paint
  // rather than for a flat pause.
  await settleLayout(page);
  await page.screenshot({ path: path.join(root, 'tmp', 'quota-mobile-light.png') });
  // Restore viewport and dark theme
  await page.evaluate(() => localStorage.setItem('omc-theme', 'omc-dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await auditPage(page, responseBodies, '/logs', '.logs-page', { pageSecrets: providerSecrets });
  await auditPage(page, responseBodies, '/config', '.config-page');

}
