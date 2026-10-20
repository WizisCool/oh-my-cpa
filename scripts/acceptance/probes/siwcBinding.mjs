import { fulfillFixture } from '../browser-guard.mjs';
import { chartTokenHeatmap } from './dashboardFixtures.mjs';

export async function verifySIWCBinding({ page, base, check }, files) {
  const target = { ...files[0], siwc_bind_supported: true, use_siwc: false, siwc_bound: false };
  const requests = [];
  let isSubmitted = false;
  const handler = async route => {
    const request = route.request();
    const url = new URL(request.url());
    let response;
    if (url.pathname.endsWith('/dashboard/token-heatmap')) {
      response = chartTokenHeatmap;
    } else if (url.pathname.endsWith('/management/auth-files')) {
      response = { files: [target, ...files.slice(1)], total: files.length };
    } else if (url.pathname.endsWith('/oauth/siwc/bind')) {
      requests.push(JSON.parse(request.postData()));
      response = { url: 'https://auth.openai.com/api/accounts/authorize', state: 'siwc-probe-state', flow: 'siwc_bind', expires_in: 300 };
    } else if (url.pathname.endsWith('/oauth/siwc/callback')) {
      requests.push(JSON.parse(request.postData()));
      isSubmitted = true;
      response = { status: 'ok' };
    } else if (url.pathname.endsWith('/oauth/siwc/status')) {
      response = isSubmitted ? { status: 'ok', completed: true, file: { ...target, use_siwc: true, siwc_bound: true } } : { status: 'wait' };
    } else return route.fallback();
    await fulfillFixture(route, { status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  };
  await page.route('**/api/v1/management/**', handler);
  try {
    await page.goto(`${base}/oauth-management`);
    const isUnloadBlocked = () => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    check('idle SIWC workspace does not block browser unload', !await isUnloadBlocked());
    const row = page.locator(`[data-testid="oauth-credential-record"][data-auth-index="${target.auth_index}"]`);
    const openDetail = async () => {
      await row.getByRole('button', { name: /^Details:/ }).click();
      await page.getByTestId('siwc-binding').waitFor();
    };
    await openDetail();
    const panel = page.getByTestId('siwc-binding');
    await panel.getByRole('button', { name: 'Bind SIWC', exact: true }).click();
    const callback = panel.getByRole('textbox', { name: 'Complete callback URL' });
    await callback.waitFor();
    const callbackURL = 'http://127.0.0.1:1455/auth/callback?state=siwc-probe-state&code=SYNTHETIC-PROBE-CODE&client_id=issued&extra=a%2Bb';
    await callback.fill(callbackURL);
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden' });
    check('a pending SIWC attempt blocks browser unload after its drawer closes', await isUnloadBlocked());
    await page.locator('.app-menu [data-route-path="/dashboard"]').first().click();
    const leaveDialog = page.getByRole('dialog').filter({ hasText: 'Authorization is still in progress' });
    await leaveDialog.waitFor();
    await leaveDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await leaveDialog.waitFor({ state: 'hidden' });
    check('declining navigation preserves the SIWC workspace', new URL(page.url()).pathname.endsWith('/oauth-management'));
    await openDetail();
    check('binding callback survives closing and reopening credential detail', await callback.inputValue() === callbackURL);
    await panel.getByRole('button', { name: 'Submit callback URL' }).click();
    await panel.getByText('SIWC bound; credential summary confirmed', { exact: true }).waitFor();
    check('binding starts for the selected credential and preserves every callback parameter', requests.length === 2 && requests[0].name === target.name && requests[0].auth_index === target.auth_index && requests[0].rebind === false && requests[1].redirect_url === callbackURL);
    check('successful binding exposes an explicit rebind action', await panel.getByRole('button', { name: 'Rebind SIWC', exact: true }).isVisible());
    await page.screenshot({ path: 'tmp/siwc-binding-confirmed.png' });
    check('confirmed SIWC completion removes the browser unload guard', !await isUnloadBlocked());
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
    await page.locator('.ant-drawer-open').waitFor({ state: 'hidden' });
    await page.locator('.app-menu [data-route-path="/dashboard"]').first().click();
    await page.waitForURL(url => url.pathname.endsWith('/dashboard'));
    check('confirmed SIWC completion permits in-app navigation', await page.getByText('Authorization is still in progress', { exact: true }).count() === 0);
  } finally {
    await page.unroute('**/api/v1/management/**', handler);
  }
}
