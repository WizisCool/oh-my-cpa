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

export async function mobileConsole({ base, page, check, errors }) {
  await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('.dashboard-page').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 320, height: 844 });
  for (const [route, contentSelector] of ROUTES) {
    await page.locator('.app-header-left button').click();
    const navigation = page.locator('.mobile-nav-drawer:visible');
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
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      for (const key of ['height', 'offsetTop']) {
        if (window.workspaceViewportDescriptors[key]) Object.defineProperty(viewport, key, window.workspaceViewportDescriptors[key]);
        else delete viewport[key];
      }
      viewport.dispatchEvent(new Event('resize'));
    });
  }
}
