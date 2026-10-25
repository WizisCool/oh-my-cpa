import type { MessageKey } from '../i18n/catalog';
import type React from 'react';
import type { TFunc } from '../i18n';

/**
 * The console rail as data, and the operator's choice of which entries it shows and in what order.
 *
 * The rail is a fixed model - groups of destinations - but which of those destinations a
 * deployment cares about, and where inside its group each one sits, is not: an operator who never
 * opens the Agent, the Playground or the audit trail should be able to take them out of the rail
 * without losing the pages themselves, and one who opens the usage pages before the dashboard
 * should read them in that order. The model lives here rather than in the layout so the settings
 * page can render the same entries the rail draws, and so the rules deciding what is visible and
 * what order it is in are pure functions the logic suite can pin without a browser.
 *
 * The groups themselves keep their membership and their headings. An entry is in a group because
 * of what it is - what the console runs, the gateway, what it observed, how it is controlled - so
 * ordering is a choice inside a group, never a way to reclassify an entry by dragging it.
 */

/**
 * One destination in the rail.
 *
 * A plugin's own page names itself with the label it registered, which is not copy this console
 * owns; `isLiteralLabel` is what tells the two apart, so `labelKey` is a translation id everywhere
 * the compiler can prove it.
 */
export type NavEntry =
  | { key: string; labelKey: MessageKey; isLiteralLabel?: false; icon: React.ReactNode }
  | { key: string; labelKey: string; isLiteralLabel: true; icon: React.ReactNode };

/** A run of destinations under one heading. */
export interface NavGroup {
  key: string;
  labelKey: MessageKey;
  items: NavEntry[];
}

/** The stored preference key holding the entries the operator has hidden. */
export const NAV_HIDDEN_PREFERENCE = 'omc_nav_hidden';

/** Module-scope so `usePreference` sees one stable fallback reference. Nothing hidden. */
export const DEFAULT_HIDDEN_NAV: readonly string[] = Object.freeze([]);

/** The stored preference key holding each rail group in the operator's order. */
export const NAV_ORDER_PREFERENCE = 'omc_nav_order';

/**
 * A group's entries in the operator's order, keyed by the group's stable key.
 *
 * The document is per group rather than one run of every route key because the groups are the unit
 * the operator reorders inside: a group the document does not name keeps the model's own order,
 * and a move that would cross a heading changes nothing at all.
 */
export type NavOrder = Readonly<Record<string, readonly string[]>>;

/** Module-scope so `usePreference` sees one stable fallback reference. No stored order. */
export const DEFAULT_NAV_ORDER: NavOrder = Object.freeze({});

export type NavDropSide = 'before' | 'after';

/**
 * Entries that cannot be hidden.
 *
 * The OMC Settings page is where the rail is customized, so a preference that hid it would leave
 * the operator no way back to the choice from the console itself - a state not worth being able to
 * reach. The page stays listed with a disabled control that says why, rather than quietly omitted.
 */
export const LOCKED_NAV_KEYS: ReadonlySet<string> = new Set(['/omc-settings']);

/** A route or group key is at most this long; anything larger is a client bug, not a destination. */
const MAX_NAV_KEY_LENGTH = 128;

export function isHideableNavKey(key: string): boolean {
  return !LOCKED_NAV_KEYS.has(key);
}

function isNavKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAV_KEY_LENGTH;
}

/**
 * parseHiddenNavKeys validates a stored hidden set.
 *
 * The value is JSON the browser wrote, so it is input rather than state: anything that is not a
 * hideable route key is dropped instead of being trusted. A key is stored hidden only if it is a
 * bounded, non-empty string and an entry that may be hidden at all.
 */
export function parseHiddenNavKeys(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const keys = new Set<string>();
  for (const value of raw) {
    if (!isNavKey(value) || !isHideableNavKey(value)) continue;
    keys.add(value);
  }
  return [...keys];
}

/**
 * parseNavOrder validates a stored rail order.
 *
 * The value is JSON the browser wrote, so it is input rather than state: a group whose value is not
 * an array is dropped, a key that is not a bounded non-empty route key is dropped, and a repeated
 * key keeps its first position. An empty group is stored as no order at all, because it cannot say
 * anything the model's own order does not.
 */
export function parseNavOrder(raw: unknown): Record<string, string[]> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const order: Record<string, string[]> = {};
  for (const [groupKey, value] of Object.entries(raw)) {
    if (!isNavKey(groupKey) || !Array.isArray(value)) continue;
    const keys: string[] = [];
    for (const key of value) {
      if (isNavKey(key) && !keys.includes(key)) keys.push(key);
    }
    if (keys.length > 0) order[groupKey] = keys;
  }
  return order;
}

/**
 * One group's keys in the stored order, with the destinations the document does not name appended in
 * the model's own order.
 *
 * An entry a release adds, or a page a newly started plugin registers, therefore arrives at the end
 * of its group instead of nowhere; and a stored key that no longer names a destination is left out
 * here, to be kept by `moveNavEntry` for the day that destination comes back.
 */
