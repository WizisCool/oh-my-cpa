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
import { pickCompactQuotaWindows, orderQuotaWindows, quotaWindowKindOf } from '../web/src/pages/quota/quotaWindowSelection.ts';
import { formatShortDateTime, quotaResetCountdown, quotaResetText } from '../web/src/pages/quota/quotaFormat.ts';
import type { TFunc } from '../web/src/i18n/index.ts';

/** Stands in for the dictionary: the countdown assertions only need the arguments back. */
const echoT: TFunc = (key, vars) => (vars ? `${key}:${Object.values(vars).join('/')}` : key);

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

test('a compact row carries the five-hour and weekly limits of one group', () => {
  const picked = pickCompactQuotaWindows([
    { id: 'a-five', label: 'Gemini Models · Five Hour Limit Remaining', kind: 'five_hour', scope: 'group' },
    { id: 'a-week', label: 'Gemini Models · Weekly Limit Remaining', kind: 'weekly', scope: 'group' },
    { id: 'b-five', label: 'Claude Models · Five Hour Limit Remaining', kind: 'five_hour', scope: 'group' },
  ]);
  assert.deepEqual(picked.map((window) => window.id), ['a-five', 'a-week']);
});

test('a compact row fills its lines from whatever the provider returned', () => {
  assert.deepEqual(
    pickCompactQuotaWindows([{ id: 'week', label: 'Weekly', kind: 'weekly', scope: 'standard' }]).map((window) => window.id),
    ['week'],
    'a provider with one window shows that window rather than an empty line',
  );
  assert.deepEqual(
    pickCompactQuotaWindows([
      { id: 'day', label: 'Daily', kind: 'daily', scope: 'standard' },
      { id: 'month', label: 'Monthly', kind: 'monthly', scope: 'standard' },
      { id: 'other', label: 'Other', kind: 'custom', scope: 'standard' },
    ]).map((window) => window.id),
    ['day', 'month'],
    'a provider with neither kind is still represented by its own first windows',
  );
  assert.deepEqual(pickCompactQuotaWindows([]), []);
});

test('a compact row never shows the same window twice', () => {
  const five = { id: 'five', label: 'Five hour', kind: 'five_hour', scope: 'standard' } as const;
  const week = { id: 'week', label: 'Weekly', kind: 'weekly', scope: 'standard' } as const;
  const picked = pickCompactQuotaWindows([five, five, week]);
  assert.deepEqual(picked.map((window) => window.id), ['five', 'week']);
});

test('a daily limit leads its own weekly limit', () => {
  const daily = { id: 'devin_daily', label: 'daily', kind: 'daily', scope: 'standard' } as const;
  const weekly = { id: 'devin_weekly', label: 'weekly', kind: 'weekly', scope: 'standard' } as const;
  assert.deepEqual(
    orderQuotaWindows([weekly, daily]).map((window) => window.id),
    ['devin_daily', 'devin_weekly'],
    'the shorter limit binds first even when the provider lists the weekly one first',
  );
  assert.deepEqual(
    pickCompactQuotaWindows(orderQuotaWindows([weekly, daily])).map((window) => window.id),
    ['devin_daily', 'devin_weekly'],
  );
});

test('a countdown marks an instant the provider did not state exactly', () => {
  const now = 1_700_000_000_000;
  const inTwoHours = now + 2 * 3_600_000;
  assert.equal(
    quotaResetCountdown({ reset_at_ms: inTwoHours, reset_accuracy: 'exact' }, now, echoT),
    'quota.in_hours:2',
    'an exact instant reads as a plain countdown',
  );
  assert.equal(
    quotaResetCountdown({ reset_at_ms: inTwoHours, reset_accuracy: 'derived' }, now, echoT),
    '~quota.in_hours:2',
    'a derived instant keeps its marker rather than reading as a verified deadline',
  );
  assert.equal(
    quotaResetCountdown({ reset_at_ms: now - 60_000, reset_accuracy: 'exact' }, now, echoT),
    'quota.recovered',
  );
  assert.equal(
    quotaResetCountdown({ reset_at_ms: now - 60_000, reset_accuracy: 'derived', reset_label: '已恢复' }, now, echoT),
    '~已恢复',
    'a passed derived instant defers to what upstream stated instead of claiming recovery',
  );
  assert.equal(
    quotaResetCountdown({ reset_at_ms: now - 60_000, reset_accuracy: 'approximate' }, now, echoT),
    '',
    'nothing is claimed when upstream stated neither recovery nor a label',
  );
  assert.equal(
    quotaResetText({ reset_at_ms: inTwoHours, reset_accuracy: 'derived' }, now, echoT),
    `~${formatShortDateTime(inTwoHours)} · quota.in_hours:2`,
    'the tooltip keeps the marker too, so the two readings cannot disagree',
  );
});

