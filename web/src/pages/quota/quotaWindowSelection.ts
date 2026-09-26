import type { QuotaWindow } from '../../types/quota';

/** How many windows a list row shows before the rest need the Drawer. */
export const COMPACT_QUOTA_WINDOW_COUNT = 2;

/**
 * Which window a reading describes.
 *
 * Providers that publish named model groups (Antigravity) send no `kind`, only a label such as
 * "Gemini Models · Five Hour Limit Remaining" and the period it covers. The period is the
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
  if (window.scope === 'group') return `group:${window.label.split(' · ')[0]}`;
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

/**
 * The pair a list row shows.
 *
 * A row answers "can this credential serve the next request", so it carries the
 * credential's own model family - the first group the provider reports, which is the one
 * named after it - and takes that family's two shortest limits, in the same
 * shortest-first order the Drawer uses. Every other family the same endpoint publishes
 * (Antigravity answers with Claude and GPT groups beside Gemini) stays in the Drawer's
 * quota tab rather than crowding the row. A family that publishes fewer than two windows
 * is filled from what it did return; a family whose windows carry no kind keeps the order
 * its provider sent.
 */
export function pickCompactQuotaWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const primary = windows[0];
  if (!primary) return [];
  const familyKey = quotaWindowGroupKey(primary);
  const family: QuotaWindow[] = [];
  const seenIds = new Set<string>();
  for (const window of windows) {
    if (quotaWindowGroupKey(window) !== familyKey) continue;
    // A provider can repeat a bucket, and a row must not spend one of its two lines on a
    // duplicate of the other. Two readings of the same window id are one window - deduped by
    // id, not by object - while distinct windows that share a kind or a group keep both lines.
    if (window.id) {
      if (seenIds.has(window.id)) continue;
      seenIds.add(window.id);
    } else if (family.includes(window)) {
      continue;
    }
    family.push(window);
  }
  return [...family]
    .sort((left, right) => windowRank(quotaWindowKindOf(left)) - windowRank(quotaWindowKindOf(right)))
    .slice(0, COMPACT_QUOTA_WINDOW_COUNT);
}
