import { settleLayout, until } from '../harness.mjs';

/**
 * Plugin management: the installed list, the store's cards and the plugin system settings,
 * on one page, and the pages plugins register, in the navigation.
 *
 * What a browser establishes here is what the operator sees and can reach: a store card draws
 * the registry's own artwork and links, a third-party install cannot be confirmed without the
 * typed id, a plugin's declared fields are typed controls whose invalid values are refused
 * before anything is sent, and the settings save carries exactly the rules on screen. A
 * page a running plugin registered is a navigation entry that opens a frame on the console's
 * plugin host.
 */

const LOGO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 12l5 5L20 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
      supports_oauth: true,
      logo: LOGO,
      repository_url: 'https://github.com/router-for-me/request-logger',
      pages: [{ path: '/v0/resource/plugins/request-logger/console', label: 'Logger Console', description: 'Recent requests.' }],
      config_fields: [
        { name: 'level', type: 'enum', enum_values: ['debug', 'info', 'warn'], description: 'Minimum level written.' },
        { name: 'sample-rate', type: 'number', description: 'Share of requests logged.' },
        { name: 'redact-headers', type: 'array', description: 'Headers removed before logging.' },
        { name: 'include-body', type: 'boolean', description: 'Log request bodies.' },
        { name: 'upstream-token', type: 'string', description: 'Token for the log sink.' },
      ],
      metadata: { name: 'Request Logger', version: '1.0.0', author: 'router-for-me', logo: LOGO },
    },
    {
      id: 'quota-notifier',
      configured: false,
      registered: false,
      enabled: true,
      effective_enabled: false,
      // Listed by a plugin that is not running: it serves nothing, so it gets no entry.
      pages: [{ path: '/v0/resource/plugins/quota-notifier/ui', label: 'Notifier' }],
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
    { id: 'source-omc', name: 'Oh My CPA', url: 'https://raw.githubusercontent.com/WizisCool/oh-my-cpa/master/plugins/registry.json', is_official: false },
  ],
  source_errors: [{ source_id: 'source-down', source_name: 'down.example', source_url: 'https://down.example/r.json', message: 'fetch registry: 503' }],
  total: 4,
  plugins: [
    {
      store_id: 'source-omc/usage-digest', source_id: 'source-omc', source_name: 'Oh My CPA', id: 'usage-digest', name: 'Usage Digest',
      description: 'Posts a daily spend and request summary.', author: 'oh-my-cpa', version: '0.3.0', repository_url: 'https://github.com/WizisCool/omc-plugin-usage-digest',
      license: 'MIT', tags: ['digest'], platforms: [], is_official: false, is_omc: true,
      auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
    },
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
  omc_source_url: 'https://raw.githubusercontent.com/WizisCool/oh-my-cpa/master/plugins/registry.json',
  omc_source_enabled: true,
  store_auth: [
    { match: 'https://mirror.example/', apply_to: ['registry', 'artifact'], type: 'bearer', token_env: 'MIRROR_TOKEN', allow_insecure: false },
  ],
};

/** The fixtures, with a log of the writes each scenario can assert against. */
export function pluginManagementFixtures(writes) {
  const installedPlugins = structuredClone(PLUGINS);
  return [
    [(url) => url.pathname.endsWith('/plugin-host/v0/resource/plugins/request-logger/console'), () => ({ contentType: 'text/html', body: '<!doctype html><html><body>Probe plugin console</body></html>' })],
    [(url, method) => ['GET', 'PUT'].includes(method) && url.pathname.endsWith('/management/plugins/settings'), (url, method, request) => {
      if (method === 'PUT') {
        const body = JSON.parse(request.postData() ?? '{}');
        writes.push({ kind: 'settings', body });
        return { ...SETTINGS, ...body, revision: 'rev-2' };
      }
      return SETTINGS;
    }],
    [(url, method) => ['GET', 'PUT'].includes(method) && /\/management\/plugins\/[^/]+\/config$/.test(url.pathname), (url, method, request) => {
      if (method === 'PUT') {
        writes.push({ kind: 'config', path: url.pathname, body: JSON.parse(request.postData() ?? '{}') });
        return { status: 'ok' };
      }
      return url.pathname.includes('request-logger')
        ? { id: 'request-logger', config: { enabled: true, level: 'info', 'sample-rate': 1, 'redact-headers': ['authorization'], legacy: 'kept', store: { name: 'Request Logger', version: '1.0.0', author: 'router-for-me', description: 'Installed from the official registry.', repository: 'router-for-me/request-logger' } } }
        : { id: 'quota-notifier', config: {} };
    }],
    [(url, method) => method === 'POST' && /\/management\/plugin-store\/[^/]+\/install$/.test(url.pathname), (url, method, request) => {
      writes.push({ kind: 'install', path: url.pathname, body: JSON.parse(request.postData() ?? '{}') });
      return { status: 'ok', id: 'team-router', version: '0.3.0', plugins_enabled: true, restart_required: false };
    }],
    [(url) => url.pathname.endsWith('/management/plugin-store'), () => STORE],
    [(url, method) => method === 'DELETE' && /\/management\/plugins\/[^/]+$/.test(url.pathname), (url, method) => {
      if (method !== 'DELETE') throw new Error(`Unexpected plugin operation: ${method}`);
      const pluginId = decodeURIComponent(url.pathname.split('/').pop());
      writes.push({ kind: 'delete', path: url.pathname });
      installedPlugins.plugins = installedPlugins.plugins.filter((plugin) => plugin.id !== pluginId);
      installedPlugins.total = installedPlugins.plugins.length;
      return { status: 'ok', id: pluginId, file_deleted: true, configured_removed: true, restart_required: false };
    }],
    [(url) => url.pathname.endsWith('/management/plugins'), () => installedPlugins],
  ];
}

