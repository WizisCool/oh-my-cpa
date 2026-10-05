import { until } from '../harness.mjs';

export async function routePreloading({ base, page, context, check }) {
  await page.addInitScript(() => {
    window.__contentScrollResets = 0;
    const scrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args) {
      if (this.classList.contains('app-content')) window.__contentScrollResets += 1;
      return scrollTo.apply(this, args);
    };
  });
  const scriptPaths = [];
  const apiPaths = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.resourceType() === 'script') scriptPaths.push(path);
    if (path.includes('/api/')) apiPaths.push(path);
  });

  // A fresh document on an unauthenticated route must not fetch a page's module.
  await context.route('**/api/auth/session', (route) => route.fulfill({ json: { authenticated: false } }));
  await page.goto(`${base}/system`);
  await page.locator('.auth-card input').waitFor();
  check('sign-in leaves lazy page modules unloaded', !scriptPaths.some((path) => /\/src\/pages\/.*\.tsx$/.test(path)), scriptPaths.join(' | '));
  await context.unroute('**/api/auth/session');

  await page.reload();
  await page.locator('.app-menu').waitFor();
  const startPath = new URL(page.url()).pathname;
  const targets = [
    { path: '/config', module: '/pages/ConfigPage.tsx', action: (item) => item.hover(), read: '/management/config' },
    { path: '/logs', module: '/pages/LogsPage.tsx', action: (item) => item.focus(), read: '/management/logs' },
    { path: '/plugins', module: '/pages/PluginsPage.tsx', action: (item) => item.dispatchEvent('touchstart'), read: '/management/plugins' },
  ];
  // The shell reads the plugin list for its navigation, so only reads made after an
  // intent count against it.
  await until(async () => apiPaths.some((path) => path.endsWith('/management/plugins')), { label: 'the shell plugin list read' });
  for (const target of targets) {
    const readsBefore = apiPaths.length;
    const item = page.locator(`.app-menu [data-route-path="${target.path}"]`).first();
    const loaded = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(target.module));
    await target.action(item);
    const response = await loaded;
    await response.finished();
    check(`${target.path} intent loads its module`, response.ok(), response.url());
    check(`${target.path} intent does not navigate`, new URL(page.url()).pathname === startPath, page.url());
    check(`${target.path} intent does not read business data`, !apiPaths.slice(readsBefore).some((path) => path.includes(target.read)), apiPaths.slice(readsBefore).join(' | '));
  }
  check('preloading config keeps the YAML editor on demand', !scriptPaths.some((path) => path.endsWith('/YamlSourceEditor.tsx')), scriptPaths.join(' | '));

  const configRead = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/management/config'));
  await page.locator('.app-menu [data-route-path="/config"]').first().click();
  await configRead;
  await page.locator('.config-page').waitFor();
  await until(() => new URL(page.url()).pathname.endsWith('/config'), { label: 'preloaded config navigation' });
  check('navigation mounts the preloaded page and its reads', new URL(page.url()).pathname.endsWith('/config'), page.url());
  check('navigation at the top avoids a redundant shell scroll reset',
    await page.evaluate(() => window.__contentScrollResets) === 0);

  await page.locator('.app-menu [data-route-path="/dashboard"]').first().click();
  await page.locator('.heatmap-grid').waitFor();
  // Real overflowing content exercises the root scroll event, rather than a nested widget.
  await page.locator('.heatmap-panel').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('.app-content').scrollTop > 0);
  const resetsBeforeNavigation = await page.evaluate(() => window.__contentScrollResets);
  await page.locator('.app-menu [data-route-path="/system"]').first().click();
  await page.waitForFunction(() => location.pathname.endsWith('/system') && document.querySelector('.app-content').scrollTop === 0);
  check('navigation after scrolling resets the content column exactly once',
    await page.evaluate(() => window.__contentScrollResets) === resetsBeforeNavigation + 1);

}
