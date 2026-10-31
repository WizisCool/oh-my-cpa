import assert from 'node:assert/strict';
import { parsePluginConfig, pluginConfigsEqual, pluginConfigSummary } from '../web/src/components/plugins/pluginConfig.ts';
import {
  buildPluginConfigDraft,
  composePluginConfig,
  isPluginFieldChanged,
  pluginFieldDefaultText,
  pluginFieldKind,
  undeclaredPluginKeys,
  withSavedEnabled,
} from '../web/src/components/plugins/pluginConfigForm.ts';
import {
  builtinChanges,
  builtinReasonKey,
  builtinVersionFacts,
  builtinWriteFailure,
  needsAttention,
} from '../web/src/components/plugins/builtinPluginLogic.ts';
import { pluginDescription } from '../web/src/components/plugins/pluginDescription.ts';
import {
  cpaStoreSources,
  filterStorePlugins,
  installedPluginDescription,
  normalizePluginSettingsDraft,
  STORE_INSTALL_WARNINGS,
  storeFilterCounts,
  storeInstallConfirmToken,
  installedListing,
  sortRecommendedFirst,
  storeEntryKey,
  storeListingsBySource,
  storePluginOrigin,
  validatePluginSettingsDraft,
} from '../web/src/components/plugins/pluginStoreLogic.ts';
import type { PluginConfigField, PluginItem, StorePluginItem } from '../web/src/types/plugin.ts';
import { test } from 'vitest';

