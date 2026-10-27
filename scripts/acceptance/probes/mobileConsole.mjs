import { until, settleLayout } from '../harness.mjs';

// Each route waits for its own content, so a preceding route cannot satisfy the sweep.
const ROUTES = [
  ['/dashboard', '.dashboard-page'], ['/ai-providers', '.providers-page'],
  ['/oauth-management', '.oauth-management-page'], ['/api-keys', '.keys-page'],
  ['/usage/events', '.usage-events-page'], ['/pricing', '[data-testid="pricing-page"]'],
  ['/logs', '.logs-page'], ['/audit', '[data-testid="audit-page"]'],
  ['/config', '.config-page'], ['/plugins', '.plugins-page'],
  ['/system', '.system-page'], ['/omc-settings', '.omc-settings-page'],
  ['/model-square', '.model-square-page'], ['/agent', '[data-testid="agent-page"]'],
  ['/playground', '[data-testid="playground-page"]'],
];

/**
 * The navigation sheet follows a finger: a sideways swipe across the page draws it out under the
 * finger and a swipe back on it puts it away, each settling by where it was released. A swipe on to
 * the trailing edge across the open sheet is Back and closes it. A swipe that is mostly vertical is
 * the page's scroll and leaves the sheet alone.
 */
async function swipeNavigation({ page, check }) {
  const cdp = await page.context().newCDPSession(page);
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  const panelLeft = () => page.evaluate(() => Math.round(document.querySelector('.mobile-nav-sheet-panel').getBoundingClientRect().left));
  const isOpen = () => page.evaluate(() => document.querySelector('.mobile-nav-sheet.is-active:not(.is-dragging)') !== null
    && document.querySelector('.app-body').hasAttribute('inert'));
  const drag = async ({ fromX, toX, fromY = 500, toY = fromY, isLanding = true, lift = true }) => {
    if (isLanding) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY, id: 1 }] });
    for (let step = 1; step <= 10; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + ((toX - fromX) * step) / 10, y: fromY + ((toY - fromY) * step) / 10, id: 1 }] });
      await frame();
    }
    if (lift) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const settled = async (label) => {
    let previous;
    await until(async () => { const current = await panelLeft(); const isStill = current === previous; previous = current; return isStill; }, { label });
  };

  await drag({ fromX: 60, toX: 180, fromY: 600, toY: 300 });
  await settled('a vertical swipe to settle');
  check('a vertical swipe leaves the navigation sheet closed', !(await isOpen()));

  await drag({ fromX: 40, toX: 140, lift: false });
  const width = await page.evaluate(() => document.querySelector('.mobile-nav-sheet-panel').offsetWidth);
  const left = await panelLeft();
  check('a sideways swipe draws the navigation sheet out under the finger', Math.abs(left - (100 - width)) <= 2, `left=${left} width=${width}`);
  await drag({ fromX: 140, toX: 240, isLanding: false });
  await settled('the released sheet to settle');
  check('released past halfway, the sheet settles open', await isOpen() && await panelLeft() === 0);

  await drag({ fromX: 240, toX: 40, fromY: 400 });
  await settled('the sheet swiped back to settle');
  await until(async () => !(await isOpen()) && await page.locator('.mobile-nav-sheet-panel').isHidden(), { label: 'the navigation sheet to close' });
  check('a swipe back on the sheet puts it away', true);

  await drag({ fromX: 40, toX: 240 });
  await settled('the sheet swiped out to settle');
  await drag({ fromX: 100, toX: 220, fromY: 400 });
  await until(async () => !(await isOpen()) && await page.locator('.mobile-nav-sheet-panel').isHidden(), { label: 'the sheet swiped as Back to close' });
  check('a swipe towards the trailing edge on the open sheet is Back', true);
}

