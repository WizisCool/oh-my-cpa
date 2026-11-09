import assert from 'node:assert/strict';
import { parsePluginConfig, pluginConfigsEqual, pluginConfigSummary } from '../../src/components/plugins/pluginConfig.ts';
import {
  buildPluginConfigDraft,
  composePluginConfig,
  isPluginFieldChanged,
  pluginFieldDefaultText,
  pluginFieldKind,
  undeclaredPluginKeys,
} from '../../src/components/plugins/pluginConfigForm.ts';
import {
  filterInstalledPlugins,
  filterStorePlugins,
  installedPluginOrigin,
  normalizePluginSettingsDraft,
  STORE_INSTALL_WARNINGS,
  storeFilterCounts,
  storeInstallConfirmToken,
  storeListingsByPluginId,
  storePluginOrigin,
  storeSections,
  storeSectionPreview,
  STORE_SECTION_PREVIEW,
  matchesInstalledState,
  validatePluginSettingsDraft,
} from '../../src/components/plugins/pluginStoreLogic.ts';
import type { PluginConfigField, PluginItem, StorePluginItem } from '../../src/types/plugin.ts';
import { test } from 'vitest';
import { selectInstalledPluginMetadata, selectStorePluginMetadata } from '../../src/types/pluginStoreMetadata.ts';

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
      store_id: 'official/x', source_id: 'official', source_name: 'official', id: 'x', name: 'X', tags: [], platforms: [],
      is_official: true, is_official_repository: true, is_omc: false, is_omc_repository: false, auth_required: false, auth_configured: false, installed: false, effective_enabled: false,
      update_available: false, ...overrides,
    };
  }
  const STORE = [
    entry({ store_id: 'official/limiter', id: 'limiter', name: 'Rate Limiter', tags: ['network'] }),
    entry({ store_id: 'official/logger', id: 'logger', name: 'Logger', installed: true, update_available: true, install_source_status: 'matched' }),
    entry({ store_id: 'mirror/logger', source_id: 'mirror', id: 'logger', name: 'Logger', is_official: false, installed: true, install_source_status: 'different', description: 'mirror copy' }),
  ];
  assert.deepEqual(storeFilterCounts(STORE), { all: 3, installed: 2, available: 1, updates: 1 });
  assert.deepEqual(filterStorePlugins(STORE, 'NETWORK', 'all', 'en').map((item) => item.store_id), ['official/limiter']);
  const multiPortalPlugin: PluginItem = {
    id: 'relay', configured: true, registered: true, enabled: true, effective_enabled: true,
    supports_oauth: true, oauth_provider: 'relay-primary', oauth_providers: ['relay-primary', 'relay-secondary'], config_fields: [],
  };
  assert.deepEqual(filterInstalledPlugins([multiPortalPlugin], ' RELAY-SECONDARY ', new Map(), 'en'), [multiPortalPlugin]);
  assert.deepEqual(filterInstalledPlugins([multiPortalPlugin], 'other-portal', new Map(), 'en'), []);
  assert.deepEqual(filterStorePlugins(STORE, '', 'updates', 'en').map((item) => item.store_id), ['official/logger']);
  const localizedEntry = entry({
    id: 'localized', name: 'Base title', description: 'Base description', tags: ['base-tag'],
    locales: {
      'zh-CN': { name: '简体标题', description: '简体描述', tags: ['简体标签'] },
      'zh-Hant': { name: '繁體標題', description: '繁體描述', tags: ['繁體標籤'] },
    },
  });
  assert.deepEqual(filterStorePlugins([localizedEntry], '简体描述', 'all', 'zh'), [localizedEntry]);
  assert.deepEqual(filterStorePlugins([localizedEntry], '繁體標籤', 'all', 'zh-Hant'), [localizedEntry]);
  assert.deepEqual(filterStorePlugins([localizedEntry], '简体标题', 'all', 'zh-Hant'), []);
  assert.deepEqual(filterStorePlugins([localizedEntry], 'base-tag', 'all', 'zh'), []);
  assert.deepEqual(filterStorePlugins([localizedEntry], 'base description', 'all', 'en'), [localizedEntry]);
  assert.deepEqual(filterStorePlugins([localizedEntry], 'localized', 'all', 'zh'), [localizedEntry]);
  const localizedInstalled = { ...multiPortalPlugin, id: 'localized' };
  const localizedCatalog = storeListingsByPluginId([localizedEntry]);
  assert.deepEqual(filterInstalledPlugins([localizedInstalled], '繁體描述', localizedCatalog, 'zh-Hant'), [localizedInstalled]);
  assert.deepEqual(filterInstalledPlugins([localizedInstalled], '简体标签', localizedCatalog, 'zh-Hant'), []);
  const base = entry({
    name: 'Base name', description: 'Base description', author: 'Base author',
    homepage: 'https://publisher.example', license: 'Base license', tags: ['base-tag'],
  });
  const baseMetadata = selectStorePluginMetadata(base, 'en');
  assert.deepEqual(baseMetadata, {
    name: base.name, description: base.description, author: base.author,
    homepage: base.homepage, license: base.license, tags: base.tags,
  });
  for (const [lang, locale] of [
    ['zh', 'zh-CN'], ['zh', 'zh-Hans'], ['zh', 'zh'],
    ['zh-Hant', 'zh-HK'], ['zh-Hant', 'zh-Hant'], ['zh-Hant', 'zh-TW'],
    ['en', 'en'], ['ms', 'ms-MY'], ['ms', 'ms'],
  ] as const) {
    const translated = { ...baseMetadata, name: `Title ${locale}`, description: `Text ${locale}`, author: `Author ${locale}`, homepage: `https://publisher.example/${locale}`, license: `License ${locale}`, tags: [locale] };
    assert.deepEqual(selectStorePluginMetadata({ ...base, locales: { [locale]: translated } }, lang), translated);
  }
  assert.deepEqual(selectStorePluginMetadata({ ...base, locales: { 'zh-CN': { name: '简体' }, zh: { name: '通用' } } }, 'zh-Hant'), baseMetadata);
  assert.deepEqual(selectStorePluginMetadata({ ...base, locales: { 'zh-Hant': { name: '繁體' }, 'zh-TW': { name: '臺灣' } } }, 'zh'), baseMetadata);
  assert.deepEqual(selectStorePluginMetadata({ ...base, locales: { en: { name: ' ', description: 'Localized', author: '', homepage: '', license: '', tags: [' '] } } }, 'en'), { ...baseMetadata, description: 'Localized' });
  assert.deepEqual(selectStorePluginMetadata({ ...base, locales: { 'zh-CN': { name: 'Regional' }, 'zh-Hans': { description: 'Other variant' } } }, 'zh'), { ...baseMetadata, name: 'Regional' });
  assert.equal(selectStorePluginMetadata({ ...base, locales: { 'zh-HK': { name: 'Hong Kong' }, 'zh-Hant': { name: 'Traditional' }, 'zh-TW': { name: 'Taiwan' } } }, 'zh-Hant').name, 'Hong Kong');
  const registeredPlugin = { ...localizedInstalled, metadata: { name: 'Runtime name', author: 'Runtime author', version: '1.0.0' } };
  const confirmedListing = { ...localizedEntry, installed: true, install_source_status: 'matched' };
  assert.equal(selectInstalledPluginMetadata(registeredPlugin, confirmedListing, 'zh').name, '简体标题');
  assert.equal(selectInstalledPluginMetadata(registeredPlugin, confirmedListing, 'en').name, 'Runtime name');
  assert.equal(selectInstalledPluginMetadata(registeredPlugin, confirmedListing, 'zh').author, 'Runtime author');
  assert.equal(selectInstalledPluginMetadata(registeredPlugin, undefined, 'zh').name, 'Runtime name');
  for (const listing of [
    { ...confirmedListing, install_source_status: 'different' },
    { ...confirmedListing, install_source_status: undefined },
    { ...confirmedListing, installed: false },
    { ...confirmedListing, id: 'different-plugin' },
  ]) {
    const foreignListing = { ...listing, author: 'Foreign author', locales: { 'zh-CN': { name: 'Foreign name', author: 'Foreign translated author' } } };
    const metadata = selectInstalledPluginMetadata(registeredPlugin, foreignListing, 'zh');
    assert.equal(metadata.name, 'Runtime name');
    assert.equal(metadata.author, 'Runtime author');
    const catalog = storeListingsByPluginId([foreignListing]);
    assert.deepEqual(filterInstalledPlugins([registeredPlugin], 'Foreign', catalog, 'zh'), []);
    assert.deepEqual(filterInstalledPlugins([registeredPlugin], 'Runtime name', catalog, 'zh'), [registeredPlugin]);
    const withoutRuntimeMetadata = selectInstalledPluginMetadata({ ...registeredPlugin, metadata: undefined }, foreignListing, 'zh');
    assert.equal(withoutRuntimeMetadata.name, registeredPlugin.id);
    assert.equal(withoutRuntimeMetadata.author, undefined);
  }

  assert.deepEqual(selectStorePluginMetadata({ ...base, locales: { en: Object.assign({ name: 'Translated' }, { id: 'evil', source_id: 'evil', is_official: true }) } }, 'en'), { ...baseMetadata, name: 'Translated' });
  assert.equal(storeInstallConfirmToken(localizedEntry), 'localized');
  assert.equal(storePluginOrigin(localizedEntry), storePluginOrigin({ ...localizedEntry, locales: undefined }));
  // An installed plugin's provenance is the listing that supplied the running copy; another
  // registry's offer for the same id is not it, and an unread store says nothing at all.
  assert.equal(installedPluginOrigin(entry({ id: 'own', is_official: false, is_omc: true, is_omc_repository: true, install_source_status: 'matched' })), 'omc');
  assert.equal(installedPluginOrigin(entry({ install_source_status: 'different' })), undefined);
  assert.equal(installedPluginOrigin(entry({ install_source_status: undefined })), undefined);
  assert.equal(installedPluginOrigin(undefined), undefined);
  // The listing an installed card borrows is the one it was installed from.
  assert.equal(storeListingsByPluginId(STORE).get('logger')?.store_id, 'official/logger');

  // The origin mark keeps the registry that listed an entry apart from whose code it names:
  // the official registry is a catalogue, and it lists community authors' repositories.
  assert.deepEqual(
    [
      entry({}),
      entry({ is_official_repository: false }),
      entry({ is_official: false }),
      entry({ is_official: false, is_official_repository: false }),
      entry({ is_official: false, is_omc: true, is_omc_repository: true }),
      entry({ is_official: false, is_omc: true }),
    ].map(storePluginOrigin),
    ['official', 'official-source', 'third-party', 'third-party', 'omc', 'omc-community'],
  );
  // Only a first-party registry's own publisher's code installs without an acknowledgement;
  // every other origin's warning block is what the operator types into.
  assert.deepEqual(
    (['omc', 'omc-community', 'official', 'official-source', 'third-party'] as const).map((origin) => STORE_INSTALL_WARNINGS[origin]?.title ?? null),
    [
      null,
      'plugin.omc_community_plugin_title',
      null,
      'plugin.official_source_plugin_title',
      'plugin.third_party_title',
    ],
  );
  // The store opens with the plugins Oh My CPA maintains; the ones it curates sit after CPA's
  // registry, with the other catalogues. A registry that failed to read keeps a section to say so in.
  const omcOwn = entry({ store_id: 'omc/own', source_id: 'omc', id: 'own', is_official: false, is_omc: true, is_omc_repository: true });
  const omcCurated = entry({ store_id: 'omc/curated', source_id: 'omc', id: 'curated', is_official: false, is_omc: true });
  const mirrorEntry = entry({ store_id: 'mirror/m', source_id: 'mirror', id: 'm', is_official: false });
  const sections = storeSections({
    plugins_enabled: true, plugins_dir: 'plugins', total: 4,
    sources: [
      { id: 'official', name: 'official', url: 'https://o/r.json', is_official: true, is_omc: false },
      { id: 'mirror', name: 'mirror.example', url: 'https://m/r.json', is_official: false, is_omc: false },
      { id: 'omc', name: 'Oh My CPA', url: 'https://omc/r.json', is_official: false, is_omc: true },
    ],
    source_errors: [{ source_id: 'down', source_name: 'down.example', source_url: 'https://d/r.json', message: '503' }],
    plugins: [],
  }, [STORE[0], mirrorEntry, omcCurated, omcOwn]);
  assert.deepEqual(
    sections.map((section) => [section.kind, section.sourceId, section.entries.map((item) => item.id), section.error ?? null]),
    [
      ['omc', 'omc', ['own'], null],
      ['official', 'official', ['limiter'], null],
      ['omc-community', 'omc#community', ['curated'], null],
      ['custom', 'mirror', ['m'], null],
      ['custom', 'down', [], '503'],
    ],
  );
  // A long registry shows its first cards while the whole store is in view, all of them once chosen.
  const longSection = { kind: 'custom' as const, sourceId: 'long', name: 'long', entries: Array.from({ length: STORE_SECTION_PREVIEW + 2 }, (_, index) => entry({ id: `p${index}` })) };
  assert.equal(storeSectionPreview(longSection, true).length, STORE_SECTION_PREVIEW);
  assert.equal(storeSectionPreview(longSection, false).length, STORE_SECTION_PREVIEW + 2);
  // A tag narrows to the entries carrying it as the card shows it, in any case.
  assert.deepEqual(filterStorePlugins(STORE, '', 'all', 'en', 'Network').map((item) => item.store_id), ['official/limiter']);
  assert.deepEqual(
    (['running', 'stopped'] as const).map((state) => [multiPortalPlugin, { ...multiPortalPlugin, effective_enabled: false }].filter((plugin) => matchesInstalledState(plugin, state)).length),
    [1, 1],
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
