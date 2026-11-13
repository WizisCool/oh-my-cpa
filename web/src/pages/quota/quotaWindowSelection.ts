import type { TFunc } from '../../i18n';
import type { QuotaWindow } from '../../types/quota';
import { quotaWindowLabel } from './quotaFormat';

/**
 * Which window a reading describes.
 *
 * Providers that publish named model groups (Antigravity) send no `kind`, only a label such as
 * naming the group and the bucket ("Gemini Models", "Five Hour Limit Remaining") and the period it covers. The period is the
 * language-independent fact, so a row can name the window in the reader's own language instead
 * of repeating the provider's label, and ordering stops depending on the source sequence. A
 * period that matches no known bucket stays unnamed rather than being forced into one.
 */
export function quotaWindowKindOf(window: QuotaWindow): QuotaWindow['kind'] {
  if (window.kind) return window.kind;
  const hours = window.period_hours;
  if (hours == null) return undefined;
  if (Math.abs(hours - 5) < 1) return 'five_hour';
  if (Math.abs(hours - 24) < 1) return 'daily';
  if (Math.abs(hours - 168) < 1) return 'weekly';
  if (hours >= 24 * 28 && hours <= 24 * 31) return 'monthly';
  return undefined;
}

/**
 * The provider's stored label for a window in a named model group, split into the group and the
 * window's own name. Antigravity's normalizer (Go `quota.translateAntigravityBucketLabel`) writes the
 * group and the bucket joined by a middle dot into the persisted snapshot, so the joined label is
 * data: this is the one place that reads it, and a surface shows the two parts as two elements, never
 * the joined string.
 */
export const QUOTA_GROUP_LABEL_SEPARATOR = ' \u00b7 '; // separator-ok: parses the stored Antigravity label

export function quotaWindowParts(window: Pick<QuotaWindow, 'label' | 'scope'>): { group: string | null; name: string } {
  if (window.scope !== 'group') return { group: null, name: window.label };
  const [group, ...rest] = window.label.split(QUOTA_GROUP_LABEL_SEPARATOR);
  return rest.length > 0 ? { group: group.trim(), name: rest.join(QUOTA_GROUP_LABEL_SEPARATOR).trim() } : { group: group.trim(), name: window.label };
}

/** A window's whole name for an accessible label or a hint heading: the group, then the window. */
export function quotaWindowFullName(window: Pick<QuotaWindow, 'label' | 'scope'>): string {
  const { group, name } = quotaWindowParts(window);
  return group ? `${group} ${name}` : name;
}

/**
 * Shortest window first, so a reading leads with the limit that binds soonest. A provider
 * that publishes a daily limit beside its weekly one (Devin) therefore reads "daily, then
 * weekly" in both the row and the Drawer.
 */
function windowRank(kind?: string): number {
  if (kind === 'five_hour') return 0;
  if (kind === 'daily') return 1;
  if (kind === 'weekly') return 2;
  if (kind === 'monthly') return 3;
  return 4;
}

/**
 * The unit a window belongs to: one model group, one model's own limit, or the credential's
 * plan.
 *
 * A model-scoped window is keyed by the model it meters rather than by its label: the label
 * carries the period, so the same model limited over five hours and over a week would
 * otherwise be two families, and the row and the Drawer would be picking from different sets.
 * Every scope that is not the credential's own plan is its own family, including a limit
 * reported outside the plan's windows (a code-review allowance is not part of the five-hour
 * and weekly limits it sits beside). Keying a scope by its window id as well would make the
 * code-review allowance's two windows two families of one window each, so a credential whose
 * only limits were those would show one of them and hide the other.
 */
export function quotaWindowGroupKey(window: QuotaWindow): string {
  if (window.scope === 'group') return `group:${quotaWindowParts(window).group}`;
  if (window.scope === 'model') return `model:${window.model || window.label}`;
  if (window.scope === 'standard') return 'standard';
  return window.scope;
}

/** Source order, one group at a time, and within a group the shorter window first. */
export function orderQuotaWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const groups = new Map<string, number>();
  for (const window of windows) {
    const key = quotaWindowGroupKey(window);
    if (!groups.has(key)) groups.set(key, groups.size);
  }
  return [...windows].sort((left, right) => (
    groups.get(quotaWindowGroupKey(left))! - groups.get(quotaWindowGroupKey(right))!
      || windowRank(quotaWindowKindOf(left)) - windowRank(quotaWindowKindOf(right))
  ));
}

/** The model group a window belongs to, by the provider's own name; null for a plan's own window. */
export function quotaWindowGroupName(window: QuotaWindow): string | null {
  return quotaWindowParts(window).group;
}

/**
 * A window's name without its group: the period in the reader's language for a plan's window or a
 * group's, the provider's label for a model's own limit.
 */
export function quotaWindowName(window: QuotaWindow, t: TFunc): string {
  if (window.scope === 'group') {
    const { name } = quotaWindowParts(window);
    return quotaWindowLabel(quotaWindowKindOf(window), name, t);
  }
  return window.scope === 'model' ? window.label : quotaWindowLabel(window.kind, window.label, t);
}

/** Whether the server attaches capacity evidence or an unavailable reason to this window. */
export function isEstimableQuotaWindow(window: QuotaWindow): boolean {
  return Boolean(window.model_forecasts?.length || window.usage || window.forecast_unavailable);
}

/**
 * All estimable sibling periods belonging to the same quota family (e.g. 5-hour and weekly on the
 * plan or on one Antigravity model group), ordered shortest period first so the capacity modal can
 * switch directly between them.
 */
export function siblingCapacityWindows(target: QuotaWindow, allWindows?: readonly QuotaWindow[]): QuotaWindow[] {
  const familyKey = quotaWindowGroupKey(target);
  const seen = new Set<string>();
  const matched: QuotaWindow[] = [];
  for (const candidate of allWindows ?? []) {
    if (!candidate.id || seen.has(candidate.id)) continue;
    if (quotaWindowGroupKey(candidate) !== familyKey) continue;
    if (candidate.id !== target.id && !isEstimableQuotaWindow(candidate)) continue;
    seen.add(candidate.id);
    matched.push(candidate);
  }
  if (!seen.has(target.id)) {
    matched.push(target);
  }
  return orderQuotaWindows(matched);
}
