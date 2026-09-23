import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagementAuthFile } from '../web/src/types/managementAuthFile.ts';
import type { QuotaItem } from '../web/src/types/quota.ts';
import {
  buildOAuthWorkspaceProjection,
  buildQuotaRefreshTargets,
  consumeOneShotIntent,
  canonicalDisplayProviderKey,
  filterOAuthWorkspaceRecords,
  legacyOAuthManagementRedirect,
  matchesQuotaFilter,
  parseOAuthWorkspaceQuery,
  resolveAuthorizationProviderId,
  sortOAuthWorkspaceRecords,
  updateWorkspaceSearch,
  workspaceProviderOptions,
} from '../web/src/pages/oauthManagement/oauthWorkspaceLogic.ts';
import type { OAuthProviderChoice } from '../web/src/pages/oauthProviderLogic.ts';

const choices: OAuthProviderChoice[] = [
  { id: 'anthropic', title: 'Claude', description: '', iconId: 'Claude', flow: 'manual-callback', loginLabel: '' },
  { id: 'codex', title: 'Codex', description: '', iconId: 'Codex', flow: 'manual-callback', loginLabel: '' },
  { id: 'kimi', title: 'Kimi', description: '', iconId: 'Kimi', flow: 'device', loginLabel: '' },
  { id: 'iflow', title: 'iFlow', description: '', iconId: '', flow: 'manual-callback', loginLabel: '', pluginId: 'iflow-auth' },
];

function file(overrides: Partial<ManagementAuthFile> = {}): ManagementAuthFile {
  return {
    name: 'credential.json',
    auth_index: 'index-1',
    type: 'codex',
    provider: 'codex',
    disabled: false,
    unavailable: false,
    runtime_only: false,
    success: 0,
    failed: 0,
    ...overrides,
  };
}

function quota(overrides: Partial<QuotaItem> = {}): QuotaItem {
  return {
    auth_index: 'index-1',
    name: 'credential.json',
    type: 'codex',
    provider: 'codex',
    disabled: false,
    status: 'healthy',
    observed_at_ms: 1,
    windows: [{ id: 'weekly', label: 'Weekly', kind: 'weekly', scope: 'standard', remaining_percent: 80 }],
    recommendation: { status: 'healthy', priority: 'none', action: 'none', reason: '' },
    capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: true },
    quota_exceeded: false,
    ...overrides,
  };
}

test('join: auth files own membership and unique exact indexes join their quota', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file(), file({ name: 'second.json', auth_index: 'index-2' })],
    [quota(), quota({ auth_index: 'index-2', name: 'second.json' })],
    choices,
  );
  assert.equal(projection.records.length, 2);
  assert.equal(projection.records[0].quota?.auth_index, 'index-1');
  assert.equal(projection.records[0].quotaMatch, 'matched');
  assert.equal(projection.quotaOnly.length, 0);
});

test('join: no fallback is made from filename, email, provider or order', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file({ auth_index: 'actual', email: 'same@example.test' })],
    [quota({ auth_index: 'different', name: 'credential.json', provider: 'codex' })],
    choices,
  );
  assert.equal(projection.records[0].quota, undefined);
  assert.equal(projection.records[0].quotaMatch, 'missing-quota');
  assert.equal(projection.quotaOnly.length, 1);
  assert.equal(projection.quotaOnly[0].auth_index, 'different');
});

test('join: a missing or duplicate file index never becomes an ambiguous quota target', () => {
  const projection = buildOAuthWorkspaceProjection(
    [
      file({ name: 'one.json', auth_index: 'duplicate' }),
      file({ name: 'two.json', auth_index: 'duplicate' }),
      file({ name: 'runtime.json', auth_index: undefined, runtime_only: true }),
    ],
    [quota({ auth_index: 'duplicate' })],
    choices,
  );
  assert.equal(projection.records[0].quotaMatch, 'ambiguous-file-index');
  assert.equal(projection.records[0].quota, undefined);
  assert.equal(projection.records[0].canRefreshQuota, false);
  assert.equal(projection.records[2].quotaMatch, 'missing-index');
  assert.equal(projection.missingAuthIndexCount, 1);
  assert.deepEqual(projection.duplicateAuthIndexes, ['duplicate']);
});

