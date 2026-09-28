import { until } from '../harness.mjs';

/**
 * Plugin management: the installed list, the store's cards and the plugin system settings,
 * on one page.
 *
 * What a browser establishes here is what the operator sees and can reach: a store card draws
 * the registry's own artwork and links, a third-party install cannot be confirmed without the
 * typed id, a plugin's declared fields are typed controls whose invalid values are refused
 * before anything is sent, and the settings save carries exactly the rules on screen.
 */

const LOGO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0F766E"/></svg>',
).toString('base64');

const PLUGINS = {
  plugins_enabled: true,
  plugins_dir: '/srv/cpa/plugins',
  total: 2,
  plugins: [
    {
      id: 'request-logger',
      path: '/srv/cpa/plugins/request-logger.so',
      configured: true,
      registered: true,
      enabled: true,
      effective_enabled: true,
      logo: LOGO,
      repository_url: 'https://github.com/router-for-me/request-logger',
      config_fields: [
        { name: 'level', type: 'enum', enum_values: ['debug', 'info', 'warn'], description: 'Minimum level written.' },
        { name: 'sample-rate', type: 'number', description: 'Share of requests logged.' },
        { name: 'redact-headers', type: 'array', description: 'Headers removed before logging.' },
        { name: 'include-body', type: 'boolean', description: 'Log request bodies.' },
      ],
      metadata: { name: 'Request Logger', version: '1.0.0', author: 'router-for-me', logo: LOGO },
    },
    {
      id: 'quota-notifier',
      configured: false,
      registered: false,
      enabled: true,
      effective_enabled: false,
      config_fields: [],
      metadata: { name: 'Quota Notifier', version: '0.2.0', author: 'community' },
    },
  ],
};

const STORE = {
  plugins_enabled: true,
  plugins_dir: '/srv/cpa/plugins',
  sources: [
    { id: 'official', name: 'official', url: 'https://registry.example/plugins.json', is_official: true },
    { id: 'source-mirror', name: 'mirror.example', url: 'https://mirror.example/registry.json', is_official: false },
  ],
  source_errors: [{ source_id: 'source-down', source_name: 'down.example', source_url: 'https://down.example/r.json', message: 'fetch registry: 503' }],
  total: 3,
  plugins: [
    {
      store_id: 'official/request-logger', source_id: 'official', source_name: 'official', id: 'request-logger', name: 'Request Logger',
      description: 'Logs request metadata.', author: 'router-for-me', version: '1.1.0', repository_url: 'https://github.com/router-for-me/request-logger',
      license: 'MIT', tags: ['logging'], logo: LOGO, platforms: ['linux/amd64'], is_official: true, auth_required: false, auth_configured: false,
      installed: true, installed_version: '1.0.0', install_source_status: 'matched', effective_enabled: true, update_available: true,
    },
    {
      store_id: 'official/rate-limiter', source_id: 'official', source_name: 'official', id: 'rate-limiter', name: 'Rate Limiter',
      description: 'Token buckets per caller key.', author: 'router-for-me', version: '2.0.0', repository_url: 'https://github.com/router-for-me/rate-limiter',
      homepage: 'https://limiter.example', license: 'Apache-2.0', tags: ['network', 'limits'], platforms: [], is_official: true,
      auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
    },
    {
      store_id: 'source-mirror/team-router', source_id: 'source-mirror', source_name: 'mirror.example', id: 'team-router', name: 'Team Router',
      description: 'Routes by team.', author: 'someone', version: '0.3.0', tags: [], platforms: [], is_official: false,
      auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
    },
  ],
};

const SETTINGS = {
  revision: 'rev-1',
  enabled: true,
  dir: 'plugins',
  store_sources: ['https://mirror.example/registry.json'],
  store_auth: [
    { match: 'https://mirror.example/', apply_to: ['registry', 'artifact'], type: 'bearer', token_env: 'MIRROR_TOKEN', allow_insecure: false },
  ],
};

/** The fixtures, with a log of the writes each scenario can assert against. */
export function pluginManagementFixtures(writes) {
  return [
    [(url) => url.pathname.endsWith('/management/plugins/settings'), (url, method, request) => {
      if (method === 'PUT') {
        const body = JSON.parse(request.postData() ?? '{}');
        writes.push({ kind: 'settings', body });
        return { ...SETTINGS, ...body, revision: 'rev-2' };
      }
      return SETTINGS;
    }],
    [(url) => /\/management\/plugins\/[^/]+\/config$/.test(url.pathname), (url, method, request) => {
      if (method === 'PUT') {
        writes.push({ kind: 'config', path: url.pathname, body: JSON.parse(request.postData() ?? '{}') });
        return { status: 'ok' };
      }
      return url.pathname.includes('request-logger')
        ? { id: 'request-logger', config: { enabled: true, level: 'info', 'sample-rate': 1, 'redact-headers': ['authorization'], legacy: 'kept' } }
        : { id: 'quota-notifier', config: {} };
    }],
    [(url) => /\/management\/plugin-store\/[^/]+\/install$/.test(url.pathname), (url, method, request) => {
      writes.push({ kind: 'install', path: url.pathname, body: JSON.parse(request.postData() ?? '{}') });
      return { status: 'ok', id: 'team-router', version: '0.3.0', plugins_enabled: true, restart_required: false };
    }],
    [(url) => url.pathname.endsWith('/management/plugin-store'), () => STORE],
    [(url) => url.pathname.endsWith('/management/plugins'), () => PLUGINS],
  ];
}

