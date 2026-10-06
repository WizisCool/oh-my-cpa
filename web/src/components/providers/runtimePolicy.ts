import type {
  ProviderBehavior,
  ProviderBehaviorSwitch,
  ProviderItem,
  ProviderOverride,
  ProviderRuntimePolicy,
} from '../../types/providers';
import {
  buildErrorRules,
  firstErrorRuleProblem,
  readErrorRuleDrafts,
  type ErrorRuleDraft,
  type ErrorRuleProblem,
} from '../policy/errorRules';

/**
 * The provider editor's runtime policy and request-behaviour form.
 *
 * Cooling and the retry count are settings the gateway also has globally, so each has an
 * explicit "inherit" state: a switch or a zero could not tell "off" from "use the global
 * value". Error rules have no global counterpart for an API-key provider, so an empty list
 * simply means the provider has none.
 */
export interface RuntimePolicyDraft {
  cooling: ProviderOverride;
  /** Null inherits the global retry count. */
  requestRetry: number | null;
  errorRules: ErrorRuleDraft[];
}

export type BehaviorDraft = Required<ProviderBehavior>;

export const EMPTY_RUNTIME_POLICY_DRAFT: RuntimePolicyDraft = {
  cooling: 'inherit',
  requestRetry: null,
  errorRules: [],
};

export const EMPTY_BEHAVIOR_DRAFT: BehaviorDraft = {
  alpha_search: false,
  codex_cloaking: 'inherit',
  rebuild_mid_system_message: false,
  support_prompt_cache_key: false,
};

export function readRuntimePolicyDraft(provider: ProviderItem): RuntimePolicyDraft {
  const policy = provider.runtime_policy;
  if (!policy) {
    // A server that predates the policy reports only the cooling switch.
    return { ...EMPTY_RUNTIME_POLICY_DRAFT, cooling: provider.disable_cooling ? 'disabled' : 'inherit' };
  }
  return {
    cooling: policy.cooling,
    requestRetry: policy.request_retry ?? null,
    errorRules: readErrorRuleDrafts(policy.error_rules),
  };
}

export function readBehaviorDraft(provider: ProviderItem): BehaviorDraft {
  return { ...EMPTY_BEHAVIOR_DRAFT, ...provider.behavior };
}

export type RuntimePolicyProblem =
  | { kind: 'retry' }
  | { kind: 'rule'; position: number; problem: ErrorRuleProblem };

export function runtimePolicyProblem(draft: RuntimePolicyDraft, supportsErrorRules: boolean): RuntimePolicyProblem | null {
  const retry = draft.requestRetry;
  if (retry !== null && (!Number.isSafeInteger(retry) || retry < 0)) return { kind: 'retry' };
  if (!supportsErrorRules) return null;
  const ruleProblem = firstErrorRuleProblem(draft.errorRules);
  return ruleProblem ? { kind: 'rule', ...ruleProblem } : null;
}

/** Builds the payload. Call `runtimePolicyProblem` first: an invalid draft throws. */
export function buildRuntimePolicy(draft: RuntimePolicyDraft, supportsErrorRules: boolean): ProviderRuntimePolicy {
  const errorRules = supportsErrorRules ? buildErrorRules(draft.errorRules) : [];
  return {
    cooling: draft.cooling,
    ...(draft.requestRetry !== null ? { request_retry: draft.requestRetry } : {}),
    ...(errorRules.length > 0 ? { error_rules: errorRules } : {}),
  };
}

/** Only the switches the family has: CPA refuses a configuration naming any other. */
export function buildBehavior(draft: BehaviorDraft, switches: ProviderBehaviorSwitch[] | undefined): ProviderBehavior | undefined {
  if (!switches || switches.length === 0) return undefined;
  const behavior: ProviderBehavior = {};
  for (const name of switches) {
    Object.assign(behavior, { [name]: draft[name] });
  }
  return behavior;
}

/** How many settings depart from the gateway's defaults, for the section's count. */
export function countPolicyOverrides(
  policy: RuntimePolicyDraft,
  behavior: BehaviorDraft,
  switches: ProviderBehaviorSwitch[] | undefined,
): number {
  let count = policy.errorRules.length;
  if (policy.cooling !== 'inherit') count++;
  if (policy.requestRetry !== null) count++;
  for (const name of switches ?? []) {
    const value = behavior[name];
    if (value === true || (typeof value === 'string' && value !== 'inherit')) count++;
  }
  return count;
}