test('join: duplicate quota observations are ambiguous and quota-only races stay diagnostics', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file({ auth_index: 'index-1' }), file({ name: 'other.json', auth_index: 'other' })],
    [quota({ auth_index: 'index-1' }), quota({ auth_index: 'index-1' }), quota({ auth_index: 'race' })],
    choices,
  );
  assert.equal(projection.records[0].quotaMatch, 'ambiguous-quota-index');
  assert.equal(projection.records[0].quota, undefined);
  assert.equal(projection.records[1].quotaMatch, 'missing-quota');
  assert.equal(projection.quotaOnly.length, 1, 'the racing index remains a diagnostic without creating a row');
});

test('identity: duplicate filenames disable writes even when auth indexes differ', () => {
  const projection = buildOAuthWorkspaceProjection(
    [
      file({ name: 'same.json', auth_index: 'one' }),
      file({ name: 'same.json', auth_index: 'two' }),
    ],
    [],
    choices,
  );
  assert.equal(projection.records.every((record) => record.canEditFile === false), true);
  assert.deepEqual(projection.duplicateFileNames, ['same.json']);
});

test('providers: Claude maps to anthropic while unknown providers remain selection-safe', () => {
  assert.equal(canonicalDisplayProviderKey(file({ type: 'claude', provider: undefined }), undefined), 'claude');
  assert.equal(resolveAuthorizationProviderId('claude', choices), 'anthropic');
  assert.equal(resolveAuthorizationProviderId('iflow', choices), 'iflow');
  assert.equal(resolveAuthorizationProviderId('mystery-plugin', choices), undefined);
  assert.notEqual(resolveAuthorizationProviderId('gemini', choices), 'antigravity');
});

test('quota conditions: capability is independent from observed health and authenticity', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file()],
    [quota({
      status: 'warning',
      capabilities: { refresh_supported: false, clear_cooldown_supported: false, reset_credit_supported: false },
    })],
    choices,
  );
  const record = projection.records[0];
  assert.equal(record.isQuotaUnsupported, true);
  assert.equal(record.isQuotaAttention, true);
  assert.equal(matchesQuotaFilter(record, 'unsupported'), true);
  assert.equal(matchesQuotaFilter(record, 'attention'), true);
  assert.equal(matchesQuotaFilter(record, 'warning'), true);
});

test('quota conditions: idle without evidence is unobserved, not exhausted or unlimited', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file()],
    [quota({ status: 'idle', windows: [], recommendation: { status: 'idle', priority: 'none', action: 'refresh', reason: '' } })],
    choices,
  );
  const record = projection.records[0];
  assert.equal(record.quotaCondition, 'unobserved');
  assert.equal(record.isQuotaAttention, false);
  assert.equal(matchesQuotaFilter(record, 'unobserved'), true);
});

test('attention: stale is independently filterable and is not attention by itself', () => {
  const projection = buildOAuthWorkspaceProjection([file()], [quota({ status: 'stale' })], choices);
  const record = projection.records[0];
  assert.equal(record.isQuotaAttention, false);
  assert.equal(matchesQuotaFilter(record, 'stale'), true);
  assert.equal(matchesQuotaFilter(record, 'attention'), false);
});

test('filters and sorting preserve the shared collection semantics', () => {
  const projection = buildOAuthWorkspaceProjection(
    [
      file({ name: 'b.json', auth_index: 'b', success: 10, priority: 1 }),
      file({ name: 'a.json', auth_index: 'a', success: 2, priority: 9, email: 'alice@example.test' }),
    ],
    [quota({ auth_index: 'a', status: 'exhausted' }), quota({ auth_index: 'b', status: 'healthy' })],
    choices,
  );
  assert.deepEqual(
    filterOAuthWorkspaceRecords(projection.records, 'alice', 'all', 'all', 'all').map((record) => record.fileName),
    ['a.json'],
  );
  assert.deepEqual(
    sortOAuthWorkspaceRecords(projection.records, 'priority-desc').map((record) => record.fileName),
    ['a.json', 'b.json'],
  );
});

test('refresh planning deduplicates indexes and reports every skip reason', () => {
  const projection = buildOAuthWorkspaceProjection(
    [
      file({ name: 'ok.json', auth_index: 'ok' }),
      file({ name: 'disabled.json', auth_index: 'disabled', disabled: true }),
      file({ name: 'unsupported.json', auth_index: 'unsupported' }),
      file({ name: 'missing.json', auth_index: 'missing' }),
      file({ name: 'no-index.json', auth_index: undefined }),
      file({ name: 'duplicate-a.json', auth_index: 'duplicate' }),
      file({ name: 'duplicate-b.json', auth_index: 'duplicate' }),
    ],
    [
      quota({ auth_index: 'ok' }),
      quota({ auth_index: 'disabled' }),
      quota({ auth_index: 'unsupported', capabilities: { refresh_supported: false, clear_cooldown_supported: false, reset_credit_supported: false } }),
    ],
    choices,
  );
  const plan = buildQuotaRefreshTargets(projection.records);
  assert.deepEqual(plan.eligibleIndexes, ['ok']);
  assert.deepEqual(
    plan.skipped.map((item) => item.reason).sort(),
    ['ambiguous-auth-index', 'ambiguous-auth-index', 'credential-disabled', 'missing-auth-index', 'missing-quota-observation', 'refresh-unsupported'].sort(),
  );
});