async function isTrue(probe, label) {
  return until(probe, { label }).then(() => true).catch(() => false);
}

export async function pluginManagement({ base, page, check, writes }) {
  // ── the old store address lands on the store tab ────────────────────────────
  await page.goto(`${base}/plugin-store`, { waitUntil: 'domcontentloaded' });
  const redirected = await isTrue(async () => new URL(page.url()).searchParams.get('tab') === 'store', 'the store redirect');
  check('the old plugin store address opens the store tab', redirected, page.url());

  // ── store cards ─────────────────────────────────────────────────────────────
  const cards = page.locator('[data-plugin-panel="store"] article[data-store-id]');
  const cardsShown = await isTrue(async () => (await cards.count()) === 3, 'the store cards');
  check('the store renders one card per registry entry', cardsShown, String(await cards.count()));
  if (!cardsShown) return;

  const limiter = page.locator('article[data-store-id="official/rate-limiter"]');
  const limiterText = await limiter.innerText();
  check('a card shows the author, the tags and the description', /router-for-me/.test(limiterText) && limiterText.includes('limits') && limiterText.includes('Token buckets'), limiterText);
  check(
    'a card links the GitHub repository and the homepage',
    (await limiter.locator('a[href="https://github.com/router-for-me/rate-limiter"]').count()) === 1
      && (await limiter.locator('a[href="https://limiter.example"]').count()) === 1,
  );
  const logger = page.locator('article[data-store-id="official/request-logger"]');
  const logoLoaded = await isTrue(async () => logger.locator('[data-plugin-logo="image"] img').evaluate((img) => img.complete && img.naturalWidth > 0), 'the card logo');
  check('a card draws the plugin icon the registry publishes', logoLoaded);
  check('a card without an icon draws the generic mark', (await limiter.locator('[data-plugin-logo="fallback"]').count()) === 1);
  check('an installed entry with a newer release offers the update', (await logger.getByRole('button', { name: /更新|Update/ }).count()) >= 1);
  check('the failing registry is named above the cards', (await page.getByText('down.example').count()) >= 1);

  await page.getByPlaceholder(/搜索名称|Search by name/).fill('limits');
  const searched = await isTrue(async () => (await cards.count()) === 1, 'the store search');
  check('the store search matches tags', searched, String(await cards.count()));
  await page.getByPlaceholder(/搜索名称|Search by name/).fill('');

  // ── a third-party install needs the typed id ────────────────────────────────
  const mirror = page.locator('article[data-store-id="source-mirror/team-router"]');
  await mirror.getByRole('button', { name: /安装|Install/ }).click();
  const dialog = page.locator('.ant-modal:visible');
  await dialog.waitFor({ timeout: 5000 });
  const confirm = dialog.locator('.ant-modal-footer .ant-btn-primary');
  check('a third-party install cannot be confirmed before the id is typed', await confirm.isDisabled());
  await dialog.getByPlaceholder('team-router').fill('team-router');
  check('typing the plugin id enables the install', !(await confirm.isDisabled()));
  await confirm.click();
  const installed = await isTrue(async () => writes.some((write) => write.kind === 'install'), 'the install request');
  const install = writes.find((write) => write.kind === 'install');
  check('the install names the registry the card came from', installed && install.body.source_id === 'source-mirror' && install.path.endsWith('/team-router/install'), JSON.stringify(install));

  // ── the installed list and a plugin's settings ──────────────────────────────
  // Switched in place rather than reloaded: the store read above is what supplies the
  // installed rows' descriptions, and a reload would start without it.
  await page.locator('.plugins-tabs .ant-segmented-item').first().click();
  const rows = page.locator('[data-plugin-panel="installed"] article[data-plugin-id]');
  await isTrue(async () => (await rows.count()) === 2, 'the installed rows');
  const waitingText = await page.locator('article[data-plugin-id="quota-notifier"]').innerText();
  check('an enabled plugin that is not running says so', /未运行|not running/.test(waitingText), waitingText);
  const describedText = await page.locator('article[data-plugin-id="request-logger"]').innerText();
  check('an installed row borrows the store description once the store was read', describedText.includes('Logs request metadata.'), describedText);
  check('an installed row names the release it can update to', /v1\.1\.0/.test(describedText), describedText);

  await page.locator('article[data-plugin-id="request-logger"]').getByRole('button', { name: /配置|Configure/ }).click();
  const drawer = page.locator('[data-plugin-config="request-logger"]');
  await drawer.waitFor({ timeout: 5000 });
  const rendered = await isTrue(async () => (await drawer.locator('[data-plugin-config-field]').count()) === 4, 'the declared fields');
  check('each declared field is its own control', rendered);
  check('an undeclared key is listed rather than dropped', (await drawer.getByText('legacy').count()) >= 1);

  const rateField = drawer.locator('[data-plugin-config-field="sample-rate"]');
  await rateField.locator('input').fill('lots');
  check('an invalid number is reported beside its field', await rateField.getByText(/请输入数字|Enter a number/).isVisible());
  await rateField.locator('input').fill('0.25');
  const bodyField = drawer.locator('[data-plugin-config-field="include-body"]');
  await bodyField.getByRole('button', { name: /设置|Set/ }).click();
  await bodyField.getByRole('switch').click();
  check('a changed field is marked', (await drawer.locator('[class*="config-field-changed"]').count()) >= 2);

  await page.locator('[data-plugin-config-save]').click();
  const saved = await isTrue(async () => writes.some((write) => write.kind === 'config'), 'the config save');
  const configWrite = writes.find((write) => write.kind === 'config');
  check(
    'saving writes typed values and keeps the undeclared key',
    saved
      && configWrite.body.config['sample-rate'] === 0.25
      && configWrite.body.config['include-body'] === true
      && configWrite.body.config.legacy === 'kept'
      && Array.isArray(configWrite.body.config['redact-headers']),
    JSON.stringify(configWrite),
  );

  // A second plugin's drawer starts from its own document, not from the first one's
  // draft; a plugin that declares no fields opens in the JSON view.
  await drawer.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
  await page.locator('article[data-plugin-id="quota-notifier"]').getByRole('button', { name: /配置|Configure/ }).click();
  const secondDrawer = page.locator('[data-plugin-config="quota-notifier"]');
  const secondOpened = await isTrue(async () => (await secondDrawer.locator('[data-plugin-config-source]').count()) === 1, 'the second plugin drawer');
  check('a plugin without declared fields opens its own document in the JSON view', secondOpened);
  await page.keyboard.press('Escape');

  // ── plugin system settings ──────────────────────────────────────────────────
  await page.goto(`${base}/plugins?tab=settings`, { waitUntil: 'domcontentloaded' });
  const settings = page.locator('[data-plugin-panel="settings"]');
  await settings.waitFor({ timeout: 10000 });
  check('the store auth rule is shown as a form, not YAML', (await settings.locator('[data-plugin-auth-rule]').count()) === 1
    && (await settings.locator('input[value="MIRROR_TOKEN"]').count()) === 1);
  await settings.getByRole('button', { name: /添加源|Add source/ }).click();
  await settings.getByLabel(/插件源 2|Source 2/).fill('not a url');
  await settings.getByRole('button', { name: /保存|Save/ }).click();
  check('an invalid source is refused before saving', await settings.getByText(/完整的 http|full http/).isVisible());
  check('a refused settings save is not sent', !writes.some((write) => write.kind === 'settings'));
  await settings.getByLabel(/插件源 2|Source 2/).fill('https://second.example/registry.json');
  await settings.getByRole('button', { name: /保存|Save/ }).click();
  const settingsSaved = await isTrue(async () => writes.some((write) => write.kind === 'settings'), 'the settings save');
  const settingsWrite = writes.find((write) => write.kind === 'settings');
  check(
    'the settings save carries the revision, the sources and the rule',
    settingsSaved
      && settingsWrite.body.revision === 'rev-1'
      && settingsWrite.body.store_sources.length === 2
      && settingsWrite.body.store_auth[0].token_env === 'MIRROR_TOKEN',
    JSON.stringify(settingsWrite),
  );
}

/** At a phone width no card, row or control may run off the right edge. */
export async function pluginManagementNarrow({ base, page, check }) {
  for (const tab of ['', '?tab=store', '?tab=settings']) {
    await page.goto(`${base}/plugins${tab}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-plugin-panel]').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const outside = [];
      for (const node of document.querySelectorAll('[data-plugin-panel] article, [data-plugin-panel] button, [data-plugin-panel] input, [data-plugin-panel] .ant-segmented')) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.right > width + 1) outside.push(`${node.tagName}.${node.className}`.slice(0, 80));
      }
      return { width, scroll: document.documentElement.scrollWidth, outside };
    });
    check(
      `the plugin page${tab || ' (installed)'} fits a phone`,
      overflow.outside.length === 0 && overflow.scroll <= overflow.width + 1,
      JSON.stringify(overflow),
    );
  }
}
