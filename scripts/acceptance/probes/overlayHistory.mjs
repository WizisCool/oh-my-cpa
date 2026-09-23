import { until } from '../harness.mjs';

/**
 * Probes for the platform's Back button and the overlays it dismisses.
 *
 * The logic suite (`scripts/test-overlay-history.ts`) can prove the module called `back()`
 * at the right moments; only an engine can prove the sentinel is where the browser's Back
 * actually goes, that the route survives it, and that the entry a UI close consumed is gone
 * rather than left to be spent by the reader's next press. Every claim below is one of those.
 */

/** What is on top right now, plus the route, so "it stayed put" is exact rather than approximate. */
const OVERLAY_STATE = `(() => {
  const visible = (selector) => Array.from(document.querySelectorAll(selector)).filter((element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return element.getBoundingClientRect().width > 0;
  }).length;
  return {
    drawers: visible('.ant-drawer-content-wrapper'),
    modals: visible('.ant-modal'),
    route: location.pathname + location.search,
  };
})()`;

/**
 * Arrives at a route through a real in-app navigation.
 *
 * `goto` cannot build the history these probes need: navigating to the URL the document
 * already holds is a reload, which *replaces* the current entry, so a following Back lands
 * outside the app and the claim under test is never exercised. Two distinct routes give Back
 * somewhere to go, which is also the only way "it did not navigate" means anything.
 */
