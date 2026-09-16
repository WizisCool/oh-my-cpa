/**
 * OAuth flow release acceptance: built-in callback replay and plugin-discovered
 * provider polling against the deterministic fake CPA.
 */
export async function runOAuthFlowAcceptance({
  appURL,
  page,
  check,
}) {
  // OAuth end-to-end against the deterministic fake: start a flow, confirm
  // the card polls `waiting`, submit a callback whose session already
  // completed on the CPA side (409), and assert the card converges to the
  // success state instead of painting an error over saved credentials.
  await page.goto(`${appURL}/oauth`, { waitUntil: 'domcontentloaded' });
  await page.locator('.oauth-page').first().waitFor({ state: 'visible', timeout: 15000 });
  const codexStart = page.locator('[data-oauth-start="codex"]');
  await codexStart.waitFor({ state: 'visible', timeout: 15000 });
  await codexStart.click();
  // The auth URL box (or the waiting status) proves the flow started and
  // the 3s status poller is running.
  const codexCard = page.locator('[data-oauth-card="codex"]');
  const waitingState = codexCard.getByText(/等待|waiting/i).first();
  await waitingState.waitFor({ state: 'visible', timeout: 15000 });
  const waitingText = await waitingState.innerText();
  check(
    'oauth start shows waiting state while polling',
    /等待|waiting/i.test(waitingText) && !/授权成功|认证成功|success|失败|error/i.test(waitingText),
    `text=${waitingText}`,
  );
  const callbackInput = codexCard.locator('[data-oauth-callback-input]');
  await callbackInput.waitFor({ state: 'visible', timeout: 15000 });
  await callbackInput.fill('http://127.0.0.1:8317/codex/callback?code=e2e-replayed&state=already-done');
  await codexCard.locator('[data-oauth-callback-submit]').click();
  // Idempotent success: the pre-completed session resolves to the
  // success badge, never to the callback error copy.
  const successBadge = codexCard.getByText(/授权成功|认证成功|success/i).first();
  await successBadge.waitFor({ state: 'visible', timeout: 20000 });
  const successText = await successBadge.innerText();
  check(
    'oauth replay callback converges to success',
    /授权成功|认证成功|success/i.test(successText) && !/提交失败|failed/i.test(successText),
    `text=${successText}`,
  );
  const replayError = await codexCard.getByText(/提交失败|failed to submit/i).count();
  check('oauth replay callback shows no error', replayError === 0, `errorBadges=${replayError}`);

  // Plugin-discovered OAuth: a CPA plugin advertising supports_oauth with an
  // oauth_provider joins the page with the same start/poll flow, and shows
  // the plugin's own logo (data-URI in the fixture, no network needed).
  const pluginCard = page.locator('[data-oauth-card="iflow"]');
  await pluginCard.waitFor({ state: 'visible', timeout: 15000 });
  check('oauth page renders plugin-discovered provider card', (await pluginCard.getByText(/CPA 插件|CPA Plugin/).count()) > 0);
  const pluginLogoSrc = await pluginCard.locator('img').first().getAttribute('src');
  check('plugin oauth card shows plugin logo', Boolean(pluginLogoSrc?.startsWith('data:image/svg+xml')), `src=${pluginLogoSrc ?? 'none'}`);
  const pluginStart = page.locator('[data-oauth-start="iflow"]');
  await pluginStart.click();
  const pluginWaitingState = pluginCard.getByText(/等待|waiting/i).first();
  await pluginWaitingState.waitFor({ state: 'visible', timeout: 15000 });
  const pluginWaitingText = await pluginWaitingState.innerText();
  check(
    'plugin oauth start polls waiting state',
    /等待|waiting/i.test(pluginWaitingText) && !/授权成功|认证成功|success|失败|error/i.test(pluginWaitingText),
    `text=${pluginWaitingText}`,
  );

}