test('a window without a kind is named from the period it covers', () => {
  const groupWindow = (periodHours: number) => ({ id: `w-${periodHours}`, label: 'Gemini Models · Five Hour Limit Remaining', scope: 'group' as const, period_hours: periodHours });
  assert.equal(quotaWindowKindOf(groupWindow(5)), 'five_hour');
  assert.equal(quotaWindowKindOf(groupWindow(24)), 'daily');
  assert.equal(quotaWindowKindOf(groupWindow(168)), 'weekly');
  assert.equal(quotaWindowKindOf(groupWindow(720)), 'monthly');
  assert.equal(quotaWindowKindOf(groupWindow(2)), undefined, 'an unknown period stays unnamed rather than being forced into a bucket');
  assert.equal(quotaWindowKindOf({ ...groupWindow(2), kind: 'custom' }), 'custom', 'an explicit kind always wins');
});

test('a grouped row is picked by period, not by the order the provider listed', () => {
  const weekly = { id: 'g-week', label: 'Gemini Models · Weekly Limit Remaining', scope: 'group' as const, period_hours: 168 };
  const fiveHour = { id: 'g-five', label: 'Gemini Models · Five Hour Limit Remaining', scope: 'group' as const, period_hours: 5 };
  const otherFamily = { id: 'c-five', label: 'Claude and GPT models · Five Hour Limit Remaining', scope: 'group' as const, period_hours: 5 };
  assert.deepEqual(
    pickCompactQuotaWindows([weekly, fiveHour, otherFamily]).map((window) => window.id),
    ['g-five', 'g-week'],
  );
});

const creditInfo = (available: number, applicable: number): QuotaItem['reset_credits'] => ({
  available_count: available,
  applicable_available_count: applicable,
});

test('redeeming is offered whenever the account holds a reset credit', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file({ type: 'codex', provider: 'codex' })],
    [quota({ reset_credits: creditInfo(2, 0) })],
    choices,
  );
  assert.equal(
    projection.records[0].canRedeemCredit,
    true,
    'an applicable count of zero gates nothing: Codex resets voluntarily and reports the outcome itself',
  );
});

test('applicability alone never offers a redemption the account cannot spend', () => {
  const projection = buildOAuthWorkspaceProjection(
    [file({ type: 'codex', provider: 'codex' })],
    [quota({ reset_credits: creditInfo(0, 3) })],
    choices,
  );
  assert.equal(projection.records[0].canRedeemCredit, false);
});

test('the redemption offer respects capability, disablement and identity ambiguity', () => {
  const noCreditSupport = buildOAuthWorkspaceProjection(
    [file({ type: 'claude', provider: 'claude' })],
    [quota({ capabilities: { refresh_supported: true, clear_cooldown_supported: true, reset_credit_supported: false }, reset_credits: creditInfo(1, 1) })],
    choices,
  );
  assert.equal(noCreditSupport.records[0].canRedeemCredit, false);

  const disabledFile = buildOAuthWorkspaceProjection(
    [file({ type: 'codex', provider: 'codex', disabled: true })],
    [quota({ reset_credits: creditInfo(1, 1) })],
    choices,
  );
  assert.equal(disabledFile.records[0].canRedeemCredit, false);

  const ambiguousIndex = buildOAuthWorkspaceProjection(
    [file({ name: 'one.json', auth_index: 'duplicate' }), file({ name: 'two.json', auth_index: 'duplicate' })],
    // The quota carries spendable credits so this case fails if identity protection
    // is; a quota without them would disable both records for the wrong reason.
    [quota({ auth_index: 'duplicate', reset_credits: creditInfo(2, 2) })],
    choices,
  );
  assert.deepEqual(ambiguousIndex.records.map((record) => record.canRedeemCredit), [false, false]);
});
