/** Initial reads and rendered content, not polling silence, define a ready demo route. */
export const DEMO_ROUTES = [
  { path: '/dashboard', heading: '仪表盘', reads: ['/management/dashboard', '/management/dashboard/models', '/management/dashboard/token-heatmap', '/management/overview', '/management/dashboard/providers', '/management/auth-files', '/management/quota'], content: '.dashboard-activity-row .heatmap-grid' },
  { path: '/model-square', heading: '模型广场', reads: ['/management/model-square', '/pricing', '/usage/facets'], content: '.model-square-page [data-model-identity]' },
  { path: '/playground', heading: '操练场', reads: ['/management/api-keys'], content: '[data-testid="playground-empty"]' },
  { path: '/agent', heading: 'Oh My CPA', headingSelector: '[data-testid="agent-empty"] [aria-label="Oh My CPA"]', reads: ['/agent/session', '/capabilities'], content: '[data-testid="agent-empty"]' },
  // Nothing can be prepared in the demonstration, so the page states that instead of reading an operation.
  { path: '/authorize/:id', heading: '授权外部 Agent', reads: [], content: '[data-testid="agent-authorize-demo"]' },
  { path: '/ai-providers', heading: 'AI 提供商', reads: ['/management/providers'], content: '.providers-page .ant-table-row' },
  { path: '/api-keys', heading: '密钥管理', reads: ['/management/api-keys'], content: '.keys-page .ant-table-row' },
  { path: '/oauth-management', heading: 'OAuth 管理', reads: ['/management/auth-files'], content: '[data-testid="oauth-credential-record"]' },
  { path: '/logs', heading: '日志', reads: ['/management/logs/status', '/management/logs'], content: '.logs-page .log-line' },
  { path: '/audit', heading: '操作审计', reads: ['/management/audit/events', '/management/audit/summary'], content: '[data-testid="audit-entry"]' },
  { path: '/usage/events', heading: '请求记录', reads: ['/usage/events'], content: '.request-list' },
  { path: '/pricing', heading: '费用与用量', reads: ['/pricing'], content: '[data-testid="pricing-model-list"]' },
  { path: '/config', heading: '配置面板', reads: ['/management/config'], content: '.config-workbench' },
  { path: '/omc-settings', heading: 'OMC 设置', reads: ['/preferences'], content: '.omc-settings-group' },
  { path: '/plugins', heading: '插件管理', reads: ['/management/plugins'], content: '[data-plugin-status]' },
  { path: '/plugins/store', heading: '插件管理', reads: ['/management/plugins', '/management/plugin-store'], content: '[data-plugin-panel="store"]' },
  { path: '/plugins/settings', heading: '插件管理', reads: ['/management/plugins', '/management/plugins/settings'], content: '[data-plugin-panel="settings"]' },
  { path: '/system', heading: '系统信息', reads: ['/management/system'], content: '[data-testid="sys-card-versions"]' },
];

/** Register before navigation so a fast local response cannot outrun its assertion. */
export function watchDemoReads(page, base, reads, timeout = 30_000) {
  const pending = new Set(['/api/auth/session', ...reads.map((path) => `/api/v1${path}`)]);
  const origin = new URL(base).origin;
  let timer;
  let finish;
  let fail;
  const ready = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const matches = (request) => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.origin === origin && pending.has(url.pathname);
  };
  const onFinished = async (request) => {
    if (!matches(request)) return;
    try {
      const response = await request.response();
      if (!response || !response.ok()) throw new Error(`required read failed: ${request.url()}`);
      pending.delete(new URL(request.url()).pathname);
      if (pending.size === 0) finish();
    } catch (error) { fail(error); }
  };
  const onFailed = (request) => {
    if (matches(request)) fail(new Error(`required read failed: ${request.url()}`));
  };
  const dispose = () => {
    clearTimeout(timer);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  };
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  timer = setTimeout(() => fail(new Error(`missing completed reads: ${[...pending].join(', ')}`)), timeout);
  return { ready: ready.finally(dispose), dispose };
}

/** Runs in Chromium: sidebar labels or a mounted loading shell are not page content. */
export function hasDemoContent(route) {
  const isVisible = (element) => Boolean(element && element.getClientRects().length > 0);
  const heading = [...document.querySelectorAll(route.headingSelector ?? 'h1.terminal-title')]
    .some((element) => isVisible(element) && (element.textContent.includes(route.heading) || element.getAttribute?.('aria-label') === route.heading));
  const content = document.querySelector(route.content);
  const isLoading = [...document.querySelectorAll('.ant-spin-spinning, .ant-skeleton, .request-loading, [aria-busy="true"]')]
    .some(isVisible);
  return heading && isVisible(content) && !isLoading
    && (!route.detail || content.textContent.includes(route.detail));
}
