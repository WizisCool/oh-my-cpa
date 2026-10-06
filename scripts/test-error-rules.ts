import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildErrorRules,
  createErrorRuleDraft,
  errorRuleProblem,
  firstErrorRuleProblem,
  moveErrorRule,
  readErrorRuleDrafts,
  type ErrorRuleDraft,
} from '../web/src/components/policy/errorRules.ts';
import {
  EMPTY_BEHAVIOR_DRAFT,
  EMPTY_RUNTIME_POLICY_DRAFT,
  buildBehavior,
  buildRuntimePolicy,
  countPolicyOverrides,
  readRuntimePolicyDraft,
  runtimePolicyProblem,
} from '../web/src/components/providers/runtimePolicy.ts';
import type { ProviderErrorRule, ProviderItem } from '../web/src/types/providers.ts';

const storedRules: ProviderErrorRule[] = [
  { status: 429, match: ['quota'], match_regex: ['rate.?limit'], action: 'stop-and-cooldown' },
  { status: 500, match: ['overloaded'], action: 'continue' },
];

function draftWith(overrides: Partial<ErrorRuleDraft>): ErrorRuleDraft {
  return { ...createErrorRuleDraft('rule-new'), status: '429', matches: [{ id: 'm', kind: 'text', value: 'quota' }], ...overrides };
}

test('a stored rule CPA would skip is not refused while it is left untouched', () => {
  const [draft] = readErrorRuleDrafts([{ status: 429, action: 'continue' }]);
  assert.equal(errorRuleProblem(draft), null);
  assert.equal(errorRuleProblem({ ...draft, status: '430' }), 'no_match');
});

test('an untouched rule is sent back exactly as it was read', () => {
  const built = buildErrorRules(readErrorRuleDrafts(storedRules));
  assert.deepEqual(built, storedRules);
  assert.equal(built[0], storedRules[0]);
});

test('an edited rule is rebuilt from the draft with its patterns split by kind', () => {
  const drafts = readErrorRuleDrafts(storedRules);
  drafts[1] = {
    ...drafts[1],
    status: ' 503 ',
    matches: [
      { id: 'a', kind: 'regex', value: 'busy|overloaded' },
      { id: 'b', kind: 'text', value: 'try again' },
    ],
  };
  assert.deepEqual(buildErrorRules(drafts)[1], {
    status: 503,
    match: ['try again'],
    match_regex: ['busy|overloaded'],
    action: 'continue',
  });
});

test('the form refuses every rule CPA would store and never run', () => {
  assert.equal(errorRuleProblem(draftWith({})), null);
  assert.equal(errorRuleProblem(draftWith({ status: '' })), 'status');
  assert.equal(errorRuleProblem(draftWith({ status: '42' })), 'status');
  assert.equal(errorRuleProblem(draftWith({ status: '600' })), 'status');
  assert.equal(errorRuleProblem(draftWith({ status: '4x9' })), 'status');
  assert.equal(errorRuleProblem(draftWith({ action: 'retry' })), 'action');
  assert.equal(errorRuleProblem(draftWith({ matches: [] })), 'no_match');
  assert.equal(errorRuleProblem(draftWith({ matches: [{ id: 'm', kind: 'text', value: '' }] })), 'empty_match');
  // A pattern is matched literally, so whitespace alone is a real pattern.
  assert.equal(errorRuleProblem(draftWith({ matches: [{ id: 'm', kind: 'text', value: ' ' }] })), null);
});

test('the first problem carries the position of the rule that has it', () => {
  const drafts = [draftWith({}), draftWith({ id: 'second', matches: [] })];
  assert.deepEqual(firstErrorRuleProblem(drafts), { position: 1, problem: 'no_match' });
  assert.equal(firstErrorRuleProblem([draftWith({})]), null);
});

test('moving a rule reorders within bounds and leaves the edges alone', () => {
  const drafts = readErrorRuleDrafts(storedRules);
  assert.deepEqual(moveErrorRule(drafts, 'rule-0', 1).map((rule) => rule.status), ['500', '429']);
  assert.equal(moveErrorRule(drafts, 'rule-0', -1), drafts);
  assert.equal(moveErrorRule(drafts, 'rule-1', 1), drafts);
});

test('a provider without a reported policy reads its cooling from the single switch', () => {
  const legacy = { disable_cooling: true } as ProviderItem;
  assert.deepEqual(readRuntimePolicyDraft(legacy), { ...EMPTY_RUNTIME_POLICY_DRAFT, cooling: 'disabled' });
  const current = {
    disable_cooling: true,
    runtime_policy: { cooling: 'enabled', request_retry: 0, error_rules: storedRules },
  } as ProviderItem;
  const draft = readRuntimePolicyDraft(current);
  assert.equal(draft.cooling, 'enabled');
  assert.equal(draft.requestRetry, 0);
  assert.equal(draft.errorRules.length, 2);
});

test('inherit is the absence of a retry count, and zero is a real override', () => {
  assert.deepEqual(buildRuntimePolicy(EMPTY_RUNTIME_POLICY_DRAFT, true), { cooling: 'inherit' });
  assert.deepEqual(buildRuntimePolicy({ ...EMPTY_RUNTIME_POLICY_DRAFT, requestRetry: 0 }, true), {
    cooling: 'inherit',
    request_retry: 0,
  });
});

test('a family without error rules neither validates nor sends them', () => {
  const draft = { ...EMPTY_RUNTIME_POLICY_DRAFT, errorRules: [draftWith({ matches: [] })] };
  assert.deepEqual(runtimePolicyProblem(draft, true), { kind: 'rule', position: 0, problem: 'no_match' });
  assert.equal(runtimePolicyProblem(draft, false), null);
  assert.deepEqual(buildRuntimePolicy(draft, false), { cooling: 'inherit' });
});

test('a negative or fractional retry count is a problem before any rule is', () => {
  const rules = [draftWith({ matches: [] })];
  assert.deepEqual(runtimePolicyProblem({ cooling: 'inherit', requestRetry: -1, errorRules: rules }, true), { kind: 'retry' });
  assert.deepEqual(runtimePolicyProblem({ cooling: 'inherit', requestRetry: 1.5, errorRules: [] }, true), { kind: 'retry' });
});

test('behaviour names only the switches the family has', () => {
  const draft = { ...EMPTY_BEHAVIOR_DRAFT, alpha_search: true, support_prompt_cache_key: true };
  assert.deepEqual(buildBehavior(draft, ['alpha_search', 'codex_cloaking']), { alpha_search: true, codex_cloaking: 'inherit' });
  assert.equal(buildBehavior(draft, undefined), undefined);
  assert.equal(buildBehavior(draft, []), undefined);
});

test('the section count is the number of settings that depart from the defaults', () => {
  assert.equal(countPolicyOverrides(EMPTY_RUNTIME_POLICY_DRAFT, EMPTY_BEHAVIOR_DRAFT, ['alpha_search', 'codex_cloaking']), 0);
  const policy = { cooling: 'disabled' as const, requestRetry: 0, errorRules: readErrorRuleDrafts(storedRules) };
  const behavior = { ...EMPTY_BEHAVIOR_DRAFT, alpha_search: true, codex_cloaking: 'disabled' as const, support_prompt_cache_key: true };
  assert.equal(countPolicyOverrides(policy, behavior, ['alpha_search', 'codex_cloaking']), 6);
});
