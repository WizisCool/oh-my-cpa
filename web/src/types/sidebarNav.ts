import type React from 'react';
import type { TFunc } from '../i18n';

/**
 * The console rail as data, and the operator's choice of which entries it shows.
 *
 * The rail is a fixed model - groups of destinations - but which of those destinations a
 * deployment cares about is not: an operator who never opens the Agent, the Playground or the
 * audit trail should be able to take them out of the rail without losing the pages themselves.
 * The model lives here rather than in the layout so the settings page can render the same
 * entries the rail draws, and so the rule deciding what is visible is a pure function that the
 * logic suite can pin without a browser.
 */

/** One destination in the rail. */
export interface NavEntry {
  /** The route it opens, and the stable key the hidden set names it by. */
  key: string;
  /** A translation key, or for a plugin's own page the label the plugin registered. */
  labelKey: string;
  isLiteralLabel?: boolean;
  icon: React.ReactNode;
}

/** A run of destinations under one heading. */
export interface NavGroup {
  key: string;
  labelKey: string;
  items: NavEntry[];
}

/** The stored preference key holding the entries the operator has hidden. */
export const NAV_HIDDEN_PREFERENCE = 'omc_nav_hidden';

/** Module-scope so `usePreference` sees one stable fallback reference. Nothing hidden. */
export const DEFAULT_HIDDEN_NAV: readonly string[] = Object.freeze([]);

/**
 * Entries that cannot be hidden.
 *
 * The OMC Settings page is where the rail is customized, so a preference that hid it would leave
 * the operator no way back to the choice from the console itself - a state not worth being able to
 * reach. The page stays listed with a disabled control that says why, rather than quietly omitted.
 */
export const LOCKED_NAV_KEYS: ReadonlySet<string> = new Set(['/omc-settings']);

/** A route key is at most this long; anything larger is a client bug, not a destination. */
const MAX_NAV_KEY_LENGTH = 128;

export function isHideableNavKey(key: string): boolean {
  return !LOCKED_NAV_KEYS.has(key);
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
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAV_KEY_LENGTH) continue;
    if (!isHideableNavKey(value)) continue;
    keys.add(value);
  }
  return [...keys];
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
