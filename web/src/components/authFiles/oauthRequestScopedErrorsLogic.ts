import { PROVIDER_ERROR_RULE_ACTIONS, type ProviderErrorRule } from '../../types/providers';
import type { ErrorRuleDraft, ErrorRuleProblem } from '../policy/errorRules';
import { isValidOAuthModelAliasProvider } from './oauthModelAliasLogic';

export const OAUTH_ERROR_RULE_LIMIT = 64;

export type OAuthErrorRulesValidationResult =
  | { ok: true; provider: string; rules: ProviderErrorRule[] }
  | { ok: false; error: 'provider' }
  | { ok: false; error: 'too_many' }
  | { ok: false; error: 'invalid_rule'; position: number; problem: ErrorRuleProblem };

const isKnownAction = (action: string): boolean =>
  (PROVIDER_ERROR_RULE_ACTIONS as readonly string[]).includes(action);

/**
 * Checks whether a global OAuth error rule draft will be accepted by CPA's
 * `SanitizeOAuthRequestScopedErrors` and executed by the gateway. CPA trims
 * patterns in `oauth.request-scoped-errors`, so whitespace-only patterns are
 * rejected before submission.
 */
export function oauthErrorRuleProblem(draft: ErrorRuleDraft): ErrorRuleProblem | null {
  const status = draft.status.trim();
  if (!/^\d{3}$/.test(status) || Number(status) < 100 || Number(status) > 599) return 'status';
  const action = draft.action.trim().toLowerCase();
  if (!isKnownAction(action)) return 'action';
  if (draft.matches.length === 0) return 'no_match';
  if (draft.matches.some((match) => match.value.trim() === '')) return 'empty_match';
  return null;
}

function draftSignature(drafts: ErrorRuleDraft[]): string {
  return JSON.stringify(
    drafts.map((rule) => [
      rule.status.trim(),
      rule.action.trim().toLowerCase(),
      rule.matches.map((match) => [match.kind, match.value]),
    ]),
  );
}

export function oauthErrorRuleDraftsEqual(left: ErrorRuleDraft[], right: ErrorRuleDraft[]): boolean {
  return draftSignature(left) === draftSignature(right);
}

export function validateOAuthErrorRuleDrafts(
  rawProvider: string,
  drafts: ErrorRuleDraft[],
): OAuthErrorRulesValidationResult {
  const provider = rawProvider.trim().toLowerCase();
  if (!provider || !isValidOAuthModelAliasProvider(provider)) {
    return { ok: false, error: 'provider' };
  }
  if (drafts.length > OAUTH_ERROR_RULE_LIMIT) {
    return { ok: false, error: 'too_many' };
  }
  const rules: ProviderErrorRule[] = [];
  for (let position = 0; position < drafts.length; position++) {
    const draft = drafts[position];
    const problem = oauthErrorRuleProblem(draft);
    if (problem) {
      return { ok: false, error: 'invalid_rule', position, problem };
    }
    const match = draft.matches
      .filter((item) => item.kind === 'text')
      .map((item) => item.value.trim());
    const matchRegex = draft.matches
      .filter((item) => item.kind === 'regex')
      .map((item) => item.value.trim());
    rules.push({
      status: Number(draft.status.trim()),
      action: draft.action.trim().toLowerCase(),
      ...(match.length > 0 ? { match } : {}),
      ...(matchRegex.length > 0 ? { match_regex: matchRegex } : {}),
    });
  }
  return { ok: true, provider, rules };
}
