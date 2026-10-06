import type { ManagementOAuthProviderModel } from '../../types/managementOAuthModelAlias';

export const OAUTH_EXCLUDED_MODEL_RULE_LIMIT = 512;
export const OAUTH_EXCLUDED_MODEL_FIELD_LIMIT = 256;

/** The one rule that hides every model of a provider's OAuth credentials. */
export const EXCLUDE_ALL_RULE = '*';

export type ExcludedModelRuleError = 'empty' | 'whitespace' | 'too_long' | 'duplicate' | 'too_many';

// CPA lower-cases a rule before it stores or matches it, so the lower-cased
// spelling is the rule itself rather than a display form of it.
const ruleKeyOf = (value: string): string => value.trim().toLowerCase();

export const isWildcardRule = (rule: string): boolean => rule.includes('*');

export function normalizeExcludedModelRules(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const value of values) {
    const rule = ruleKeyOf(value);
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);
    rules.push(rule);
  }
  return rules;
}

/** Why a typed rule cannot join `rules`, or undefined when it can. */
export function validateExcludedModelRule(candidate: string, rules: readonly string[]): ExcludedModelRuleError | undefined {
  const rule = ruleKeyOf(candidate);
  if (!rule) return 'empty';
  // A model ID has no whitespace, so a rule holding some can only be several
  // rules typed as one and would match nothing.
  if (/[\s\u0000-\u001f\u007f]/.test(rule)) return 'whitespace';
  if (Array.from(rule).length > OAUTH_EXCLUDED_MODEL_FIELD_LIMIT) return 'too_long';
  if (rules.includes(rule)) return 'duplicate';
  if (rules.length >= OAUTH_EXCLUDED_MODEL_RULE_LIMIT) return 'too_many';
  return undefined;
}

/**
 * CPA's own matcher: only `*` is special and it matches any run of characters,
 * so the `.` in `gpt-4.1` is a literal. Segments are consumed left to right the
 * way the gateway does, rather than through a regular expression whose
 * backtracking could find a match the gateway would not.
 */
export function matchesExcludedModelRule(rule: string, modelId: string): boolean {
  const pattern = ruleKeyOf(rule);
  let value = ruleKeyOf(modelId);
  if (!pattern || !value) return false;
  if (!isWildcardRule(pattern)) return pattern === value;

  const parts = pattern.split('*');
  const prefix = parts[0];
  if (prefix) {
    if (!value.startsWith(prefix)) return false;
    value = value.slice(prefix.length);
  }
  const suffix = parts[parts.length - 1];
  if (suffix) {
    if (!value.endsWith(suffix)) return false;
    value = value.slice(0, value.length - suffix.length);
  }
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const position = value.indexOf(part);
    if (position < 0) return false;
    value = value.slice(position + part.length);
  }
  return true;
}

export interface ExcludedCatalogModel {
  id: string;
  displayName?: string;
  isExcluded: boolean;
  /** Excluded by a rule naming exactly this model: the row's own checkbox. */
  isExactlyExcluded: boolean;
  /**
   * The first pattern that also covers this model. Clearing the checkbox of
   * such a row leaves it excluded, so the row has to say which rule holds it.
   */
  patternRule?: string;
}

export interface ExcludedRuleSummary {
  rule: string;
  isWildcard: boolean;
  /** How many catalog models this rule covers; zero for a typed ID the catalog does not list. */
  matchCount: number;
}

export interface ExcludedModelsView {
  models: ExcludedCatalogModel[];
  /** Rules the catalog list cannot express as a checkbox: patterns, and IDs it does not list. */
  typedRules: ExcludedRuleSummary[];
  excludedCount: number;
  totalCount: number;
  isEverythingExcluded: boolean;
}

/**
 * Joins the rule list to the provider's catalog.
 *
 * `excludedCount` counts catalog models a rule covers, not rules: one pattern
 * may cover six models or none, and a count of rules beside a count of models
 * would be a ratio of two different things.
 */
export function describeExcludedModels(
  ruleValues: readonly string[],
  catalog: readonly ManagementOAuthProviderModel[],
): ExcludedModelsView {
  const rules = normalizeExcludedModelRules(ruleValues);
  const exactRules = new Set(rules.filter((rule) => !isWildcardRule(rule)));
  const patterns = rules.filter(isWildcardRule);
  const catalogKeys = new Set(catalog.map((model) => ruleKeyOf(model.id)));

  const models = catalog.map((model): ExcludedCatalogModel => {
    const isExactlyExcluded = exactRules.has(ruleKeyOf(model.id));
    const patternRule = patterns.find((pattern) => matchesExcludedModelRule(pattern, model.id));
    return {
      id: model.id,
      displayName: model.display_name && model.display_name !== model.id ? model.display_name : undefined,
      isExcluded: isExactlyExcluded || patternRule !== undefined,
      isExactlyExcluded,
      patternRule,
    };
  });

  const typedRules = rules
    .filter((rule) => isWildcardRule(rule) || !catalogKeys.has(rule))
    .map((rule): ExcludedRuleSummary => ({
      rule,
      isWildcard: isWildcardRule(rule),
      matchCount: isWildcardRule(rule)
        ? catalog.reduce((count, model) => (matchesExcludedModelRule(rule, model.id) ? count + 1 : count), 0)
        : 0,
    }));

  return {
    models,
    typedRules,
    excludedCount: models.reduce((count, model) => (model.isExcluded ? count + 1 : count), 0),
    totalCount: models.length,
    isEverythingExcluded: rules.includes(EXCLUDE_ALL_RULE),
  };
}

export function setExcludedModelRule(rules: readonly string[], candidate: string, shouldExclude: boolean): string[] {
  const rule = ruleKeyOf(candidate);
  const next = normalizeExcludedModelRules(rules).filter((existing) => existing !== rule);
  if (shouldExclude && rule) next.push(rule);
  return next;
}

/** Rule order carries no meaning to the gateway, so two orders of one set are the same draft. */
export function excludedModelRulesEqual(left: readonly string[], right: readonly string[]): boolean {
  const leftRules = normalizeExcludedModelRules(left).sort();
  const rightRules = normalizeExcludedModelRules(right).sort();
  return leftRules.length === rightRules.length && leftRules.every((rule, index) => rule === rightRules[index]);
}

export function filterCatalogModels<Model extends { id: string; displayName?: string }>(
  models: readonly Model[],
  query: string,
): Model[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...models];
  return models.filter((model) => (
    model.id.toLowerCase().includes(needle) || (model.displayName ?? '').toLowerCase().includes(needle)
  ));
}