async function isTrue(probe, label) {
  return until(probe, { label }).then(() => true).catch(() => false);
}

export async function pluginManagement({ base, page, check, writes }) {
  // ── the old store addresses land on the store tab ───────────────────────────
  await page.goto(`${base}/plugin-store`, { waitUntil: 'domcontentloaded' });
  const redirected = await isTrue(async () => new URL(page.url()).pathname.endsWith('/plugins/store'), 'the store redirect');
  check('the old plugin store address opens the store tab', redirected, page.url());
  await page.goto(`${base}/plugins?tab=store`, { waitUntil: 'domcontentloaded' });
  const queryRedirected = await isTrue(async () => {
    const url = new URL(page.url());
    return url.pathname.endsWith('/plugins/store') && !url.searchParams.has('tab');
  }, 'the tab query redirect');
  check('a link that names the tab in its query opens the same tab', queryRedirected, page.url());

  // ── the navigation lists the store and the pages plugins registered ─────────
  const storeEntry = page.locator('.app-menu [data-route-path="/plugins/store"]').first();
  check('the store is a navigation entry of its own', await storeEntry.isVisible());
  const storeSelected = await isTrue(
    async () => /ant-menu-item-selected/.test((await storeEntry.getAttribute('class')) ?? ''),
    'the store navigation selection',
  );
  check('the store entry is the selected one on the store tab', storeSelected);
  const pageEntry = page.locator('.app-menu [data-route-path="/plugin-pages/request-logger/0"]').first();
  const pageListed = await isTrue(async () => pageEntry.isVisible(), 'the plugin page entry');
  check('a running plugin\'s page is a navigation entry under its registered label', pageListed && (await pageEntry.innerText()).includes('Logger Console'));
  check('a plugin that is not running gets no page entry', (await page.locator('.app-menu [data-route-path^="/plugin-pages/quota-notifier"]').count()) === 0);
  check('the page entry carries the plugin\'s own artwork', (await pageEntry.locator('.app-menu-plugin-logo[data-plugin-logo="svg"]').count()) === 1);

  await pageEntry.hover();
  const hoverFollowsText = await isTrue(async () => pageEntry.locator('[data-plugin-logo="svg"]').evaluate((glyph) =>
    getComputedStyle(glyph).backgroundColor === getComputedStyle(glyph.closest('li')).color,
  ), 'the hovered menu glyph colour');
  check('the SVG menu glyph inherits its hover text colour', hoverFollowsText);

  // ── store cards ─────────────────────────────────────────────────────────────
  const cards = page.locator('[data-plugin-panel="store"] article[data-store-id]');
  const cardsShown = await isTrue(async () => (await cards.count()) === 4, 'the store cards');
  check('the store renders one card per registry entry', cardsShown, String(await cards.count()));
  if (!cardsShown) return;

  const omc = page.locator('article[data-store-id="source-omc/usage-digest"]');
  check('the Oh My CPA registry is pinned above the other registries', (await cards.first().getAttribute('data-store-id')) === 'source-omc/usage-digest');
  const omcText = await omc.innerText();
  check('an Oh My CPA entry carries its own badge and source name', /Oh My CPA/.test(omcText) && !/Third-party|第三方/.test(omcText), omcText);

  const limiter = page.locator('article[data-store-id="official/rate-limiter"]');
  const limiterText = await limiter.innerText();
  check('a card shows the author, the tags and the description', /router-for-me/.test(limiterText) && limiterText.includes('limits') && limiterText.includes('Token buckets'), limiterText);
  check(
    'a card links the GitHub repository and the homepage',
    (await limiter.locator('a[href="https://github.com/router-for-me/rate-limiter"]').count()) === 1
      && (await limiter.locator('a[href="https://limiter.example"]').count()) === 1,
  );
  const logger = page.locator('article[data-store-id="official/request-logger"]');
  const cardGlyph = logger.locator('[data-plugin-logo="svg"]');
  const logoLoaded = await isTrue(async () => cardGlyph.evaluate(async (glyph) => {
    const source = getComputedStyle(glyph).maskImage.match(/^url\("(.*)"\)$/)?.[1];
    if (!source) return false;
    const image = new Image();
    image.src = source;
    await image.decode();
    return image.naturalWidth > 0;
  }), 'the card logo');
  check('a card draws the plugin icon the registry publishes', logoLoaded);
  const cardInk = await cardGlyph.evaluate((glyph) => {
    const style = getComputedStyle(glyph);
    return { mask: style.maskImage, ink: style.backgroundColor, text: getComputedStyle(glyph.closest('article')).color };
  });
  check('the SVG card mark uses the registry artwork as an alpha mask in the card text colour',
    cardInk.mask.includes(LOGO) && cardInk.ink === cardInk.text, JSON.stringify(cardInk));
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

  const loggerRow = page.locator('article[data-plugin-id="request-logger"]');
  check('the auth-provider capability does not claim an OAuth login method',
    (await loggerRow.getByText('Auth provider', { exact: true }).count()) === 1
      && (await loggerRow.getByText('OAuth', { exact: true }).count()) === 0);
  const configureButton = loggerRow.getByRole('button', { name: /配置|Configure/ });
  const moreButton = loggerRow.getByRole('button', { name: /更多|More/ });
  const actions = await loggerRow.locator('.row-actions button').evaluateAll((buttons) => buttons.map((button) => {
    const bounds = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return { width: bounds.width, height: bounds.height, top: bounds.top, background: style.backgroundColor, border: style.borderColor, color: style.color };
  }));
  check('configuration and overflow use two aligned, matching 28px row controls', actions.length === 2
    && actions.every((action) => action.width === 28 && action.height === 28)
    && actions[0].top === actions[1].top
    && actions[0].background === actions[1].background
    && actions[0].border === actions[1].border
    && actions[0].color === actions[1].color, JSON.stringify(actions));
  check('removal and external links do not crowd the installed row',
    (await loggerRow.getByRole('button', { name: /卸载|Uninstall/ }).count()) === 0
      && (await loggerRow.locator('a[target="_blank"]').count()) === 0);
  await moreButton.click();
  const menu = page.locator('.ant-dropdown:visible');
  await menu.waitFor();
  check('the overflow keeps the safe repository link reachable',
    (await menu.locator('a[href="https://github.com/router-for-me/request-logger"][target="_blank"][rel="noreferrer noopener"]').count()) === 1);
  await menu.getByRole('menuitem', { name: /卸载|Uninstall/ }).click();
  const removal = page.locator('.ant-popconfirm:visible');
  await removal.waitFor();
  check('choosing removal opens a named confirmation without deleting',
    (await removal.innerText()).includes('Request Logger') && !writes.some((write) => write.kind === 'delete'));
  await removal.getByRole('button', { name: /取消|Cancel/ }).click();
  await removal.waitFor({ state: 'hidden' });
  check('cancelling removal returns keyboard focus to the row action',
    await moreButton.evaluate((button) => document.activeElement === button));
  check('cancelling removal keeps the plugin and sends no delete', await loggerRow.isVisible()
    && !writes.some((write) => write.kind === 'delete'));
  await moreButton.click();
  await menu.getByRole('menuitem', { name: /卸载|Uninstall/ }).click();
  await removal.waitFor();
  await page.keyboard.press('Escape');
  await removal.waitFor({ state: 'hidden' });
  check('Escape returns keyboard focus to the row action',
    await moreButton.evaluate((button) => document.activeElement === button));
  check('Escape dismisses the removal confirmation without deleting',
    await isTrue(async () => !(await removal.isVisible()), 'dismissed removal')
      && !writes.some((write) => write.kind === 'delete'));

  await configureButton.click();
  const drawer = page.locator('[data-plugin-config="request-logger"]');
  await drawer.waitFor({ timeout: 5000 });
  const rendered = await isTrue(async () => (await drawer.locator('[data-plugin-config-field]').count()) === 5, 'the declared fields');
  check('each declared field is its own control', rendered);
  const tokenField = drawer.locator('[data-plugin-config-field="upstream-token"]');
  check('a field left out of the document is editable at once and says the default applies',
    (await tokenField.locator('input').isEditable()) && (await tokenField.locator('[data-plugin-config-default]').count()) === 1);
  await tokenField.locator('input').fill('sink-token-value');
  const isMasked = await tokenField.locator('input').evaluate((input) => input.type === 'password' || getComputedStyle(input).webkitTextSecurity === 'disc');
  check('a field named like a credential is masked', isMasked);
  check('typing into a field sets it', (await tokenField.locator('[data-plugin-config-default]').count()) === 0);
  await tokenField.locator('input').fill('');
  check('emptying a field returns it to the plugin default', (await tokenField.locator('[data-plugin-config-default]').count()) === 1);
  check('an undeclared key is listed rather than dropped', (await drawer.getByText('legacy').count()) >= 1);
  const record = drawer.locator('[data-plugin-install-record]');
  check('the install record reads as where the plugin came from, not as a raw key',
    (await record.innerText()).includes('Installed from the official registry.')
      && (await record.locator('a[href="https://github.com/router-for-me/request-logger"]').count()) === 1
      && (await drawer.locator('[class*="extra-key"]').getByText('store', { exact: true }).count()) === 0);
  check('the drawer offers the plugin\'s own page', (await drawer.locator('[data-plugin-config-pages] button').count()) === 1);

  const rateField = drawer.locator('[data-plugin-config-field="sample-rate"]');
  await rateField.locator('input').fill('lots');
  check('an invalid number is reported beside its field', await rateField.getByText(/请输入数字|Enter a number/).isVisible());
  await rateField.locator('input').fill('0.25');
  const bodyField = drawer.locator('[data-plugin-config-field="include-body"]');
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
      && configWrite.body.config.store?.version === '1.0.0'
      && !('upstream-token' in configWrite.body.config)
      && Array.isArray(configWrite.body.config['redact-headers']),
    JSON.stringify(configWrite),
  );

  // A second plugin's drawer starts from its own document, not from the first one's
  // draft; a plugin that declares no fields still opens on the form, with the host's
  // settings, and its document is one switch away.
  await drawer.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
  await page.locator('article[data-plugin-id="quota-notifier"]').getByRole('button', { name: /配置|Configure/ }).click();
  const secondDrawer = page.locator('[data-plugin-config="quota-notifier"]');
  const secondOpened = await isTrue(async () => secondDrawer.getByRole('switch', { name: 'enabled' }).isVisible(), 'the second plugin drawer');
  check('a plugin without declared fields opens on the form with the host settings', secondOpened && (await secondDrawer.locator('[data-plugin-config-source]').count()) === 0);
  await secondDrawer.locator('.ant-segmented-item').last().click();
  const sourceShown = await isTrue(async () => (await secondDrawer.locator('[data-plugin-config-source]').inputValue()) === '{}', 'the second plugin document');
  check('its JSON view is its own document', sourceShown);
  const sourceBox = await secondDrawer.locator('[data-plugin-config-source]').boundingBox();
  check('the JSON document takes the drawer height', Boolean(sourceBox) && sourceBox.height > page.viewportSize().height * 0.45, JSON.stringify(sourceBox));
  await page.keyboard.press('Escape');

  // ── a plugin's own page ─────────────────────────────────────────────────────
  await page.locator('.app-menu [data-route-path="/plugin-pages/request-logger/0"]').first().click();
  const hosted = page.locator('[data-plugin-page="request-logger"]');
  const hostedShown = await isTrue(async () => hosted.isVisible(), 'the plugin page');
  check('the navigation entry opens the plugin page route', hostedShown && new URL(page.url()).pathname.endsWith('/plugin-pages/request-logger/0'), page.url());
  if (hostedShown) {
    const inner = page.frameLocator('[data-plugin-page-frame]').locator('iframe');
    const source = await inner.getAttribute('src');
    check('the frame reads the page through the console\'s plugin host', /\/api\/v1\/plugin-host\/v0\/resource\/plugins\/request-logger\/console$/.test(source ?? ''), source);
    check('the frame sends no referrer', (await inner.getAttribute('referrerpolicy')) === 'no-referrer');
    const frameTheme = await page.frameLocator('[data-plugin-page-frame]').locator('html').getAttribute('data-theme');
    check('the frame\'s parent states the colour mode as dark or light', frameTheme === 'dark' || frameTheme === 'light', frameTheme);
    // A frame whose colour scheme differs from the console's is painted on an opaque
    // white canvas, which is the flash an operator sees on opening the page.
    const schemes = await page.evaluate(() => {
      const frame = document.querySelector('[data-plugin-page-frame]');
      return {
        console: getComputedStyle(document.documentElement).colorScheme,
        shell: frame.contentWindow.getComputedStyle(frame.contentDocument.documentElement).colorScheme,
      };
    });
    check('the frame declares the console\'s colour scheme', schemes.shell === frameTheme && schemes.console.includes(frameTheme), JSON.stringify(schemes));
    const revealed = await isTrue(async () => page.locator('[data-plugin-page-frame]').evaluate((frame) => getComputedStyle(frame).visibility === 'visible'), 'the loaded frame');
    check('the frame is shown once its document has loaded', revealed);
    const bar = await hosted.locator('> div').first().boundingBox();
    check('the heading above the frame is one compact row', Boolean(bar) && bar.height <= 56, JSON.stringify(bar));
    const box = await page.locator('[data-plugin-page-frame]').boundingBox();
    const viewport = page.viewportSize();
    check('the frame fills the content area below its heading', Boolean(box) && box.height > viewport.height * 0.6, JSON.stringify(box));
    const pageSelected = await isTrue(
      async () => /ant-menu-item-selected/.test((await page.locator('.app-menu [data-route-path="/plugin-pages/request-logger/0"]').first().getAttribute('class')) ?? ''),
      'the plugin page navigation selection',
    );
    check('the plugin page is the selected navigation entry', pageSelected);
    const selectedEntry = page.locator('.app-menu [data-route-path="/plugin-pages/request-logger/0"]').first();
    const readInk = () => selectedEntry.locator('[data-plugin-logo="svg"]').evaluate((glyph) => {
      const style = getComputedStyle(glyph);
      return { ink: style.backgroundColor, text: getComputedStyle(glyph.closest('li')).color, mask: style.maskImage };
    });
    const readSettledInk = async (label) => {
      let ink;
      // Menu icons transition their ink independently of the entry's theme token.
      await until(async () => {
        ink = await readInk();
        return ink.ink === ink.text;
      }, { label });
      return ink;
    };
    await page.getByRole('button', { name: /^Theme: Light$/ }).click();
    await isTrue(async () => (await page.locator('html').getAttribute('data-theme-mode')) === 'dark', 'the dark theme');
    await settleLayout(page);
    const darkInk = await readSettledInk('the dark menu glyph colour');
    check('the selected SVG menu glyph follows the entry text colour', darkInk.ink === darkInk.text && darkInk.mask.includes(LOGO), JSON.stringify(darkInk));
    const headingGlyph = hosted.locator('[data-plugin-logo="svg"]');
    const headingInk = await headingGlyph.evaluate((glyph) => {
      const frame = glyph.parentElement;
      return { ink: getComputedStyle(glyph).backgroundColor, title: getComputedStyle(frame.parentElement.nextElementSibling.firstElementChild).color, border: getComputedStyle(frame).borderColor, background: getComputedStyle(frame).backgroundColor };
    });
    check('the hosted SVG heading mark is unframed and inherits the heading colour',
      headingInk.ink === headingInk.title && headingInk.border === 'rgba(0, 0, 0, 0)' && headingInk.background === 'rgba(0, 0, 0, 0)', JSON.stringify(headingInk));
    await page.screenshot({ path: 'tmp/plugin-svg-logos/dark.png' });
    // Follow the operating-system preference, which exercises the real theme provider.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: /^Theme: Dark$/ }).click();
    const lightMode = await isTrue(async () => (await page.locator('html').getAttribute('data-theme-mode')) === 'light', 'the light theme');
    await settleLayout(page);
    const lightInk = await readSettledInk('the light menu glyph colour');
    check('the SVG menu glyph changes ink with the light theme', lightMode && lightInk.ink === lightInk.text && lightInk.ink !== darkInk.ink, JSON.stringify({ darkInk, lightInk }));
    await page.screenshot({ path: 'tmp/plugin-svg-logos/light.png' });
    await page.getByRole('button', { name: /^Theme: Follow system$/ }).click();
  }
  await page.goto(`${base}/plugin-pages/quota-notifier/0`, { waitUntil: 'domcontentloaded' });
  check('a page of a plugin that is not running is reported as unavailable', await isTrue(async () => page.locator('[data-plugin-page-unavailable]').isVisible(), 'the unavailable notice'));

  // ── the plugin page in the rail-visibility panel ────────────────────────────
  // The panel draws the same nav-model element outside the rail; artwork must stay glyph-sized.
  await page.goto(`${base}/omc-settings`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /管理入口|Manage entries/ }).click();
  const panelLogo = page.locator('[data-testid="sidebar-nav-dialog"] .app-menu-plugin-logo');
  const panelLogoShown = await isTrue(async () => panelLogo.isVisible(), 'the plugin logo in the sidebar panel');
  const panelLogoBox = panelLogoShown ? await panelLogo.boundingBox() : null;
  check('the plugin page\'s logo in the sidebar panel is drawn at the rail glyph size',
    Boolean(panelLogoBox) && panelLogoBox.width <= 16 && panelLogoBox.height <= 16, JSON.stringify(panelLogoBox));
  await page.keyboard.press('Escape');

  // ── plugin system settings ──────────────────────────────────────────────────
  await page.goto(`${base}/plugins/settings`, { waitUntil: 'domcontentloaded' });
  const settings = page.locator('[data-plugin-panel="settings"]');
  await settings.waitFor({ timeout: 10000 });
  const omcRow = settings.locator('[data-plugin-omc-source]');
  check('the managed Oh My CPA source is a fixed row rather than an editable source',
    (await omcRow.count()) === 1 && (await omcRow.locator('input').count()) === 0
      && (await omcRow.innerText()).includes('Oh My CPA'));
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

  await page.goto(`${base}/plugins`, { waitUntil: 'domcontentloaded' });
  const removable = page.locator('article[data-plugin-id="quota-notifier"]');
  await removable.getByRole('button', { name: /更多|More/ }).click();
  await page.locator('.ant-dropdown:visible').getByRole('menuitem', { name: /卸载|Uninstall/ }).click();
  const confirmedRemoval = page.locator('.ant-popconfirm:visible');
  await confirmedRemoval.getByRole('button', { name: /卸载|Uninstall/ }).click();
  const removed = await isTrue(async () => writes.some((write) => write.kind === 'delete'), 'the confirmed removal');
  check('confirmed removal deletes only the chosen plugin', removed
    && writes.filter((write) => write.kind === 'delete').length === 1
    && writes.find((write) => write.kind === 'delete').path.endsWith('/plugins/quota-notifier'), JSON.stringify(writes.filter((write) => write.kind === 'delete')));
  check('the removed plugin disappears while other plugins remain',
    await isTrue(async () => (await removable.count()) === 0, 'the refreshed plugin rows')
      && (await page.locator('article[data-plugin-id="request-logger"]').count()) === 1);
}

