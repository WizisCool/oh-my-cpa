import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  BUILTIN_OAUTH_PROVIDERS,
  XAI_CALLBACK_URL,
  builtinOAuthProviderChoices,
  lookupOAuthProvider,
  pluginOAuthProviderChoices,
  normalizeOAuthFlow,
  normalizeOAuthStatus,
  resolveStartedOAuthFlow,
  resolveXaiCallback,
  validateDevinCallback,
} from '../../src/pages/oauthProviderLogic.ts';
import { BUILTIN_OAUTH_IDS, OAUTH_PROVIDER_PATTERN, pluginOAuthProviderTitles } from '../../src/types/pluginOAuthProviders.ts';
import { providerDisplayName } from '../../src/types/providerMetadata.ts';

test('Registry: provider ids are unique, routable and consistent with the lookup', () => {
  assert.ok(BUILTIN_OAUTH_PROVIDERS.length > 0, 'registry must not be empty');
  for (const provider of BUILTIN_OAUTH_PROVIDERS) {
    assert.match(provider.id, OAUTH_PROVIDER_PATTERN, `${provider.id} must be a valid CPA provider id`);
    assert.equal(provider.id, provider.id.toLowerCase(), `${provider.id} must be lower case`);
    assert.ok(provider.keyBase.length > 0, `${provider.id} needs an i18n key base`);
    assert.ok(provider.iconId.length > 0, `${provider.id} needs a brand mark`);
    assert.equal(lookupOAuthProvider(provider.id)?.id, provider.id, `${provider.id} must be resolvable`);
    // A redirect flow without callback rules would render no way to submit the
    // paste, which is the only way a remote browser can finish it.
    if (provider.flow === 'manual-callback') {
      assert.ok(provider.callback, `${provider.id} is a redirect flow and needs callback rules`);
      assert.ok(provider.callback?.errorKeys.invalid, `${provider.id} needs an invalid-paste message`);
      assert.ok(provider.callback?.errorKeys.missingState, `${provider.id} needs a missing-state message`);
    } else {
      assert.equal(provider.callback, undefined, `${provider.id} is a device flow and cannot take a paste`);
    }
  }
  assert.deepEqual([...BUILTIN_OAUTH_IDS].sort(), BUILTIN_OAUTH_PROVIDERS.map((provider) => provider.id).sort(), 'registry ids are unique and match the leaf list every surface reads');
});

test('Registry: the Devin and Meta Muse adapters are registered', () => {
  const devin = lookupOAuthProvider('DEViN');
  assert.equal(devin?.flow, 'manual-callback');
  assert.equal(devin?.keyBase, 'devin');
  assert.equal(devin?.requiresExplicitCancel, true, 'Devin holds one attempt at a time');
  assert.equal(typeof devin?.callback?.validate, 'function', 'Devin must judge the pasted redirect');

  const meta = lookupOAuthProvider('meta');
  assert.equal(meta?.flow, 'device');
  assert.equal(meta?.keyBase, 'meta');
  assert.equal(meta?.requiresExplicitCancel, undefined, 'a device flow is restartable by design');

  assert.equal(lookupOAuthProvider('not-a-provider'), undefined);
});

test('normalizeOAuthFlow: unknown labels keep the declared flow', () => {
  assert.equal(normalizeOAuthFlow('device'), 'device');
  assert.equal(normalizeOAuthFlow(' DEVICE '), 'device');
  assert.equal(normalizeOAuthFlow('redirect'), 'manual-callback');
  assert.equal(normalizeOAuthFlow('callback'), 'manual-callback');
  assert.equal(normalizeOAuthFlow(''), undefined);
  assert.equal(normalizeOAuthFlow(undefined), undefined);
  assert.equal(normalizeOAuthFlow('telepathy'), undefined);
});

test('normalizeOAuthStatus: legacy aliases must not become terminal states on their own', () => {
  assert.equal(normalizeOAuthStatus('ok'), 'ok');
  assert.equal(normalizeOAuthStatus('success'), 'ok');
  assert.equal(normalizeOAuthStatus('wait'), 'wait');
  assert.equal(normalizeOAuthStatus('pending'), 'wait');
  assert.equal(normalizeOAuthStatus('error'), 'error');
  assert.equal(normalizeOAuthStatus('failed'), 'error');
  assert.equal(normalizeOAuthStatus(undefined), 'wait');
});

