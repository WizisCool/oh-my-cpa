/**
 * Whether the list drawn now continues the one drawn before it.
 *
 * A transition needs something that stays: while at least one key is in both lists, the change is
 * the list narrowing or widening, and what left and what arrived can be drawn as one move. A change
 * that keeps nothing - the next page, another provider's rows, another source's plugins - replaces
 * the list instead, and tying the two states together would draw the page twice.
 */
export function keepsSomething(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length === 0 || next.length === 0) return false;
  const held = new Set(previous);
  return next.some((key) => held.has(key));
}