export async function mobileConsole({ base, page, check, errors }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-page').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 320, height: 844 });
  await swipeNavigation({ page, check });
  for (const [route, contentSelector] of ROUTES) {
    await page.locator('.app-header-left button').click();
    const navigation = page.locator('.mobile-nav-sheet-panel:visible');
    await navigation.locator(`[data-route-path="${route}"]`).click();
    await page.waitForURL(`${base}${route}`);
    await navigation.waitFor({ state: 'hidden' });
    await page.locator(contentSelector).waitFor({ state: 'visible' });
    // Resize the mounted page at all three widths, retaining every route/width assertion.
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await settleLayout(page);
      const geometry = await page.evaluate(() => {
        const pane = document.querySelector('.app-content');
        const header = document.querySelector('.app-header');
        const controls = [...header.querySelectorAll('button')].map((control) => control.getBoundingClientRect());
        return {
          overflow: pane.scrollWidth - pane.clientWidth,
          outside: [...pane.querySelectorAll('*')].filter((node) => node.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(node).position !== 'fixed').slice(0, 12).map((node) => ({ className: node.className, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width })),
          headerOverflow: header.scrollWidth - header.clientWidth,
          actions: document.querySelectorAll('.app-header-actions > button').length,
          hasReachableControls: controls.every((box) => box.left >= 0 && box.right <= innerWidth && box.width >= 32),
        };
      });
      check(`${route} fits ${width}px with two reachable header tools`, geometry.overflow <= 1 && geometry.headerOverflow <= 1 && geometry.actions === 2 && geometry.hasReachableControls, JSON.stringify(geometry));
      check(`${route} has no recovery fallback at ${width}px`, await page.locator('#route-error-title').count() === 0);
      if (route === '/dashboard') {
        const pageTools = page.locator('.terminal-page-actions').getByRole('button', { name: 'More', exact: true });
        check(`loaded dashboard discloses secondary phone tools at ${width}px`, await pageTools.count() === 1);
      }
    }
  }

  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  const tools = page.getByRole('button', { name: 'Console tools', exact: true });
  await tools.click();
  const popup = page.locator('.action-menu-content:visible').filter({ has: page.getByRole('button', { name: 'English', exact: true }) });
  await popup.waitFor({ state: 'visible' });
  check('the header menu names the selected language and theme', await popup.getByRole('button', { name: 'English', exact: true }).getAttribute('aria-pressed') === 'true' && await popup.getByRole('button', { name: 'Light', exact: true }).getAttribute('aria-pressed') === 'true');
  const heights = await popup.locator('button, a').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
  check('header menu rows have 44px hit areas', heights.length >= 9 && heights.every((height) => height >= 44), JSON.stringify(heights));
  await page.goBack();
  await until(async () => await tools.getAttribute('aria-expanded') === 'false', { label: 'Back dismisses header tools' });
  check('Back closes tools without leaving the page and restores focus', page.url().endsWith('/config') && await tools.evaluate((control) => control === document.activeElement));

  for (const width of [640, 641, 900, 901, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await settleLayout(page);
    const count = await page.locator('.app-header-actions > .ant-btn').count();
    check(`header changes once at the phone boundary (${width}px)`, count === (width <= 640 ? 2 : 5), `tools=${count}`);
    const hasSheetTrigger = await page.locator('.app-header-left button').isVisible();
    check(`navigation remains reachable at ${width}px`, hasSheetTrigger);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  check('landscape content remains bounded', await page.locator('.app-content').evaluate((pane) => pane.scrollWidth <= pane.clientWidth + 1));
  await checkWorkspaceKeyboard({ base, page, check });
  check('the complete phone sweep has no runtime errors', errors.length === 0, errors.join(' | '));
}

async function checkWorkspaceKeyboard({ base, page, check }) {
  for (const route of ['/agent', '/playground']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    const workspace = page.getByTestId(`${route.slice(1)}-page`);
    await workspace.locator('textarea').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      window.workspaceViewportDescriptors = {};
      for (const key of ['height', 'offsetTop']) window.workspaceViewportDescriptors[key] = Object.getOwnPropertyDescriptor(viewport, key);
      Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 30 });
      viewport.dispatchEvent(new Event('resize'));
    });
    await until(async () => await workspace.evaluate((region) => region.getBoundingClientRect().bottom <= 450), { label: `${route} fits the keyboard viewport` });
    const geometry = await workspace.evaluate((region) => {
      const input = region.querySelector('textarea').getBoundingClientRect();
      const send = region.querySelector('button[aria-label="Send"]').getBoundingClientRect();
      const hit = document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2);
      return { inputBottom: input.bottom, sendBottom: send.bottom, sendTop: send.top, isSendHit: Boolean(hit?.closest('button[aria-label="Send"]')) };
    });
    check(`${route} keeps input and Send reachable above the keyboard`, geometry.inputBottom <= 450 && geometry.sendBottom <= 450 && geometry.sendTop >= 30 && geometry.isSendHit, JSON.stringify(geometry));
    // The Agent's floating actions give their row to the conversation while the keyboard is up.
    const pageActions = page.getByRole('button', { name: 'Capabilities', exact: true });
    if (route === '/agent') check('/agent folds its page actions away under a keyboard', !(await pageActions.isVisible()));
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      for (const key of ['height', 'offsetTop']) {
        if (window.workspaceViewportDescriptors[key]) Object.defineProperty(viewport, key, window.workspaceViewportDescriptors[key]);
        else delete viewport[key];
      }
      viewport.dispatchEvent(new Event('resize'));
    });
    if (route === '/agent') {
      await pageActions.waitFor({ state: 'visible' });
      check('/agent brings its page actions back when the keyboard goes', await pageActions.isVisible());
    }
  }
}