test('query parsing clamps unknown state and keeps one-shot OAuth intent separate', () => {
  const parsed = parseOAuthWorkspaceQuery(new URLSearchParams(
    'provider=CODEX&q=ops&status=bogus&quota=attention&sort=weight-desc&page=-4&page_size=99&density=compact&action=connect&connect_provider=iflow&focus=quota&code=secret',
  ));
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.query, 'ops');
  assert.equal(parsed.status, 'all');
  assert.equal(parsed.quota, 'attention');
  assert.equal(parsed.sort, 'weight-desc');
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 12);
  assert.equal(parsed.density, 'compact');
  const durable = consumeOneShotIntent(new URLSearchParams(
    'provider=codex&q=ops&density=compact&action=connect&connect_provider=iflow&focus=quota',
  ));
  assert.equal(durable.get('provider'), 'codex');
  assert.equal(durable.get('q'), 'ops');
  assert.equal(durable.get('density'), 'compact');
  assert.equal(durable.has('action'), false);
  assert.equal(durable.has('connect_provider'), false);
  assert.equal(durable.has('focus'), false);
});

test('legacy redirects preserve only documented navigation intent', () => {
  assert.equal(
    legacyOAuthManagementRedirect('/oauth', new URLSearchParams('provider=claude')),
    '/oauth-management?provider=claude&action=connect&connect_provider=anthropic',
  );
  assert.equal(
    legacyOAuthManagementRedirect('/oauth', new URLSearchParams('provider=codex&state=secret&code=abc')),
    '/oauth-management?provider=codex&action=connect&connect_provider=codex',
  );
  assert.equal(
    legacyOAuthManagementRedirect('/auth-files', new URLSearchParams('provider=claude&q=example')),
    '/oauth-management?provider=claude&q=example',
  );
  assert.equal(
    legacyOAuthManagementRedirect('/quota', new URLSearchParams('provider=codex&session_id=secret')),
    '/oauth-management?provider=codex&density=expanded&focus=quota',
  );
});

test('runtime-null quota arrays remain unobserved instead of crashing the workspace', () => {
  const malformed = {
    ...quota({ status: 'idle' }),
    windows: null,
    recommendation: null,
    capabilities: null,
  } as unknown as QuotaItem;
  const projection = buildOAuthWorkspaceProjection([file()], [malformed], choices);
  assert.equal(projection.records[0].quotaCondition, 'unobserved');
  assert.equal(projection.records[0].isQuotaUnsupported, true);
  assert.equal(projection.records[0].isQuotaAttention, false);
});

test('provider strip lists display families without duplicate or authorization-only ids', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file({ type: 'claude', provider: 'claude' }), file({ name: 'other.json', auth_index: 'two', type: 'mystery', provider: 'mystery' })],
    [],
    choices,
  );
  const options = workspaceProviderOptions(projection.records, choices);
  assert.equal(options.includes('all'), false);
  assert.equal(options.includes('anthropic'), false);
  assert.equal(options.includes('claude'), true);
  assert.equal(options.includes('iflow'), true, 'plugin authorization ids are displayable when they are their own family');
  assert.equal(options.includes('mystery'), true, 'unknown observed providers remain filterable');
});

test('auth-index joining is exact, so whitespace near-misses remain diagnostics', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file({ name: 'exact.json', auth_index: 'index-1' })],
    [quota({ auth_index: ' index-1' })],
    choices,
  );
  assert.equal(projection.records[0].quota, undefined);
  assert.equal(projection.records[0].quotaMatch, 'missing-quota');
  assert.equal(projection.quotaOnly[0].auth_index, ' index-1');
});

test('the all sentinel does not erase a literal search for the word all', () => {
  const updated = updateWorkspaceSearch(new URLSearchParams('provider=codex&q=old'), { q: 'all', page: null });
  assert.equal(updated.get('q'), 'all');
  assert.equal(updated.get('provider'), 'codex');
});
