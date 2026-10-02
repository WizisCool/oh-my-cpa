const FAILURE_MARKER = 'Cannot read properties of undefined (reading model)';
const PRIVATE_MARKER = 'fixture-private123456';
const RECOVERY_MARKER = 'route-error-fixture-recovered';

const READINGS = [
  { lang: 'en', theme: 'omc-light', width: 1280, title: 'This page couldn’t load', reload: 'Reload page', home: 'Go to dashboard' },
  { lang: 'zh', theme: 'omc-dark', width: 375, title: '页面未能加载', reload: '刷新页面', home: '返回首页' },
  { lang: 'zh-Hant', theme: 'omc-light', width: 375, title: '頁面未能載入', reload: '重新整理頁面', home: '返回首頁' },
  { lang: 'ms', theme: 'omc-dark', width: 1280, title: 'Halaman ini tidak dapat dimuatkan', reload: 'Muat semula halaman', home: 'Ke papan pemuka' },
];

async function checkRouteRecovery({ base, page, context, check, errors }, failureMode) {
  await context.addInitScript(() => {
    window.__OMCPA_CONFIG__ = { basePath: '/omc', apiBaseUrl: '/omc/api/v1', mediaBaseUrl: '/omc/media', version: 'route-error-test-build' };
  });
  const modulePattern = '**/src/pages/ConfigPage.tsx*';
  for (const reading of READINGS) {
    await page.goto(`${base}/dashboard`);
    await page.locator('.app-shell').waitFor();
    await page.evaluate(({ lang, theme }) => {
      localStorage.setItem('omc-lang', lang);
      localStorage.setItem('omc-theme', theme);
    }, reading);
    await page.setViewportSize({ width: reading.width, height: 800 });

    let hasInjectedFailure = false;
    const failModule = (route) => {
      hasInjectedFailure = true;
      if (failureMode === 'lazy') return route.abort('failed');
      return route.fulfill({
        contentType: 'application/javascript',
        body: `export function ConfigPage() { throw new TypeError('${FAILURE_MARKER} api_key=${PRIVATE_MARKER}'); }`,
      });
    };
    await context.route(modulePattern, failModule);
    await page.goto(`${base}/config`);
    const heading = page.getByRole('heading', { name: reading.title, exact: true });
    await heading.waitFor();
    check(`${failureMode}/${reading.lang}: a real route failure reached the OMC boundary`, hasInjectedFailure);
    check(`${failureMode}/${reading.lang}: branded logo is visible`, await page.getByRole('img', { name: 'Oh My CPA', exact: true }).isVisible());
    check(`${failureMode}/${reading.lang}: the error owns focus and the tab title`,
      await heading.evaluate((element) => document.activeElement === element) &&
      await page.title() === `Oh My CPA · ${reading.title}`);
    const text = await page.locator('body').innerText();
    check(`${failureMode}/${reading.lang}: no framework fallback or private exception content`,
      !text.includes('Unexpected Application Error!') && !text.includes('errorElement') &&
      !text.includes(PRIVATE_MARKER));
    const message = await page.getByTestId('route-error-message').innerText();
    check(`${failureMode}/${reading.lang}: useful failure reason is visible`,
      failureMode === 'render' ? message.includes(FAILURE_MARKER) && message.includes('[REDACTED]') : message.includes('Failed to fetch dynamically imported module'));
    await page.locator('summary').click();
    const stack = page.getByTestId('route-error-stack');
    await stack.waitFor();
    check(`${failureMode}/${reading.lang}: stack details are selectable and useful`,
      failureMode === 'render' ? (await stack.innerText()).includes('ConfigPage') : (await stack.innerText()).length > 0);
    await page.evaluate(() => {
      window.__routeErrorCopied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__routeErrorCopied = text; } } });
    });
    await page.locator('section .ant-btn').click();
    const copied = await page.evaluate(() => window.__routeErrorCopied);
    check(`${failureMode}/${reading.lang}: copy contains the redacted message, route and build`,
      copied.includes(message) && copied.includes(`${new URL(base).pathname}/config`) && copied.includes('route-error-test-build') && !copied.includes(PRIVATE_MARKER));
    const geometry = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      background: getComputedStyle(document.querySelector('main')).backgroundColor,
      expected: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    }));
    check(`${failureMode}/${reading.lang}: no horizontal overflow`, geometry.scrollWidth <= geometry.viewport, JSON.stringify(geometry));
    check(`${failureMode}/${reading.lang}: selected theme survives the failure`,
      geometry.background === (reading.theme === 'omc-dark' ? 'rgb(18, 18, 20)' : 'rgb(255, 255, 255)'), JSON.stringify(geometry));
    const home = page.getByRole('link', { name: reading.home, exact: true });
    check(`${failureMode}/${reading.lang}: home respects the deployment sub-path`, await home.getAttribute('href') === `${new URL(base).pathname}/dashboard`);
    const reload = page.getByRole('button', { name: reading.reload, exact: true });
    const bounds = await reload.boundingBox();
    check(`${failureMode}/${reading.lang}: reload has a touch-sized hit area`, bounds?.height >= (reading.width <= 640 ? 44 : 32), JSON.stringify(bounds));

    // Swap in a healthy module. A client-side retry cannot clear the rejected lazy promise.
    await context.unroute(modulePattern, failModule);
    const recoverModule = (route) => route.fulfill({
      contentType: 'application/javascript',
      body: `export function ConfigPage() { return '${RECOVERY_MARKER}'; }`,
    });
    await context.route(modulePattern, recoverModule);
    await reload.focus();
    await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);
    await page.getByText(RECOVERY_MARKER, { exact: true }).waitFor();
    check(`${failureMode}/${reading.lang}: keyboard reload recovered the same route`, new URL(page.url()).pathname.endsWith('/config'));
    await context.unroute(modulePattern, recoverModule);

    // A second fresh failure proves the home action escapes the boundary with a full navigation.
    await context.route(modulePattern, failModule);
    await page.goto(`${base}/config`);
    await heading.waitFor();
    await home.focus();
    await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);
    await page.locator('.app-shell').waitFor();
    check(`${failureMode}/${reading.lang}: keyboard home recovered the dashboard`,
      new URL(page.url()).pathname === `${new URL(base).pathname}/dashboard` && await heading.count() === 0);
    await context.unroute(modulePattern, failModule);
  }
  check(`${failureMode}: only deliberately injected exceptions escaped to the browser`,
    errors.every((message) => failureMode === 'render' ? message.includes(FAILURE_MARKER) : message.includes('Failed to fetch dynamically imported module')), errors.join(' | '));
}

