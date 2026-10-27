/**
 * Overlays are UI state, not browser history entries: Back at an open surface still follows the
 * page history the reader travelled.
 */
export async function browserNavigation({ base, page, check }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible' });
  await page.goto(`${base}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.locator('.request-row').first().click();
  await page.locator('.request-detail').waitFor({ state: 'visible' });
  await page.goBack();
  check('browser Back navigates to the previous page with a request open', new URL(page.url()).pathname.endsWith('/dashboard'), page.url());

  await page.goto(`${base}/usage/events`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.locator('.mobile-nav-drawer:visible').waitFor();
  await page.goBack();
  check('browser Back navigates to the previous page with the navigation sheet open', new URL(page.url()).pathname.endsWith('/dashboard'), page.url());
}
