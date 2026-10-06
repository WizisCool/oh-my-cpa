import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_CREDENTIAL_POLICY_DRAFT,
  buildCredentialPolicyPatch,
  credentialPolicyProblem,
  isSameCredentialPolicy,
  readCredentialPolicyDraft,
} from '../web/src/components/authFiles/credentialPolicy.ts';
import { createErrorRuleDraft } from '../web/src/components/policy/errorRules.ts';
import type { ManagementAuthFileSafeFields } from '../web/src/types/managementAuthFile.ts';

const stored: ManagementAuthFileSafeFields = {
  name: 'codex.json',
  disable_cooling: false,
  websockets: false,
  using_api: false,
  request_retry: 2,
  request_scoped_errors: [{ status: 429, match: ['quota'], action: 'stop-and-cooldown' }],
};

test('a credential that states nothing reads as inheriting', () => {
  const bare = { ...stored, request_retry: undefined, request_scoped_errors: undefined };
  assert.deepEqual(readCredentialPolicyDraft(bare), EMPTY_CREDENTIAL_POLICY_DRAFT);
  assert.deepEqual(readCredentialPolicyDraft(undefined), EMPTY_CREDENTIAL_POLICY_DRAFT);
});

test('an untouched policy patches nothing', () => {
  const baseline = readCredentialPolicyDraft(stored);
  const draft = readCredentialPolicyDraft(stored);
  assert.equal(isSameCredentialPolicy(draft, baseline), true);
  assert.deepEqual(buildCredentialPolicyPatch(draft, baseline), {});
});

test('only the changed setting is patched', () => {
  const baseline = readCredentialPolicyDraft(stored);
  assert.deepEqual(buildCredentialPolicyPatch({ ...baseline, requestRetry: 0 }, baseline), { request_retry: 0 });

  const edited = {
    ...baseline,
    errorRules: [{ ...baseline.errorRules[0], action: 'continue' }],
  };
  assert.equal(isSameCredentialPolicy(edited, baseline), false);
  assert.deepEqual(buildCredentialPolicyPatch(edited, baseline), {
    request_scoped_errors: [{ status: 429, match: ['quota'], action: 'continue' }],
  });
});

test('inheriting again is stated as null and an empty list', () => {
  const baseline = readCredentialPolicyDraft(stored);
  assert.deepEqual(buildCredentialPolicyPatch(EMPTY_CREDENTIAL_POLICY_DRAFT, baseline), {
    request_retry: null,
    request_scoped_errors: [],
  });
});

test('the order of rules is part of the policy', () => {
  const twoRules = readCredentialPolicyDraft({
    ...stored,
    request_scoped_errors: [
      { status: 429, match: ['quota'], action: 'stop' },
      { status: 500, match: ['boom'], action: 'continue' },
    ],
  });
  const swapped = { ...twoRules, errorRules: [...twoRules.errorRules].reverse() };
  assert.equal(isSameCredentialPolicy(swapped, twoRules), false);
});

test('a retry count outside the server bound and an unfinished rule are problems', () => {
  assert.equal(credentialPolicyProblem(EMPTY_CREDENTIAL_POLICY_DRAFT), null);
  assert.equal(credentialPolicyProblem({ requestRetry: 100, errorRules: [], modelAliases: [] }), null);
  assert.deepEqual(credentialPolicyProblem({ requestRetry: 101, errorRules: [], modelAliases: [] }), { kind: 'retry' });
  assert.deepEqual(credentialPolicyProblem({ requestRetry: -1, errorRules: [], modelAliases: [] }), { kind: 'retry' });
  assert.deepEqual(credentialPolicyProblem({ requestRetry: null, errorRules: [createErrorRuleDraft('new')], modelAliases: [] }), {
    kind: 'rule',
    position: 0,
    problem: 'status',
  });
});

test('model aliases are patched whole, and only when they changed', () => {
  const withAliases = { ...stored, model_aliases: [{ name: 'gpt-5', alias: 'fast', force_mapping: true }] };
  const baseline = readCredentialPolicyDraft(withAliases);
  assert.equal(baseline.modelAliases.length, 1);
  assert.deepEqual(buildCredentialPolicyPatch(readCredentialPolicyDraft(withAliases), baseline), {});

  const added = {
    ...baseline,
    modelAliases: [...baseline.modelAliases, { rowKey: 'new-1', name: ' gpt-5-mini ', alias: 'cheap', fork: true, display_name: '' }],
  };
  assert.equal(isSameCredentialPolicy(added, baseline), false);
  assert.deepEqual(buildCredentialPolicyPatch(added, baseline), {
    model_aliases: [
      { name: 'gpt-5', alias: 'fast', force_mapping: true },
      { name: 'gpt-5-mini', alias: 'cheap', fork: true },
    ],
  });
  // Removing every alias states "use the provider's aliases only".
  assert.deepEqual(buildCredentialPolicyPatch({ ...baseline, modelAliases: [] }, baseline), { model_aliases: [] });
});

test('an alias the gateway would drop is reported instead of saved', () => {
  const draft = (modelAliases: { name: string; alias: string }[]) => ({
    ...EMPTY_CREDENTIAL_POLICY_DRAFT,
    modelAliases: modelAliases.map((entry, position) => ({ ...entry, rowKey: `row-${position}` })),
  });
  assert.deepEqual(credentialPolicyProblem(draft([{ name: 'gpt-5', alias: '' }])), { kind: 'alias', error: 'name_alias_required', alias: undefined });
  assert.deepEqual(credentialPolicyProblem(draft([{ name: 'gpt-5', alias: 'GPT-5' }])), { kind: 'alias', error: 'alias_same', alias: 'GPT-5' });
  assert.deepEqual(
    credentialPolicyProblem(draft([{ name: 'a', alias: 'x' }, { name: 'b', alias: 'X' }])),
    { kind: 'alias', error: 'alias_duplicate', alias: 'X' },
  );
  const tooMany = Array.from({ length: 101 }, (_unused, position) => ({ name: `m-${position}`, alias: `a-${position}` }));
  assert.deepEqual(credentialPolicyProblem(draft(tooMany)), { kind: 'alias', error: 'too_many' });
  assert.equal(credentialPolicyProblem(draft([{ name: 'gpt-5', alias: 'fast' }])), null);
});
