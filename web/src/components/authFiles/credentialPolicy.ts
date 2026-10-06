import type { ManagementAuthFileSafeFields } from '../../types/managementAuthFile';
import {
  buildErrorRules,
  firstErrorRuleProblem,
  readErrorRuleDrafts,
  type ErrorRuleDraft,
  type ErrorRuleProblem,
} from '../policy/errorRules';
import {
  createOAuthModelAliasDrafts,
  oauthModelAliasDraftsEqual,
  validateOAuthModelAliasDrafts,
  type ManagementOAuthModelAliasDraft,
  type OAuthModelAliasValidationError,
} from './oauthModelAliasLogic';

/**
 * A credential's own routing policy: the retry count, error rules and model aliases that replace
 * what it would otherwise inherit. All are absent on a credential that states nothing, so the form
 * keeps an empty retry count and empty lists as "inherit" rather than as values.
 */
export interface CredentialPolicyDraft {
  /** Null inherits the retry count. */
  requestRetry: number | null;
  errorRules: ErrorRuleDraft[];
  /** The credential's own aliases, resolved before its provider's. */
  modelAliases: ManagementOAuthModelAliasDraft[];
}

export const EMPTY_CREDENTIAL_POLICY_DRAFT: CredentialPolicyDraft = { requestRetry: null, errorRules: [], modelAliases: [] };

/** The server's bound on one credential's alias list. */
export const MAX_CREDENTIAL_MODEL_ALIASES = 100;

/** The alias rules are the provider-wide ones; they only need a well-formed scope name to run. */
const ALIAS_VALIDATION_SCOPE = 'credential';

/** The server's bound; it only keeps a mistyped number from multiplying every request. */
export const MAX_CREDENTIAL_REQUEST_RETRY = 100;

export function readCredentialPolicyDraft(fields: ManagementAuthFileSafeFields | undefined): CredentialPolicyDraft {
  return {
    requestRetry: fields?.request_retry ?? null,
    errorRules: readErrorRuleDrafts(fields?.request_scoped_errors),
    modelAliases: createOAuthModelAliasDrafts(fields?.model_aliases),
  };
}

export type CredentialPolicyProblem =
  | { kind: 'retry' }
  | { kind: 'rule'; position: number; problem: ErrorRuleProblem }
  | { kind: 'alias'; error: OAuthModelAliasValidationError; alias?: string };

export function credentialPolicyProblem(draft: CredentialPolicyDraft): CredentialPolicyProblem | null {
  const retry = draft.requestRetry;
  if (retry !== null && (!Number.isSafeInteger(retry) || retry < 0 || retry > MAX_CREDENTIAL_REQUEST_RETRY)) {
    return { kind: 'retry' };
  }
  const ruleProblem = firstErrorRuleProblem(draft.errorRules);
  if (ruleProblem) return { kind: 'rule', ...ruleProblem };
  if (draft.modelAliases.length > MAX_CREDENTIAL_MODEL_ALIASES) return { kind: 'alias', error: 'too_many' };
  const aliases = validateOAuthModelAliasDrafts(ALIAS_VALIDATION_SCOPE, draft.modelAliases);
  return aliases.ok ? null : { kind: 'alias', error: aliases.error, alias: aliases.alias };
}

const rulesKey = (draft: CredentialPolicyDraft) =>
  JSON.stringify(
    draft.errorRules.map((rule) => [rule.status.trim(), rule.action, rule.matches.map((match) => [match.kind, match.value])]),
  );

export function isSameCredentialPolicy(left: CredentialPolicyDraft, right: CredentialPolicyDraft): boolean {
  return left.requestRetry === right.requestRetry
    && rulesKey(left) === rulesKey(right)
    && oauthModelAliasDraftsEqual(left.modelAliases, right.modelAliases);
}

/**
 * The fields to patch: only what changed, so an untouched policy is never rewritten. A null retry
 * count and an empty list are how the patch states "inherit again". Call
 * `credentialPolicyProblem` first: an invalid draft throws.
 */
export function buildCredentialPolicyPatch(
  draft: CredentialPolicyDraft,
  baseline: CredentialPolicyDraft,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.requestRetry !== baseline.requestRetry) patch.request_retry = draft.requestRetry;
  if (rulesKey(draft) !== rulesKey(baseline)) patch.request_scoped_errors = buildErrorRules(draft.errorRules);
  if (!oauthModelAliasDraftsEqual(draft.modelAliases, baseline.modelAliases)) {
    const aliases = validateOAuthModelAliasDrafts(ALIAS_VALIDATION_SCOPE, draft.modelAliases);
    if (!aliases.ok) throw new Error(`invalid model aliases: ${aliases.error}`);
    patch.model_aliases = aliases.aliases;
  }
  return patch;
}
