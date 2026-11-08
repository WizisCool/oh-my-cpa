import { expect, test } from 'vitest';
import { defaultWarmupTaskInput, groupWarmupAccounts, type WarmupCatalog, type WarmupCatalogAccount } from '../../src/types/warmup';

function account(authIndex: string, provider: string, patch: Partial<WarmupCatalogAccount> = {}): WarmupCatalogAccount {
  return {
    auth_index: authIndex,
    name: `${authIndex}.json`,
    provider,
    models: ['gpt-5.1-codex'],
    auto_model: 'gpt-5.1-codex',
    windows: [],
    ...patch,
  };
}

test('groupWarmupAccounts keeps the catalogue order and names each provider', () => {
  const catalog: WarmupCatalog = {
    timezone: 'UTC',
    providers: [
      { provider: 'codex', accounts: [account('codex-1', 'codex'), account('codex-2', 'codex')] },
      // A provider whose every credential was filtered out has no heading of its own.
      { provider: 'claude', accounts: [] },
      { provider: 'harbor', accounts: [account('harbor-1', 'harbor', { oauth_provider: 'harbor-cn' })] },
    ],
  };

  const groups = groupWarmupAccounts(catalog, new Map([['harbor', 'Harbor Labs']]));

  expect(groups.map((group) => group.provider)).toEqual(['codex', 'harbor']);
  expect(groups.map((group) => group.label)).toEqual(['Codex', 'Harbor Labs']);
  expect(groups[0].accounts.map((entry) => entry.auth_index)).toEqual(['codex-1', 'codex-2']);
  // The portal is what a credential's own mark is drawn from, so it travels with the account.
  expect(groups[1].accounts[0].oauth_provider).toBe('harbor-cn');
});

test('groupWarmupAccounts answers a missing catalogue with no groups', () => {
  expect(groupWarmupAccounts(undefined)).toEqual([]);
});

test('defaultWarmupTaskInput starts a new task on the first credential the picker offers', () => {
  const catalog: WarmupCatalog = {
    timezone: 'Asia/Shanghai',
    providers: [
      { provider: 'claude', accounts: [account('claude-off', 'claude', { disabled: true })] },
      { provider: 'codex', accounts: [account('codex-1', 'codex')] },
    ],
  };

  expect(defaultWarmupTaskInput(catalog)).toMatchObject({
    provider: 'codex',
    auth_index: 'codex-1',
    trigger: { kind: 'window', time_zone: 'Asia/Shanghai' },
  });
  // With nothing to choose, the draft names no credential rather than one the picker refuses.
  expect(defaultWarmupTaskInput({ ...catalog, providers: catalog.providers.slice(0, 1) }).auth_index).toBe('');
});
