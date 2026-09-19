import assert from 'node:assert/strict';
import {
  aggregateProviders,
  computeProviderSummary,
  OAUTH_CHANNEL_META,
  isOAuthChannel,
  resolveChannelName,
  normalizeProviderKey,
} from '../web/src/components/dashboard/dashboardProvidersLogic';
import type { ManagementOverviewProvider } from '../web/src/types/management';
import type { ProviderItem } from '../web/src/types/providers';

console.log('--- Testing Dashboard Providers Logic ---');

// Test 1: OAuth channel metadata check
assert.equal(OAUTH_CHANNEL_META.codex.name, 'CodeX');
assert.equal(OAUTH_CHANNEL_META.meta.name, 'Meta');
assert.equal(OAUTH_CHANNEL_META.devin.name, 'Devin');
assert.equal(OAUTH_CHANNEL_META.antigravity.name, 'Antigravity');
assert.equal(OAUTH_CHANNEL_META.kimi.name, 'Kimi');
assert.equal(OAUTH_CHANNEL_META.codebuddy.name, 'Codebuddy');
assert.equal(isOAuthChannel('codex'), true);
assert.equal(isOAuthChannel('meta'), true);
assert.equal(isOAuthChannel('devin'), true);
assert.equal(isOAuthChannel('antigravity'), true);
assert.equal(isOAuthChannel('codebuddy'), true);
assert.equal(isOAuthChannel('cline'), false);
assert.equal(resolveChannelName('codex'), 'CodeX');
assert.equal(resolveChannelName('meta'), 'Meta');
assert.equal(resolveChannelName('devin'), 'Devin');
assert.equal(resolveChannelName('codebuddy'), 'Codebuddy');
assert.equal(normalizeProviderKey('openai-compatible-cline'), 'cline');
assert.equal(normalizeProviderKey('DeepSeek V3'), 'deepseekv3');
console.log('✓ OAuth channel metadata, normalization and helpers verified');

