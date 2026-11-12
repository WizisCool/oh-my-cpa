import assert from 'node:assert/strict';
import {
  activityBlocks,
  aggregateProviders,
  computeProviderSummary,
  isOAuthChannel,
  resolveChannelName,
  normalizeProviderKey,
} from '../../src/components/dashboard/dashboardProvidersLogic';
import type { ManagementOverviewProvider } from '../../src/types/management';
import type { ProviderItem } from '../../src/types/providers';
import { pluginOAuthProviderKeys } from '../../src/types/pluginOAuthProviders';
import {
  applyTail,
  dashboardMetricComparison,
  isOpenCalendarPreset,
  parseDashboardComparisonPreference,
  previousCalendarPreset,
  type DashboardResponse,
  type DashboardTailResponse,
} from '../../src/types/dashboard';
import { formatCompareWindowBounds } from '../../src/types/insightsFormat';
import { buildModelTrendTooltipRows } from '../../src/charts/modelTrendData';
import { test } from 'vitest';

test('dashboard providers', () => {
  // Test 1: OAuth channel metadata check
  assert.equal(isOAuthChannel('codex'), true);
  assert.equal(isOAuthChannel('meta'), true);
  assert.equal(isOAuthChannel('devin'), true);
  assert.equal(isOAuthChannel('antigravity'), true);
  assert.equal(isOAuthChannel('codebuddy'), true);
  assert.equal(isOAuthChannel('cline'), false);
  assert.equal(resolveChannelName('codex'), 'Codex');
  assert.equal(resolveChannelName('meta'), 'Meta');
  assert.equal(resolveChannelName('devin'), 'Devin');
  assert.equal(resolveChannelName('codebuddy'), 'Codebuddy');
  assert.equal(normalizeProviderKey('openai-compatible-cline'), 'cline');
  assert.equal(normalizeProviderKey('DeepSeek V3'), 'deepseekv3');


  // Test 2: Exact fixture from user screenshot
  // cline (1,894), inception (1,108), antigravity (664), codebuddy (127), codex (4)
  const mockOverviewProviders: ManagementOverviewProvider[] = [
    { id: 'cline', credentials: 1, success: 1876, failure: 18, total: 1894, success_rate: 99.05 },
    { id: 'inception', credentials: 1, success: 1104, failure: 4, total: 1108, success_rate: 99.64 },
    { id: 'antigravity', credentials: 2, success: 663, failure: 1, total: 664, success_rate: 99.85 },
    { id: 'codebuddy', credentials: 1, success: 77, failure: 50, total: 127, success_rate: 60.63 },
    { id: 'codex', credentials: 2, success: 0, failure: 4, total: 4, success_rate: 0.0 },
  ];

  const mockConfiguredProviders: ProviderItem[] = [
    {
      id: 'openai-compat-0',
      family: 'openai-compatibility',
      name: 'cline',
      upstream_name: 'cline',
      protocol: 'OpenAI Chat Completions',
      models: ['claude-3-5-sonnet', 'gpt-4o'],
      disabled: false,
      key_configured: true,
    },
    {
      id: 'openai-compat-1',
      family: 'openai-compatibility',
      name: 'inception',
      upstream_name: 'inception',
      protocol: 'OpenAI Chat Completions',
      models: ['deepseek-chat'],
      disabled: false,
      key_configured: true,
    },
    {
      id: 'openai-compat-2',
      family: 'openai-compatibility',
      name: 'codebuddy',
      upstream_name: 'codebuddy',
      protocol: 'OpenAI Chat Completions',
      models: ['codebuddy-model'],
      disabled: false,
      key_configured: true,
    },
    // Configured provider with 0 traffic in window
    {
      id: 'openai-compat-3',
      family: 'openai-compatibility',
      name: 'DeepSeek V3',
      upstream_name: 'deepseek',
      protocol: 'OpenAI Chat Completions',
      models: ['deepseek-v3', 'deepseek-r1'],
      disabled: true,
      key_configured: true,
      key_entries: [{ index: 0, api_key: 'sk-xxx' }],
    },
  ];

  const aggregated = aggregateProviders({
    overviewProviders: mockOverviewProviders,
    configuredProviders: mockConfiguredProviders,
  });

  // Check that all 4 configured providers + 2 OAuth channels (antigravity, codex) = 6 providers
  assert.equal(aggregated.length, 6, `Expected 6 aggregated providers, got ${aggregated.length}`);

  // Check codex was mapped to Codex and marked as OAuth
  const codexRow = aggregated.find((p) => p.name === 'Codex' || p.id === 'codex');
  assert.ok(codexRow, 'Codex row must exist');
  assert.equal(codexRow.name, 'Codex', 'Codex must use channel name Codex');
  assert.equal(codexRow.kind, 'oauth', 'Codex must be kind oauth');
  assert.equal(codexRow.iconId, 'Codex', 'Codex must have iconId Codex');
  assert.equal(codexRow.credentials, 2);
  assert.equal(codexRow.total, 4);

  // Check antigravity was mapped to Antigravity and marked as OAuth
  const antigravityRow = aggregated.find((p) => p.name === 'Antigravity' || p.id === 'antigravity');
  assert.ok(antigravityRow, 'Antigravity row must exist');
  assert.equal(antigravityRow.name, 'Antigravity', 'Antigravity must use channel name Antigravity');
  assert.equal(antigravityRow.kind, 'oauth', 'Antigravity must be kind oauth');
  assert.equal(antigravityRow.iconId, 'Antigravity', 'Antigravity must have iconId Antigravity');
  assert.equal(antigravityRow.credentials, 2);
  assert.equal(antigravityRow.total, 664);

  // Check cline row
  const clineRow = aggregated.find((p) => p.name === 'cline');
  assert.ok(clineRow, 'Cline row must exist');
  assert.equal(clineRow.kind, 'ai_provider');
  assert.equal(clineRow.iconId, 'Cline');
  assert.equal(clineRow.total, 1894);
  assert.equal(clineRow.modelsCount, 2);

  // Check idle DeepSeek provider was included, and has disabled=true
  const deepseekRow = aggregated.find((p) => p.name === 'DeepSeek V3');
  assert.ok(deepseekRow, 'DeepSeek idle provider must be included');
  assert.equal(deepseekRow.name, 'DeepSeek V3');
  assert.equal(deepseekRow.disabled, true, 'DeepSeek must preserve disabled status');
  assert.equal(deepseekRow.total, 0);
  assert.equal(deepseekRow.credentials, 1);
  assert.equal(deepseekRow.modelsCount, 2);
  assert.equal(deepseekRow.kind, 'ai_provider');

  // Check codebuddy was mapped to Codebuddy and marked as OAuth
  const codebuddyRow = aggregated.find((p) => p.name === 'Codebuddy' || p.id === 'codebuddy' || p.id === 'openai-compat-2');
  assert.ok(codebuddyRow, 'Codebuddy row must exist');
  assert.equal(codebuddyRow.kind, 'oauth', 'Codebuddy must be kind oauth');
  assert.equal(codebuddyRow.iconId, 'CodeBuddy', 'Codebuddy must have iconId CodeBuddy');

  // Check ordering: cline (1894) > inception (1108) > antigravity (664) > codebuddy (127) > codex (4) > deepseek (0)
  assert.equal(aggregated[0].total, 1894);
  assert.equal(aggregated[1].total, 1108);
  assert.equal(aggregated[2].total, 664);
  assert.equal(aggregated[3].total, 127);
  assert.equal(aggregated[4].total, 4);
  assert.equal(aggregated[5].total, 0);


  // Test 3: No duplicate DeepSeek channels when window has traffic for a configured provider
  const windowedWithDeepseek = aggregateProviders({
    overviewProviders: mockOverviewProviders,
    windowProviders: [
      { id: 'deepseek', total: 500, success: 490, failure: 10, success_rate: 98.0 },
    ],
    configuredProviders: mockConfiguredProviders, // DeepSeek V3 is disabled=true
  });
  // Count how many rows are named DeepSeek
  const deepseekMatches = windowedWithDeepseek.filter((p) => p.name.includes('DeepSeek'));
  assert.equal(deepseekMatches.length, 1, 'There must NEVER be two DeepSeek rows (duplicate bug fixed!)');
  assert.equal(deepseekMatches[0].total, 500, 'DeepSeek must receive the window traffic');
  assert.equal(deepseekMatches[0].disabled, true, 'DeepSeek must preserve disabled status');


  // Test 4: Deleted channels must NOT be displayed
  const withDeletedChannelTraffic = aggregateProviders({
    overviewProviders: [
      // Deleted provider with credentials = 0
      { id: 'deleted-old-channel', credentials: 0, success: 10, failure: 0, total: 10, success_rate: 100 },
    ],
    windowProviders: [
      // Historical traffic for a provider that was deleted from CPA config
      { id: 'deleted-old-channel', total: 100, success: 99, failure: 1, success_rate: 99.0 },
    ],
    configuredProviders: mockConfiguredProviders, // does NOT contain deleted-old-channel
    authFilesByType: [], // does NOT contain deleted-old-channel
  });
  const deletedRow = withDeletedChannelTraffic.find((p) => p.id === 'deleted-old-channel' || p.name.includes('deleted'));
  assert.equal(deletedRow, undefined, 'Deleted channels must NOT be displayed in the provider fleet');


  // Test 5: Enabled channels always precede disabled ones, whatever the volume
  //
  // A disabled channel's requests are history rather than capacity in play: beta has
  // the window's largest volume and still sorts below alpha, while the disabled
  // group itself keeps the volume order (beta before gamma).
  const orderingFixture = aggregateProviders({
    windowProviders: [
      { id: 'beta', total: 5000, success: 5000, failure: 0, success_rate: 100 },
      { id: 'alpha', total: 10, success: 10, failure: 0, success_rate: 100 },
      { id: 'gamma', total: 900, success: 900, failure: 0, success_rate: 100 },
    ],
    configuredProviders: [
      {
        id: 'openai-compat-0',
        family: 'openai-compatibility',
        name: 'alpha',
        upstream_name: 'alpha',
        protocol: 'OpenAI Chat Completions',
        disabled: false,
        key_configured: true,
      },
      {
        id: 'openai-compat-1',
        family: 'openai-compatibility',
        name: 'beta',
        upstream_name: 'beta',
        protocol: 'OpenAI Chat Completions',
        disabled: true,
        key_configured: true,
      },
      {
        id: 'openai-compat-2',
        family: 'openai-compatibility',
        name: 'gamma',
        upstream_name: 'gamma',
        protocol: 'OpenAI Chat Completions',
        disabled: true,
        key_configured: true,
      },
    ],
  });
  assert.deepEqual(
    orderingFixture.map((p) => p.name),
    ['alpha', 'beta', 'gamma'],
    'The enabled channel leads even with the smallest volume, and the disabled group keeps volume order',
  );
  assert.equal(orderingFixture[0].disabled, false);
  assert.equal(orderingFixture[1].disabled, true);
  assert.equal(orderingFixture[1].total, 5000, 'The disabled group still ranks by volume inside itself');


  // Test 6: A channel reads as disabled when the gateway reports every one of its
  // credentials disabled - and only then
  const credentialState = aggregateProviders({
    authFilesByType: [
      { type: 'codex', count: 2, disabled: 2 },
      { type: 'kimi', count: 2, disabled: 1 },
      { type: 'gemini', count: 1, disabled: 1 },
    ],
    configuredProviders: [
      // The containment match traffic uses must not leak into this claim: a relay
      // whose name merely contains a disabled type key is not that channel.
      {
        id: 'openai-compat-9',
        family: 'openai-compatibility',
        name: 'gemini-relay',
        upstream_name: 'gemini-relay',
        protocol: 'OpenAI Chat Completions',
        disabled: false,
        key_configured: true,
      },
    ],
  });
  const codexChannel = credentialState.find((p) => p.name === 'Codex');
  assert.ok(codexChannel, 'Codex row must exist');
  assert.equal(codexChannel.disabled, true, 'Every Codex credential is disabled, so the channel is disabled');
  assert.equal(codexChannel.credentials, 2, 'The credential count still reports the files the gateway holds');
  const kimiChannel = credentialState.find((p) => p.name === 'Kimi');
  assert.ok(kimiChannel, 'Kimi row must exist');
  assert.equal(kimiChannel.disabled, false, 'One enabled Kimi credential keeps the channel on');
  const relayRow = credentialState.find((p) => p.name === 'gemini-relay');
  assert.ok(relayRow, 'Relay row must exist');
  assert.equal(relayRow.disabled, false, 'A disabled type key must not disable a provider that merely contains it');
  assert.equal(credentialState[credentialState.length - 1].name, 'Codex', 'The disabled channel sorts last');


  // Test 7: The all-disabled claim follows only the credentials a row owns
  //
  // CPA's tally covers every auth-file type, so a configured relay that merely
  // shares a name with one of them must not inherit its state.
  const relayNamedLikeAType = aggregateProviders({
    authFilesByType: [{ type: 'gemini', count: 2, disabled: 2 }],
    configuredProviders: [
      {
        id: 'openai-compat-4',
        family: 'openai-compatibility',
        name: 'gemini',
        upstream_name: 'gemini',
        protocol: 'OpenAI Chat Completions',
        disabled: false,
        key_configured: true,
      },
    ],
  });
  assert.equal(relayNamedLikeAType.length, 1);
  assert.equal(relayNamedLikeAType[0].name, 'gemini');
  assert.equal(relayNamedLikeAType[0].disabled, false, 'A relay is not the channel its name collides with');

  // The console's own Gemini family does hold those files.
  const geminiFamily = aggregateProviders({
    authFilesByType: [{ type: 'gemini', count: 2, disabled: 2 }],
    configuredProviders: [
      {
        id: 'gemini-0',
        family: 'gemini',
        name: 'Gemini',
        protocol: 'Gemini API',
        disabled: false,
        key_configured: true,
      },
    ],
  });
  assert.equal(geminiFamily.length, 1);
  assert.equal(geminiFamily[0].disabled, true, 'A console family reads the credentials it owns');

  // A secondary login identifier still belongs to its plugin's OAuth channel.
  const pluginChannel = aggregateProviders({
    authFilesByType: [{ type: 'acme', count: 1, disabled: 1 }],
    pluginOAuthIds: new Set(pluginOAuthProviderKeys({
      id: 'acme-auth', configured: true, registered: true, enabled: true, effective_enabled: true,
      supports_oauth: true, oauth_provider: 'acme-primary', oauth_providers: ['acme-primary', 'acme'], config_fields: [],
    })),
    configuredProviders: [
      {
        id: 'openai-compat-5',
        family: 'openai-compatibility',
        name: 'acme',
        upstream_name: 'acme',
        protocol: 'OpenAI Chat Completions',
        disabled: false,
        key_configured: true,
      },
    ],
  });
  assert.equal(pluginChannel.length, 1);
  assert.equal(pluginChannel[0].disabled, true, 'A plugin OAuth channel reads the files its plugin id names');

  // A channel row carries the name the OAuth page gives the same provider: the plugin's own
  // title for a provider it registers, the brand table otherwise - never the capitalized key.
  const namedChannels = aggregateProviders({
    authFilesByType: [
      { type: 'deepseek', count: 1 },
      { type: 'minimax', count: 1 },
      { type: 'opencode-go', count: 1 },
    ],
    pluginOAuthIds: new Set(['deepseek', 'minimax', 'opencode-go']),
    pluginTitles: new Map([['opencode-go', 'OpenCode Go']]),
  });
  assert.deepEqual(namedChannels.map((row) => row.name).sort(), ['DeepSeek', 'MiniMax', 'OpenCode Go']);
  // A configured row standing for a plugin channel takes its title unless the operator renamed it.
  const configuredChannel = (name: string) => aggregateProviders({
    pluginOAuthIds: new Set(['opencode-go']),
    pluginTitles: new Map([['opencode-go', 'OpenCode Go']]),
    configuredProviders: [{
      id: 'openai-compat-9', family: 'openai-compatibility', name, upstream_name: 'opencode-go',
      protocol: 'OpenAI Chat Completions', disabled: false, key_configured: true,
    }],
  })[0].name;
  assert.equal(configuredChannel('opencode-go'), 'OpenCode Go');
  assert.equal(configuredChannel('My Go relay'), 'My Go relay');
  // A built-in channel is no exception: an operator's name outranks the brand name.
  const renamedBuiltin = aggregateProviders({
    configuredProviders: [{
      id: 'openai-compat-10', family: 'openai-compatibility', name: 'My Codex relay', upstream_name: 'codex',
      protocol: 'OpenAI Chat Completions', disabled: false, key_configured: true,
    }],
  })[0].name;
  assert.equal(renamedBuiltin, 'My Codex relay');
  assert.equal(resolveChannelName('minimax'), 'MiniMax');
  assert.equal(resolveChannelName('opencode-go', new Map([['opencode-go', 'OpenCode Go']])), 'OpenCode Go');


  // A plugin that registers an OAuth provider publishes the mark for it, and that
  // mark outranks both the console's catalog default and an operator-stored icon
  // override: the console does not own a plugin provider's identity.
  const pluginLogoURL = 'https://cdn.example.test/codebuddy.svg';
  const pluginBranded = aggregateProviders({
    authFilesByType: [{ type: 'codebuddy', count: 1, disabled: 0 }],
    pluginOAuthIds: new Set(['codebuddy']),
    pluginLogos: { codebuddy: pluginLogoURL },
    customIcons: { codebuddy: 'DeepSeek' },
  });
  const brandedRow = pluginBranded.find((p) => p.id === 'codebuddy');
  assert.ok(brandedRow, 'the plugin OAuth channel must be aggregated');
  assert.equal(brandedRow.logo, pluginLogoURL, 'the plugin logo is carried on the row');
  assert.equal(brandedRow.iconId, 'DeepSeek', 'the stored icon override is still resolved as the fallback mark');

  const normalizedPlugin = aggregateProviders({
    authFilesByType: [{ type: 'CodeBuddy', count: 1, disabled: 0 }],
    pluginOAuthIds: new Set(['codebuddy']),
    customIcons: { codebuddy: 'DeepSeek' },
  });
  assert.equal(normalizedPlugin[0].iconId, 'DeepSeek', 'a normalized plugin key finds its stored icon');

  const apiKeyFamily = aggregateProviders({
    configuredProviders: [{
      id: 'codex-0',
      family: 'codex',
      name: 'Codex',
      protocol: 'OpenAI Responses',
      auth_indexes: ['key-a'],
      disabled: false,
      key_configured: true,
    }],
    pluginOAuthIds: new Set(['codex']),
  });
  assert.deepEqual(apiKeyFamily[0].providerKeys, ['codex-0'], 'an API-key family does not become plugin ownership');

  // A channel no plugin owns carries no logo, so its row renders the console mark.
  const unbranded = aggregateProviders({ authFilesByType: [{ type: 'antigravity', count: 1, disabled: 0 }] });
  assert.equal(unbranded[0].logo, undefined, 'a non-plugin channel has no plugin logo');


  // Test 7b: API-key providers are credited by the keys that served them, never by family
  //
  // CPA labels every codex API-key request "codex", as it labels a Codex OAuth request. Joining on
  // that label credited a codex provider created a moment ago with the OAuth channel's traffic,
  // while the first codex provider took the whole label and the others read "no requests"; two rows
  // sharing the family's default name lost the second row entirely.
  const codexFamilyRow = (id: string, name: string, authIndex: string): ProviderItem => ({
    id,
    family: 'codex',
    name,
    protocol: 'OpenAI Responses',
    auth_indexes: [authIndex],
    disabled: false,
    key_configured: true,
  });const byKey = aggregateProviders({
    windowProviders: [{ id: 'codex', total: 7, success: 5, failure: 2, success_rate: 71.4 }],
    windowCredentials: [
      { auth_index: 'key-a', total: 3, failure: 1 },
      { auth_index: 'key-b', total: 2, failure: 0 },
    ],
    authFilesByType: [{ type: 'codex', count: 1, disabled: 0 }],
    configuredProviders: [
      codexFamilyRow('codex-0', 'Codex / Responses', 'key-a'),
      codexFamilyRow('codex-1', 'Codex / Responses', 'key-b'),
      codexFamilyRow('codex-2', 'TEST1', 'key-c'),
    ],
  });
  const trafficOf = (providerId: string) => byKey.find((row) => row.providerId === providerId);
  assert.equal(trafficOf('codex-0')?.total, 3, 'the first codex key is credited with its own requests');
  assert.equal(trafficOf('codex-0')?.failure, 1);
  assert.equal(trafficOf('codex-1')?.total, 2, 'a second row with the same default name keeps its own row and traffic');
  assert.equal(trafficOf('codex-2')?.total, 0, 'a provider no request used has no traffic');
  assert.equal(trafficOf('codex-2')?.successRate, null);
  assert.equal(trafficOf('codex-2')?.kind, 'ai_provider', 'a codex API-key provider is not the Codex OAuth channel');
  assert.equal(trafficOf('codex-2')?.credentials, 1, 'an API-key provider counts its own keys, not the channel files');
  const oauthCodex = byKey.find((row) => row.key === 'oauth:codex');
  assert.equal(oauthCodex?.total, 7, 'the OAuth channel keeps the traffic no API key answered');


  // Test 7c: a configured key provider does not swallow the OAuth channel of its family
  //
  // The channel row is built from the gateway's auth-file tally, and the configured row used to claim
  // every name of a family it touched - so configuring a Codex API key made the Codex OAuth channel
  // disappear from the panel, and the requests its files served were credited to no row at all.
  const withChannel = aggregateProviders({
    windowProviders: [
      { id: 'codex', total: 5, success: 5, failure: 0, success_rate: 100 },
      { id: 'claude', total: 2, success: 2, failure: 0, success_rate: 100 },
    ],
    windowCredentials: [{ auth_index: 'key-a', total: 3, failure: 1 }],
    authFilesByType: [
      { type: 'codex', count: 2, disabled: 0 },
      { type: 'claude', count: 1, disabled: 0 },
    ],
    configuredProviders: [codexFamilyRow('codex-0', 'Codex', 'key-a')],
  });
  const channelRow = withChannel.find((row) => row.key === 'oauth:codex');
  assert.ok(channelRow, 'the Codex OAuth channel still has its own row beside the configured provider');
  assert.equal(channelRow.credentials, 2, 'the channel reports its own auth files');
  assert.equal(channelRow.total, 5, 'the channel keeps the traffic no API key answered');
  assert.equal(withChannel.find((row) => row.providerId === 'codex-0')?.total, 3, 'the configured provider keeps its own keys');
  const claudeRow = withChannel.find((row) => row.key === 'oauth:claude');
  assert.equal(claudeRow?.total, 2, 'an unrelated channel is untouched');


  // Test 7d: an OpenAI-compatible relay that stands for a channel takes both halves of its traffic
  //
  // CPA labels its requests `openai-compatible-<name>` and strips that prefix everywhere the id is
  // normalized, so the label row is shared with the channel. Its key-indexed records are split out of
  // that row into `credentials[]`, which means a row credited only by the label would silently lose
  // every request one of its keys served.
  const relay = aggregateProviders({
    windowProviders: [{
      id: 'codex', total: 4, success: 4, failure: 0, success_rate: 100,
      buckets: [{ start_ms: 0, total: 1, failure: 0 }, { start_ms: 60_000, total: 3, failure: 0 }],
    }],
    windowCredentials: [{
      auth_index: 'relay-key', total: 6, failure: 1,
      buckets: [{ start_ms: 60_000, total: 2, failure: 1 }, { start_ms: 120_000, total: 4, failure: 0 }],
    }],
    authFilesByType: [{ type: 'codex', count: 1, disabled: 0 }],
    configuredProviders: [{
      id: 'openai-compat-0',
      family: 'openai-compatibility',
      name: 'codex',
      upstream_name: 'codex',
      protocol: 'OpenAI Responses',
      auth_indexes: ['relay-key'],
      disabled: false,
      key_configured: true,
    }],
  });
  const channelRelayRow = relay.find((row) => row.providerId === 'openai-compat-0');
  assert.ok(channelRelayRow, 'the relay renders as the channel');
  assert.equal(channelRelayRow.total, 10, 'the relay takes its keys\' requests and the unindexed label traffic');
  assert.equal(channelRelayRow.failure, 1);
  // Its activity is the same two halves bucket by bucket: a bucket both halves served is one block.
  assert.deepEqual(channelRelayRow.buckets, [
    { start_ms: 0, total: 1, failure: 0 },
    { start_ms: 60_000, total: 5, failure: 1 },
    { start_ms: 120_000, total: 4, failure: 0 },
  ]);
  assert.equal(relay.length, 1, 'the auth-file channel does not appear a second time beside it');


  // Test 7e: an index two providers both publish is credited to neither
  //
  // CPA derives a credential's runtime index from the credential's own values, so one key entered twice
  // under one name resolves to one index and appears in both providers' `auth_indexes`. Crediting
  // whichever row came first printed a number that depended on the order of the provider list, and the
  // second provider reported a zero it had not earned.
  const sharedIndexScenario = (reversed: boolean) => {
    const providers = [codexFamilyRow('codex-0', 'Codex One', 'key-shared'), codexFamilyRow('codex-1', 'Codex Two', 'key-shared')];
    return aggregateProviders({
      windowProviders: [{ id: 'codex', total: 5, success: 5, failure: 0, success_rate: 100 }],
      windowCredentials: [{ auth_index: 'key-shared', total: 5, failure: 2 }],
      configuredProviders: reversed ? [...providers].reverse() : providers,
    });
  };
  const sharedForward = sharedIndexScenario(false);
  const sharedReversed = sharedIndexScenario(true);
  for (const [name, rows] of [
    ['forward', sharedForward],
    ['reversed', sharedReversed],
  ] as const) {
    assert.equal(rows.find((row) => row.providerId === 'codex-0')?.total, 0, `codex-0 reports nothing for an index two providers claim (${name})`);
    assert.equal(rows.find((row) => row.providerId === 'codex-1')?.total, 0, `codex-1 reports nothing for an index two providers claim (${name})`);
  }
  assert.deepEqual(
    sharedForward.map((row) => row.total),
    sharedReversed.map((row) => row.total),
    'the numbers do not depend on the order of the provider list',
  );


  // Test 7f: two labels that differ only by separators stay two labels
  //
  // `normalizeProviderKey` strips separators, so it maps CPA's `deep-seek` and `deepseek` labels onto one
  // key - and the exact label lookup has to keep them apart, because CPA does.
  const separatorLabels = aggregateProviders({
    windowProviders: [
      { id: 'deep-seek', total: 6, success: 6, failure: 0, success_rate: 100 },
      { id: 'deepseek', total: 4, success: 3, failure: 1, success_rate: 75 },
    ],
    configuredProviders: [
      { id: 'openai-compat-0', family: 'openai-compatibility', name: 'Deep Seek', upstream_name: 'Deep-Seek', protocol: 'OpenAI Chat Completions', disabled: false, key_configured: true },
      { id: 'openai-compat-1', family: 'openai-compatibility', name: 'DeepSeek', upstream_name: 'DeepSeek', protocol: 'OpenAI Chat Completions', disabled: false, key_configured: true },
    ],
  });
  assert.equal(separatorLabels.find((row) => row.providerId === 'openai-compat-0')?.total, 6, 'Deep-Seek keeps its own label traffic');
  assert.equal(separatorLabels.find((row) => row.providerId === 'openai-compat-1')?.total, 4, 'DeepSeek keeps its own label traffic');


  // Test 7g: a locally renamed relay does not become the channel it is renamed after
  //
  // The console stores provider names as an operator preference, so `name` may be any string the
  // operator typed while `upstream_name` stays what CPA carries. Deriving the channel identity from the
  // display name let a rename hand a relay the channel's traffic, its credential count and its row.
  const renamedRelay = aggregateProviders({
    windowProviders: [
      { id: 'codex', total: 9, success: 7, failure: 2, success_rate: 77.8 },
      { id: 'myrelay', total: 3, success: 3, failure: 0, success_rate: 100 },
    ],
    windowCredentials: [{ auth_index: 'relay-key', total: 2, failure: 1 }],
    authFilesByType: [{ type: 'codex', count: 2, disabled: 0 }],
    configuredProviders: [{
      id: 'openai-compat-0',
      family: 'openai-compatibility',
      name: 'Codex',
      upstream_name: 'myrelay',
      protocol: 'OpenAI Chat Completions',
      auth_indexes: ['relay-key'],
      disabled: false,
      key_configured: true,
    }],
  });
  const relayUnderOwnName = renamedRelay.find((row) => row.providerId === 'openai-compat-0');
  assert.ok(relayUnderOwnName, 'the renamed relay keeps its own row');
  assert.equal(relayUnderOwnName.total, 5, 'the renamed relay is credited with its own label and its own keys, never the channel\'s requests');
  assert.equal(relayUnderOwnName.credentials, 1, 'the renamed relay reports the one key it holds, not the channel\'s files');
  assert.equal(relayUnderOwnName.kind, 'ai_provider', 'a rename does not make the row an OAuth channel');
  const survivingChannel = renamedRelay.find((row) => row.key === 'oauth:codex');
  assert.ok(survivingChannel, 'the channel whose name the relay borrowed keeps its own row');
  assert.equal(survivingChannel.total, 9, 'the channel keeps its own requests');


  // Test 7h: key rows without their label list are not credited at all
  //
  // Both halves come from one response because `credentials[]` is the part of the label rows the server
  // split out; taking the keys alone would count those requests twice.
  const keysWithoutLabels = aggregateProviders({
    overviewProviders: [{ id: 'codex', credentials: 2, success: 5, failure: 2, total: 7, success_rate: 71.4 }],
    windowCredentials: [{ auth_index: 'key-a', total: 3, failure: 1 }],
    configuredProviders: [codexFamilyRow('codex-0', 'Codex', 'key-a')],
  });
  assert.equal(
    keysWithoutLabels.reduce((sum, row) => sum + row.total, 0),
    7,
    'the panel never reports more requests than the window holds',
  );


  // Test 7e: configured API keys are not the OAuth channel's credentials
  //
  // CPA lists a runtime entry for every configured `codex-api-key` under the `codex` type, beside the
  // Codex OAuth files. Counting the whole type made the Codex OAuth row report six credentials for an
  // operator with six Codex API-key providers and no OAuth account, and link to a page holding none.
  const sixCodexKeys = Array.from({ length: 6 }, (_, i) => codexFamilyRow(`codex-${i}`, `Relay ${i}`, `key-${i}`));
  const keysOnly = aggregateProviders({
    windowProviders: [{ id: 'codex', total: 0, success: 0, failure: 0, success_rate: 0 }],
    overviewProviders: [{ id: 'codex', credentials: 6, success: 0, failure: 0, total: 0, success_rate: null, buckets: [] }],
    authFilesByType: [{ type: 'codex', count: 6, disabled: 2, api_keys: 6, api_keys_disabled: 2 }],
    configuredProviders: sixCodexKeys,
  });
  assert.equal(keysOnly.filter((row) => row.kind === 'oauth').length, 0, 'API keys alone make no OAuth channel row');
  assert.equal(keysOnly.length, 6, 'each configured key keeps its own row');

  const keysAndFiles = aggregateProviders({
    authFilesByType: [{ type: 'codex', count: 8, disabled: 2, api_keys: 6, api_keys_disabled: 0 }],
    configuredProviders: sixCodexKeys,
  });
  const codexOAuthRow = keysAndFiles.find((row) => row.key === 'oauth:codex');
  assert.equal(codexOAuthRow?.credentials, 2, 'the channel counts its auth files, not the configured keys');
  assert.equal(codexOAuthRow?.disabled, true, 'both files disabled switch the channel off');
  assert.equal(
    keysAndFiles.find((row) => row.providerId === 'codex-0')?.disabled,
    false,
    'disabled OAuth files do not switch off a configured key that still serves',
  );

  const allKeysOff = aggregateProviders({
    authFilesByType: [{ type: 'codex', count: 3, disabled: 2, api_keys: 2, api_keys_disabled: 2 }],
    configuredProviders: [codexFamilyRow('codex-0', 'Relay', 'key-0')],
  });
  assert.equal(allKeysOff.find((row) => row.providerId === 'codex-0')?.disabled, true, 'a family row reads its own keys');
  assert.equal(allKeysOff.find((row) => row.key === 'oauth:codex')?.disabled, false, 'the enabled file keeps the channel on');


  // Test 7f: an empty tally is a reading, not a missing one
  //
  // With 13 Codex API keys and no OAuth account the gateway's tally is empty while the live overview
  // still counts 13 keys under `codex`. Falling back to that bucket made a Codex OAuth row holding 13
  // credentials; a type absent from a non-empty tally must not borrow the bucket either.
  const thirteenCodexKeys = Array.from({ length: 13 }, (_, i) => codexFamilyRow(`codex-${i}`, `Key ${i}`, `key-${i}`));
  const codexKeyBucket = [{ id: 'codex', credentials: 13, success: 40, failure: 2, total: 42, success_rate: 95.2, buckets: [] }];
  for (const tally of [[], [{ type: 'antigravity', count: 1, disabled: 0, api_keys: 0, api_keys_disabled: 0 }]]) {
    const rows = aggregateProviders({
      overviewProviders: codexKeyBucket,
      authFilesByType: tally,
      configuredProviders: thirteenCodexKeys,
    });
    assert.equal(rows.find((row) => row.id === 'codex' && row.kind === 'oauth'), undefined, 'API keys alone make no Codex OAuth row');
    assert.equal(rows.filter((row) => row.providerId?.startsWith('codex-')).length, 13, 'each configured key keeps its own row');
  }


  // Test 8: Summary stats calculation
  const summary = computeProviderSummary(aggregated);
  assert.equal(summary.totalProviders, 6);
  assert.equal(summary.totalCredentials, 8); // 1 + 1 + 2 + 1 + 2 + 1 = 8
  assert.equal(summary.totalRequests, 3797); // 1894 + 1108 + 664 + 127 + 4 = 3797
  assert.equal(summary.oauthCount, 3); // antigravity + codex + codebuddy
  assert.equal(summary.aiProviderCount, 3); // cline + inception + deepseek
  assert.ok(summary.overallSuccessRate !== null && summary.overallSuccessRate > 97);


  // Test 9: the activity strip lays sparse buckets on the server's epoch grid
  //
  // The window rarely starts on the grid, so the first block starts with the window and covers only
  // its later part; an idle bucket is a block with no rate rather than a missing one, so every strip of
  // a window has the same length and its blocks line up row to row.
  const minute = 60_000;
  const blocks = activityBlocks(
    [{ start_ms: 2 * minute, total: 4, failure: 1 }, { start_ms: 4 * minute, total: 2, failure: 2 }],
    1.5 * minute,
    4.5 * minute,
    minute,
  );
  assert.deepEqual(blocks, [
    { startMs: 1.5 * minute, endMs: 2 * minute, total: 0, failure: 0, successRate: null },
    { startMs: 2 * minute, endMs: 3 * minute, total: 4, failure: 1, successRate: 75 },
    { startMs: 3 * minute, endMs: 4 * minute, total: 0, failure: 0, successRate: null },
    { startMs: 4 * minute, endMs: 4.5 * minute, total: 2, failure: 2, successRate: 0 },
  ]);


  // The API's window includes its closing instant. When that instant lands on a bucket edge, the
  // sparse response carries a bucket the visible half-open grid cannot start; it belongs to the
  // closing block, otherwise the strip's traffic would end one block short of the row total.
  const closingEdgeBlocks = activityBlocks(
    [{ start_ms: 3 * minute, total: 1, failure: 1 }],
    1 * minute,
    3 * minute,
    minute,
  );
  assert.deepEqual(closingEdgeBlocks, [
    { startMs: 1 * minute, endMs: 2 * minute, total: 0, failure: 0, successRate: null },
    { startMs: 2 * minute, endMs: 3 * minute, total: 1, failure: 1, successRate: 0 },
  ]);

  // Unsettled provider catalog propagates isIdentityUnknown onto configured rows so
  // positional IDs do not borrow stale custom icons during a refetch.
  const unsettledRows = aggregateProviders({
    overviewProviders: mockOverviewProviders,
    configuredProviders: mockConfiguredProviders,
    isProviderCatalogUnknown: true,
  });
  const unsettledCline = unsettledRows.find((p) => p.providerId === 'openai-compat-0');
  assert.ok(unsettledCline);
  assert.equal(unsettledCline.isIdentityUnknown, true);
});