test('plugin config', () => {
  assert.equal(parsePluginConfig('').error, 'object-required');
  assert.deepEqual(parsePluginConfig('{"level":"info"}'), { value: { level: 'info' } });
  assert.equal(parsePluginConfig('[]').error, 'object-required');
  assert.equal(parsePluginConfig('null').error, 'object-required');
  assert.equal(parsePluginConfig('{oops').error, 'invalid-json');

  // A repeated member is refused rather than silently resolved to its last value: the
  // submitted object has to be the text the operator reviewed and the preview showed.
  assert.deepEqual(parsePluginConfig('{"level":"info","level":"debug"}'), { error: 'duplicate-key', key: 'level' });
  assert.deepEqual(
    parsePluginConfig('{"retry":{"count":1,"count":2}}'),
    { error: 'duplicate-key', key: 'count' },
  );
  assert.deepEqual(
    parsePluginConfig('{"a":[{"b":1},{"b":2}]}'),
    { value: { a: [{ b: 1 }, { b: 2 }] } },
  );
  assert.deepEqual(parsePluginConfig('{"a":1,"b":{"a":2}}'), { value: { a: 1, b: { a: 2 } } });
  // Escaping must not hide a repeated name: both members decode to `a`.
  assert.deepEqual(parsePluginConfig('{"\\u0061":1,"a":2}'), { error: 'duplicate-key', key: 'a' });
  // An escaped quote inside a name is part of the name, not the end of the string.
  assert.deepEqual(
    parsePluginConfig('{"a\\"b":1,"a\\"b":2}'),
    { error: 'duplicate-key', key: 'a"b' },
  );
  assert.deepEqual(parsePluginConfig('{"text":"}\\"","text2":1}'), { value: { text: '}"', text2: 1 } });
  assert.equal(pluginConfigsEqual({ z: 1, a: { y: 2, x: 3 } }, { a: { x: 3, y: 2 }, z: 1 }), true);
  assert.equal(pluginConfigsEqual({ z: 1 }, { z: 2 }), false);

  assert.deepEqual(
    pluginConfigSummary({ z: 1, a: true, list: [1, 2], none: null }),
    [
      { key: 'a', type: 'boolean' },
      { key: 'list', type: 'array[2]' },
      { key: 'none', type: 'null' },
      { key: 'z', type: 'number' },
    ],
  );



  // ── the settings form ──────────────────────────────────────────────────────
  const FIELDS: PluginConfigField[] = [
    { name: 'level', type: 'enum', enum_values: ['debug', 'info'] },
    { name: 'rate', type: 'number' },
    { name: 'retries', type: 'integer' },
    { name: 'verbose', type: 'boolean' },
    { name: 'headers', type: 'array' },
    { name: 'matrix', type: 'array' },
    { name: 'labels', type: 'object' },
    { name: 'note', type: 'string' },
  ];

  assert.equal(pluginFieldKind({ name: 'x', type: 'enum', enum_values: [] }), 'string');
  assert.equal(pluginFieldKind({ name: 'x', type: 'mystery' }), 'string');
  assert.equal(pluginFieldKind({ name: 'x', type: 'INTEGER' }), 'integer');

  const SAVED = {
    enabled: true,
    level: 'info',
    rate: 0.5,
    headers: ['authorization'],
    matrix: [[1, 2]],
    labels: { team: 'a' },
    legacy: 'kept',
  };
  const draft = buildPluginConfigDraft(FIELDS, SAVED, false);
  assert.equal(draft.enabled, true);
  assert.equal(draft.fields.level.text, 'info');
  // A list of strings is edited as tags, any other array as JSON.
  assert.equal(draft.fields.headers.isList, true);
  assert.equal(draft.fields.matrix.isList, false);
  assert.equal(draft.fields.retries.isSet, false);
  assert.deepEqual(undeclaredPluginKeys(SAVED, FIELDS), ['legacy']);

  // An untouched draft composes back to exactly the saved document, undeclared keys included.
  assert.deepEqual(composePluginConfig(draft, FIELDS, SAVED), { value: SAVED, errors: {} });

  // An absent `enabled` is not written until it changes, so opening the editor is not an edit.
  const bare = buildPluginConfigDraft(FIELDS, {}, true);
  assert.deepEqual(composePluginConfig(bare, FIELDS, {}).value, {});
  assert.deepEqual(composePluginConfig({ ...bare, enabled: false }, FIELDS, {}).value, { enabled: false });

  // An undeclared key spelled `__proto__` is carried through as a key, not as a prototype.
  const protoSaved = JSON.parse('{"__proto__":{"polluted":true},"level":"info"}') as Record<string, unknown>;
  const protoComposed = composePluginConfig(buildPluginConfigDraft(FIELDS, protoSaved, false), FIELDS, protoSaved).value!;
  assert.equal(Object.prototype.hasOwnProperty.call(protoComposed, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(protoComposed), Object.prototype);
  assert.equal(JSON.stringify(protoComposed), '{"__proto__":{"polluted":true},"level":"info"}');

  // Typed values are written with their types; clearing a field removes its key.
  const edited = {
    ...draft,
    priority: '5',
    fields: {
      ...draft.fields,
      rate: { ...draft.fields.rate, text: '2.5' },
      retries: { ...draft.fields.retries, isSet: true, text: '3' },
      verbose: { ...draft.fields.verbose, isSet: true, checked: true },
      labels: { ...draft.fields.labels, isSet: false },
    },
  };
  assert.deepEqual(composePluginConfig(edited, FIELDS, SAVED).value, {
    enabled: true, priority: 5, level: 'info', rate: 2.5, retries: 3, verbose: true,
    headers: ['authorization'], matrix: [[1, 2]], legacy: 'kept',
  });
  assert.equal(isPluginFieldChanged(FIELDS[1], edited.fields.rate, SAVED), true);
  assert.equal(isPluginFieldChanged(FIELDS[0], edited.fields.level, SAVED), false);
  assert.equal(isPluginFieldChanged(FIELDS[6], edited.fields.labels, SAVED), true);

  // Invalid values are reported per field and no document is produced.
  const broken = {
    ...draft,
    priority: '1.5',
    fields: {
      ...draft.fields,
      level: { ...draft.fields.level, text: 'trace' },
      retries: { ...draft.fields.retries, isSet: true, text: '3.2' },
      matrix: { ...draft.fields.matrix, text: '{"a":1}' },
      labels: { ...draft.fields.labels, text: '[1' },
    },
  };
  assert.deepEqual(composePluginConfig(broken, FIELDS, SAVED), {
    errors: { priority: 'invalid-integer', level: 'invalid-enum', retries: 'invalid-integer', matrix: 'expected-array', labels: 'invalid-json' },
  });

  // ── the store ──────────────────────────────────────────────────────────────
  function entry(overrides: Partial<StorePluginItem>): StorePluginItem {
    return {
      store_id: 'official/x', source_id: 'official', source_name: 'official', source_kind: 'official', id: 'x', name: 'X', tags: [], platforms: [],
      is_official: true, is_official_repository: true, auth_required: false, auth_configured: false, installed: false, effective_enabled: false,
      update_available: false, ...overrides,
    };
  }
  const STORE = [
    entry({ store_id: 'official/limiter', id: 'limiter', name: 'Rate Limiter', tags: ['network'] }),
    entry({ store_id: 'official/logger', id: 'logger', name: 'Logger', installed: true, update_available: true, install_source_status: 'matched' }),
    entry({ store_id: 'mirror/logger', source_id: 'mirror', id: 'logger', name: 'Logger', is_official: false, installed: true, install_source_status: 'different', description: 'mirror copy' }),
  ];
  assert.deepEqual(storeFilterCounts(STORE), { all: 3, recommended: 0, installed: 2, available: 1, updates: 1 });
  assert.deepEqual(filterStorePlugins(STORE, 'NETWORK', 'all', 'en').map((item) => item.store_id), ['official/limiter']);
  assert.deepEqual(filterStorePlugins(STORE, '', 'updates', 'en').map((item) => item.store_id), ['official/logger']);

  // The OMC tag is matched exactly: a near miss is an ordinary community entry, not a recommendation.
  const TAGGED = [
    entry({ store_id: 'c/a', id: 'a', tags: ['OMC'], is_official: false }),
    entry({ store_id: 'c/b', id: 'b', tags: ['omc', 'OMC-ready'], is_official: false }),
  ];
  assert.deepEqual(filterStorePlugins(TAGGED, '', 'recommended', 'en').map((item) => item.store_id), ['c/a']);
  assert.equal(storeFilterCounts(TAGGED).recommended, 1);

  // A description reads in the reading language, then English, then the registry's own text;
  // a blank translation never hides the registry's description.
  const described = { description: 'native', description_i18n: { en: 'english', zh: '中文', ms: '  ' } };
  assert.equal(pluginDescription('zh', described), '中文');
  assert.equal(pluginDescription('zh-Hant', described), 'english');
  assert.equal(pluginDescription('ms', described), 'english');
  assert.equal(pluginDescription('en', { description: 'native' }), 'native');
  // The store search finds an entry by the description its card shows, and by the registry's.
  const localized = [entry({ store_id: 'c/l', description: 'Token buckets', description_i18n: { zh: '令牌桶限流' } })];
  assert.equal(filterStorePlugins(localized, '令牌桶', 'all', 'zh').length, 1);
  assert.equal(filterStorePlugins(localized, 'token', 'all', 'zh').length, 1);

  // The built-in catalog and the OMC community registry have pages of their own; neither
  // is a choice in CPA's store.
  assert.deepEqual(
    cpaStoreSources([
      { id: 'official', name: 'official', url: 'https://o', is_official: true, source_kind: 'official' },
      { id: 'builtin', name: 'OMC', url: 'https://b', is_official: false, source_kind: 'builtin' },
      { id: 'omc-community', name: 'Oh My CPA', url: 'https://c', is_official: false, source_kind: 'omc_community' },
      { id: 'mirror', name: 'mirror', url: 'https://m', is_official: false, source_kind: 'community' },
    ]).map((source) => source.id),
    ['official', 'mirror'],
  );

  // An installed row is described by the registry it came from: a built-in entry with the same
  // id does not describe a copy installed from elsewhere.
  const installed = (overrides: Partial<PluginItem>): PluginItem => ({
    id: 'zc', configured: true, registered: true, enabled: true, effective_enabled: true, config_fields: [], source_kind: 'community', ...overrides,
  });
  const storeEntry = entry({ id: 'zc', description: 'store text' });
  assert.equal(installedPluginDescription('zh', installed({}), storeEntry), 'store text');
  // Built-ins are not shown in the ordinary installed list, and a same-id store
  // listing is never allowed to describe them by accident.
  assert.equal(installedPluginDescription('zh', installed({ source_kind: 'builtin' }), storeEntry), 'store text');
  assert.equal(installedPluginDescription('en', installed({ description: 'own', description_i18n: { en: 'own en' } }), storeEntry), 'own en');
  // One source describes the row. A plugin that declared only its plain text keeps it:
  // taking the listing's translations alongside the plugin's own words would show the
  // registry's wording - which may describe a newer release than the installed copy.
  assert.equal(installedPluginDescription('en', installed({ description: 'own' }), entry({ id: 'zc', description: 'store text', description_i18n: { en: 'store en' } })), 'own');

  // ── built-in plugins ───────────────────────────────────────────────────────
  // Only the server's explicit code may report a policy as saved; anything else is a failure.
  assert.equal(builtinWriteFailure('policy_revision_conflict', 409), 'conflict');
  assert.equal(builtinWriteFailure('builtin_policy_apply_incomplete', 502), 'saved-unconfirmed');
  assert.equal(builtinWriteFailure('', 400), 'refused');
  // No answer, or a server fault without a code, says nothing about whether the write landed.
  assert.equal(builtinWriteFailure('', 0), 'unknown');
  assert.equal(builtinWriteFailure('', 500), 'unknown');
  assert.equal(builtinReasonKey('automation_disabled'), 'plugin.builtin_reason_automation_disabled');
  assert.equal(builtinReasonKey('toString'), undefined);

  // A built-in's switch is its policy's: a settings save never moves it, from either view.
  assert.deepEqual(withSavedEnabled({ enabled: false, region: 'cn' }, { enabled: true }), { enabled: true, region: 'cn' });
  assert.deepEqual(withSavedEnabled({ enabled: false, region: 'cn' }, {}), { region: 'cn' });

  // Versions name only what differs from the installed copy.
  assert.deepEqual(builtinVersionFacts({ version: '0.1.5', installed_version: '0.1.5', runtime_version: '0.1.5' }), { current: 'v0.1.5', update: undefined, running: undefined });
  assert.deepEqual(builtinVersionFacts({ version: '0.2.0', installed_version: '0.1.5', runtime_version: '0.1.4' }), { current: 'v0.1.5', update: 'v0.2.0', running: 'v0.1.4' });
  assert.deepEqual(builtinVersionFacts({ version: '0.2.0', installed_version: '', runtime_version: '' }), { available: 'v0.2.0', running: undefined });

  const builtin = { id: 'z', name: 'Z', description: '', version: '0.2.0', source_id: 'b', source_kind: 'builtin' as const, policy: { enabled: true },
    status: 'running' as const, installed_version: '0.1.5', runtime_version: '0.1.5', registered: true, effective_enabled: true, reason: '' };
  assert.deepEqual(builtinChanges([builtin], [{ ...builtin, installed_version: '0.2.0' }]), [{ id: 'z', name: 'Z', kind: 'updated', version: 'v0.2.0' }]);
  assert.deepEqual(builtinChanges([{ ...builtin, installed_version: '' }], [builtin]), [{ id: 'z', name: 'Z', kind: 'installed', version: 'v0.1.5' }]);
  assert.deepEqual(builtinChanges([builtin], [{ ...builtin, installed_version: '' }]), [{ id: 'z', name: 'Z', kind: 'removed', version: 'v0.1.5' }]);
  assert.deepEqual(builtinChanges([builtin], [builtin]), []);
  // A plugin the operator switched off, or one still being worked on, is not a problem to report.
  assert.equal(needsAttention({ ...builtin, status: 'disabled' }, true), false);
  assert.equal(needsAttention({ ...builtin, status: 'pending' }, true), false);
  assert.equal(needsAttention({ ...builtin, status: 'restart_required' }, true), true);
  assert.equal(needsAttention({ ...builtin, status: 'not_installed' }, true), true);
  assert.equal(needsAttention({ ...builtin, status: 'not_installed', policy: { enabled: false } }, true), false);
  // Two registries listing one id are two cards, and an installed row borrows only from the
  // registry its install record names.
  assert.notEqual(storeEntryKey(STORE[1]), storeEntryKey(STORE[2]));
  const listings = storeListingsBySource(STORE);
  const loggerInstalled = { id: 'logger', configured: true, registered: true, enabled: true, effective_enabled: true, config_fields: [], source_kind: 'community' } as PluginItem;
  assert.equal(installedListing(listings, { ...loggerInstalled, source_id: 'mirror' })?.store_id, 'mirror/logger');
  assert.equal(installedListing(listings, { ...loggerInstalled, source_id: 'official' })?.store_id, 'official/logger');
  assert.equal(installedListing(listings, { ...loggerInstalled, source_id: 'elsewhere' }), undefined);
  assert.equal(installedListing(listings, loggerInstalled), undefined);
  assert.deepEqual(
    sortRecommendedFirst([entry({ id: 'a' }), entry({ id: 'b', tags: ['OMC'] }), entry({ id: 'c' })]).map((item) => item.id),
    ['b', 'a', 'c'],
  );

  // The origin mark keeps the registry that listed an entry apart from whose code it names:
  // the official registry is a catalogue, and it lists community authors' repositories.
  assert.deepEqual(
    [
      entry({}),
      entry({ is_official_repository: false }),
      entry({ is_official: false }),
      entry({ is_official: false, is_official_repository: false }),
      entry({ is_official: false, source_kind: 'omc_community' }),
    ].map(storePluginOrigin),
    ['official', 'official-source', 'third-party', 'third-party', 'omc-community'],
  );
  // Only the vendor's own code from the vendor's own registry installs without an
  // acknowledgement; every other origin's warning block is what the operator types into.
  assert.deepEqual(
    (['omc-community', 'official', 'official-source', 'third-party'] as const).map((origin) => STORE_INSTALL_WARNINGS[origin]?.title ?? null),
    [
      'plugin.omc_plugin_title',
      null,
      'plugin.official_source_plugin_title',
      'plugin.third_party_title',
    ],
  );
  assert.equal(storeInstallConfirmToken(entry({ id: 'deepseek-search' })), 'deepseek-search');

  // ── plugin system settings ─────────────────────────────────────────────────
  assert.deepEqual(
    validatePluginSettingsDraft(
      ['https://a.example/r.json', '', 'ftp://b.example', 'https://a.example/r.json'],
      [
        { match: '', apply_to: [], type: 'none', allow_insecure: false },
        { match: 'https://x/', apply_to: [], type: 'basic', username_env: 'USER', password_env: 'bad name', allow_insecure: false },
        { match: 'https://x/', apply_to: [], type: 'header', header_name: 'bad header', header_value_env: 'V', allow_insecure: false },
      ],
    ),
    [
      { kind: 'source-url', index: 2 },
      { kind: 'source-duplicate', index: 3 },
      { kind: 'rule-match', index: 0 },
      { kind: 'rule-env', index: 1, field: 'password_env' },
      { kind: 'rule-header', index: 2 },
    ],
  );
  // Switching a rule's type drops the variables the new type does not read.
  assert.deepEqual(
    normalizePluginSettingsDraft([' https://a.example/r.json ', ''], [
      { match: ' https://x/ ', apply_to: ['artifact', 'registry'], type: 'bearer', token_env: 'T', username_env: 'STALE', allow_insecure: false },
    ]),
    {
      storeSources: ['https://a.example/r.json'],
      storeAuth: [{
        match: 'https://x/', apply_to: ['registry', 'artifact'], type: 'bearer', token_env: 'T',
        username_env: undefined, password_env: undefined, header_name: undefined, header_value_env: undefined, allow_insecure: false,
      }],
    },
  );

  // The declared default is what an unset key falls back to; the empty control names it as text.
  assert.equal(pluginFieldDefaultText({ name: 'mode', type: 'enum', default: 'safe' }), 'safe');
  assert.equal(pluginFieldDefaultText({ name: 'retries', type: 'integer', default: 3 }), '3');
  assert.equal(pluginFieldDefaultText({ name: 'hosts', type: 'array', default: ['a', 'b'] }), '["a","b"]');
  assert.equal(pluginFieldDefaultText({ name: 'mode', type: 'string' }), undefined);
  assert.equal(pluginFieldDefaultText({ name: 'blob', type: 'string', default: 'x'.repeat(200) })?.length, 80);
});