function completeGroupOrder(canonical: readonly string[], stored: readonly string[]): string[] {
  const present = new Set(canonical);
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of stored) {
    if (!present.has(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  for (const key of canonical) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * applyNavOrder is the rail model in the operator's order, hidden entries included.
 *
 * A group with no stored order is returned untouched, so a deployment that never rearranged the
 * rail reads the model exactly as it is written. The filter that removes hidden entries runs over
 * this result rather than before it, which is what keeps one entry's position independent of
 * whether another is hidden.
 */
export function applyNavOrder(groups: readonly NavGroup[], order: NavOrder): NavGroup[] {
  return groups.map((group) => {
    const stored = order[group.key];
    if (!stored || stored.length === 0) return group;
    const rank = new Map(completeGroupOrder(group.items.map((entry) => entry.key), stored).map((key, index) => [key, index]));
    return { ...group, items: [...group.items].sort((left, right) => rank.get(left.key)! - rank.get(right.key)!) };
  });
}

function moveKeyWithin(keys: readonly string[], movingKey: string, targetKey: string, side: NavDropSide): string[] {
  const rest = keys.filter((key) => key !== movingKey);
  const targetIndex = rest.indexOf(targetKey);
  if (targetIndex < 0) return [...keys];
  rest.splice(side === 'before' ? targetIndex : targetIndex + 1, 0, movingKey);
  return rest;
}

/**
 * moveNavEntry is the order to store after moving `movingKey` beside `targetKey`.
 *
 * A drop onto itself, or one naming a destination of another group, changes nothing: the groups say
 * what an entry is, so crossing a heading is not an ordering choice. Only the moved group is
 * rewritten, and it keeps the sequence it already holds - including a destination this build no
 * longer draws - so a plugin page whose plugin is stopped returns to the place the operator left
 * it. A destination the document does not name yet is appended in the model's own order; the groups
 * the move does not touch are carried over untouched rather than materialized into defaults.
 */
export function moveNavEntry(
  groups: readonly NavGroup[],
  order: NavOrder,
  movingKey: string,
  targetKey: string,
  side: NavDropSide,
): NavOrder {
  if (movingKey === targetKey) return order;
  const movingGroup = groups.find((group) => group.items.some((entry) => entry.key === movingKey));
  const targetGroup = groups.find((group) => group.items.some((entry) => entry.key === targetKey));
  if (!movingGroup || movingGroup !== targetGroup) return order;

  const drawn = new Set(movingGroup.items.map((entry) => entry.key));
  const stored = order[movingGroup.key] ?? [];
  const sequence = [...stored];
  const known = new Set(sequence);
  for (const entry of movingGroup.items) {
    if (known.has(entry.key)) continue;
    known.add(entry.key);
    sequence.push(entry.key);
  }

  const before = sequence.filter((key) => drawn.has(key));
  const moved = moveKeyWithin(sequence, movingKey, targetKey, side);
  const after = moved.filter((key) => drawn.has(key));
  // A drop that leaves the drawn order as it was is not a change worth storing.
  if (after.every((key, index) => key === before[index])) return order;
  return { ...order, [movingGroup.key]: moved };
}

/**
 * stepNavEntry moves one entry a place earlier or later inside its group, for the keyboards and touch
 * screens a native drag does not reach.
 *
 * Hidden entries keep their places: the panel lists them, so stepping past one is a move the
 * operator can see, and their position in the rail is where they return when shown again.
 */
export function stepNavEntry(
  groups: readonly NavGroup[],
  order: NavOrder,
  key: string,
  direction: -1 | 1,
): NavOrder {
  const group = groups.find((candidate) => candidate.items.some((entry) => entry.key === key));
  if (!group) return order;
  const keys = completeGroupOrder(group.items.map((entry) => entry.key), order[group.key] ?? []);
  const index = keys.indexOf(key);
  const neighbour = keys[index + direction];
  if (index < 0 || neighbour === undefined) return order;
  return moveNavEntry(groups, order, key, neighbour, direction < 0 ? 'before' : 'after');
}

/**
 * The hidden set as the lookup a filter wants. The stored document is what `hideNavKey` keeps
 * sorted, so that two documents naming the same keys compare equal; this is only the shape the
 * rail's filter reads.
 */
export function hiddenNavSet(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys);
}

/** Hide one entry, unless it is not hideable or already hidden. The result is sorted for stability. */
export function hideNavKey(keys: readonly string[], key: string): string[] {
  if (!isHideableNavKey(key) || keys.includes(key)) return [...keys];
  return [...keys, key].sort();
}

/** Show one entry again. */
export function showNavKey(keys: readonly string[], key: string): string[] {
  return keys.filter((candidate) => candidate !== key);
}

/** The label an entry renders, translated unless a plugin registered it literally. */
export function navEntryLabel(entry: NavEntry, t: TFunc): string {
  return entry.isLiteralLabel ? entry.labelKey : t(entry.labelKey);
}

/**
 * The groups the rail draws: hidden entries removed, and any group left with nothing dropped.
 *
 * An empty group heading is worse than no group - it reads as a section that failed to load - so a
 * group whose every destination is hidden goes with them. The rail in its collapsed form and the
 * phone sheet are built from this same result, so the three renderings cannot disagree.
 */
export function retainVisibleGroups(groups: readonly NavGroup[], hidden: ReadonlySet<string>): NavGroup[] {
  if (hidden.size === 0) return [...groups];
  const visible: NavGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => !hidden.has(item.key));
    if (items.length > 0) visible.push({ ...group, items });
  }
  return visible;
}
