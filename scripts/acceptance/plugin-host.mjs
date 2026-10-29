import { FAKE_CPA_MANAGEMENT_KEY } from '../fake-cpa.mjs';

/**
 * The trusted plugin host end to end on the built binary: a registered plugin
 * page loads through the console's host, its CPA-root paths are re-based onto it, its
 * native management calls carry the key only the server holds, and nothing it reads or
 * stores exposes the management or OAuth credentials.
 */
export async function runPluginHostedPageAcceptance({ appURL, page, check }) {
  // A page the plugin registered is a destination in the navigation, and it works end to
  // end only if the whole chain does: the frame's document and script come through the
  // console's plugin host, their CPA-root paths are re-based onto it, and the plugin's own
  // management route is called with the key the server holds.
  const pageEntry = page.locator('.app-menu [data-route-path="/plugin-pages/fixture-logger/0"]').first();
  await pageEntry.waitFor({ state: 'visible', timeout: 10000 });
  check('a plugin page is listed in the navigation under its registered label', (await pageEntry.innerText()).includes('Logger Console'));
  await pageEntry.click();
  await page.locator('[data-plugin-page="fixture-logger"]').waitFor({ state: 'visible', timeout: 10000 });
  const pluginDocument = page.frameLocator('[data-plugin-page-frame]').frameLocator('iframe');
  await pluginDocument.locator('#plugin-title').waitFor({ state: 'visible', timeout: 15000 });
  const pluginStatus = pluginDocument.locator('#plugin-status');
  const statusSettled = await pluginStatus.filter({ hasText: 'logger running' }).waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  check('the plugin page reaches its own management route through the console', statusSettled, await pluginStatus.innerText().catch(() => ''));
  check('inline plugin startup identifies its provider from the CPA resource pathname', await pluginDocument.locator('#plugin-provider').innerText() === 'fixture-logger');
  const nativeStartup = pluginDocument.locator('#plugin-contract');
  await nativeStartup.filter({ hasText: /models [1-9]\d*; groups [1-9]\d*; native startup ready/ }).waitFor({ timeout: 10000 });
  check('the built plugin starts through native v0/v8 config, model and namespaced routes', /native startup ready/.test(await nativeStartup.innerText()));
  const pluginFrame = page.frames().find(frame => frame.url().endsWith('/v0/resource/plugins/fixture-logger/console'));
  check('provider identification keeps the frame on the hosted resource URL', pluginFrame?.url() === `${appURL}/api/v1/plugin-host/v0/resource/plugins/fixture-logger/console`);
  if (!pluginFrame) throw new Error('hosted plugin frame is missing');
  await pluginFrame.evaluate(() => window.runPluginContract('invalid-plugin-management-key'));
  check('an explicit wrong plugin credential remains unauthorized', await pluginDocument.locator('#plugin-credential-status').innerText() === '401');
  await pluginFrame.evaluate(credential => window.runPluginContract(credential), FAKE_CPA_MANAGEMENT_KEY);
  check('an explicit valid plugin credential is accepted', await pluginDocument.locator('#plugin-credential-status').innerText() === '200');
  await pluginFrame.evaluate(() => {
    const source = new EventSource(['', 'v0', 'management', 'plugins', 'fixture-logger', 'events'].join('/'));
    const probe = window.pluginHostEventProbe = { source, hasFinished: false, payload: undefined };
    source.onmessage = event => { probe.payload = event.data; };
    // Wait for finite fixture EOF rather than aborting a response still being audited.
    source.onerror = () => { source.close(); probe.hasFinished = true; };
  });
  let nativeEvent;
  try {
    await pluginFrame.waitForFunction(() => window.pluginHostEventProbe.hasFinished, undefined, { timeout: 10000 });
    nativeEvent = await pluginFrame.evaluate(() => window.pluginHostEventProbe.payload);
  } finally {
    await pluginFrame.evaluate(() => {
      window.pluginHostEventProbe.source.close();
      delete window.pluginHostEventProbe;
    });
  }
  check('the runtime shim also rebases EventSource paths', nativeEvent === 'native event ready');
  const overriddenRequestStatus = await pluginFrame.evaluate(async () => {
    const path = ['', 'v0', 'management', 'plugins', 'fixture-logger', 'credentials', 'sync'].join('/');
    const request = new Request(new URL(path, location.origin), { method: 'POST', body: 'invalid initial body' });
    const reply = await fetch(request, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentials: ['codex'], model_count: 1 }) });
    await reply.json();
    return reply.status;
  });
  check('rebased Request uploads preserve fetch body/header overrides on HTTP/1', overriddenRequestStatus === 200);
  const hostedConfigURL = `${appURL}/api/v1/plugin-host/v8/management/config/api-keys`;
  const hostedConfigStatus = await pluginFrame.evaluate(async url => {
    const reply = await fetch(url, {credentials: 'omit'});
    await reply.json();
    return reply.status;
  }, hostedConfigURL);
  check('already hosted URLs retain session access with omitted credentials', hostedConfigStatus === 200);
  const storedPluginData = await pluginFrame.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  check('the host does not write a management credential to browser storage', !storedPluginData.includes(FAKE_CPA_MANAGEMENT_KEY));
  const frameTheme = await pluginDocument.locator('#plugin-theme').innerText();
  check('the plugin page reads the console colour mode from its parent', frameTheme === 'dark' || frameTheme === 'light', frameTheme);
}

// Native plugin APIs intentionally return secrets. Match only their exact
// same-origin host surfaces, so ordinary response leak checks remain strict.
export function isNativePluginHostResponse(responseURL, appURL) {
  const prefix = `${appURL}/api/v1/plugin-host`;
  if (!responseURL.startsWith(prefix)) return false;
  return /^(?:\/v[08]\/management\/|\/v1\/models(?:\?|$))/.test(responseURL.slice(prefix.length));
}

// Native startup needs client/provider keys, not the injected server key or OAuth fixture.
export function hasPluginHostProtectedSecret(body, protectedSecrets) {
  return protectedSecrets.some((value) => body.includes(value));
}

export async function auditNativePluginHostResponse(response, protectedSecrets, check) {
  let body;
  try {
    body = await response.text();
  } catch {
    check('native plugin startup response is readable for secret auditing', false, response.url());
    return;
  }
  check(
    'native plugin startup excludes server management and OAuth credentials',
    !hasPluginHostProtectedSecret(body, protectedSecrets),
    response.url(),
  );
}

export async function settleNativeResponseAudits(audits, check) {
  const results = await Promise.allSettled(audits);
  for (const result of results) {
    if (result.status === 'rejected') check('native response audit completed', false, result.reason?.message ?? String(result.reason));
  }
}