test('dashboard adaptive calendar tail healing and pace comparisons', () => {
  const base: DashboardResponse = {
    window: {
      preset: 'today',
      from: 1_000_000,
      to: 1_300_000,
      bucket_ms: 60_000,
      minutes: 5,
      complete: true,
      open_end: true,
    },
    requests: {
      total: 11,
      success: 11,
      failed: 0,
      success_rate: 100,
      series: [
        { t: 1_020_000, v: 4, f: 0 },
        { t: 1_080_000, v: 7, f: 0 },
      ],
    },
    tokens: {
      total: 1_000_000,
      input: 950_000,
      output: 50_000,
      reasoning: 0,
      cached: 0,
      cache_read: 900_000,
      cache_creation: 0,
      series: [
        { t: 1_020_000, tokens: 400_000, cache_read: 360_000, cost_nanos: 120_000_000 },
        { t: 1_080_000, tokens: 600_000, cache_read: 540_000, cost_nanos: 200_000_000 },
      ],
    },
    metrics: {
      rpm: 2.2,
      tpm: 200_000,
      cache_rate: 94.74,
      cost: 0.32,
      cost_nanos: 320_000_000,
      costed_requests: 11,
      cost_source: 'estimated',
      cost_note: '',
      avg_latency_ms: 420,
      avg_ttft_ms: 110,
    },
    comparison: {
      from: 136_000,
      to: 436_000,
      same_stretch: true,
      requests: 5,
      tokens: 400_000,
      cost_nanos: 160_000_000,
      costed_requests: 5,
    },
    coverage: {
      rollup_requests: 0,
      detail_requests: 11,
      pending_inbox: 0,
      has_usage: true,
    },
    partial_errors: [],
  };

  // Stepping from 1m buckets to 2m buckets on a live 'today' poll triggers a clean full refetch.
  const steppedTail: DashboardTailResponse = {
    window: { ...base.window, to: 3_900_000, bucket_ms: 120_000, minutes: 48 },
    requests: { ...base.requests, series: [{ t: 3_780_000, v: 2, f: 0 }] },
    tokens: { ...base.tokens, series: [{ t: 3_780_000, tokens: 100_000 }] },
    metrics: base.metrics,
    comparison: base.comparison,
    live: {
      as_of_ms: 3_900_000,
      bucket_ms: 120_000,
      series_start_ms: 1_020_000,
      tail_from_ms: 3_780_000,
    },
    partial_errors: [],
  };
  assert.equal(applyTail(base, steppedTail).broken, true);

  // Stale or cross-preset tails are ignored without triggering a broken refetch.
  assert.equal(
    applyTail(base, { ...steppedTail, live: { ...steppedTail.live, as_of_ms: base.window.to - 1 } }).broken,
    false,
  );
  assert.equal(
    applyTail(base, { ...steppedTail, window: { ...steppedTail.window, preset: '24h' } }).broken,
    false,
  );

  // Same-grid live tail splices series and updates comparison totals.
  const sameGridTail: DashboardTailResponse = {
    window: { ...base.window, to: 1_360_000 },
    requests: { ...base.requests, total: 14, success: 14, series: [{ t: 1_080_000, v: 7, f: 0 }, { t: 1_140_000, v: 3, f: 0 }] },
    tokens: { ...base.tokens, total: 1_200_000, series: [{ t: 1_080_000, tokens: 600_000 }, { t: 1_140_000, tokens: 200_000 }] },
    metrics: { ...base.metrics, cost: 0.4, cost_nanos: 400_000_000, costed_requests: 14 },
    comparison: { ...base.comparison!, requests: 6, tokens: 500_000, cost_nanos: 200_000_000, costed_requests: 6 },
    live: {
      as_of_ms: 1_360_000,
      bucket_ms: 60_000,
      series_start_ms: 1_020_000,
      tail_from_ms: 1_080_000,
    },
    partial_errors: [],
  };
  const merged = applyTail(base, sameGridTail);
  assert.equal(merged.broken, false);
  assert.equal(merged.data?.requests.series.length, 3);
  assert.equal(merged.data?.comparison?.requests, 6);

  // A tail whose comparison is absent clears the stale base comparison rather than
  // dividing newer current totals by an older comparison stretch.
  const degradedTail: DashboardTailResponse = {
    ...sameGridTail,
    comparison: undefined,
    partial_errors: ['comparison unavailable'],
  };
  const degradedMerged = applyTail({ ...base, partial_errors: ['pipeline stats unavailable'] }, degradedTail);
  assert.equal(degradedMerged.data?.comparison, undefined);
  assert.deepEqual(degradedMerged.data?.partial_errors, ['pipeline stats unavailable', 'comparison unavailable']);

  // A subsequent healthy tail clears the transient comparison warning while keeping collector warnings.
  const healedComparison = applyTail(degradedMerged.data!, sameGridTail);
  assert.deepEqual(healedComparison.data?.partial_errors, ['pipeline stats unavailable']);

  // Robust full-period baseline comparisons evaluate requests, tokens and cost using baseline_* values
  // while preserving raw previous sample counts for statistical evidence.
  const reqDelta = dashboardMetricComparison(base, 'requests');
  assert.ok(reqDelta);
  assert.equal(reqDelta.isSameStretch, false);
  assert.equal(reqDelta.previousValue, 5);
  assert.equal(reqDelta.comparison.kind, 'change');

  const withScaledBaseline: DashboardResponse = {
    ...base,
    comparison: {
      ...base.comparison!,
      same_stretch: false,
      requests: 100,
      tokens: 1_000_000,
      cost_nanos: 1_000_000_000,
      costed_requests: 100,
      baseline_requests: 11,
      baseline_tokens: 1_000_000,
      baseline_cost_nanos: 320_000_000,
      baseline_costed_requests: 11,
    },
  };
  const scaledReq = dashboardMetricComparison(withScaledBaseline, 'requests');
  assert.ok(scaledReq);
  assert.equal(scaledReq.previousValue, 11);
  assert.equal(scaledReq.comparison.kind, 'change');
  if (scaledReq.comparison.kind === 'change') {
    assert.equal(scaledReq.comparison.change, 0);
  }
  const scaledCost = dashboardMetricComparison(withScaledBaseline, 'cost');
  assert.ok(scaledCost);
  assert.equal(scaledCost.previousValue, 0.32);

  // Quiet midnight start (0 requests today, active yesterday same stretch) preserves yesterday's spend readout.
  const quietMidnight: DashboardResponse = {
    ...base,
    requests: { ...base.requests, total: 0, success: 0, success_rate: null, series: [{ t: 1_000_000, v: 0, f: 0 }] },
    tokens: { ...base.tokens, total: 0, input: 0, output: 0, cache_read: 0, series: [{ t: 1_000_000, tokens: 0 }] },
    metrics: { ...base.metrics, rpm: null, tpm: null, cache_rate: null, cost: 0, cost_nanos: 0, costed_requests: 0, cost_source: 'placeholder' },
  };
  const quietReqDelta = dashboardMetricComparison(quietMidnight, 'requests');
  assert.ok(quietReqDelta);
  assert.equal(quietReqDelta.comparison.kind, 'none');
  assert.equal(quietReqDelta.previousValue, 5);
  const quietCostDelta = dashboardMetricComparison(quietMidnight, 'cost');
  assert.ok(quietCostDelta);
  assert.equal(quietCostDelta.comparison.kind, 'none');
  assert.equal(quietCostDelta.previousValue, 0.16);

  // Completely idle windows omit comparison noise.
  const bothIdle: DashboardResponse = {
    ...quietMidnight,
    comparison: { ...base.comparison!, requests: 0, tokens: 0, cost_nanos: 0, costed_requests: 0 },
  };
  assert.equal(dashboardMetricComparison(bothIdle, 'requests'), null);

  assert.equal(isOpenCalendarPreset('today'), true);
  assert.equal(isOpenCalendarPreset('this_week'), true);
  assert.equal(isOpenCalendarPreset('yesterday'), false);
  assert.equal(isOpenCalendarPreset('24h'), false);
  assert.equal(previousCalendarPreset('today'), 'yesterday');
  assert.equal(previousCalendarPreset('this_week'), 'last_week');
  assert.equal(previousCalendarPreset('this_month'), 'last_month');
  assert.equal(previousCalendarPreset('24h'), undefined);

  assert.equal(parseDashboardComparisonPreference(true), true);
  assert.equal(parseDashboardComparisonPreference(false), false);
  assert.equal(parseDashboardComparisonPreference('yes'), undefined);

  // Compare-window formatting omits the year only when both endpoints fall inside the active year.
  const sameYearBounds = formatCompareWindowBounds(
    { from: Date.UTC(2026, 10, 12, 0, 0), to: Date.UTC(2026, 10, 12, 0, 5) },
    2026,
    (ms, layout) => `${layout}:${new Date(ms).toISOString().slice(0, 16)}`,
    (ms) => new Date(ms).getUTCFullYear(),
  );
  assert.equal(sameYearBounds.from, 'MM-DD HH:mm:2026-11-12T00:00');
  const crossYearBounds = formatCompareWindowBounds(
    { from: Date.UTC(2025, 11, 31, 0, 0), to: Date.UTC(2026, 0, 1, 0, 0) },
    2026,
    (ms, layout) => `${layout}:${new Date(ms).toISOString().slice(0, 16)}`,
    (ms) => new Date(ms).getUTCFullYear(),
  );
  assert.equal(crossYearBounds.from, 'YYYY-MM-DD HH:mm:2025-12-31T00:00');
});