test('validateDevinCallback: accepts a complete redirect for this attempt', () => {
  const state = 'devin-12345';
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc&state=${state}`, state),
    undefined,
  );
  assert.equal(
    validateDevinCallback(`https://proxy.example.test/devin/callback?state=${state}&code=abc`, state),
    undefined,
  );
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/devin/callback?state=${state}&error=access_denied`, state),
    undefined,
    'a denial is a real callback and has to reach CPA so the session ends',
  );
});

test('validateDevinCallback: refuses anything that cannot belong to this attempt', () => {
  const state = 'devin-12345';
  assert.equal(validateDevinCallback('', state), 'invalid');
  assert.equal(validateDevinCallback('abc123', state), 'invalid', 'a bare code is not enough for Devin');
  assert.equal(validateDevinCallback(`not-a-url?code=abc&state=${state}`, state), 'invalid');
  assert.equal(validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc`, state), 'invalid', 'no state');
  assert.equal(validateDevinCallback(`http://127.0.0.1:8317/callback?state=${state}`, state), 'invalid', 'no code or error');
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc&state=${state}&state=other`, state),
    'invalid',
    'two states cannot be attributed to one attempt',
  );
  assert.equal(
    validateDevinCallback('http://127.0.0.1:8317/callback?code=abc&state=stale-session', state),
    'state_mismatch',
    'a callback from an earlier attempt must not be submitted against this one',
  );
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc&state=${state}`, undefined),
    'state_mismatch',
    'without a live state the paste cannot be attributed at all',
  );
});

