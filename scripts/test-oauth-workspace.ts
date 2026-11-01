import { renewalDetail, renewalLabel, renewalTone } from '../web/src/components/authFiles/credentialRecovery.ts';
import assert from 'node:assert/strict';
import { test } from 'vitest';
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
  quotaRefreshOutcomeKind,
  sortOAuthWorkspaceRecords,
  updateWorkspaceSearch,
  workspaceProviderOptions,
} from '../web/src/pages/oauthManagement/oauthWorkspaceLogic.ts';
import type { OAuthProviderChoice } from '../web/src/pages/oauthProviderLogic.ts';
import { orderQuotaWindows, quotaWindowGroupKey, quotaWindowKindOf } from '../web/src/pages/quota/quotaWindowSelection.ts';
import { credentialStatusOf, compareSections, quotaCellsOf, quotaFamiliesOf, sortByQuotaColumn } from '../web/src/pages/oauthManagement/credentialSections.ts';
import type { QuotaWindow } from '../web/src/types/quota.ts';
import { formatShortDateTime, quotaResetCountdown, quotaResetText, resetAccuracyMarker } from '../web/src/pages/quota/quotaFormat.ts';
import { matchesStatusFilter } from '../web/src/components/authFiles/authFileLogic.ts';
import { siwcBadgeState } from '../web/src/components/authFiles/siwcBadge.ts';
import type { TFunc } from '../web/src/i18n/index.tsx';

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

