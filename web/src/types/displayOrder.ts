/**
 * A list's display order as the operator arranged it by dragging rows.
 *
 * It is presentation only: which credential or provider serves a request is the routing
 * arrangement's business, so nothing here reads or writes a priority or a weight. A stored order
 * names keys; an item it does not name (one added since) follows the named ones in the order the
 * list would otherwise have, and a stored key that names nothing is dropped on the next write.
 */

export type DropSide = 'before' | 'after';

/** `key` placed beside `target`; the same array when the drop changes nothing. */
export function moveKey(order: readonly string[], key: string, target: string, side: DropSide): readonly string[] {
  if (key === target || !order.includes(key) || !order.includes(target)) return order;
  const rest = order.filter((entry) => entry !== key);
  const index = rest.indexOf(target) + (side === 'after' ? 1 : 0);
  const next = [...rest.slice(0, index), key, ...rest.slice(index)];
  return next.every((entry, position) => entry === order[position]) ? order : next;
}

/** The items in the stored order, then the items it does not name in their incoming order. */
export function applyKeyOrder<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[] | undefined): T[] {
  if (!order || order.length === 0) return [...items];
  const position = new Map(order.map((key, index) => [key, index]));
  const named = items.filter((item) => position.has(keyOf(item)));
  const unnamed = items.filter((item) => !position.has(keyOf(item)));
  named.sort((left, right) => (position.get(keyOf(left)) ?? 0) - (position.get(keyOf(right)) ?? 0));
  return [...named, ...unnamed];
}

/** Each group's keys, as the OAuth list stores them; anything malformed is read as no order. */
export function parseGroupedOrder(raw: unknown): Record<string, string[]> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const order: Record<string, string[]> = {};
  for (const [group, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const keys = [...new Set(value.filter((key): key is string => typeof key === 'string' && key !== ''))];
    if (keys.length > 0) order[group] = keys;
  }
  return order;
}

/**
 * The provider list stores a rank per positional id rather than a list, so the server can re-key it
 * with the names, websites and icons when a delete moves later entries down. Ranks are decimal
 * strings because those documents are string maps.
 */
export function parseRankOrder(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const ranks: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && Number.isFinite(Number(value))) ranks[key] = value;
  }
  return ranks;
}

/** The keys a rank document orders, lowest rank first; a tie keeps the keys' incoming order. */
export function rankedKeys(keys: readonly string[], ranks: Record<string, string>): string[] {
  const ranked = keys.filter((key) => key in ranks);
  ranked.sort((left, right) => Number(ranks[left]) - Number(ranks[right]));
  return ranked;
}

/** One rank per key, in the order given. */
export function ranksOf(order: readonly string[]): Record<string, string> {
  return Object.fromEntries(order.map((key, index) => [key, String(index)]));
}