// Test 2: Exact fixture from user screenshot
// cline (1,894), inception (1,108), antigravity (664), codebuddy (127), codex (4)
const mockOverviewProviders: ManagementOverviewProvider[] = [
  { id: 'cline', credentials: 1, success: 1876, failure: 18, total: 1894, success_rate: 99.05, buckets: [] },
  { id: 'inception', credentials: 1, success: 1104, failure: 4, total: 1108, success_rate: 99.64, buckets: [] },
  { id: 'antigravity', credentials: 2, success: 663, failure: 1, total: 664, success_rate: 99.85, buckets: [] },
  { id: 'codebuddy', credentials: 1, success: 77, failure: 50, total: 127, success_rate: 60.63, buckets: [] },
  { id: 'codex', credentials: 2, success: 0, failure: 4, total: 4, success_rate: 0.0, buckets: [] },
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

// Check codex was mapped to CodeX and marked as OAuth
const codexRow = aggregated.find((p) => p.name === 'CodeX' || p.id === 'codex');
assert.ok(codexRow, 'Codex row must exist');
assert.equal(codexRow.name, 'CodeX', 'Codex must use channel name CodeX');
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
console.log('✓ Aggregation with screenshot fixture and configured provider verified');

// Test 3: No duplicate DeepSeek channels when window has traffic for a configured provider
const windowedWithDeepseek = aggregateProviders({
  overviewProviders: mockOverviewProviders,
  windowProviders: [
    { id: 'deepseek', total: 500, success: 490, failure: 10, success_rate: 98.0, buckets: [] },
  ],
  configuredProviders: mockConfiguredProviders, // DeepSeek V3 is disabled=true
});
// Count how many rows are named DeepSeek
const deepseekMatches = windowedWithDeepseek.filter((p) => p.name.includes('DeepSeek'));
assert.equal(deepseekMatches.length, 1, 'There must NEVER be two DeepSeek rows (duplicate bug fixed!)');
assert.equal(deepseekMatches[0].total, 500, 'DeepSeek must receive the window traffic');
assert.equal(deepseekMatches[0].disabled, true, 'DeepSeek must preserve disabled status');
console.log('✓ Duplicate DeepSeek channel prevention verified');

// Test 4: Deleted channels must NOT be displayed
const withDeletedChannelTraffic = aggregateProviders({
  overviewProviders: [
    // Deleted provider with credentials = 0
    { id: 'deleted-old-channel', credentials: 0, success: 10, failure: 0, total: 10, success_rate: 100, buckets: [] },
  ],
  windowProviders: [
    // Historical traffic for a provider that was deleted from CPA config
    { id: 'deleted-old-channel', total: 100, success: 99, failure: 1, success_rate: 99.0, buckets: [] },
  ],
  configuredProviders: mockConfiguredProviders, // does NOT contain deleted-old-channel
  authFilesByType: [], // does NOT contain deleted-old-channel
});
const deletedRow = withDeletedChannelTraffic.find((p) => p.id === 'deleted-old-channel' || p.name.includes('deleted'));
assert.equal(deletedRow, undefined, 'Deleted channels must NOT be displayed in the provider fleet');
console.log('✓ Deleted provider exclusion verified');

// Test 5: Enabled channels always precede disabled ones, whatever the volume
//
// A disabled channel's requests are history rather than capacity in play: beta has
// the window's largest volume and still sorts below alpha, while the disabled
// group itself keeps the volume order (beta before gamma).
const orderingFixture = aggregateProviders({
  windowProviders: [
    { id: 'beta', total: 5000, success: 5000, failure: 0, success_rate: 100, buckets: [] },
    { id: 'alpha', total: 10, success: 10, failure: 0, success_rate: 100, buckets: [] },
    { id: 'gamma', total: 900, success: 900, failure: 0, success_rate: 100, buckets: [] },
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
console.log('✓ Enabled-first ordering verified');

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
const codexChannel = credentialState.find((p) => p.name === 'CodeX');
assert.ok(codexChannel, 'CodeX row must exist');
assert.equal(codexChannel.disabled, true, 'Every CodeX credential is disabled, so the channel is disabled');
assert.equal(codexChannel.credentials, 2, 'The credential count still reports the files the gateway holds');
const kimiChannel = credentialState.find((p) => p.name === 'Kimi');
assert.ok(kimiChannel, 'Kimi row must exist');
assert.equal(kimiChannel.disabled, false, 'One enabled Kimi credential keeps the channel on');
const relayRow = credentialState.find((p) => p.name === 'gemini-relay');
assert.ok(relayRow, 'Relay row must exist');
assert.equal(relayRow.disabled, false, 'A disabled type key must not disable a provider that merely contains it');
assert.equal(credentialState[credentialState.length - 1].name, 'CodeX', 'The disabled channel sorts last');
console.log('✓ All-credentials-disabled channel detection verified');

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

// A plugin-driven OAuth channel owns the files its plugin id names.
const pluginChannel = aggregateProviders({
  authFilesByType: [{ type: 'acme', count: 1, disabled: 1 }],
  pluginOAuthIds: new Set(['acme']),
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
console.log('✓ Credential ownership boundary verified');

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

// A channel no plugin owns carries no logo, so its row renders the console mark.
const unbranded = aggregateProviders({ authFilesByType: [{ type: 'antigravity', count: 1, disabled: 0 }] });
assert.equal(unbranded[0].logo, undefined, 'a non-plugin channel has no plugin logo');
console.log('✓ Plugin-provided brand artwork verified');

// Test 8: Summary stats calculation
const summary = computeProviderSummary(aggregated);
assert.equal(summary.totalProviders, 6);
assert.equal(summary.totalCredentials, 8); // 1 + 1 + 2 + 1 + 2 + 1 = 8
assert.equal(summary.totalRequests, 3797); // 1894 + 1108 + 664 + 127 + 4 = 3797
assert.equal(summary.oauthCount, 3); // antigravity + codex + codebuddy
assert.equal(summary.aiProviderCount, 3); // cline + inception + deepseek
assert.ok(summary.overallSuccessRate !== null && summary.overallSuccessRate > 97);
console.log('✓ Summary statistics verified');

console.log('All dashboard provider logic tests passed successfully!');