test('model trend tooltip honors the console token unit style', () => {
  const row = {
    t: '1762972800000',
    total: 5_694_578,
    'model:gemini-4-carbon': 4_701_976,
    'model:gemini-3.8-flash': 974_396,
    'model:retain': 17_360,
    folded: 846,
    'model:unused': 0,
  };
  const domain = ['model:gemini-4-carbon', 'model:gemini-3.8-flash', 'model:retain', 'folded', 'model:unused'];
  const range = ['#111', '#222', '#333', '#444', '#555'];
  const labelOf = (key: string) => (key === 'folded' ? 'Other models' : key.replace(/^model:/, ''));

  const compact = buildModelTrendTooltipRows({
    row,
    domain,
    range,
    labelOf,
    totalLabel: 'Total',
    tokenUnitLabel: 'tokens',
    tokenStyle: 'en-compact',
  });
  assert.deepEqual(compact, [
    { key: 'model:gemini-4-carbon', name: 'gemini-4-carbon', color: '#111', value: '4.7M', share: '83%' },
    { key: 'model:gemini-3.8-flash', name: 'gemini-3.8-flash', color: '#222', value: '974.4K', share: '17%' },
    { key: 'model:retain', name: 'retain', color: '#333', value: '17.4K', share: '0.3%' },
    { key: 'folded', name: 'Other models', color: '#444', value: '846', share: '<0.1%' },
    { key: 'total', name: 'Total', value: '5.7M tokens', isTotal: true },
  ]);

  const chinese = buildModelTrendTooltipRows({
    row,
    domain,
    range,
    labelOf,
    totalLabel: '合计',
    tokenUnitLabel: 'tokens',
    tokenStyle: 'zh',
  });
  assert.deepEqual(
    chinese.map((entry) => [entry.key, entry.value]),
    [
      ['model:gemini-4-carbon', '470.2万'],
      ['model:gemini-3.8-flash', '97.4万'],
      ['model:retain', '1.7万'],
      ['folded', '846'],
      ['total', '569.5万 tokens'],
    ],
  );

  const full = buildModelTrendTooltipRows({
    row,
    domain,
    range,
    labelOf,
    totalLabel: 'Total',
    tokenUnitLabel: 'tokens',
    tokenStyle: 'full',
  });
  assert.deepEqual(
    full.map((entry) => [entry.key, entry.value]),
    [
      ['model:gemini-4-carbon', '4,701,976'],
      ['model:gemini-3.8-flash', '974,396'],
      ['model:retain', '17,360'],
      ['folded', '846'],
      ['total', '5,694,578 tokens'],
    ],
  );
});