test('quota conditions: an empty reading is unobserved without asking for another read', () => {
  // A provider that answered without publishing a window is a different status from an unread
  // credential, and the difference is carried by the status and the card's copy. Triage keeps both
  // in one bucket on purpose: an operator looking for a credential without a usable reading wants
  // them together, and only the card distinguishes which of the two happened.
  const projection = buildOAuthWorkspaceProjection(
    [file()],
    [quota({ status: 'unpublished', windows: [], recommendation: { status: 'unpublished', priority: 'low', action: 'none', reason: '' } })],
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
  // A link or a saved view from before the request-count sort was retired reads as the default.
  assert.equal(parseOAuthWorkspaceQuery(new URLSearchParams('sort=requests-desc')).sort, 'name-asc');
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

test('a daily limit leads its own weekly limit', () => {
  const daily = { id: 'devin_daily', label: 'daily', kind: 'daily', scope: 'standard' } as const;
  const weekly = { id: 'devin_weekly', label: 'weekly', kind: 'weekly', scope: 'standard' } as const;
  assert.deepEqual(
    orderQuotaWindows([weekly, daily]).map((window) => window.id),
    ['devin_daily', 'devin_weekly'],
    'the shorter limit binds first even when the provider lists the weekly one first',
  );
});

test('a countdown marks an instant the provider did not state exactly', () => {
  const now = 1_700_000_000_000;
  const inTwoHours = now + 2 * 3_600_000;
  assert.equal(resetAccuracyMarker('exact'), '');
  assert.equal(resetAccuracyMarker('derived'), '~');
  assert.equal(resetAccuracyMarker(undefined), '');
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

test('the list summary and the status filter agree on what is healthy', () => {
  // The page counts "Active" and filters "enabled" over the same records. Both must read the
  // shared predicates, or a row could be counted active and filtered out of the enabled list.
  const statusMessage = 'token expired';
  const cases: Array<[string, ManagementAuthFile, string[]]> = [
    ['a plainly enabled file', file({ type: 'codex', provider: 'codex' }), ['all', 'enabled']],
    ['a disabled file', file({ disabled: true }), ['all', 'disabled']],
    ['an unavailable file', file({ unavailable: true }), ['all', 'problem']],
    ['a file whose status is error', file({ status: 'error' }), ['all', 'problem']],
    ['a file carrying a warning message', file({ status_message: statusMessage }), ['all', 'problem']],
    ['a file whose message is a healthy one', file({ status_message: 'healthy' }), ['all', 'enabled']],
  ];
  for (const [label, authFile, expected] of cases) {
    const projection = buildOAuthWorkspaceProjection([authFile], [], choices);
    const record = projection.records[0];
    for (const filter of ['all', 'enabled', 'disabled', 'problem'] as const) {
      const matched = filterOAuthWorkspaceRecords([record], '', 'all', filter, 'all').length === 1;
      assert.equal(
        matched,
        expected.includes(filter),
        `${label}: filter "${filter}" ${matched ? 'matched' : 'did not match'}`,
      );
    }
    // The summary strip is built from the same two predicates, so it can only agree.
    const countedActive = !record.file.disabled && matchesStatusFilter(record.file, 'enabled');
    assert.equal(
      countedActive,
      expected.includes('enabled'),
      `${label}: the Active count and the enabled filter disagree`,
    );
  }
});

test('a refresh is acknowledged or reported, chosen by whether it needs inspecting', () => {
  assert.equal(
    quotaRefreshOutcomeKind({ failed: 0, unknown: 0 }),
    'acknowledgement',
    'a run whose targets all answered is an acknowledgement that leaves on its own',
  );
  assert.equal(
    quotaRefreshOutcomeKind({ failed: 1, unknown: 0 }),
    'report',
    'a failure needs its per-target reason, so its toast stays until it is closed',
  );
  assert.equal(
    quotaRefreshOutcomeKind({ failed: 0, unknown: 2 }),
    'report',
    'a target the response never mentioned is as inspectable as a failure',
  );
});

test('one model’s limits form one family whatever period each covers', () => {
  // The label carries the period, so keying the family by label would split one model into
  // two and let the row and the Drawer pick from different sets.
  const fiveHour = {
    id: 'addl_0_p', label: 'gpt-reserve 5小时配额', kind: 'model_scoped', scope: 'model', model: 'gpt-reserve',
  } as const;
  const weekly = {
    id: 'addl_0_s', label: 'gpt-reserve 每周配额', kind: 'model_scoped', scope: 'model', model: 'gpt-reserve',
  } as const;
  assert.equal(quotaWindowGroupKey(fiveHour), quotaWindowGroupKey(weekly));
  assert.notEqual(
    quotaWindowGroupKey(weekly),
    quotaWindowGroupKey({ ...weekly, id: 'addl_1_s', model: 'o-series' }),
    'two models are still two families',
  );
});

test('a limit outside the plan’s windows is not folded into them', () => {
  const standard = { id: 'weekly', label: 'Weekly', kind: 'weekly', scope: 'standard' } as const;
  const codeReview = { id: 'code_review_weekly', label: '代码审查 每周配额', scope: 'code_review' } as const;
  assert.equal(quotaWindowGroupKey(standard), 'standard');
  assert.notEqual(
    quotaWindowGroupKey(codeReview),
    quotaWindowGroupKey(standard),
    'a code-review allowance is not one of the credential’s five-hour or weekly limits',
  );
});

test('a target nobody could refresh is reported, not counted as clean', () => {
  // A conflict is resolved before the run, so it must not be filed with the credentials that
  // were never eligible: a run whose every target was held elsewhere refreshed nothing, and
  // `skipped` is the count the clean acknowledgement is built from.
  const kindFor = (failed: number, unknown: number) => quotaRefreshOutcomeKind({ failed, unknown });
  assert.equal(kindFor(0, 3), 'report', 'a fully conflicted run is not an acknowledgement');
  assert.equal(kindFor(0, 0), 'acknowledgement');
});

test('an allowance outside the plan is one family, not one per window', () => {
  // Keyed by id as well, the code-review allowance's five-hour and weekly windows became two
  // families of one window each, so a credential whose only limits were those would show one
  // of them and hide the other.
  const fiveHour = { id: 'code_review_5h', label: '代码审查 5小时配额', scope: 'code_review' } as const;
  const weekly = { id: 'code_review_weekly', label: '代码审查 每周配额', scope: 'code_review' } as const;
  assert.equal(quotaWindowGroupKey(fiveHour), quotaWindowGroupKey(weekly));
  assert.notEqual(quotaWindowGroupKey(weekly), quotaWindowGroupKey({ id: 'weekly', label: 'Weekly', scope: 'standard' }));
});

test('siwc badge: the row names the one SIWC state the operator acts on', () => {
  const cases: Array<[string, Partial<ManagementAuthFile>, Parameters<typeof siwcBadgeState>[1], ReturnType<typeof siwcBadgeState>]> = [
    ['not codex', { type: 'claude', provider: 'claude', siwc_bind_supported: true }, undefined, undefined],
    ['unsupported and unbound', { siwc_bind_supported: false }, undefined, undefined],
    ['runtime-only cannot bind', { siwc_bind_supported: true, runtime_only: true }, undefined, undefined],
    ['supported and unbound', { siwc_bind_supported: true, siwc_bound: false }, undefined, 'bind'],
    ['bound, not used', { siwc_bind_supported: true, siwc_bound: true, use_siwc: false, siwc_status: 'off' }, undefined, 'off'],
    ['bound and used', { siwc_bind_supported: true, siwc_bound: true, use_siwc: true, siwc_status: 'valid' }, undefined, 'active'],
    ['bound where binding is unavailable keeps its switch', { siwc_bind_supported: false, siwc_bound: true, use_siwc: true }, undefined, 'active'],
    ['locally invalid outranks use', { siwc_bind_supported: true, siwc_bound: true, use_siwc: true, siwc_status: 'invalid' }, undefined, 'rebind'],
    ['pending attempt outranks everything', { siwc_bind_supported: true, siwc_bound: true, siwc_status: 'invalid' }, { phase: 'waiting', callbackUrl: '', isBusy: false }, 'pending'],
    ['finished attempt falls back to the summary', { siwc_bind_supported: true, siwc_bound: false }, { phase: 'cancelled', callbackUrl: '', isBusy: false }, 'bind'],
  ];
  for (const [name, overrides, session, expected] of cases) {
    assert.equal(siwcBadgeState(file({ provider: 'codex', ...overrides }), session), expected, name);
  }
});

const quotaRecord = (name: string, windows: QuotaWindow[], provider = 'antigravity') =>
  buildOAuthWorkspaceProjection([file({ name, auth_index: name, type: provider, provider })], [quota({ auth_index: name, name, type: provider, provider, windows })], choices).records[0];

test('section columns: each family once, each period a column, in the order a reader compares', () => {
  const group = (name: string, bucket: string, hours: number): QuotaWindow => ({ id: `ag_${name}_${bucket}`, label: `${name} · ${hours === 5 ? '5小时限制 (5-Hour)' : '每周限制 (Weekly)'}`, scope: 'group', period_hours: hours });
  const cases: Array<[string, QuotaWindow[][], Array<[string | undefined, string[]]>]> = [
    ['antigravity groups, weekly listed first, Argon weekly only', [[
      group('Gemini models', 'week', 168), group('Gemini models', '5h', 5),
      group('Claude and GPT models', 'week', 168), group('Claude and GPT models', '5h', 5),
      group('Gemini 4 Argon', 'week', 168),
    ]], [['Gemini', ['5h', 'weekly']], ['Claude and GPT', ['5h', 'weekly']], ['Gemini 4 Argon', ['weekly']]]],
    ['a group only one credential reports still gets its column', [
      [group('Gemini models', '5h', 5)],
      [group('Gemini models', '5h', 5), group('Gemini 4 Argon', 'week', 168)],
    ], [['Gemini', ['5h']], ['Gemini 4 Argon', ['weekly']]]],
    ['a group no credential reports gets no column', [
      [group('Gemini models', '5h', 5), group('Claude and GPT models', '5h', 5)],
      [group('Gemini models', '5h', 5), group('Claude and GPT models', '5h', 5)],
    ], [['Gemini', ['5h']], ['Claude and GPT', ['5h']]]],
    ['a second weekly limit in the plan is its own column, not an overwrite', [[
      { id: 'five_hour', label: '5小时滚动用量 (5-Hour)', scope: 'standard', period_hours: 5 },
      { id: 'seven_day', label: '每周总用量上限 (Weekly)', scope: 'standard', period_hours: 168 },
      { id: 'seven_day_oauth_apps', label: '第三方应用 每周用量', scope: 'standard', period_hours: 168 },
      { id: 'seven_day_opus', label: 'Opus 每周用量', scope: 'model', model: 'claude-3-opus', period_hours: 168 },
    ]], [[undefined, ['5h', 'weekly', '第三方应用 每周用量']], ['Opus', ['weekly']]]],
    ['a period with no name keeps the provider label', [[
      { id: 'meta_window', label: '3-hour window', scope: 'standard', period_hours: 3 },
      { id: 'meta_weekly', label: 'Weekly', kind: 'weekly', scope: 'standard', period_hours: 168 },
    ]], [[undefined, ['weekly', '3-hour window']]]],
    ['the code-review allowance is a family beside the plan', [[
      { id: 'five_hour', label: '5h', kind: 'five_hour', scope: 'standard' },
      { id: 'code_review_weekly', label: '代码审查 每周配额', scope: 'code_review', period_hours: 168 },
    ]], [[undefined, ['5h']], [undefined, ['weekly']]]],
    ['no readings, no columns', [[]], []],
  ];
  const short = { five_hour: '5h', daily: 'daily', weekly: 'weekly', monthly: 'monthly' } as const;
  for (const [name, credentials, expected] of cases) {
    const records = credentials.map((windows, index) => quotaRecord(`cred-${index}`, windows));
    const families = quotaFamiliesOf(records).map((family) => [family.label, family.columns.map((column) => column.period ? short[column.period] : column.label!)]);
    assert.deepEqual(families, expected, name);
  }
});

test('section columns: a repeated window id is one reading', () => {
  const week: QuotaWindow = { id: 'weekly', label: 'Weekly', kind: 'weekly', scope: 'standard', remaining_percent: 80 };
  const cells = quotaCellsOf([week, { ...week, remaining_percent: 75 }]);
  assert.equal(cells.size, 1);
  assert.equal(cells.get('standard|weekly')?.remaining_percent, 80);
});

test('section columns sort by reading, with missing readings last either way', () => {
  const weekly = (remaining?: number): QuotaWindow[] => remaining === undefined ? [] : [{ id: 'weekly', label: 'Weekly', kind: 'weekly', scope: 'standard', remaining_percent: remaining }];
  const records = [quotaRecord('a', weekly(40)), quotaRecord('b', weekly()), quotaRecord('c', weekly(90))];
  assert.deepEqual(sortByQuotaColumn(records, 'standard|weekly', 'asc').map((record) => record.fileName), ['a', 'c', 'b']);
  assert.deepEqual(sortByQuotaColumn(records, 'standard|weekly', 'desc').map((record) => record.fileName), ['c', 'a', 'b']);
});

test('sections keep a fixed order: pinned providers, then the rest alphabetically', () => {
  const providers = ['zeta-plugin', 'codex', 'gemini', 'claude', 'acme-plugin', 'meta'];
  assert.deepEqual([...providers].sort(compareSections), ['claude', 'codex', 'meta', 'acme-plugin', 'gemini', 'zeta-plugin']);
});

test('renewal evidence stays independent of healthy quota, SIWC and inference', () => {
  const [record] = buildOAuthWorkspaceProjection([file({ requires_sign_in: true, renewal_state: 'sign_in_required', siwc_status: 'valid' })], [quota()], choices).records;
  assert.equal(record.quotaCondition, 'healthy');
  assert.equal(record.isQuotaAttention, true);
  assert.equal(credentialStatusOf(record, false, false).needsReauth, true);
  assert.equal(renewalLabel(record.file), 'recovery.sign_in_required');
  assert.equal(renewalTone(record.file), 'warn');
  assert.equal(renewalLabel(file({ inference_verified: true, adopted: true })), 'recovery.unknown');
  assert.equal(renewalTone(file({ inference_verified: true, adopted: true })), 'neutral');
  assert.equal(renewalDetail(file({ renewal_state: 'renewal_verified' })), 'recovery.detail_verified');
  assert.equal(renewalDetail(file({ renewal_state: 'retry_scheduled' })), 'recovery.detail_retry');
  assert.equal(renewalLabel(file({ renewal_state: 'awaiting_first_renewal' })), 'recovery.awaiting_first_renewal');
});