async function arriveFrom(base, page, route) {
  await page.goto(`${base}${route === '/dashboard' ? '/ai-providers' : '/dashboard'}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 20_000 });
  await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 20_000 });
}


/**
 * Waits for the overlay to be gone before the route is read.
 *
 * A fixed sleep would be a guess in both directions. The dismissal is a state transition and
 * antd keeps the drawer's wrapper mounted for the length of its leave animation, so "no
 * drawers" becomes true only once that animation has finished - which is a condition, not a
 * duration, and a loaded machine takes longer to reach it than an idle one.
 */
async function settled(page) {
  return until(async () => {
    const state = await page.evaluate(OVERLAY_STATE);
    // Both classes are waited out, because both are wired to the same hook and either can be the one
    // a Back dismissed.
    return state.drawers === 0 && state.modals === 0 ? state : false;
  }, { label: 'the overlay to be dismissed', timeoutMs: 5_000 }).catch(async () => page.evaluate(OVERLAY_STATE));
}

/** The route after a Back, with the transition waited out. */
async function routeAfterBack(base, page) {
  await page.goBack();
  return settled(page);
}

/** The request list needs seeded records; the other surfaces need only the route. */
async function waitForRequests(page) {
  await page.locator('.request-row').first().waitFor({ timeout: 20_000 });
}

export async function overlayBackDismisses({ base, page, check }) {
  // The console is served under a base path (`/omc` by default) and the whole app is expected to
  // work under any of them, so the route a check compares is the base path plus the route rather
  // than the route alone.
  const basePath = new URL(base).pathname.replace(/\/$/, '');

  // ---- the navigation sheet ----
  await arriveFrom(base, page, '/dashboard');
  const dashboardURL = page.url();
  await page.locator('.app-header-left button').first().click();
  await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5_000 });
  let state = await routeAfterBack(base, page);
  check(
    'a Back closes the navigation sheet and leaves the route alone',
    state.drawers === 0 && state.route === `${basePath}/dashboard`,
    `drawers=${state.drawers} route=${state.route} startedAt=${new URL(dashboardURL).pathname}`,
  );

  // ---- the unified OAuth Connect drawer ----
  await arriveFrom(base, page, '/oauth-management');
  await page.locator('.oauth-management-page').first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /Connect account|连接账号/i }).first().click();
  await page.locator('[data-testid="oauth-connect-panel"]').waitFor({ state: 'visible', timeout: 5_000 });
  state = await routeAfterBack(base, page);
  check(
    'a Back minimizes the OAuth Connect drawer and leaves the workspace route alone',
    state.drawers === 0 && state.route === `${basePath}/oauth-management`,
    `drawers=${state.drawers} route=${state.route}`,
  );

  // The old provider-specific link opens the same drawer after a parameter-safe
  // replace. Back must close it once and must not reopen it from the consumed
  // action query value.
  await arriveFrom(base, page, '/oauth?provider=codex');
  await page.locator('[data-testid="oauth-connect-panel"]').waitFor({ state: 'visible', timeout: 10_000 });
  state = await routeAfterBack(base, page);
  check(
    'a provider-specific legacy link closes once without reopening from its query',
    state.drawers === 0
      && state.route === `${basePath}/oauth-management?provider=codex`
      && !state.route.includes('action=connect'),
    `drawers=${state.drawers} route=${state.route}`,
  );

  // ---- the request detail drawer ----
  await arriveFrom(base, page, '/usage/events');
  await waitForRequests(page);
  await page.locator('.request-row').first().click();
  await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5_000 });
  state = await routeAfterBack(base, page);
  check(
    'a Back closes the request record and leaves the reader on the list',
    state.drawers === 0 && state.route.startsWith(`${basePath}/usage/events`),
    `drawers=${state.drawers} route=${state.route}`,
  );

  // ---- the filter drawer: applying must survive the close ----
  await arriveFrom(base, page, '/usage/events');
  await waitForRequests(page);
  await page.getByRole('button', { name: /更多筛选|More filters/i }).first().click();
  await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5_000 });
  // Typed by id rather than by position: the drawer also renders facet selects, and an open
  // popup would intercept the click on the footer that applies the draft.
  await page.locator('#req-text-request_id').fill('req_fixture');
  await page.locator('[data-testid="req-filter-apply"]').click();
  await page.waitForTimeout(900);
  const applied = await page.evaluate(OVERLAY_STATE);
  check(
    'applying from the filter drawer keeps the filters it applied',
    applied.drawers === 0 && applied.route.includes('request_id='),
    `drawers=${applied.drawers} route=${applied.route}`,
  );
  // The claim this pins is the accident the sentinel design exists to prevent: a close that
  // traverses would pop the entry the filters were just written to and revert them.
  const afterBack = await routeAfterBack(base, page);
  check(
    'the Back after an apply clears the filter rather than the drawer it left behind',
    !afterBack.route.includes('request_id='),
    `route=${afterBack.route}`,
  );

  // ---- a Modal-class overlay ----
  //
  // The hook is wired into dialogs as well as drawers, and a scenario that only ever opened a drawer
  // would pass while Back did nothing for every dialog in the console.
  await arriveFrom(base, page, '/api-keys');
  await page.locator('.keys-page').first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /Add API Key|添加 API 密钥/ }).first().click();
  await page.locator('.ant-modal').first().waitFor({ state: 'visible', timeout: 5_000 });
  await page.goBack();
  const afterModalBack = await settled(page);
  check(
    'a Back closes a dialog and leaves the route alone',
    afterModalBack.modals === 0 && afterModalBack.route.startsWith(`${basePath}/api-keys`),
    `modals=${afterModalBack.modals} route=${afterModalBack.route}`,
  );

  // ---- the provider editor ----
  await arriveFrom(base, page, '/ai-providers');
  await page.locator('.providers-page').first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /编辑|Edit/i }).first().click();
  await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5_000 });
  state = await routeAfterBack(base, page);
  check(
    'a Back closes the provider editor and leaves the route alone',
    state.drawers === 0 && state.route === `${basePath}/ai-providers`,
    `drawers=${state.drawers} route=${state.route}`,
  );

  // ---- a close from the overlay's own UI consumes its sentinel ----
  //
  // The distinction this pins: an overlay that *pushes* an entry and forgets it is not the
  // same as one that consumes it. With the sentinel consumed, the reader's next Back is a
  // route Back; with a dead entry left behind, it is a press that does nothing.
  await arriveFrom(base, page, '/dashboard');
  await page.locator('.app-header-left button').first().click();
  await page.locator('.ant-drawer-content-wrapper').first().waitFor({ state: 'visible', timeout: 5_000 });
  await page.keyboard.press('Escape');
  const afterEscape = await settled(page);
  // The traversal itself is awaited; the condition is on the *route* changing, because a spent
  // press leaves the reader on the same URL and that is exactly the failure being ruled out.
  await page.goBack();
  await until(async () => !new URL(page.url()).pathname.endsWith('/dashboard'), {
    label: 'the route Back to land',
    timeoutMs: 5_000,
  }).catch(() => {});
  check(
    'an overlay closed by its own UI leaves no entry for the next Back to spend',
    afterEscape.drawers === 0 && page.url().endsWith(`${basePath}/ai-providers`),
    `afterEscape=${afterEscape.route} afterBack=${new URL(page.url()).pathname}`,
  );
}
