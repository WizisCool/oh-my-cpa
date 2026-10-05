import http from 'node:http';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// The endpoints the client reads on /v0/management; every other one lives under
// /v8/management only. `/config.yaml` is on both: v0 returns the file as stored
// (read before a write that would convert it) and v8 its v8 rendering. The
// per-family credential lists are the only source of each key's auth index.
const V0_ENDPOINTS = new Set(['/config.yaml', '/openai-compatibility']);
const BOTH_GENERATION_ENDPOINTS = new Set(['/config.yaml']);

function isV0Endpoint(path) {
  return V0_ENDPOINTS.has(path) || /^\/[a-z0-9-]+-api-key$/.test(path);
}

// The settings a v8 credential group may carry for all of its keys.
const GROUP_SHARED_FIELDS = new Set(['base-url', 'priority', 'prefix', 'proxy-url', 'headers', 'models', 'excluded-models', 'disable-cooling', 'request-retry', 'request-scoped-errors']);

// groupEntries renders a flat credential list the way CPA renders a converted
// pre-v8 file: one group per entry, without the runtime auth index.
function groupEntries(family, entries) {
  if (family === 'openai-compatibility') {
    return entries.map(({ 'api-key-entries': keys = [], ...provider }) => ({
      ...provider,
      keys: keys.map(({ 'auth-index': _runtime, ...key }) => key),
    }));
  }
  return entries.map((entry, index) => {
    const group = { name: `${family}-${index + 1}` };
    const key = {};
    for (const [field, value] of Object.entries(entry)) {
      if (field === 'auth-index') continue;
      if (GROUP_SHARED_FIELDS.has(field)) group[field] = value;
      else key[field] = value;
    }
    group.keys = [key];
    return group;
  });
}

// flattenGroups is CPA's reading of written groups: one entry per key. A key
// keeps the auth index of the entry it replaces, since CPA derives the index
// from the key's content.
function flattenGroups(family, groups, previous) {
  const indexOf = (apiKey) => previous.flatMap((entry) => [entry, ...(entry['api-key-entries'] ?? [])])
    .find((entry) => entry['api-key'] === apiKey)?.['auth-index'] ?? `${family}-${apiKey}`;
  if (family === 'openai-compatibility') {
    return (groups ?? []).map(({ keys = [], ...provider }) => ({
      ...provider,
      'api-key-entries': keys.map((key) => ({ ...key, 'auth-index': indexOf(key['api-key']) })),
    }));
  }
  return (groups ?? []).flatMap((group) => (group.keys ?? []).map((key) => {
    const entry = {};
    for (const [field, value] of Object.entries(group)) {
      if (field !== 'name' && field !== 'keys') entry[field] = value;
    }
    return { ...entry, ...key, 'auth-index': indexOf(key['api-key']) };
  }));
}

export const FAKE_CPA_MANAGEMENT_KEY = 'omc-e2e-management-key';
export const FAKE_PROVIDER_SECRET = 'omc-e2e-provider-secret';
// FAKE_SECOND_PROVIDER_SECRET belongs to the second codex entry. Providers are
// addressed positionally and a toggle writes the family's whole list, so a
// fixture with one entry cannot express a concurrent toggle of two rows - which
// is the case where one write can discard another.
export const FAKE_SECOND_PROVIDER_SECRET = 'omc-e2e-provider-secret-second';
export const FAKE_ACCOUNT_SECRET = 'omc-e2e-account-secret';
export const FAKE_CLIENT_SECRET = 'omc-e2e-client-secret';

/**
 * The inline artwork the `iflow-auth` fixture plugin publishes for its OAuth provider.
 *
 * Exported because the acceptance flows assert that a plugin-owned provider draws *this*
 * mark: "an <img> loaded" would also pass for a catalog mark, a neighbouring plugin's
 * logo, or the console's own fallback, none of which is the claim being made.
 */
export const FAKE_PLUGIN_LOGO_DATA_URL = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'%3E%3Crect width=\'24\' height=\'24\' rx=\'6\' fill=\'%234F46E5\'/%3E%3Ctext x=\'12\' y=\'16\' font-size=\'9\' font-family=\'monospace\' fill=\'white\' text-anchor=\'middle\'%3EiF%3C/text%3E%3C/svg%3E';

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'X-CPA-Version': '8.0.2-e2e', ...headers });
  response.end(JSON.stringify(body));
}