/** At a phone width no card, row or control may run off the right edge. */
export async function pluginManagementNarrow({ base, page, check }) {
  for (const tab of ['', '/store', '/settings']) {
    await page.goto(`${base}/plugins${tab}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-plugin-panel]').first().waitFor({ timeout: 20_000 });
    await settleLayout(page);
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

  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(`${base}/plugins`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('article[data-plugin-id="request-logger"]');
  const more = row.getByRole('button', { name: /更多|More/ });
  await more.waitFor();
  await settleLayout(page);
  check('the installed action group fits a 320px viewport', await row.evaluate((article) =>
    [...article.querySelectorAll('button')].every((button) => button.getBoundingClientRect().right <= document.documentElement.clientWidth)));
  await more.click();
  const menu = page.locator('.ant-dropdown:visible');
  await menu.waitFor();
  await settleLayout(page);
  check('the overflow menu fits a 320px viewport', await menu.evaluate((popup) => {
    const bounds = popup.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth;
  }));
  await menu.getByRole('menuitem', { name: /卸载|Uninstall/ }).click();
  const removal = page.locator('.ant-popconfirm:visible');
  await removal.waitFor();
  await settleLayout(page);
  check('the removal confirmation fits a 320px viewport', await removal.evaluate((popup) => {
    const bounds = popup.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth;
  }));
  await removal.getByRole('button', { name: /取消|Cancel/ }).click();

}
