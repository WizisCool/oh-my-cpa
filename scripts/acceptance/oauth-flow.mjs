import { FAKE_PLUGIN_LOGO_DATA_URL } from '../fake-cpa.mjs';

/**
 * OAuth release acceptance against the deterministic fake CPA.
 *
 * The authorization controller lives above the Connect drawer, so this flow also
 * proves that minimizing the drawer preserves an attempt instead of restarting or
 * cancelling it.
 */

async function openConnect(page) {
  await page.getByRole('button', { name: /Connect account|连接账号/i }).first().click();
  await page.locator('[data-testid="oauth-connect-panel"]').waitFor({ state: 'visible', timeout: 5000 });
}

async function selectProvider(page, providerId, title) {
  const select = page.locator('#oauth-connect-provider');
  await select.click();
  const option = page.getByTitle(title, { exact: true }).last();
  await option.waitFor({ state: 'visible', timeout: 5000 });
  await option.click();
  await page.locator(`[data-oauth-start="${providerId}"]`).waitFor({ state: 'visible', timeout: 5000 });
}

async function minimizeConnect(page) {
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await page.locator('.ant-drawer-open').waitFor({ state: 'hidden', timeout: 5000 });
}

export async function runOAuthFlowAcceptance({
  appURL,
  page,
  check,
}) {
  const oauthStarts = [];
  const oauthCancels = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/management/oauth/start')) oauthStarts.push(request.url());
    if (request.url().includes('/api/v1/management/oauth/session') && request.method() === 'DELETE') {
      oauthCancels.push(request.url());
    }
  });

  await page.goto(`${appURL}/oauth-management`, { waitUntil: 'domcontentloaded' });
  await page.locator('.oauth-management-page').first().waitFor({ state: 'visible', timeout: 15000 });

  // Codex is a redirect flow. Its callback is replay-safe: a duplicate submission
  // answers 409, the controller re-reads status, and the already-saved session
  // converges to success instead of showing a false failure.
  await openConnect(page);
  await selectProvider(page, 'codex', 'Codex OAuth');
  const codexStart = page.locator('[data-oauth-start="codex"]');
  await codexStart.click();
  const codexPanel = page.locator('[data-oauth-card="codex"]');
  const waitingState = codexPanel.getByText(/等待|waiting/i).first();
  await waitingState.waitFor({ state: 'visible', timeout: 15000 });
  const callbackInput = codexPanel.locator('[data-oauth-callback-input]');
  await callbackInput.waitFor({ state: 'visible', timeout: 15000 });
  await callbackInput.fill('http://127.0.0.1:8317/codex/callback?code=e2e-replayed&state=already-done');
  await codexPanel.locator('[data-oauth-callback-submit]').click();
  const successBadge = codexPanel.getByText(/授权成功|认证成功|success/i).first();
  await successBadge.waitFor({ state: 'visible', timeout: 20000 });
  const replayErrors = await codexPanel.getByText(/提交失败|Callback submission failed|授权失败|Authorization failed/i).count();
  check(
    'oauth replay callback converges to success without a submission error',
    !/提交失败|failed/i.test(await successBadge.innerText()) && replayErrors === 0,
    `errors=${replayErrors}`,
  );

  // Minimize the successful panel, then reopen it. The drawer is presentation
  // only: the confirmed result must still be there and Start must have become the
  // explicit "sign in another account" action rather than a duplicate attempt.
  await minimizeConnect(page);
  await openConnect(page);
  await selectProvider(page, 'codex', 'Codex OAuth');
  check(
    'minimizing and reopening preserves the confirmed authorization result',
    await page.locator('[data-oauth-card="codex"]').getByText(/授权成功|认证成功|success/i).first().isVisible(),
  );
  check(
    'the confirmed provider offers an explicit new-account action instead of auto-restarting',
    /another|其他/.test(await page.locator('[data-oauth-start="codex"]').innerText()),
  );
  await minimizeConnect(page);

  // Plugin-discovered OAuth: a CPA plugin advertising supports_oauth joins the
  // same picker with its declared provider id and plugin-published logo.
  await openConnect(page);
  await selectProvider(page, 'iflow', 'iFlow Alliance Auth OAuth');
  const pluginLogo = await page.locator(`[data-oauth-card="iflow"] img`).first().getAttribute('src');
  check('connect picker draws the plugin-published logo', pluginLogo === FAKE_PLUGIN_LOGO_DATA_URL, `src=${pluginLogo ?? 'none'}`);
  check(
    'connect panel identifies iFlow as a CPA plugin provider',
    (await page.locator('[data-oauth-card="iflow"]').getByText(/CPA 插件|CPA Plugin/i).count()) > 0,
  );
  await page.locator('[data-oauth-start="iflow"]').click();
  const pluginPanel = page.locator('[data-oauth-card="iflow"]');
  await pluginPanel.getByText(/等待|waiting/i).first().waitFor({ state: 'visible', timeout: 15000 });
  await minimizeConnect(page);
  await openConnect(page);
  await selectProvider(page, 'iflow', 'iFlow Alliance Auth OAuth');
  const resumedPluginText = await page.locator('[data-oauth-card="iflow"]').innerText();
  check(
    'reopening a minimized plugin session preserves its waiting attempt without restart or cancel',
    /等待|waiting/i.test(resumedPluginText)
      && !/授权成功|认证成功|success|授权失败|Authorization failed|error/i.test(resumedPluginText)
      && oauthStarts.length === 2
      && oauthCancels.length === 0,
    `start=${oauthStarts.length} cancel=${oauthCancels.length} text=${resumedPluginText.slice(0, 100)}`,
  );
  await minimizeConnect(page);

  // Devin: the redirect lands on a loopback callback the browser cannot reach, so
  // the pasted URL is the only thing carrying the code. A stale state must be
  // refused before anything is submitted.
  await openConnect(page);
  await selectProvider(page, 'devin', 'Devin OAuth');
  await page.locator('[data-oauth-start="devin"]').click();
  const devinPanel = page.locator('[data-oauth-card="devin"]');
  await devinPanel.getByText(/等待|waiting/i).first().waitFor({ state: 'visible', timeout: 15000 });
  const devinCallbackInput = devinPanel.locator('[data-oauth-callback-input]');
  await devinCallbackInput.fill('http://127.0.0.1:8317/devin/callback?code=e2e&state=stale-attempt');
  await devinPanel.locator('[data-oauth-callback-submit]').click();
  const devinMismatch = page.getByText(/不属于本次|does not belong/i).first();
  await devinMismatch.waitFor({ state: 'visible', timeout: 10000 });
  check('devin refuses a callback from another attempt', !/授权成功|认证成功|success/i.test(await devinPanel.innerText()));
  await devinCallbackInput.fill('http://127.0.0.1:8317/devin/callback?code=e2e&state=e2e-state');
  await devinPanel.locator('[data-oauth-callback-submit]').click();
  await devinPanel.getByText(/回调已提交|Callback submitted/i).first().waitFor({ state: 'visible', timeout: 15000 });
  const devinSubmittedText = await devinPanel.innerText();
  check(
    'devin accepts the current attempt callback',
    /回调已提交|Callback submitted/i.test(devinSubmittedText)
      && !/不属于本次|does not belong|提交失败|submission failed/i.test(devinSubmittedText),
    devinSubmittedText.slice(0, 160),
  );
  await minimizeConnect(page);

  // Meta Muse is a device grant: the panel shows CPA's short code, no paste box,
  // and the explicit status check.
  await openConnect(page);
  await selectProvider(page, 'meta', 'Meta Muse OAuth');
  await page.locator('[data-oauth-start="meta"]').click();
  const metaPanel = page.locator('[data-oauth-card="meta"]');
  const metaUserCode = metaPanel.locator('[data-oauth-user-code]');
  await metaUserCode.waitFor({ state: 'visible', timeout: 15000 });
  check('meta device grant shows the code to confirm', (await metaUserCode.innerText()).trim() === 'E2E-CODE-1');
  check('meta device grant offers no callback paste', (await metaPanel.locator('[data-oauth-callback-input]').count()) === 0);
  const sessionPills = page.getByTestId('oauth-session-pill');
  check(
    'concurrent provider sessions are exposed by provider identity in the workspace strip',
    (await sessionPills.filter({ hasText: /iFlow/i }).count()) === 1
      && (await sessionPills.filter({ hasText: /Meta Museo|Meta Muse/i }).count()) === 1,
    `sessions=${await sessionPills.count()}`,
  );
}
