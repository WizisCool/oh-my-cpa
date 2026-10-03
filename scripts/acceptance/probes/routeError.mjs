import { checkWaitingActivity } from './loadingProgress.mjs';

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
  await page.emulateMedia({ reducedMotion: 'no-preference' });
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
    await page.locator('.shell-loading .page-loading').waitFor();
    check('the authenticated shell has a visible loading state', await page.locator('.app-shell').count() === 0);
    // The held download is work in flight, so the shell's bar paints once the show delay passes.
    await page.locator('.shell-loading-progress[data-state="running"]').waitFor();
    check('the held shell download exposes waiting without an estimated accessible percentage',
      await page.locator('.shell-loading-progress').getAttribute('aria-valuenow') === null);
    // Enough completed work puts the bar past 95%, but the held module still owns the last task.
    await page.evaluate(async (moduleUrl) => {
      const { beginProgressTask } = await import(moduleUrl);
      const settleTasks = Array.from({ length: 19 }, () => beginProgressTask());
      for (const settleTask of settleTasks) settleTask();
    }, `${new URL(base).pathname}/src/utils/progressTasks.ts`);
    await page.waitForFunction(() => {
      const fill = document.querySelector('.shell-loading-progress .progress-bar-fill');
      return fill && new DOMMatrix(getComputedStyle(fill).transform).a >= 0.95;
    });
    check('the almost-filled bar cannot announce completion while its module is held',
      await page.locator('.shell-loading-progress').getAttribute('aria-valuenow') === null &&
      await page.locator('.shell-loading-progress').getAttribute('aria-busy') === 'true');
    await checkWaitingActivity(fixtures, '.shell-loading-progress');
    const fill = page.locator('.shell-loading-progress .progress-bar-fill');
    const beforeMotionChange = await fill.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Sample the bar's next drawing frame, not an arbitrary elapsed duration.
    const reduced = await fill.evaluate(element => new Promise(resolve => {
      const sample = () => requestAnimationFrame(() => {
        // A restarted effect hides the bar; wait for its painted frame instead of reading "none" as 1.
        if (element.parentElement.hidden) { sample(); return; }
        resolve({
          scale: new DOMMatrix(getComputedStyle(element).transform).a,
          animation: getComputedStyle(document.querySelector('.shell-loading .placeholder')).animationName,
          activity: getComputedStyle(document.querySelector('.shell-loading-progress .progress-bar-activity-mark')).animationName,
        });
      });
      sample();
    }));
    check('reduced motion freezes the placeholder without restarting the counted batch',
      reduced.scale >= beforeMotionChange && reduced.animation === 'none' && reduced.activity === 'none' &&
      await page.locator('.shell-loading-progress').getAttribute('aria-valuenow') === null, JSON.stringify(reduced));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const resumed = await fill.evaluate(element => new Promise(resolve => {
      const sample = () => requestAnimationFrame(() => {
        if (element.parentElement.hidden) { sample(); return; }
        resolve(new DOMMatrix(getComputedStyle(element).transform).a);
      });
      sample();
    }));
    check('restoring motion keeps the same batch and never moves progress backwards', resumed >= reduced.scale);
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
  // The sign-in bar has no query-cache notifications that can incidentally restart its finished loop.
  const sessionPattern = '**/api/auth/session';
  const signedOutSession = (route) => route.fulfill({ json: { authenticated: false } });
  await context.route(sessionPattern, signedOutSession);
  try {
    await page.goto(`${base}/dashboard`);
    await page.locator('.auth-form').waitFor();
    await page.waitForFunction(() => document.querySelector('.auth-progress')?.hidden);
    await page.evaluate(async (moduleUrl) => {
      const { beginProgressTask } = await import(moduleUrl);
      const progress = document.querySelector('.auth-progress');
      window.__hasProgressFadeStarted = false;
      window.__hasProgressFadeCancelled = false;
      progress.addEventListener('transitionrun', (event) => {
        if (event.target !== progress || event.propertyName !== 'opacity') return;
        // Hold the browser's animation clock so emulation cannot race a naturally finished fade.
        for (const transition of progress.getAnimations()) {
          if (transition.transitionProperty === 'opacity') transition.pause();
        }
        window.__hasProgressFadeStarted = true;
      }, { once: true });
      progress.addEventListener('transitioncancel', (event) => {
        if (event.target === progress && event.propertyName === 'opacity') window.__hasProgressFadeCancelled = true;
      }, { once: true });
      window.__settleProgressTask = beginProgressTask();
    }, `${new URL(base).pathname}/src/utils/progressTasks.ts`);
    await page.locator('.auth-progress[data-state="running"]').waitFor();
    await checkWaitingActivity(fixtures, '.auth-progress', { shouldChangeTheme: true });
    await page.evaluate(() => window.__settleProgressTask());
    await page.waitForFunction(() => window.__hasProgressFadeStarted);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => window.__hasProgressFadeCancelled);
    check('reduced motion cancels the completion fade and hides the finished progress bar',
      await page.locator('.auth-progress').evaluate(progress => progress.hidden && !progress.hasAttribute('aria-busy')));
  } finally {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await context.unroute(sessionPattern, signedOutSession);
  }
  await page.goto(`${base}/dashboard`);
  await page.locator('.dashboard-page').waitFor();
  await page.locator('.dashboard-page').getByRole('button', { name: 'Refresh all', exact: true }).waitFor();
  const dashboardPattern = '**/api/v1/management/dashboard?*';
  let releaseDashboard;
  let observeDashboard;
  const dashboardRelease = new Promise(resolve => { releaseDashboard = resolve; });
  const dashboardObserved = new Promise(resolve => { observeDashboard = resolve; });
  const holdDashboard = async (route) => {
    observeDashboard();
    await dashboardRelease;
    await route.fallback();
  };
  await context.route(dashboardPattern, holdDashboard);
  try {
    await page.getByText('98.70%', { exact: true }).first().waitFor();
    await page.locator('.dashboard-page').getByRole('button', { name: 'Refresh all', exact: true }).click();
    await dashboardObserved;
    await page.locator('.data-progress[data-state="running"]').waitFor();
    check('a real non-silent dashboard refresh keeps its data while reporting waiting',
      await page.getByText('98.70%', { exact: true }).first().isVisible() &&
      await page.locator('.dashboard-page .placeholder').count() === 0);
    await checkWaitingActivity(fixtures, '.data-progress');
    releaseDashboard();
    await page.waitForFunction(() => document.querySelector('.data-progress')?.hidden);
    check('the real query settlement retires console activity independently of its page',
      await page.locator('.data-progress').getAttribute('aria-busy') === null &&
      await page.locator('.dashboard-page').isVisible());
  } finally {
    releaseDashboard();
    await context.unroute(dashboardPattern, holdDashboard);
  }

}
