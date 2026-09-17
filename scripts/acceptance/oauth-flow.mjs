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

  // Devin: the redirect lands on a loopback callback the browser cannot reach,
  // so the pasted URL is the only thing carrying the code. A URL from another
  // attempt must be refused before anything is submitted, because CPA would
  // otherwise attribute the code to the wrong session.
  const devinCard = page.locator('[data-oauth-card="devin"]');
  await devinCard.waitFor({ state: 'visible', timeout: 15000 });
  check('oauth page renders the Devin card', (await devinCard.getByText(/Devin/i).count()) > 0);
  await page.locator('[data-oauth-start="devin"]').click();
  const devinWaiting = devinCard.getByText(/等待|waiting/i).first();
  await devinWaiting.waitFor({ state: 'visible', timeout: 15000 });
  const devinCallbackInput = devinCard.locator('[data-oauth-callback-input]');
  await devinCallbackInput.waitFor({ state: 'visible', timeout: 15000 });
  await devinCallbackInput.fill('http://127.0.0.1:8317/devin/callback?code=e2e&state=stale-attempt');
  await devinCard.locator('[data-oauth-callback-submit]').click();
  // The refusal is a toast, which antd renders at the document root rather than
  // inside the card.
  const devinMismatch = page.getByText(/不属于本次|does not belong/i).first();
  await devinMismatch.waitFor({ state: 'visible', timeout: 10000 });
  check(
    'devin refuses a callback from another attempt',
    !/授权成功|认证成功|success/i.test(await devinCard.innerText()),
    'a stale paste must not reach the success state',
  );
  await devinCallbackInput.fill('http://127.0.0.1:8317/devin/callback?code=e2e&state=e2e-state');
  await devinCard.locator('[data-oauth-callback-submit]').click();
  const devinSubmitted = devinCard.getByText(/回调已提交|Callback submitted/i).first();
  await devinSubmitted.waitFor({ state: 'visible', timeout: 15000 });
  check(
    'devin accepts the current attempt callback',
    /回调已提交|Callback submitted/i.test(await devinSubmitted.innerText()),
    `text=${await devinSubmitted.innerText()}`,
  );

  // Meta Muse is a device grant: the card shows the code CPA issued, and no
  // paste box at all.
  const metaCard = page.locator('[data-oauth-card="meta"]');
  await metaCard.waitFor({ state: 'visible', timeout: 15000 });
  check('oauth page renders the Meta Muse card', (await metaCard.getByText(/Meta Muse/i).count()) > 0);
  await page.locator('[data-oauth-start="meta"]').click();
  const metaUserCode = metaCard.locator('[data-oauth-user-code]');
  await metaUserCode.waitFor({ state: 'visible', timeout: 15000 });
  check(
    'meta device grant shows the code to confirm',
    (await metaUserCode.innerText()).trim() === 'E2E-CODE-1',
    `code=${await metaUserCode.innerText()}`,
  );
  check(
    'meta device grant offers no callback paste',
    (await metaCard.locator('[data-oauth-callback-input]').count()) === 0,
  );
}