export async function routeRenderError(fixtures) {
  await checkRouteRecovery(fixtures, 'render');
  const { base, page, context, check } = fixtures;
  const shellModulePattern = '**/src/components/common/AppLayout.tsx*';
  const failShell = (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `export function AppLayout() { throw new Error('${FAILURE_MARKER}'); }`,
  });
  await context.route(shellModulePattern, failShell);
  await page.goto(`${base}/config`);
  await page.getByTestId('route-error-message').waitFor();
  check('a broken shell still has a standalone root recovery page',
    (await page.getByTestId('route-error-message').innerText()).includes(FAILURE_MARKER) &&
    await page.getByRole('img', { name: 'Oh My CPA', exact: true }).isVisible() &&
    await page.locator('.app-shell').count() === 0);
  await context.unroute(shellModulePattern, failShell);
}
export async function routeLazyError(fixtures) {
  await checkRouteRecovery(fixtures, 'lazy');
  const { base, page, context, check, errors } = fixtures;
  const reading = READINGS[0];
  await page.evaluate(({ lang }) => localStorage.setItem('omc-lang', lang), reading);
  const shellModulePattern = '**/src/components/common/AppLayout.tsx*';
  let rejectShell;
  const shellRelease = new Promise(resolve => { rejectShell = resolve; });
  const failShell = async (route) => {
    await shellRelease;
    await route.abort('failed');
  };
  await context.route(shellModulePattern, failShell);
  try {
    await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
    await page.locator('.page-loading .ant-spin').waitFor();
    check('the authenticated shell has a visible loading state', await page.locator('.app-shell').count() === 0);
    check('the shell loading state exposes a localized accessible name',
      await page.getByRole('status', { name: 'Loading…', exact: true }).isVisible());
    rejectShell();
    await page.getByTestId('route-error-message').waitFor();
    check('a failed shell download still shows branded diagnostic recovery',
      (await page.getByTestId('route-error-message').innerText()).includes('Failed to fetch dynamically imported module') &&
      await page.getByRole('img', { name: 'Oh My CPA', exact: true }).isVisible() &&
      await page.locator('.app-shell').count() === 0);
    await page.evaluate(() => {
      window.__routeErrorCopied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__routeErrorCopied = text; } } });
    });
    await page.locator('section .ant-btn').click();
    check('a failed shell download retains the diagnostic copy action',
      (await page.evaluate(() => window.__routeErrorCopied)).includes('Failed to fetch dynamically imported module'));
  } finally {
    rejectShell();
    await context.unroute(shellModulePattern, failShell);
  }
  const home = page.getByRole('link', { name: reading.home, exact: true });
  await home.focus();
  await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);
  await page.locator('.app-shell').waitFor();
  check('full-document dashboard recovery retries the shell download',
    new URL(page.url()).pathname === `${new URL(base).pathname}/dashboard` && await page.getByTestId('route-error-message').count() === 0);
  check('shell import errors are the only additional browser exceptions',
    errors.every(message => message.includes('Failed to fetch dynamically imported module')), errors.join(' | '));
}
