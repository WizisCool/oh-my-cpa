import path from 'node:path';

import { FAKE_PLUGIN_LOGO_DATA_URL } from '../fake-cpa.mjs';
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
  providerMarkImage,
}) {
  await auditPage(page, responseBodies, '/oauth', '.oauth-management-page', { pageSecrets: providerSecrets });
  await auditPage(page, responseBodies, '/quota', '.oauth-management-page', { pageSecrets: providerSecrets });
  // Quota Cards Flow & Screenshots (cards-only page)
  await page.goto(`${appURL}/oauth-management?density=expanded&focus=quota`, { waitUntil: 'domcontentloaded' });
  await page.locator('.oauth-management-page').first().waitFor({ state: 'visible', timeout: 15000 });

  // Verify card grid renders one card per credential
  await checkEventually(
    'quota page renders credential cards',
    async () => (await page.locator('[data-quota-body]').count()) > 0,
    { detail: async () => `quotaCards=${await page.locator('[data-quota-body]').count()}` },
  );

  // Verify quota tab brand icons are not OpenAI
  const quotaAntigravityIcon = await lobeIconSignature(page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Antigravity/i }));
  check('quota page Antigravity tab icon is not OpenAI', /antigravity/i.test(quotaAntigravityIcon) && !/openai/i.test(quotaAntigravityIcon), quotaAntigravityIcon);

  // A catalog brand the display table was not taught, and a provider whose mark
  // only its plugin can supply: both used to render a neutral placeholder here.
  const quotaDevinTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Devin/i }).first();
  await checkEventually(
    'quota page Devin tab draws the Devin brand mark',
    async () => {
      const mark = await providerMarkImage(quotaDevinTab);
      return Boolean(mark)
        && mark.complete === true
        && mark.naturalWidth > 0
        && /devin/i.test(mark.src)
        && !/openai/i.test(mark.src);
    },
    { detail: async () => JSON.stringify(await providerMarkImage(quotaDevinTab)) },
  );

  const quotaPluginTab = page.locator('.oauth-management-page .ant-tabs-tab').filter({ hasText: /Iflow/i }).first();
  await checkEventually(
    'quota page uses the plugin\u2019s own logo for a plugin-owned provider',
    async () => {
      const mark = await providerMarkImage(quotaPluginTab);
      return Boolean(mark)
        && mark.complete === true
        && mark.naturalWidth > 0
        && mark.src === FAKE_PLUGIN_LOGO_DATA_URL;
    },
    { detail: async () => JSON.stringify(await providerMarkImage(quotaPluginTab)) },
  );

  // Explicit live probes are the toolbar action; opening the page and read-only
  // reloads must not issue them.
  const refreshAllBtn = page.getByRole('button', { name: /刷新配额|Refresh quota/i }).first();
  await refreshAllBtn.waitFor({ state: 'visible', timeout: 10000 });
  await refreshAllBtn.click();
  await page.getByTestId('quota-operation-report').waitFor({ state: 'visible', timeout: 90000 });

  // Verify progress bars are visible with positive fill width after live refresh
  await checkEventually(
    'quota page renders progress bars',
    async () => (await page.locator('[data-quota-body] .ant-progress').count()) > 0,
    { detail: async () => `count=${await page.locator('[data-quota-body] .ant-progress').count()}`, timeoutMs: 60000 },
  );
  await checkEventually(
    'expanded density exposes six model/group windows after a live refresh',
    async () => page.evaluate(() => [...document.querySelectorAll('[data-quota-window-count="6"]')]
      .some((body) => body.getAttribute('data-quota-density') === 'expanded')),
    {
      detail: async () => `sixWindowBodies=${await page.locator('[data-quota-window-count="6"]').count()}`,
      timeoutMs: 120000,
    },
  );
  const firstProgressBg = page.locator('[data-quota-body] .ant-progress-track').first();
  await checkEventually(
    'quota progress bar fill has positive width',
    async () => (await firstProgressBg.evaluate((el) => parseFloat(window.getComputedStyle(el).width))) > 0,
    {
      detail: async () =>
        `width=${await firstProgressBg.evaluate((el) => parseFloat(window.getComputedStyle(el).width))}`,
    },
  );

  // A renewal read from the credential's id_token is a lower bound, not a verified
  // date, so it carries the unverified marker and never a countdown; the live read
  // for the other seats is the counter-example in the same page.
  await checkEventually(
    'quota renewal marks a credential-snapshot bound as unverified',
    async () => {
      const bound = page.locator('[data-quota-body] [data-renewal-source="credential_snapshot"]');
      if ((await bound.count()) === 0) return false;
      return (await bound.first().innerText()).includes('≥');
    },
    { detail: async () => `snapshotCards=${await page.locator('[data-renewal-source="credential_snapshot"]').count()}` },
  );
  check(
    'quota renewal live read is labelled as such',
    (await page.locator('[data-quota-body] [data-renewal-source="live_subscription"]').count()) > 0,
    `liveCards=${await page.locator('[data-renewal-source="live_subscription"]').count()}`,
  );
  check(
    'quota renewal marks an end-of-term seat',
    (await page.locator('[data-quota-body] [data-renewal-not-renewing]').count()) > 0,
    `notRenewing=${await page.locator('[data-renewal-not-renewing]').count()}`,
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
