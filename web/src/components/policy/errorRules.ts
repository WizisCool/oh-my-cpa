import { PROVIDER_ERROR_RULE_ACTIONS, type ProviderErrorRule } from '../../types/providers';

/**
 * The editable form of CPA's request-scoped error rules, shared by every surface that edits
 * them (a provider's runtime policy, a credential's policy).
 *
 * CPA applies a rule only when its status is positive, at least one pattern is non-empty and
 * its action is one it knows, and it skips any other rule without reporting it. The checks here
 * are those conditions, so the form refuses a rule that would be stored and never run. The
 * server repeats them and additionally compiles each regular expression with the engine CPA
 * uses; this module cannot, because a browser's dialect differs from Go's.
 */

export type ErrorMatchKind = 'text' | 'regex';

export interface ErrorMatchDraft {
  id: string;
  kind: ErrorMatchKind;
  value: string;
}

export interface ErrorRuleDraft {
  id: string;
  /** Text, so a half-typed or empty status is representable. */
  status: string;
  action: string;
  matches: ErrorMatchDraft[];
  /** The rule as it was read; an unchanged draft is sent back exactly as this. */
  original?: ProviderErrorRule;
}

export type ErrorRuleProblem = 'status' | 'action' | 'no_match' | 'empty_match';

export const DEFAULT_ERROR_RULE_ACTION = 'continue';

const isKnownAction = (action: string) =>
  (PROVIDER_ERROR_RULE_ACTIONS as readonly string[]).includes(action);

export function createErrorRuleDraft(id: string): ErrorRuleDraft {
  return {
    id,
    status: '',
    action: DEFAULT_ERROR_RULE_ACTION,
    matches: [{ id: `${id}-match-0`, kind: 'text', value: '' }],
  };
}

/** Ids are positional so reading the same rules twice yields equal drafts for dirty checks. */
export function readErrorRuleDrafts(rules: ProviderErrorRule[] | undefined): ErrorRuleDraft[] {
  return (rules ?? []).map((rule, position) => {
    const id = `rule-${position}`;
    return {
      id,
      status: rule.status ? String(rule.status) : '',
      action: rule.action,
      matches: [
        ...(rule.match ?? []).map((value, i): ErrorMatchDraft => ({ id: `${id}-text-${i}`, kind: 'text', value })),
        ...(rule.match_regex ?? []).map((value, i): ErrorMatchDraft => ({ id: `${id}-regex-${i}`, kind: 'regex', value })),
      ],
      original: rule,
    };
  });
}

const patternsOf = (draft: ErrorRuleDraft, kind: ErrorMatchKind) =>
  draft.matches.filter((match) => match.kind === kind).map((match) => match.value);

const isSameList = (left: string[], right: string[] | undefined) =>
  left.length === (right?.length ?? 0) && left.every((value, i) => value === right?.[i]);

/**
 * Whether the draft still states what was read. A stored rule the gateway already accepted is
 * not refused because another field of the same form changed, even when CPA would skip it.
 */
export function isUnchangedErrorRule(draft: ErrorRuleDraft): boolean {
  const original = draft.original;
  return (
    original !== undefined &&
    draft.status === (original.status ? String(original.status) : '') &&
    draft.action === original.action &&
    isSameList(patternsOf(draft, 'text'), original.match) &&
    isSameList(patternsOf(draft, 'regex'), original.match_regex)
  );
}

export function errorRuleProblem(draft: ErrorRuleDraft): ErrorRuleProblem | null {
  if (isUnchangedErrorRule(draft)) return null;
  const status = draft.status.trim();
  if (!/^\d{3}$/.test(status) || Number(status) < 100 || Number(status) > 599) return 'status';
  if (!isKnownAction(draft.action)) return 'action';
  if (draft.matches.length === 0) return 'no_match';
  // A pattern is literal, whitespace included, so only a truly empty one is refused.
  if (draft.matches.some((match) => match.value === '')) return 'empty_match';
  return null;
}

/** The first problem among the drafts, with the position of the rule that has it. */
export function firstErrorRuleProblem(
  drafts: ErrorRuleDraft[],
): { position: number; problem: ErrorRuleProblem } | null {
  for (let position = 0; position < drafts.length; position++) {
    const problem = errorRuleProblem(drafts[position]);
    if (problem) return { position, problem };
  }
  return null;
}

/** Builds the wire rules. Call `firstErrorRuleProblem` first: an invalid draft throws. */
export function buildErrorRules(drafts: ErrorRuleDraft[]): ProviderErrorRule[] {
  return drafts.map((draft) => {
    if (isUnchangedErrorRule(draft)) return draft.original as ProviderErrorRule;
    const problem = errorRuleProblem(draft);
    if (problem) throw new Error(`invalid error rule: ${problem}`);
    const match = patternsOf(draft, 'text');
    const matchRegex = patternsOf(draft, 'regex');
    return {
      status: Number(draft.status.trim()),
      action: draft.action,
      ...(match.length > 0 ? { match } : {}),
      ...(matchRegex.length > 0 ? { match_regex: matchRegex } : {}),
    };
  });
}

export function moveErrorRule(drafts: ErrorRuleDraft[], id: string, direction: -1 | 1): ErrorRuleDraft[] {
  const from = drafts.findIndex((draft) => draft.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= drafts.length) return drafts;
  const moved = [...drafts];
  [moved[from], moved[to]] = [moved[to], moved[from]];
  return moved;
}