export function createFakeCpaServer({ managementKey = FAKE_CPA_MANAGEMENT_KEY } = {}) {
  const requests = [];
  const initialAuthFiles = [
    {
      id: 'auth-e2e-1', auth_index: 'auth-index-e2e-1', name: 'fixture-auth.json', type: 'codex', provider: 'codex',
      label: 'Primary fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      email: 'owner@example.test', account_type: 'oauth', account: FAKE_ACCOUNT_SECRET,
      id_token: { chatgpt_account_id: 'chatgpt-e2e-account', chatgpt_subscription_active_until: Math.floor((Date.now() - 3 * 86400000) / 1000), plan_type: 'pro' },
      success: 12, failed: 1, recent_requests: [{ time: '2026-09-01T12:00:00Z', success: 12, failed: 1 }],
      models: [{ id: 'gpt-e2e', display_name: 'GPT E2E' }], priority: 1, weight: 1, note: 'deterministic fixture',
      prefix: 'team-a', proxy_url: '', disable_cooling: false, websockets: true, using_api: false, excluded_models: [],
    },
    {
      id: 'auth-e2e-2', auth_index: 'auth-index-e2e-2', name: 'claude-fixture.json', type: 'claude', provider: 'claude',
      label: 'Claude fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 8, failed: 0, models: [{ id: 'claude-3-5-sonnet', display_name: 'Claude 3.5 Sonnet' }], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-3', auth_index: 'auth-index-e2e-3', name: 'antigravity-fixture.json', type: 'antigravity', provider: 'antigravity',
      project_id: 'e2e-project', label: 'Antigravity fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 5, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-4', auth_index: 'auth-index-e2e-4', name: 'kimi-fixture.json', type: 'kimi', provider: 'kimi',
      label: 'Kimi fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 3, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-5', auth_index: 'auth-index-e2e-5', name: 'xai-fixture.json', type: 'xai', provider: 'xai',
      label: 'xAI fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      success: 2, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-virtual', auth_index: 'auth-index-e2e-virtual', name: 'virtual-runtime.json', type: 'codex', provider: 'codex',
      label: 'Virtual fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: true,
      success: 0, failed: 0, models: [], priority: 0, weight: 1,
    },
    // A second codex credential whose live subscription read this fixture refuses, so
    // the quota card's unverified-snapshot rendering is reached by an ordinary run
    // rather than only when a real provider read happens to fail. Its id_token window
    // is deliberately in the past, which is the state the report described.
    {
      id: 'auth-e2e-8', auth_index: 'auth-index-e2e-8', name: 'codex-snapshot-only.json', type: 'codex', provider: 'codex',
      label: 'Snapshot-only fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      email: 'snapshot@example.test', account_type: 'oauth',
      id_token: { chatgpt_account_id: 'chatgpt-e2e-snapshot', chatgpt_subscription_active_until: Math.floor((Date.now() - 3 * 86400000) / 1000), plan_type: 'plus' },
      success: 1, failed: 0, models: [{ id: 'gpt-e2e', display_name: 'GPT E2E' }], priority: 1, weight: 1,
    },
    // One credential per brand-mark path the provider filters have to draw: a
    // built-in the console's catalog carries (Devin), and one owned by a plugin
    // (the `iflow-auth` fixture below), which draws the plugin's own logo.
    {
      id: 'auth-e2e-6', auth_index: 'auth-index-e2e-6', name: 'devin-fixture.json', type: 'devin', provider: 'devin',
      label: 'Devin fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      email: 'devin-fixture@example.test', account_type: 'oauth',
      success: 1, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-7', auth_index: 'auth-index-e2e-7', name: 'iflow-fixture.json', type: 'iflow', provider: 'iflow',
      label: 'iFlow fixture', status: 'ok', disabled: false, unavailable: false, runtime_only: false,
      account_type: 'oauth', success: 1, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-duplicate-a', auth_index: 'duplicate-index', name: 'duplicate-provider-a.json',
      type: 'mystery-provider', provider: 'mystery-provider', label: 'Duplicate index A', status: 'ok',
      disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-duplicate-b', auth_index: 'duplicate-index', name: 'duplicate-provider-b.json',
      type: 'mystery-provider', provider: 'mystery-provider', label: 'Duplicate index B', status: 'ok',
      disabled: false, unavailable: false, runtime_only: false, success: 0, failed: 0, models: [], priority: 1, weight: 1,
    },
    {
      id: 'auth-e2e-no-index', name: 'runtime-no-index.json', type: 'mystery-provider', provider: 'mystery-provider',
      label: 'Runtime without index', status: 'ok', disabled: false, unavailable: false, runtime_only: true,
      success: 0, failed: 0, models: [], priority: 0, weight: 1,
    },
  ];
  let authFiles = JSON.parse(JSON.stringify(initialAuthFiles));
  let oauthModelAliases = {
    codex: [{ name: 'gpt-e2e', alias: 'gpt-e2e-preview', fork: true, 'force-mapping': false, 'display-name': 'GPT E2E Preview' }],
    claude: [{ name: 'claude-3-5-sonnet', alias: 'sonnet-latest' }],
  };

  // The codex API-key list is stateful for the same reason authFiles is: the
  // provider enable/disable flow writes it and then re-reads it, so a fixture
  // that acknowledged the write without storing it could not tell a working
  // toggle from a lost one.
  const initialCodexProviders = [
    { 'api-key': FAKE_PROVIDER_SECRET, 'auth-index': 'codex-e2e', 'base-url': 'https://provider.example.test', models: [{ name: 'gpt-e2e', alias: 'gpt-e2e' }] },
    { 'api-key': FAKE_SECOND_PROVIDER_SECRET, 'auth-index': 'codex-e2e-second', 'base-url': 'https://provider-second.example.test', models: [{ name: 'gpt-e2e-second', alias: 'gpt-e2e-second' }] },
  ];
  let codexProviders = JSON.parse(JSON.stringify(initialCodexProviders));

  // The Meta Muse credential list is served so the console's family wiring is
  // observable in the browser: a family that reaches the API but not the page
  // renders as a row without its protocol label. It is stateful for the same
  // reason codex is - an acknowledged write that is not stored cannot be told
  // apart from a lost one.
  const initialMetaProviders = [
    { 'api-key': FAKE_PROVIDER_SECRET, 'auth-index': 'meta-e2e', 'base-url': 'https://api.meta.ai/v1' },
  ];
  let metaProviders = JSON.parse(JSON.stringify(initialMetaProviders));
  // The xAI list is served for the same reason, and it carries a setting the
  // console does not model (`websockets`): an edit made through the console
  // rewrites the whole list, and the stored copy is what shows that setting
  // survived it.
  const initialXAIProviders = [
    { 'api-key': FAKE_PROVIDER_SECRET, 'auth-index': 'xai-e2e', 'base-url': 'https://api.x.ai/v1', websockets: true },
  ];
  let xaiProviders = JSON.parse(JSON.stringify(initialXAIProviders));
  // The families the fixture keeps no credentials for answer an empty list, and
  // a write to one is stored like any other.
  const otherProviders = { claude: [], gemini: [], vertex: [], interactions: [], 'openai-compatibility': [] };
  const providerLists = {
    codex: { get: () => codexProviders, set: (list) => { codexProviders = list; } },
    meta: { get: () => metaProviders, set: (list) => { metaProviders = list; } },
    xai: { get: () => xaiProviders, set: (list) => { xaiProviders = list; } },
    ...Object.fromEntries(Object.keys(otherProviders).map((family) => [family, {
      get: () => otherProviders[family],
      set: (list) => { otherProviders[family] = list; },
    }])),
  };

  // The configuration is one v8 document, stateful for the same reason authFiles
  // is: the key-management page and the configuration page write single settings
  // and read the whole document back, so a fixture that acknowledged writes
  // without storing them would let a lost or misplaced setting pass unnoticed.
  // The writes follow CPA's v8 semantics: PATCH merges objects and replaces lists
  // and scalars, PUT replaces a path, DELETE removes one, and a legacy field name
  // is refused.
  let configDoc = {
    server: { host: '127.0.0.1', port: 8317 },
    observability: { logs: { debug: false, 'logging-to-file': true, 'request-log': true } },
    access: { 'api-keys': [FAKE_CLIENT_SECRET] },
    plugins: { enabled: true, dir: 'plugins' },
    'config-version': 8,
  };
  const V8_ROOTS = new Set(['server', 'management', 'access', 'credentials', 'routing', 'requests', 'oauth', 'multimedia', 'observability', 'plugins', 'quota-exceeded', 'api-keys', 'config-version']);
  const legacyRootIn = (document) => Object.keys(document ?? {}).find((key) => !V8_ROOTS.has(key));
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const mergeConfig = (target, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (isPlainObject(value) && isPlainObject(target[key])) mergeConfig(target[key], value);
      else target[key] = structuredClone(value);
    }
  };
  const configPathOf = (path) => path.slice('/config/'.length).split('/').map(decodeURIComponent);
  const renderConfigYaml = () => stringifyYaml(configDoc);

  const plugins = new Map([
    ['fixture-logger', {
      id: 'fixture-logger',
      path: 'plugins/fixture-logger.so',
      configured: true,
      registered: true,
      enabled: true,
      supports_oauth: false,
      oauth_provider: '',
      supports_quota: false,
      logo: '',
      config_fields: [
        { name: 'level', type: 'enum', enum_values: ['debug', 'info', 'warn'], description: 'Minimum level written to the log.' },
        { name: 'sample-rate', type: 'number', enum_values: [], description: 'Share of requests logged.' },
        { name: 'redact-headers', type: 'array', enum_values: [], description: 'Header names removed before logging.' },
        { name: 'include-body', type: 'boolean', enum_values: [], description: 'Log request bodies.' },
      ],
      menus: [{ path: '/v0/resource/plugins/fixture-logger/console', menu: 'Logger Console', description: 'Recent requests the logger kept.' }],
      metadata: { name: 'Request Logger Plugin', version: '1.0.0', author: 'router-for-me', github_repository: 'router-for-me/fixture-logger', logo: '', config_fields: [] },
    }],
    ['iflow-auth', {
      id: 'iflow-auth',
      path: 'plugins/iflow-auth.so',
      configured: true,
      registered: true,
      enabled: true,
      supports_oauth: true,
      oauth_provider: 'iflow',
      supports_quota: false,
      logo: FAKE_PLUGIN_LOGO_DATA_URL,
      config_fields: [],
      menus: [],
      metadata: { name: 'iFlow Alliance Auth', version: '1.0.0', author: 'router-for-me', github_repository: '', logo: FAKE_PLUGIN_LOGO_DATA_URL, config_fields: [] },
    }],
  ]);
  const pluginConfigs = new Map([
    ['fixture-logger', { enabled: true, level: 'info', 'sample-rate': 1, 'redact-headers': ['authorization'], 'include-body': false }],
    ['iflow-auth', { enabled: true }],
  ]);
  // applyPluginConfig stores `plugins.configs.<id>` and what the plugin host
  // derives from it.
  const applyPluginConfig = (id, config) => {
    pluginConfigs.set(id, config);
    const plugin = plugins.get(id);
    if (plugin) {
      plugin.configured = true;
      if (typeof config.enabled === 'boolean') plugin.enabled = config.enabled;
    }
  };
  const storePlugins = [
    {
      store_id: 'official/fixture-limiter', source_id: 'official', source_name: 'official', source_url: 'https://registry.fake-cpa.local/plugins.json',
      id: 'fixture-limiter', name: 'Rate Limiter', description: 'In-memory client token-bucket rate limiter',
      author: 'router-for-me', version: '1.2.0', repository: 'router-for-me/fixture-limiter', install_type: 'github_release',
      auth_required: false, auth_configured: false, platforms: [{ goos: 'linux', goarch: 'amd64' }],
      logo: FAKE_PLUGIN_LOGO_DATA_URL, homepage: 'https://limiter.fake-cpa.local', license: 'MIT', tags: ['network', 'limits'],
    },
    {
      store_id: 'official/fixture-logger', source_id: 'official', source_name: 'official', source_url: 'https://registry.fake-cpa.local/plugins.json',
      id: 'fixture-logger', name: 'Request Logger Plugin', description: 'Audits and logs request metadata to internal store',
      author: 'router-for-me', version: '1.1.0', repository: 'router-for-me/fixture-logger', install_type: 'github_release',
      auth_required: false, auth_configured: false, platforms: [], logo: '', homepage: '', license: 'MIT', tags: ['logging'],
    },
    {
      store_id: 'source-community/fixture-mirror', source_id: 'source-community', source_name: 'community.fake-cpa.local', source_url: 'https://community.fake-cpa.local/registry.json',
      id: 'fixture-mirror', name: 'Community Mirror', description: 'A plugin from a third-party registry',
      author: 'someone', version: '0.3.0', repository: 'someone/fixture-mirror', install_type: 'direct',
      auth_required: true, auth_configured: false, platforms: [], logo: '', homepage: '', license: '', tags: [],
    },
  ];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake-cpa.local');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: url.pathname, query: url.search, body: Buffer.concat(chunks).toString('utf8') });

    // Gateway reads use the live client-key list, not the management credential.
    // Project only model identities; provider configuration contains secrets.
    if (url.pathname === '/v1/models') {
      const clientKeys = configDoc.access?.['api-keys'] ?? [];
      if (!clientKeys.some((key) => typeof key === 'string' && key.trim() && request.headers.authorization === `Bearer ${key}`)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      if (request.method !== 'GET') {
        json(response, 405, { error: 'method not allowed' }, { Allow: 'GET' });
        return;
      }
      const modelIds = new Set();
      for (const credential of authFiles) {
        if (credential.disabled || credential.unavailable) continue;
        for (const model of credential.models ?? []) {
          const aliases = (oauthModelAliases[credential.provider] ?? []).filter((alias) => alias.name === model.id);
          if (aliases.length === 0 || aliases.some((alias) => alias.fork)) modelIds.add(model.id);
          for (const alias of aliases) modelIds.add(alias.alias);
        }
      }
      for (const list of Object.values(providerLists)) {
        for (const provider of list.get()) {
          if (provider.disabled) continue;
          for (const model of provider.models ?? []) {
            const identity = model.alias || model.name;
            modelIds.add(provider.prefix ? `${provider.prefix}/${identity}` : identity);
          }
        }
      }
      json(response, 200, { object: 'list', data: [...modelIds].filter(Boolean).sort().map((id) => ({ id, object: 'model', owned_by: 'fixture' })) });
      return;
    }

    // A plugin's own page and its assets: CPA serves these without the management key,
    // and the page reaches its plugin through absolute paths from CPA's root.
    if (request.method === 'GET' && url.pathname === '/v0/resource/plugins/fixture-logger/console') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end([
        '<!doctype html><html><head><meta charset="utf-8"><title>Logger Console</title></head><body>',
        '<h1 id="plugin-title">Logger Console</h1><p id="plugin-status">loading</p><p id="plugin-theme"></p>',
        '<script src="/v0/resource/plugins/fixture-logger/console.js"></script>',
        '</body></html>',
      ].join(''));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v0/resource/plugins/fixture-logger/console.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end([
        "document.getElementById('plugin-theme').textContent = window.parent.document.documentElement.getAttribute('data-theme') || '';",
        "fetch(new URL('/v0/management/fixture-logger/status', location.origin))",
        "  .then((reply) => reply.json())",
        "  .then((body) => { document.getElementById('plugin-status').textContent = body.state; })",
        "  .catch((error) => { document.getElementById('plugin-status').textContent = 'failed: ' + error.message; });",
      ].join('\n'));
      return;
    }

    if (request.headers.authorization !== `Bearer ${managementKey}`) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    // The plugin's own management route, registered beside CPA's and guarded by the same key.
    if (request.method === 'GET' && url.pathname === '/v0/management/fixture-logger/status') {
      json(response, 200, { state: 'logger running' });
      return;
    }
    // A v8 gateway: operations live under /v8/management, and /v0/management answers
    // only the reads the client still sends there
    // (internal/cpa/management/client_v0.go). A request sent to the other generation
    // finds no route, so a call moved to the wrong tree fails the suites instead of
    // passing against a handler shared by both.
    const path = url.pathname.replace(/^\/v[08]\/management/, '');
    if (request.method === 'GET' && url.pathname === '/v8/management/config/config-version') {
      json(response, 200, 8);
      return;
    }
    const isV0Request = url.pathname.startsWith('/v0/management/');
    if ((!isV0Request && !url.pathname.startsWith('/v8/management/'))
      || (!BOTH_GENERATION_ENDPOINTS.has(path) && isV0Request !== isV0Endpoint(path))) {
      json(response, 404, { error: 'not found' });
      return;
    }

    if (request.method === 'GET' && path === '/credentials') {
      json(response, 200, { files: authFiles });
      return;
    }
    if (request.method === 'GET' && path === '/credentials/models') {
      json(response, 200, { models: [{ id: 'gpt-e2e', display_name: 'GPT E2E' }] });
      return;
    }
    if (request.method === 'GET' && path === '/credentials/download') {
      const target = authFiles.find(f => f.name === url.searchParams.get('name'));
      if (!target) {
        json(response, 404, { error: 'auth file not found' });
        return;
      }
      json(response, 200, {
        type: target.type,
        prefix: target.prefix ?? '',
        proxy_url: target.proxy_url ?? '',
        priority: target.priority ?? 0,
        weight: target.weight ?? 1,
        disable_cooling: target.disable_cooling ?? false,
        websockets: target.websockets ?? false,
        using_api: target.using_api ?? false,
        expired: target.expired ?? '',
        note: target.note ?? '',
        excluded_models: target.excluded_models ?? [],
      });
      return;
    }
    if (request.method === 'PATCH' && path === '/credentials/status') {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try { payload = JSON.parse(bodyText || '{}'); } catch {}
      const target = authFiles.find(f => f.name === payload.name);
      if (target) {
        target.disabled = Boolean(payload.disabled);
        target.status = payload.disabled ? 'disabled' : 'ok';
      }
      json(response, 200, { status: 'ok', disabled: payload.disabled });
      return;
    }
    if (request.method === 'PATCH' && path === '/credentials/fields') {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try { payload = JSON.parse(bodyText || '{}'); } catch {}
      const target = authFiles.find(f => f.name === payload.name);
      if (target) {
        if (payload.priority !== undefined) target.priority = payload.priority;
        if (payload.weight !== undefined) target.weight = payload.weight;
        if (payload.note !== undefined) target.note = payload.note;
        if (payload.prefix !== undefined) target.prefix = payload.prefix;
        if (payload.proxy_url !== undefined) target.proxy_url = payload.proxy_url;
        if (payload.disable_cooling !== undefined) target.disable_cooling = payload.disable_cooling;
        if (payload.websockets !== undefined) target.websockets = payload.websockets;
        if (payload.using_api !== undefined) target.using_api = payload.using_api;
        if (payload.excluded_models !== undefined) target.excluded_models = payload.excluded_models;
        if (payload.expired !== undefined) target.expired = payload.expired;
      }
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'DELETE' && path === '/credentials') {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let requestedNames = [];
      try {
        const parsed = JSON.parse(bodyText || '{}');
        requestedNames = parsed.names || (parsed.name ? [parsed.name] : []);
      } catch {}
      if (requestedNames.length === 0 && url.searchParams.get('name')) {
        requestedNames = [url.searchParams.get('name')];
      }
      const deletedFiles = [];
      const failed = [];
      for (const name of requestedNames) {
        if (name === 'fail-delete.json') {
          failed.push({ name, error: 'permission denied' });
          continue;
        }
        const idx = authFiles.findIndex(f => f.name === name);
        if (idx >= 0) {
          authFiles.splice(idx, 1);
          deletedFiles.push(name);
        } else {
          failed.push({ name, error: 'file not found' });
        }
      }
      if (failed.length > 0) {
        json(response, 207, { status: 'partial', deleted: deletedFiles.length, files: deletedFiles, failed });
        return;
      }
      if (requestedNames.length === 1) {
        json(response, 200, { status: 'ok' });
        return;
      }
      json(response, 200, { status: 'ok', deleted: deletedFiles.length, files: deletedFiles });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v8/management/config') {
      json(response, 200, configDoc);
      return;
    }
    // The v8 view and the stored file are the same document here: the fixture's
    // file is already migrated, so no write converts it.
    if (request.method === 'GET' && (url.pathname === '/v8/management/config.yaml' || url.pathname === '/v0/management/config.yaml')) {
      response.writeHead(200, { 'Content-Type': 'application/yaml', 'X-CPA-Version': '8.0.2-e2e' });
      response.end(renderConfigYaml());
      return;
    }
    // Upstream credentials, OAuth model aliases and plugin settings live in the
    // v8 document, but the fixture keeps them where the rest of it reads them:
    // the credential lists its v0 routes serve, the alias map and the plugin
    // host. These routes translate between the two.
    const configPathMatch = /^\/v8\/management\/config\/(.+)$/.exec(url.pathname);
    const settingPath = configPathMatch ? configPathMatch[1].split('/').map(decodeURIComponent) : [];
    if (settingPath[0] === 'api-keys' && settingPath.length === 2 && (request.method === 'GET' || request.method === 'DELETE')) {
      const list = providerLists[settingPath[1]]?.get() ?? [];
      if (list.length === 0) {
        json(response, 404, { error: 'not_found' });
        return;
      }
      if (request.method === 'DELETE') {
        providerLists[settingPath[1]].set([]);
        json(response, 200, { status: 'ok', 'config-version': 8 });
        return;
      }
      json(response, 200, groupEntries(settingPath[1], list));
      return;
    }
    if (settingPath.join('/') === 'oauth/model-alias' && request.method === 'GET') {
      json(response, 200, oauthModelAliases);
      return;
    }
    if (settingPath[0] === 'oauth' && settingPath[1] === 'model-alias' && settingPath.length === 3 && request.method === 'DELETE') {
      if (!(settingPath[2] in oauthModelAliases)) {
        json(response, 404, { error: 'not_found' });
        return;
      }
      delete oauthModelAliases[settingPath[2]];
      json(response, 200, { status: 'ok', 'config-version': 8 });
      return;
    }
    if (settingPath[0] === 'plugins' && settingPath[1] === 'configs' && settingPath.length === 3) {
      const id = settingPath[2];
      if (request.method === 'GET') {
        if (!pluginConfigs.has(id)) {
          json(response, 404, { error: 'not_found' });
          return;
        }
        json(response, 200, pluginConfigs.get(id));
        return;
      }
      if (request.method === 'PUT') {
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        applyPluginConfig(id, payload);
        json(response, 200, { status: 'ok', 'config-version': 8 });
        return;
      }
    }
    if (request.method === 'PATCH' && url.pathname === '/v8/management/config') {
      let patch = {};
      try { patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      for (const [family, groups] of Object.entries(patch['api-keys'] ?? {})) {
        if (!providerLists[family]) {
          json(response, 400, { error: 'invalid_config', message: `unknown API-key provider ${family}` });
          return;
        }
        providerLists[family].set(flattenGroups(family, groups, providerLists[family].get()));
      }
      for (const [channel, aliases] of Object.entries(patch.oauth?.['model-alias'] ?? {})) {
        oauthModelAliases[channel] = aliases;
      }
      for (const [id, config] of Object.entries(patch.plugins?.configs ?? {})) {
        applyPluginConfig(id, { ...(pluginConfigs.get(id) ?? {}), ...config });
      }
      delete patch['api-keys'];
      if (patch.oauth) delete patch.oauth['model-alias'];
      if (patch.plugins) delete patch.plugins.configs;
      const isHandled = Object.keys(patch).every((root) => isPlainObject(patch[root]) && Object.keys(patch[root]).length === 0);
      if (isHandled) {
        json(response, 200, { status: 'ok', 'config-version': 8 });
        return;
      }
      chunks.splice(0, chunks.length, Buffer.from(JSON.stringify(patch)));
    }
    if (url.pathname.startsWith('/v8/management/config') && request.method !== 'GET') {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const configPath = path === '/config' || path === '/config.yaml' ? [] : configPathOf(path);
      try {
        if (request.method === 'PUT' && path === '/config.yaml') {
          const document = parseYaml(bodyText) ?? {};
          const legacy = legacyRootIn(document);
          if (legacy) {
            json(response, 400, { error: 'invalid_config', message: `legacy field ${legacy} is not accepted by v8` });
            return;
          }
          configDoc = { ...document, 'config-version': 8 };
        } else if (request.method === 'PATCH' && configPath.length === 0) {
          const patch = JSON.parse(bodyText || '{}');
          const legacy = legacyRootIn(patch);
          if (legacy) {
            json(response, 400, { error: 'invalid_config', message: `legacy field ${legacy} is not accepted by v8` });
            return;
          }
          mergeConfig(configDoc, patch);
        } else if (request.method === 'PUT' && configPath.length > 0) {
          let parent = configDoc;
          for (const key of configPath.slice(0, -1)) {
            if (!isPlainObject(parent[key])) parent[key] = {};
            parent = parent[key];
          }
          parent[configPath.at(-1)] = JSON.parse(bodyText);
        } else if (request.method === 'DELETE' && configPath.length > 0) {
          let parent = configDoc;
          for (const key of configPath.slice(0, -1)) parent = isPlainObject(parent?.[key]) ? parent[key] : undefined;
          if (!parent || !(configPath.at(-1) in parent)) {
            json(response, 404, { error: 'not_found' });
            return;
          }
          delete parent[configPath.at(-1)];
        } else {
          json(response, 405, { error: 'method not allowed' });
          return;
        }
      } catch (error) {
        json(response, 400, { error: 'invalid_config', message: String(error?.message ?? error) });
        return;
      }
      json(response, 200, { status: 'ok', 'config-version': 8 });
      return;
    }
    const familyListMatch = /^\/([a-z0-9-]+)-api-key$/.exec(path);
    if (familyListMatch && request.method === 'GET' && providerLists[familyListMatch[1]]) {
      json(response, 200, { [`${familyListMatch[1]}-api-key`]: providerLists[familyListMatch[1]].get() });
      return;
    }
    if (request.method === 'GET' && path === '/openai-compatibility') {
      json(response, 200, { 'openai-compatibility': providerLists['openai-compatibility'].get() });
      return;
    }
    if (request.method === 'GET' && path === '/observability/usage/api-keys') {
      json(response, 200, { codex: { [`https://provider.example.test|${FAKE_PROVIDER_SECRET}`]: { success: 12, failed: 1, recent_requests: [{ time: '2026-09-01T12:00:00Z', success: 12, failed: 1 }] } } });
      return;
    }
    if (request.method === 'GET' && path === '/observability/logs') {
      json(response, 200, { lines: ['2026-09-01T12:00:00Z INFO fixture request completed'], 'latest-timestamp': 1788264000, 'next-cursor': 'fixture-cursor' });
      return;
    }
    if (request.method === 'GET' && path === '/observability/logs/errors') {
      json(response, 200, { files: [] });
      return;
    }
    if (request.method === 'GET' && path === '/server/latest-version') {
      json(response, 200, { 'latest-version': '8.0.3' });
      return;
    }
    if (request.method === 'GET' && path === '/oauth/auth-url') {
      const provider = url.searchParams.get('provider') || '';
      // Device-code providers answer with their flow label and the short code
      // the operator confirms on the vendor page, as CPA does.
      if (provider === 'meta' || provider === 'kimi') {
        json(response, 200, {
          url: 'https://auth.example.test/oauth?session=e2e',
          state: 'e2e-state',
          flow: 'device',
          user_code: 'E2E-CODE-1',
          expires_in: 900,
        });
        return;
      }
      json(response, 200, { url: 'https://auth.example.test/oauth?session=e2e', state: 'e2e-state' });
      return;
    }
    if (request.method === 'GET' && path === '/oauth/status') {
      const state = url.searchParams.get('state') || url.searchParams.get('session_id') || '';
      // Sessions whose browser auto-callback already finished report
      // completed, so the facade idempotency path is exercisable in E2E.
      if (state === 'already-done') {
        json(response, 200, { status: 'ok' });
        return;
      }
      json(response, 200, { status: 'wait', message: 'waiting for user' });
      return;
    }
    if (request.method === 'DELETE' && path === '/oauth/session') {
      const state = url.searchParams.get('state') || url.searchParams.get('session_id') || '';
      // A session CPA could not cancel (already finished or expired) reports
      // cancelled:false rather than pretending it was abandoned.
      json(response, 200, { status: 'ok', cancelled: state !== 'already-done' });
      return;
    }
    if (request.method === 'POST' && path === '/oauth/callback') {
      let state = '';
      try {
        const body = JSON.parse(requests[requests.length - 1].body || '{}');
        state = new URL(body.redirect_url || '', 'http://placeholder.local').searchParams.get('state') || '';
      } catch { /* keep state empty */ }
      // Simulate the CPA auto-callback race: a repeated manual submission
      // for an already-completed session answers 409.
      if (state === 'already-done') {
        json(response, 409, { status: 'error', error: 'oauth flow is already completed' });
        return;
      }
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/routing/cooldown/reset') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'POST' && path === '/requests/api-call') {
      let body = {};
      try {
        body = JSON.parse(requests[requests.length - 1].body || '{}');
      } catch {}
      const targetURL = body.url || '';
      // The subscription probe is scoped per credential. One codex credential answers
      // it (exercising a live read) and the other reports the upstream failure, so the
      // unverified-snapshot path is covered in the same run.
      if (targetURL.includes('backend-api/subscriptions')) {
        if ((body.auth_index || '') === 'auth-index-e2e-8') {
          json(response, 200, {
            status_code: 503,
            header: { 'content-type': ['application/json'] },
            body: { error: 'subscription read unavailable' },
          });
          return;
        }
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            plan_type: 'pro',
            active_start: new Date(Date.now() - 21 * 86400000).toISOString(),
            active_until: new Date(Date.now() + 21 * 86400000).toISOString(),
            will_renew: false,
          },
        });
        return;
      }
      if (targetURL.includes('rate-limit-reset-credits/consume') || targetURL.includes('reset_credits/consume')) {
        json(response, 200, { status_code: 200, header: { 'content-type': ['application/json'] }, body: { status: 'ok' } });
        return;
      }
      if (targetURL.includes('rate-limit-reset-credits')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            available_count: 2,
            applicable_available_count: 1,
            credits: [
              { id: 'credit-1', status: 'available', reset_type: 'codex_rate_limits', granted_at: String(Date.now() - 86400000), expires_at: String(Date.now() + 28 * 86400000) },
              { id: 'credit-2', status: 'available', reset_type: 'codex_rate_limits', granted_at: String(Date.now() - 86400000), expires_at: String(Date.now() + 29 * 86400000) },
              { id: 'credit-3', status: 'used', reset_type: 'codex_rate_limits', granted_at: String(Date.now() - 3 * 86400000), expires_at: String(Date.now() + 2 * 86400000) },
            ],
          },
        });
        return;
      }
      if (targetURL.includes('backend-api/wham/usage')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            plan_type: 'pro',
            rate_limit: {
              primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 7200 },
              secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_after_seconds: 172800 },
            },
            rate_limit_reset_credits: { available_count: 2, applicable_available_count: 1 },
          },
        });
        return;
      }
      if (targetURL.includes('oauth/usage')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            five_hour: { utilization: 20.0, resets_at: new Date(Date.now() + 7200000).toISOString() },
            seven_day: { utilization: 50.0, resets_at: new Date(Date.now() + 86400000).toISOString() },
          },
        });
        return;
      }
      if (targetURL.includes('oauth/profile')) {
        json(response, 200, { status_code: 200, header: { 'content-type': ['application/json'] }, body: { account: { has_claude_pro: true } } });
        return;
      }
      if (targetURL.includes('retrieveUserQuotaSummary')) {
        // Mirrors the real antigravity summary: two groups, weekly bucket listed
        // before the five-hour one, display names like "Five Hour Limit".
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            groups: [
              { displayName: 'Gemini Models', buckets: [
                { bucketId: 'gemini-week', displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 0.51, resetTime: new Date(Date.now() + 5.5 * 86400000).toISOString() },
                { bucketId: 'gemini-5h', displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
              ] },
              { displayName: 'Claude and GPT models', buckets: [
                { bucketId: 'aerolith-week', displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 1.0, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
                { bucketId: 'aerolith-5h', displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1.0, resetTime: new Date(Date.now() + 5 * 3600000).toISOString() },
              ] },
              { displayName: 'Additional model group', buckets: [
                { bucketId: 'additional-week', displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 0.8, resetTime: new Date(Date.now() + 6 * 86400000).toISOString() },
                { bucketId: 'additional-5h', displayName: 'Five Hour Limit', window: '5h', remainingFraction: 0.9, resetTime: new Date(Date.now() + 4 * 3600000).toISOString() },
              ] },
            ],
          },
        });
        return;
      }
      if (targetURL.includes('coding/v1/usages')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            limits: [{ name: 'daily', title: 'Daily limit', used: 15, limit: 100 }],
          },
        });
        return;
      }
      if (targetURL.includes('cli-chat-proxy.grok.com') || targetURL.includes('x.ai')) {
        json(response, 200, {
          status_code: 200,
          header: { 'content-type': ['application/json'] },
          body: {
            config: { credit_usage_percent: 30.0, monthly_limit: 10000, used: 3000 },
          },
        });
        return;
      }
      json(response, 200, { status_code: 200, header: {}, body: {} });
      return;
    }
    // The plugin routes are CPA's own shapes: the installed list carries the global
    // switch and each plugin's declared config fields, the settings document is read
    // per plugin, and the store joins each registry entry with the local install state.
    // Enablement, settings and installs are stateful, so a control that stops writing
    // is caught on the next read rather than acknowledged.
    if (request.method === 'GET' && path === '/plugins') {
      json(response, 200, {
        plugins_enabled: true,
        plugins_dir: 'plugins',
        plugins: [...plugins.values()].map((plugin) => ({ ...plugin, effective_enabled: plugin.enabled && plugin.registered })),
      });
      return;
    }
    if (request.method === 'GET' && path === '/plugins/store') {
      json(response, 200, {
        plugins_enabled: true,
        plugins_dir: 'plugins',
        sources: [
          { id: 'official', name: 'official', url: 'https://registry.fake-cpa.local/plugins.json' },
          { id: 'source-community', name: 'community.fake-cpa.local', url: 'https://community.fake-cpa.local/registry.json' },
        ],
        source_errors: [],
        plugins: storePlugins.map((entry) => {
          const installed = plugins.get(entry.id);
          return {
            ...entry,
            installed: Boolean(installed),
            installed_version: installed?.metadata?.version ?? '',
            effective_enabled: Boolean(installed?.enabled && installed?.registered),
            update_available: Boolean(installed && installed.metadata?.version !== entry.version),
          };
        }),
      });
      return;
    }
    const pluginInstallMatch = /^\/plugins\/store\/([^/]+)\/install$/.exec(path);
    if (pluginInstallMatch && request.method === 'POST') {
      const id = decodeURIComponent(pluginInstallMatch[1]);
      const entry = storePlugins.find((candidate) => candidate.id === id);
      if (!entry) {
        json(response, 404, { error: 'plugin_not_found', message: `plugin ${id} was not found in any plugin store source` });
        return;
      }
      plugins.set(id, {
        id,
        path: `plugins/${id}.so`,
        configured: true,
        registered: true,
        enabled: true,
        supports_oauth: false,
        oauth_provider: '',
        supports_quota: false,
        logo: '',
        config_fields: [],
        menus: [],
        metadata: { name: entry.name, version: entry.version, author: entry.author, github_repository: entry.repository, logo: '', config_fields: [] },
      });
      pluginConfigs.set(id, { enabled: true });
      json(response, 200, { status: 'installed', source_id: entry.source_id, source_name: entry.source_name, id, version: entry.version, install_type: 'github_release', path: `plugins/${id}.so`, plugins_enabled: true, restart_required: false });
      return;
    }
    const pluginDeleteMatch = /^\/plugins\/([^/]+)$/.exec(path);
    if (pluginDeleteMatch && request.method === 'DELETE') {
      const id = decodeURIComponent(pluginDeleteMatch[1]);
      const existed = plugins.delete(id);
      pluginConfigs.delete(id);
      json(response, existed ? 200 : 404, existed
        ? { status: 'deleted', id, path: `plugins/${id}.so`, file_deleted: true, configured_removed: true, restart_required: false }
        : { error: 'plugin_not_found', message: 'plugin not found' });
      return;
    }
    if (request.method === 'PUT' && path.startsWith('/')) {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'DELETE' && path === '/observability/logs') {
      json(response, 200, { status: 'ok' });
      return;
    }
    json(response, 404, { error: 'not found' });
  });
  return { server, requests };
}
