import { settleLayout, until } from '../harness.mjs';

/**
 * Plugin management: the installed list, Oh My CPA's built-in plugins, the store's cards and
 * the plugin system settings, on one page, and the pages plugins register, in the navigation.
 *
 * What a browser establishes here is what the operator sees and can reach: a store card draws
 * the registry's own artwork and links, an install of anything but the vendor's own code cannot
 * be confirmed without the typed id, a plugin's declared fields are typed controls whose invalid
 * values are refused before anything is sent, and the settings save carries exactly the rules on
 * screen. A page a running plugin registered is a navigation entry that opens a frame on the
 * console's plugin host.
 */

const LOGO = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#2a78d6"/><path d="M4 12l5 5L20 6" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
).toString('base64');

const PLUGINS = {
  plugins_enabled: true,
  plugins_dir: '/srv/cpa/plugins',
  total: 2,
  plugins: [
    {
      id: 'request-logger',
      path: '/srv/cpa/plugins/request-logger.so',
      source_kind: 'official',
      source_id: 'official',
      installed_version: '1.0.0',
      description: 'Logs request metadata.',
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
      source_kind: 'unknown',
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

const STORE_SOURCES = [
  { id: 'official', name: 'official', url: 'https://registry.example/plugins.json', is_official: true, source_kind: 'official' },
  { id: 'source-builtin', name: 'Oh My CPA', url: 'https://omc.example/builtin/registry.json', is_official: false, source_kind: 'builtin' },
  { id: 'source-omc-community', name: 'Oh My CPA', url: 'https://omc.example/community/registry.json', is_official: false, source_kind: 'omc_community' },
  { id: 'source-mirror', name: 'mirror.example', url: 'https://mirror.example/registry.json', is_official: false, source_kind: 'community' },
  { id: 'source-down', name: 'down.example', url: 'https://down.example/r.json', is_official: false, source_kind: 'community' },
];

const STORE_PLUGINS = [
  {
    store_id: 'official/request-logger', source_id: 'official', source_name: 'official', source_kind: 'official', id: 'request-logger', name: 'Request Logger',
    description: 'Logs request metadata.', author: 'router-for-me', version: '1.1.0', repository_url: 'https://github.com/router-for-me/request-logger',
    license: 'MIT', tags: ['logging'], logo: LOGO, platforms: ['linux/amd64'], is_official: true, is_official_repository: true, auth_required: false, auth_configured: false,
    installed: true, installed_version: '1.0.0', install_source_status: 'matched', effective_enabled: true, update_available: true,
  },
  {
    store_id: 'official/rate-limiter', source_id: 'official', source_name: 'official', source_kind: 'official', id: 'rate-limiter', name: 'Rate Limiter',
    description: 'Token buckets per caller key.', author: 'router-for-me', version: '2.0.0', repository_url: 'https://github.com/router-for-me/rate-limiter',
    homepage: 'https://limiter.example', license: 'Apache-2.0', tags: ['network', 'limits'], platforms: [], is_official: true, is_official_repository: true,
    auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
  },
  {
    // Listed by the official registry, published in the author's own repository.
    store_id: 'official/deepseek-search', source_id: 'official', source_name: 'official', source_kind: 'official', id: 'deepseek-search', name: 'DeepSeek Search',
    description: 'Adds DeepSeek-powered web search.', author: 'karuboniru', version: '0.1.0', repository_url: 'https://github.com/karuboniru/deepseek-search',
    license: 'MIT', tags: ['search'], platforms: [], is_official: true, is_official_repository: false,
    auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
  },
  {
    store_id: 'source-mirror/team-router', source_id: 'source-mirror', source_name: 'mirror.example', source_kind: 'community', id: 'team-router', name: 'Team Router',
    description: 'Routes by team.', author: 'someone', version: '0.3.0', tags: [], platforms: [], is_official: false, is_official_repository: false, is_omc: false,
    auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
  },
  {
    // A community author's plugin tagged as adapted for Oh My CPA: recommended, still third-party.
    store_id: 'source-mirror/codex-candy', source_id: 'source-mirror', source_name: 'mirror.example', source_kind: 'community', id: 'codex-candy', name: 'Codex Candy',
    description: 'Evaluates Codex candy.', description_i18n: { en: 'Scores Codex sessions.', zh: '为 Codex 会话评分。' }, author: 'someone',
    version: '1.0.0', tags: ['OMC'], platforms: [], is_official: false, is_official_repository: false, is_omc: false,
    auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
  },
];

/** One registry per read, as the server answers it: a source that cannot be read reports itself. */
function storeOf(sourceId) {
  const source = STORE_SOURCES.find((candidate) => candidate.id === (sourceId || 'official'));
  const plugins = STORE_PLUGINS.filter((plugin) => plugin.source_id === source.id);
  const errors = source.id === 'source-down'
    ? [{ source_id: source.id, source_name: source.name, source_url: source.url, message: 'fetch registry: 503' }]
    : [];
  return { plugins_enabled: true, plugins_dir: '/srv/cpa/plugins', sources: STORE_SOURCES, source_errors: errors, plugins, total: plugins.length };
}

const OMC_COMMUNITY = {
  plugins_enabled: true,
  plugins_dir: '/srv/cpa/plugins',
  source_enabled: true,
  source_id: 'source-omc-community',
  sources: [STORE_SOURCES[2]],
  source_errors: [],
  total: 1,
  plugins: [{
    store_id: 'source-omc-community/usage-digest', source_id: 'source-omc-community', source_name: 'Oh My CPA', source_kind: 'omc_community', id: 'usage-digest', name: 'Usage Digest',
    description: 'Posts a daily spend and request summary.', author: 'someone', version: '0.3.0', tags: ['digest'], platforms: [],
    is_official: false, is_official_repository: false, is_omc: true, auth_required: false, auth_configured: false, installed: false, effective_enabled: false, update_available: false,
  }],
};

const BUILTINS = {
  policy: { enabled: true, revision: 3 },
  catalog: { status: 'ready', revision: 'catalog-7' },
  plugins: [{
    id: 'omc-zcode-oauth', name: 'ZCode OAuth', description: 'ZCode OAuth provider', description_i18n: { en: 'Signs in to ZCode.', zh: '登录 ZCode。' },
    version: '0.2.0', source_id: 'source-builtin', source_kind: 'builtin', policy: { enabled: true },
    status: 'running', installed_version: '0.2.0', runtime_version: '0.2.0', registered: true, effective_enabled: true, reason: '',
  }],
  last_reconcile_at: '',
};

const SETTINGS = {
  revision: 'rev-1',
  enabled: true,
  dir: 'plugins',
  store_sources: ['https://mirror.example/registry.json'],
  omc_source_url: 'https://raw.githubusercontent.com/WizisCool/oh-my-cpa/main/plugins/registry.json',
  omc_source_enabled: true,
  store_auth: [
    { match: 'https://mirror.example/', apply_to: ['registry', 'artifact'], type: 'bearer', token_env: 'MIRROR_TOKEN', allow_insecure: false },
  ],
};

/** The fixtures, with a log of the writes each scenario can assert against. */
export function pluginManagementFixtures(writes) {
  const installedPlugins = structuredClone(PLUGINS);
  let builtins = structuredClone(BUILTINS);
  return [
    [(url, method) => method === 'PUT' && url.pathname.endsWith('/management/builtin-plugins/policy'), (url, method, request) => {
      const body = JSON.parse(request.postData() ?? '{}');
      writes.push({ kind: 'builtin-policy', body });
      // Switching on starts a run, which the fixture completes at once and stamps as the worker does.
      builtins = {
        ...builtins,
        policy: { enabled: body.enabled, revision: body.revision + 1 },
        plugins: builtins.plugins.map((plugin) => ({ ...plugin, status: body.enabled ? 'running' : 'blocked', reason: body.enabled ? '' : 'automation_disabled' })),
        last_reconcile_at: body.enabled ? `2026-10-31T10:0${body.revision}:00Z` : builtins.last_reconcile_at,
      };
      return builtins;
    }],
    [(url, method) => method === 'PUT' && /\/management\/builtin-plugins\/[^/]+\/policy$/.test(url.pathname), (url, method, request) => {
      const body = JSON.parse(request.postData() ?? '{}');
      writes.push({ kind: 'builtin-plugin-policy', body });
      builtins = {
        ...builtins,
        policy: { ...builtins.policy, revision: body.revision + 1 },
        plugins: builtins.plugins.map((plugin) => plugin.id === 'omc-zcode-oauth'
          ? { ...plugin, policy: { enabled: body.enabled }, status: body.enabled ? 'running' : 'disabled', reason: '' }
          : plugin),
        last_reconcile_at: body.enabled ? `2026-10-31T11:0${body.revision}:00Z` : builtins.last_reconcile_at,
      };
      return builtins;
    }],
    [(url) => url.pathname.endsWith('/management/builtin-plugins'), () => builtins],
    [(url) => url.pathname.endsWith('/management/omc-community-plugins'), () => OMC_COMMUNITY],
    [(url) => url.pathname.endsWith('/plugin-host/v0/resource/plugins/request-logger/console'), () => ({ contentType: 'text/html', body: `<!doctype html><html data-theme="plugin-owned"><body>
      <h1>Probe plugin console</h1><input aria-label="Plugin draft"><output id="plugin-theme"></output>
      <div style="height:1600px"></div>
      <script>
        const host = window.parent.document.documentElement;
        const syncTheme = () => { document.querySelector('#plugin-theme').textContent = host.dataset.theme; };
        new MutationObserver(syncTheme).observe(host, { attributes: true, attributeFilter: ['data-theme'] });
        syncTheme();
      </script>
    </body></html>` })],
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
    [(url) => url.pathname.endsWith('/management/plugin-store'), (url) => storeOf(url.searchParams.get('source_id'))],
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
  const menuMark = pageEntry.locator('.app-menu-plugin-logo[data-plugin-logo="svg"] img');
  check('the page entry carries the plugin\'s own artwork', (await menuMark.count()) === 1 && (await menuMark.getAttribute('src')) === LOGO);

  // ── store cards: CPA's official registry and the OMC registry, side by side ──
  const cards = page.locator('[data-plugin-panel="store"] article[data-store-id]');
  const cardsShown = await isTrue(async () => (await cards.count()) === 4, 'the store cards');
  check('the store opens on CPA\'s official registry and the OMC registry together', cardsShown
    && (await page.locator('[data-store-source="official"] article').count()) === 3
    && (await page.locator('[data-store-source="omc"] article').count()) === 1, String(await cards.count()));
  if (!cardsShown) return;
  const sourceSelect = page.getByRole('combobox', { name: /插件源|Plugin source/ });
  await sourceSelect.click();
  const sourceOptions = await page.locator('.ant-select-dropdown:visible .ant-select-item-option').allInnerTexts();
  check('the source filter offers both registries together, each alone, and the operator\'s own; never the built-in catalog',
    sourceOptions.length === 5 && !sourceOptions.includes('Oh My CPA') && sourceOptions.includes('mirror.example'), JSON.stringify(sourceOptions));
  await page.keyboard.press('Escape');

  // ── the OMC registry: hosted by Oh My CPA, installed as third-party code ─────
  const omcCard = page.locator('[data-store-source="omc"] article[data-store-id="source-omc-community/usage-digest"]');
  const omcCardText = await omcCard.innerText();
  check('an OMC registry entry is marked as such, not as a built-in',
    (await omcCard.getAttribute('data-store-origin')) === 'omc-community'
      && /OMC 插件源|OMC registry/.test(omcCardText) && !/内置插件|Built-in/.test(omcCardText), omcCardText);
  await omcCard.getByRole('button', { name: /安装|Install/ }).click();
  const omcInstall = page.locator('.ant-modal:visible');
  await omcInstall.waitFor({ timeout: 5000 });
  check('an OMC registry install needs its id typed', await omcInstall.locator('.ant-modal-footer .ant-btn-primary').isDisabled());
  await omcInstall.getByRole('button', { name: /取消|Cancel/ }).click();

  const limiter = page.locator('article[data-store-id="official/rate-limiter"]');
  const limiterText = await limiter.innerText();
  check('a card shows the author, the tags and the description', /router-for-me/.test(limiterText) && limiterText.includes('limits') && limiterText.includes('Token buckets'), limiterText);
  check(
    'a card links the GitHub repository and the homepage',
    (await limiter.locator('a[href="https://github.com/router-for-me/rate-limiter"]').count()) === 1
      && (await limiter.locator('a[href="https://limiter.example"]').count()) === 1,
  );
  const logger = page.locator('article[data-store-id="official/request-logger"]');
  const cardArtwork = logger.locator('[data-plugin-logo="svg"] img');
  const logoLoaded = await isTrue(async () => (await cardArtwork.getAttribute('src')) === LOGO && await cardArtwork.evaluate(async (image) => {
    await image.decode();
    return image.naturalWidth > 0;
  }), 'the card logo');
  check('a card draws the plugin icon the registry publishes', logoLoaded);
  const cardMark = await logger.locator('[data-plugin-logo="svg"]').evaluate((mark) => ({
    mask: getComputedStyle(mark).maskImage,
    isPainted: getComputedStyle(mark).backgroundColor !== 'rgba(0, 0, 0, 0)',
  }));
  check('the card mark shows the artwork as drawn instead of repainting it in the card colour',
    cardMark.mask === 'none' && !cardMark.isPainted, JSON.stringify(cardMark));
  check('a card without an icon draws the generic mark', (await limiter.locator('[data-plugin-logo="fallback"]').count()) === 1);
  check('an installed entry with a newer release offers the update', (await logger.getByRole('button', { name: /更新|Update/ }).count()) >= 1);

  // ── the official registry's community entry ─────────────────────────────────
  const communityCard = page.locator('article[data-store-id="official/deepseek-search"]');
  const communityOrigin = await communityCard.getAttribute('data-store-origin');
  const communityBadges = await communityCard.locator('[class*="badge"]').first().innerText();
  check(
    'a community repository listed by the official registry is marked as the official source, not as a third-party one',
    communityOrigin === 'official-source' && /官方源|Official source/.test(communityBadges) && !/第三方|Third-party/.test(communityBadges),
    `${communityOrigin}: ${communityBadges}`,
  );
  await communityCard.getByRole('button', { name: /安装|Install/ }).click();
  const communityDialog = page.locator('.ant-modal:visible');
  await communityDialog.waitFor({ timeout: 5000 });
  check('an official-registry community install still needs its id typed', await communityDialog.locator('.ant-modal-footer .ant-btn-primary').isDisabled());
  await communityDialog.getByRole('button', { name: /取消|Cancel/ }).click();

  await page.getByPlaceholder(/搜索名称|Search by name/).fill('limits');
  const searched = await isTrue(async () => (await cards.count()) === 1, 'the store search');
  check('the store search matches tags', searched, String(await cards.count()));
  await page.getByPlaceholder(/搜索名称|Search by name/).fill('');

  // ── a registry that cannot be read says so, and another one can still be chosen ──
  await page.goto(`${base}/plugins/store?source=source-down`, { waitUntil: 'domcontentloaded' });
  const downNamed = await isTrue(async () => (await page.getByText('down.example').count()) >= 1, 'the failing registry notice');
  check('the failing registry is named in place of its cards', downNamed && (await cards.count()) === 0);
  await page.getByRole('combobox', { name: /插件源|Plugin source/ }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: 'mirror.example' }).click();
  const mirrorRead = await isTrue(async () => new URL(page.url()).searchParams.get('source') === 'source-mirror' && (await cards.count()) === 2, 'the mirror registry');
  check('choosing another registry reads that one', mirrorRead, page.url());

  // ── an entry adapted for Oh My CPA leads, still as third-party code ──────────
  const recommended = page.locator('[data-store-source="source-mirror"] article').first();
  check('an entry tagged for Oh My CPA leads its registry', (await recommended.getAttribute('data-store-id')) === 'source-mirror/codex-candy');
  const candyText = await recommended.innerText();
  check('the recommended entry shows its declared description in the reading language', /Scores Codex sessions\.|为 Codex 会话评分。/.test(candyText), candyText);
  check('a recommendation does not make the entry first-party', (await recommended.getAttribute('data-store-origin')) === 'third-party');

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
  // Switched in place rather than reloaded: the official registry's read is what tells an
  // installed row about a newer release, and a reload would start without it.
  await page.getByRole('combobox', { name: /插件源|Plugin source/ }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await isTrue(async () => (await cards.count()) === 4, 'both default registries again');
  const installedEntry = page.locator('.app-menu [data-route-path="/plugins"]').first();
  await installedEntry.click();
  const installedSelected = await isTrue(
    async () => new URL(page.url()).pathname.endsWith('/plugins') && /ant-menu-item-selected/.test((await installedEntry.getAttribute('class')) ?? ''),
    'the plugin management entry',
  );
  check('the installed list is plugin management, a navigation entry of its own', installedSelected, page.url());
  const rows = page.locator('[data-plugin-panel="installed"] article[data-plugin-id]');
  await isTrue(async () => (await rows.count()) === 2, 'the installed rows');
  const waitingText = await page.locator('article[data-plugin-id="quota-notifier"]').innerText();
  check('an enabled plugin that is not running says so', /未运行|not running/.test(waitingText), waitingText);
  const describedText = await page.locator('article[data-plugin-id="request-logger"]').innerText();
  check('an installed row shows its own description', describedText.includes('Logs request metadata.'), describedText);
  check('an installed row names the registry it came from', /CPA 官方源|CPA official/.test(describedText), describedText);
  check('an installed row no install record vouches for says its source is unknown', /来源未知|Unknown source/.test(waitingText), waitingText);
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
    const pluginDocument = page.frameLocator('[data-plugin-page-frame]').frameLocator('iframe');
    await pluginDocument.getByRole('heading', { name: 'Probe plugin console' }).waitFor({ state: 'visible' });
    const draft = pluginDocument.getByRole('textbox', { name: 'Plugin draft' });
    await draft.fill('unsaved plugin state');
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
    await page.getByRole('button', { name: /^Theme: Light$/ }).click();
    await isTrue(async () => (await page.locator('html').getAttribute('data-theme-mode')) === 'dark', 'the dark theme');
    await pluginDocument.locator('#plugin-theme').filter({ hasText: /^dark$/ }).waitFor();
    check('a theme change reaches the plugin without reloading its document', await draft.inputValue() === 'unsaved plugin state');
    check('theme synchronization leaves the plugin-owned theme attribute intact', await pluginDocument.locator('html').getAttribute('data-theme') === 'plugin-owned');
    await settleLayout(page);
    const darkMark = await selectedEntry.locator('[data-plugin-logo="svg"]').evaluate((mark) => ({
      source: mark.querySelector('img')?.getAttribute('src'),
      mask: getComputedStyle(mark).maskImage,
      isPainted: getComputedStyle(mark).backgroundColor !== 'rgba(0, 0, 0, 0)',
    }));
    check('a theme change keeps the menu entry\'s artwork as the plugin drew it',
      darkMark.source === LOGO && darkMark.mask === 'none' && !darkMark.isPainted, JSON.stringify(darkMark));
    const headingArtwork = hosted.locator('[data-plugin-logo="svg"] img');
    const headingShown = await isTrue(async () => (await headingArtwork.getAttribute('src')) === LOGO && await headingArtwork.evaluate(async (image) => {
      await image.decode();
      return image.naturalWidth > 0;
    }), 'the hosted page heading mark');
    check('the hosted page\'s heading mark is the plugin\'s artwork', headingShown);
    await page.screenshot({ path: 'tmp/plugin-svg-logos/dark.png' });
    // Follow the operating-system preference, which exercises the real theme provider.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: /^Theme: Dark$/ }).click();
    await isTrue(async () => (await page.locator('html').getAttribute('data-theme-mode')) === 'light', 'the light theme');
    await pluginDocument.locator('#plugin-theme').filter({ hasText: /^light$/ }).waitFor();
    check('following the light system theme preserves plugin state', await draft.inputValue() === 'unsaved plugin state');
    await settleLayout(page);
    await page.screenshot({ path: 'tmp/plugin-svg-logos/light.png' });
    await page.getByRole('button', { name: /^Theme: Follow system$/ }).click();
    const scrolled = await pluginDocument.locator('body').evaluate((body) => {
      const view = body.ownerDocument.defaultView;
      view.scrollTo(0, 600);
      return view.scrollY > 0;
    });
    check('the plugin document scrolls inside its frame', scrolled);
    await page.getByRole('button', { name: 'Reload the page', exact: true }).click();
    await pluginDocument.getByRole('heading', { name: 'Probe plugin console' }).waitFor({ state: 'visible' });
    check('reload replaces the plugin document', await draft.inputValue() === '');
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Open in a new tab', exact: true }).click();
    const popup = await popupPromise;
    try {
      await popup.getByRole('heading', { name: 'Probe plugin console' }).waitFor({ state: 'visible' });
      check('a new tab opens the plugin resource directly', popup.url().endsWith('/plugin-host/v0/resource/plugins/request-logger/console'));
    } finally {
      await popup.close();
      await page.bringToFront();
    }
    // A reverse proxy may answer a missing shell asset with its own HTML page.
    const shellURL = await page.locator('[data-plugin-page-frame]').evaluate(frame => frame.src);
    const replaceShell = route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Unavailable</body></html>' });
    await page.route(shellURL, replaceShell);
    try {
      await page.getByRole('button', { name: 'Reload the page', exact: true }).click();
      const failure = page.getByTestId('plugin-page-load-failure');
      await failure.waitFor({ state: 'visible' });
      check('a missing shell frame reports a recoverable failure', await page.locator('[data-plugin-page-frame]').count() === 0);
    } finally {
      await page.unroute(shellURL, replaceShell);
    }
    await page.getByTestId('plugin-page-load-failure').getByRole('button', { name: /重试|Retry/ }).click();
    await pluginDocument.getByRole('heading', { name: 'Probe plugin console' }).waitFor({ state: 'visible' });
    check('retrying a failed shell loads the plugin document', await page.getByTestId('plugin-page-load-failure').count() === 0);
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

  // ── Oh My CPA's built-in plugins: default-on automation and per-plugin switches ──
  await page.goto(`${base}/plugins/builtins`, { waitUntil: 'domcontentloaded' });
  const builtinEntry = page.locator('.app-menu [data-route-path="/plugins/builtins"]').first();
  const builtinSelected = await isTrue(
    async () => /ant-menu-item-selected/.test((await builtinEntry.getAttribute('class')) ?? ''),
    'the built-in navigation selection',
  );
  check('the built-in plugins are a navigation entry of their own, selected on their page', builtinSelected);
  check('the plugin group names three places besides plugin pages: built-in plugins, plugin management and the store',
    JSON.stringify(await page.locator('.app-menu [data-route-path^="/plugins"]').evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute('data-route-path')))].sort()))
      === JSON.stringify(['/plugins', '/plugins/builtins', '/plugins/store']));
  const builtinRow = page.locator('[data-plugin-panel="builtins"] article[data-plugin-id="omc-zcode-oauth"]');
  await builtinRow.waitFor();
  const builtinText = await builtinRow.innerText();
  const automation = page.locator('[data-plugin-panel="builtins"] [data-builtin-enabled]').getByRole('switch');
  check('the built-in plugin is on by default and shows its declared description',
    (await automation.getAttribute('aria-checked')) === 'true'
      && (await builtinRow.getAttribute('data-builtin-status')) === 'running'
      && /登录 ZCode。|Signs in to ZCode\./.test(builtinText), builtinText);
  await automation.click();
  const stopped = await isTrue(async () => writes.some((write) => write.kind === 'builtin-policy'), 'the global switch write');
  const stopWrite = writes.find((write) => write.kind === 'builtin-policy');
  check('turning the feature off writes the visible revision with no consent field',
    stopped && stopWrite.body.enabled === false && stopWrite.body.revision === 3 && !('consent' in stopWrite.body), JSON.stringify(stopWrite));
  const featureOff = await isTrue(
    async () => (await page.locator('[data-plugin-panel="builtins"] [data-builtin-enabled]').getAttribute('data-builtin-enabled')) === 'false',
    'the disabled built-in feature',
  );
  check('turning the feature off says managed copies are uninstalled',
    featureOff && await page.getByText(/内置插件已停用|Built-in plugins are off/).first().isVisible());
  check('with the feature off the page holds only its switch', (await builtinRow.count()) === 0);
  await automation.click();
  const featureOn = await isTrue(
    async () => (await page.locator('[data-plugin-panel="builtins"] [data-builtin-enabled]').getAttribute('data-builtin-enabled')) === 'true',
    'the re-enabled built-in feature',
  );
  const resumed = await isTrue(async () => writes.filter((write) => write.kind === 'builtin-policy').length === 2, 'the global switch resume');
  const resumeWrite = writes.filter((write) => write.kind === 'builtin-policy')[1];
  check('turning the feature back on reuses the next visible revision',
    featureOn && resumed && resumeWrite.body.enabled === true && resumeWrite.body.revision === 4, JSON.stringify(resumeWrite));
  const resumeReported = await isTrue(async () => page.getByText(/已启用内置插件|Built-in plugins are on/).first().isVisible(), 'the resume outcome');
  check('turning the feature on reports once the run it started has finished', resumeReported);
  await builtinRow.getByRole('switch').click();
  const perPlugin = await isTrue(async () => writes.some((write) => write.kind === 'builtin-plugin-policy'), 'the per-plugin switch write');
  const perPluginWrite = writes.find((write) => write.kind === 'builtin-plugin-policy');
  check('the per-plugin switch writes only that plugin policy and keeps the built-in installed',
    perPlugin && perPluginWrite.body.enabled === false && perPluginWrite.body.revision === 5
      && /v0\.2\.0/.test(await builtinRow.innerText()),
    JSON.stringify(perPluginWrite));

  // ── plugin system settings ──────────────────────────────────────────────────
  await page.goto(`${base}/plugins/settings`, { waitUntil: 'domcontentloaded' });
  const settings = page.locator('[data-plugin-panel="settings"]');
  await settings.waitFor({ timeout: 10000 });
  const omcRow = settings.locator('[data-plugin-omc-source]');
  check('the managed OMC plugin registry is a fixed row rather than an editable source',
    (await omcRow.count()) === 1 && (await omcRow.locator('input').count()) === 0
      && /OMC 插件源|OMC plugin registry/.test(await omcRow.innerText()));
  const omcRowText = await omcRow.innerText();
  check('the managed source row is one compact line: no registry address and no state label',
    !/https?:\/\//.test(omcRowText) && !/(已启用|已关闭|\bOn\b|\bOff\b)/.test(omcRowText), omcRowText);
  const glyphOf = (row) => row.locator('svg').first().evaluate((node) => node.outerHTML);
  const omcGlyph = await glyphOf(omcRow);
  // It lists other authors' plugins, so it must not borrow the official source's mark.
  check('the community registry row does not draw the official source\'s glyph',
    omcGlyph !== (await glyphOf(settings.locator('[data-plugin-official-source]'))), omcGlyph.slice(0, 120));
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
  await omcRow.getByRole('button', { name: /在 OMC 设置中管理|Manage in OMC settings/ }).click();
  check('the managed source row links to the OMC settings switch',
    await isTrue(async () => new URL(page.url()).pathname.endsWith('/omc-settings'), 'the OMC settings page'));

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