// Query order is not part of the contract, so comparisons go through the parsed
// parameters rather than the serialized string.
function paramsOf(url: string): Record<string, string> {
  const parsed = new URL(url);
  const out: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

test('resolveXaiCallback: a real URL is submitted verbatim', () => {
  const url = 'http://127.0.0.1:56121/callback?code=xyz&state=abc';
  assert.equal(resolveXaiCallback(url, 'abc'), url);
});

test('resolveXaiCallback: a bare code is rebuilt against the fixed local callback', () => {
  for (const input of ['code=xyz', 'xyz', 'code: xyz']) {
    const resolved = resolveXaiCallback(input, 'state-1');
    assert.ok(resolved, `${input} must resolve`);
    assert.equal(new URL(resolved!).origin + new URL(resolved!).pathname, XAI_CALLBACK_URL);
    assert.deepEqual(paramsOf(resolved!), { state: 'state-1', code: 'xyz' });
  }
});

test('resolveXaiCallback: a printed code line is not mistaken for a URL', () => {
  // `new URL("Code: xyz")` parses as a `code:` URL, so an unguarded absolute-URL
  // probe submits the displayed line verbatim and loses the code it carries.
  const resolved = resolveXaiCallback('Code: xyz', 'state-1');
  assert.ok(resolved, 'a printed code line must still resolve');
  assert.deepEqual(paramsOf(resolved!), { state: 'state-1', code: 'xyz' });
});

test('resolveXaiCallback: cannot fabricate a callback without the live state', () => {
  assert.equal(resolveXaiCallback('xyz', undefined), null);
  assert.equal(resolveXaiCallback('', 'state-1'), null);
});

test('resolveXaiCallback: a partial callback keeps the state it arrived with', () => {
  assert.deepEqual(paramsOf(resolveXaiCallback('?code=xyz&state=abc', 'state-1')!), { state: 'abc', code: 'xyz' });
  assert.deepEqual(paramsOf(resolveXaiCallback('?error=access_denied&state=abc', 'state-1')!), { state: 'abc', error: 'access_denied' });
  assert.deepEqual(
    paramsOf(resolveXaiCallback('?code=xyz&error=access_denied&error_description=denied&state=abc', 'state-1')!),
    { state: 'abc', code: 'xyz', error: 'access_denied', error_description: 'denied' },
  );
  assert.equal(
    new URL(resolveXaiCallback('?code=xyz', 'state-1')!).searchParams.get('state'),
    'state-1',
    'a callback without its own state borrows the live one',
  );
});


test('provider choices keep built-ins, plugin ids and disabled discovery separate', () => {
  const t = ((key: string, args?: { name?: string }) => args?.name || key) as Parameters<typeof builtinOAuthProviderChoices>[0];
  const builtins = builtinOAuthProviderChoices(t);
  assert.equal(builtins.find((provider) => provider.id === 'anthropic')?.title, 'oauth.anthropic_title');
  assert.equal(builtins.some((provider) => provider.id === 'codex'), true);

  const choices = pluginOAuthProviderChoices([
    {
      id: 'disabled-shadow', enabled: false, effective_enabled: false, supports_oauth: true,
      oauth_providers: ['iflow-international'], logo: 'data:image/svg+xml,disabled-shadow',
    },
    {
      id: 'iflow-auth',
      name: 'iFlow Alliance Auth',
      description: '',
      version: '',
      author: '',
      enabled: true,
      effective_enabled: true,
      registered: true,
      supports_oauth: true,
      oauth_provider: 'iflow',
      oauth_providers: [' IFLOW ', 'iflow-international', 'iflow-international', 'bad/path', 'codex'],
      metadata: { name: 'iFlow Alliance Auth' },
      logo: 'data:image/svg+xml,fixture',
      permissions: [],
    },
    {
      id: 'disabled-auth',
      name: 'Disabled Auth',
      description: '',
      version: '',
      author: '',
      enabled: false,
      effective_enabled: false,
      registered: true,
      supports_oauth: true,
      oauth_provider: 'disabled',
      oauth_providers: ['disabled', 'disabled-secondary'],
      permissions: [],
    },
    {
      id: 'codex',
      name: 'Duplicate built-in',
      description: '',
      version: '',
      author: '',
      enabled: true,
      effective_enabled: true,
      registered: true,
      supports_oauth: true,
      oauth_provider: 'codex',
      permissions: [],
    },
    {
      id: 'duplicate-auth', enabled: true, effective_enabled: true, supports_oauth: true,
      oauth_providers: ['iflow-international'],
    },
    {
      id: 'stopped-auth', enabled: true, effective_enabled: false, supports_oauth: true,
      oauth_providers: ['stopped-secondary'],
    },
    { id: 'not-auth', enabled: true, effective_enabled: true, oauth_providers: ['not-auth-secondary'] },
    { id: 'legacy-auth', enabled: true, supports_oauth: true, oauth_provider: 'legacy-login' },
    { id: 'legacy-id', enabled: true, supports_oauth: true },
    { id: 'plural-only', enabled: true, effective_enabled: true, supports_oauth: true, oauth_providers: ['portal-one', 'portal-two'] },
    { id: 'invalid-portals', enabled: true, effective_enabled: true, supports_oauth: true, oauth_providers: [' ', 'bad/path', 'bad?query'] },
  ], t);

  assert.deepEqual(choices.map((choice) => choice.id), ['iflow', 'iflow-international', 'legacy-login', 'legacy-id', 'portal-one', 'portal-two']);
  assert.equal(choices[0].pluginId, 'iflow-auth');
  assert.equal(choices[0].logo, 'data:image/svg+xml,fixture');
  assert.equal(choices[0].callback?.errorKeys.missingState, 'oauth.missing_state');
  assert.equal(choices[1].pluginId, 'iflow-auth');
  assert.equal(choices[1].logo, choices[0].logo);
  assert.notEqual(choices[0].title, choices[1].title);
  assert.equal(choices[0].title.includes('iflow'), true);
  assert.equal(choices[1].title.includes('iflow-international'), true);
  assert.equal(choices[4].pluginId, 'plural-only');
  assert.equal(choices[5].pluginId, 'plural-only');
});


test('a plugin\'s login cards carry each portal\'s own name and mark', () => {
  const t = ((key: string, args?: { name?: string }) => args?.name || key) as Parameters<typeof builtinOAuthProviderChoices>[0];
  const zaiLogo = 'https://cdn.example.test/zai.png';
  const bigmodelLogo = 'http://cdn.example.test/bigmodel.png';
  const [zai, bigmodel, plain] = pluginOAuthProviderChoices([
    {
      id: 'omc-zcode-oauth', enabled: true, effective_enabled: true, supports_oauth: true,
      oauth_providers: ['zcode-zai', 'zcode-bigmodel', 'zcode-legacy'],
      metadata: { name: 'OMC ZCode OAuth' },
      logo: 'data:image/svg+xml,%3Csvg%20id%3D%22plugin%22/%3E',
      oauth_provider_entries: [
        { identifier: 'zcode-zai', name: 'Z.ai', logo: zaiLogo },
        { identifier: 'zcode-bigmodel', name: 'BigModel', logo: bigmodelLogo },
      ],
    },
  ], t);

  // Two portals of one plugin answer with one account system each, so the card names the
  // portal rather than the plugin, and draws that portal's own brand instead of the
  // plugin's - a BigModel card wearing Z.ai's mark mislabels the operator's credential.
  assert.equal(zai.id, 'zcode-zai');
  assert.equal(zai.title, 'Z.ai');
  assert.equal(zai.logo, zaiLogo);
  assert.equal(bigmodel.id, 'zcode-bigmodel');
  assert.equal(bigmodel.title, 'BigModel');
  assert.equal(bigmodel.logo, bigmodelLogo);
  // A portal that publishes no text of its own keeps v0.3.19's reading: the identifier
  // in the title, the plugin's mark in the card.
  assert.equal(plain.id, 'zcode-legacy');
  assert.equal(plain.title, 'OMC ZCode OAuth · zcode-legacy');
  assert.equal(plain.logo, 'data:image/svg+xml,%3Csvg%20id%3D%22plugin%22/%3E');
  // The portal verdict does not change ownership: the card still belongs to the plugin.
  assert.deepEqual([zai.pluginId, bigmodel.pluginId, plain.pluginId], ['omc-zcode-oauth', 'omc-zcode-oauth', 'omc-zcode-oauth']);

  // CPA fills an entry's empty name from the plugin's metadata, so a portal that named
  // nothing of its own arrives reading as the plugin does. That is the fallback arriving
  // as text, not a portal label: the card keeps the identifier suffix it had before.
  const [named, filled] = pluginOAuthProviderChoices([{
    id: 'omc-zcode-oauth', enabled: true, effective_enabled: true, supports_oauth: true,
    oauth_providers: ['zcode-zai', 'zcode-bigmodel'],
    metadata: { name: 'OMC ZCode OAuth' },
    oauth_provider_entries: [
      { identifier: 'zcode-zai', name: 'Z.ai' },
      { identifier: 'zcode-bigmodel', name: 'OMC ZCode OAuth' },
    ],
  }], t);
  assert.equal(named.title, 'Z.ai');
  assert.equal(filled.title, 'OMC ZCode OAuth · zcode-bigmodel');

  // A portal logo that cannot be rendered falls back to the plugin's, then to the catalog.
  const [unusable] = pluginOAuthProviderChoices([{
    id: 'one-portal', enabled: true, effective_enabled: true, supports_oauth: true,
    oauth_provider: 'one-portal-login', logo: 'data:image/svg+xml,%3Csvg%20id%3D%22plugin%22/%3E',
    oauth_provider_entries: [{ identifier: 'one-portal-login', logo: 'javascript:alert(1)' }],
  }], t);
  assert.equal(unusable.logo, 'data:image/svg+xml,%3Csvg%20id%3D%22plugin%22/%3E');
  const [catalogOnly] = pluginOAuthProviderChoices([{
    id: 'anon-portal', enabled: true, effective_enabled: true, supports_oauth: true,
    oauth_provider: 'anon-portal-login',
    oauth_provider_entries: [{ identifier: 'anon-portal-login', logo: 'icons/anon.svg' }],
  }], t);
  assert.equal(catalogOnly.logo, undefined, 'an unusable mark leaves the catalog mark, never a plugin logo');
});

test('portal titles stay distinct when their identifiers share a credential-family alias', () => {
  const titles = pluginOAuthProviderTitles([{
    id: 'buddy', supports_oauth: true, enabled: false,
    oauth_providers: ['codebuddy', 'workbuddy', 'workbuddy-ai'],
    metadata: { name: 'Buddy' },
    oauth_provider_entries: [
      { identifier: 'codebuddy', name: 'CodeBuddy' },
      { identifier: 'workbuddy', name: 'Workbuddy' },
      { identifier: 'workbuddy-ai', name: 'Workbuddy AI' },
    ],
  }]);
  assert.equal(providerDisplayName('codebuddy', titles), 'CodeBuddy');
  assert.equal(providerDisplayName(' Workbuddy ', titles), 'Workbuddy');
  assert.equal(providerDisplayName('workbuddy-ai', titles), 'Workbuddy AI');
  assert.equal(providerDisplayName('buddy', titles), 'Buddy');
});

test('credentials keep the name their plugin\'s login card gives the provider', () => {
  const titles = pluginOAuthProviderTitles([
    // Switching a plugin off keeps its credentials, so it keeps naming them.
    { id: 'opencode', enabled: false, effective_enabled: false, supports_oauth: true, oauth_provider: 'opencode-go', metadata: { name: 'OpenCode Go' }, config_fields: [] },
    // A credential filed under an alias reads like the section it is grouped into.
    { id: 'buddy', enabled: true, effective_enabled: true, supports_oauth: true, oauth_provider: 'workbuddy', metadata: { name: 'WorkBuddy' }, config_fields: [] },
    // A built-in provider keeps its own name.
    { id: 'codex-shadow', enabled: true, effective_enabled: true, supports_oauth: true, oauth_provider: 'codex', metadata: { name: 'Shadow' }, config_fields: [] },
  ]);
  assert.equal(providerDisplayName('opencode-go', titles), 'OpenCode Go');
  assert.equal(providerDisplayName('workbuddy', titles), 'WorkBuddy');
  assert.equal(providerDisplayName('codebuddy', titles), 'WorkBuddy');
  assert.equal(providerDisplayName('codex', titles), 'Codex');
  // When an enabled plugin declares the same provider, its title wins, as its login card does.
  const overlapping = pluginOAuthProviderTitles([
    { id: 'old-go', enabled: false, effective_enabled: false, supports_oauth: true, oauth_provider: 'opencode-go', metadata: { name: 'Old Go' }, config_fields: [] },
    { id: 'opencode', enabled: true, effective_enabled: true, supports_oauth: true, oauth_provider: 'opencode-go', metadata: { name: 'OpenCode Go' }, config_fields: [] },
  ]);
  assert.equal(providerDisplayName('opencode-go', overlapping), 'OpenCode Go');
  // Provider keys come from plugins; an inherited member is not a brand, and a key nobody
  // names reads as recorded.
  assert.equal(providerDisplayName('constructor'), 'constructor');
  assert.equal(providerDisplayName(''), 'Unknown');
  // A plugin's own id and quota provider name the same credentials its login portal does.
  const familyKeys = pluginOAuthProviderTitles([
    { id: 'acme', enabled: true, effective_enabled: true, supports_oauth: true, oauth_provider: 'acme-login', quota_provider: 'acme-credentials', metadata: { name: 'Acme' }, config_fields: [] },
  ]);
  assert.equal(providerDisplayName('acme-credentials', familyKeys), 'Acme');
  assert.equal(providerDisplayName('acme', familyKeys), 'Acme');
  // Built-in credentials and CPA's native API-key families are never renamed by a plugin.
  const reserved = pluginOAuthProviderTitles([
    { id: 'shadow', enabled: true, effective_enabled: true, supports_oauth: true, oauth_providers: ['claude', 'gemini', 'interactions'], metadata: { name: 'Shadow' }, config_fields: [] },
  ]);
  assert.equal(providerDisplayName('claude', reserved), 'Claude');
  assert.equal(providerDisplayName('gemini', reserved), 'Gemini');
  assert.equal(providerDisplayName('interactions', reserved), 'interactions');
});


test('auth-provider metadata keeps login flow unknown and management pages independent', () => {
  const t = ((key: string) => key) as Parameters<typeof builtinOAuthProviderChoices>[0];
  const plugins = [{
    id: 'key-bridge', configured: true, registered: true, enabled: true,
    effective_enabled: true, supports_oauth: true, oauth_provider: 'key-service',
    oauth_providers: ['key-service', 'key-service-secondary'],
    config_fields: [], pages: [{ path: '/v0/resource/plugins/key-bridge/console', label: 'Credentials' }],
  }];
  const [choice] = pluginOAuthProviderChoices(plugins, t);
  assert.equal(choice.flow, 'plugin');
  assert.equal(choice.pluginPageRoute, '/plugin-pages/key-bridge/0');
  const secondary = pluginOAuthProviderChoices(plugins, t)[1];
  assert.equal(secondary.id, 'key-service-secondary');
  assert.equal(secondary.pluginPageRoute, choice.pluginPageRoute);
  assert.deepEqual(secondary.callback, choice.callback);
  const [pageless] = pluginOAuthProviderChoices([{ ...plugins[0], pages: [] }], t);
  assert.equal(pageless.flow, 'plugin', 'pageless auth providers have no declared login flow either');
  assert.equal(pageless.pluginPageRoute, undefined);
  assert.equal(choice.description, pageless.description, 'a management page must not change the login offer');
  assert.equal(choice.loginLabel, pageless.loginLabel);
  assert.deepEqual(choice.callback, {
    errorKeys: { invalid: 'oauth.callback_invalid_url', missingState: 'oauth.missing_state' },
  }, 'callback rules are available if a successful response declares a redirect flow');
  assert.deepEqual(pageless.callback, choice.callback);
});


test('plugin login flow is resolved only from a successful login response', () => {
  assert.equal(resolveStartedOAuthFlow('plugin', {}), 'plugin');
  assert.equal(resolveStartedOAuthFlow('plugin', { flow: 'device' }), 'device');
  assert.equal(resolveStartedOAuthFlow('plugin', { flow: 'redirect' }), 'manual-callback');
  assert.equal(resolveStartedOAuthFlow('plugin', { user_code: 'ABCD' }), 'device');
  assert.equal(resolveStartedOAuthFlow('plugin', { url: 'https://auth.example.test', state: 'session' }), 'manual-callback');
  assert.equal(resolveStartedOAuthFlow('plugin', { url: 'https://auth.example.test', session_id: 'session' }), 'manual-callback');
  assert.equal(resolveStartedOAuthFlow('plugin', { url: 'https://auth.example.test' }), 'plugin');
  assert.equal(resolveStartedOAuthFlow('device', {}), 'device');
  assert.equal(resolveStartedOAuthFlow('manual-callback', {}), 'manual-callback');
});


test('unknown plugin flow labels use successful response fields without inventing a flow', () => {
  assert.equal(resolveStartedOAuthFlow('plugin', {
    flow: 'custom', url: 'https://auth.example.test', state: 'session',
  }), 'manual-callback');
  assert.equal(resolveStartedOAuthFlow('plugin', {
    flow: 'custom', url: 'https://auth.example.test', session_id: 'session',
  }), 'manual-callback');
  assert.equal(resolveStartedOAuthFlow('plugin', {
    flow: 'custom', url: 'https://auth.example.test', state: 'session', user_code: 'ABCD',
  }), 'device', 'a returned device code takes precedence over redirect-shaped fields');
  assert.equal(resolveStartedOAuthFlow('plugin', { flow: 'custom' }), 'plugin');
  assert.equal(resolveStartedOAuthFlow('plugin', { flow: 'custom', url: 'https://auth.example.test' }), 'plugin');
  assert.equal(resolveStartedOAuthFlow('plugin', { flow: 'custom', url: ' ', state: 'session' }), 'plugin');
  assert.equal(resolveStartedOAuthFlow('plugin', { flow: 'custom', url: 'https://auth.example.test', state: ' ' }), 'plugin');
  assert.equal(resolveStartedOAuthFlow('plugin', {
    flow: 'device', url: 'https://auth.example.test', state: 'session',
  }), 'device', 'recognized flow labels remain authoritative');
  assert.equal(resolveStartedOAuthFlow('plugin', { flow: 'redirect', user_code: 'ABCD' }), 'manual-callback');
  assert.equal(resolveStartedOAuthFlow('device', { flow: 'custom' }), 'device');
  assert.equal(resolveStartedOAuthFlow('manual-callback', { flow: 'custom', user_code: 'ABCD' }), 'manual-callback');
});
