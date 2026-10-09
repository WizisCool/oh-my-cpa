export const CONTEXT_WARNING_SHARE = 0.75;
export const CONTEXT_DANGER_SHARE = 0.9;

/** The share of the context window in use, or undefined when either figure is unknown. */
export function contextShare(usedTokens?: number, windowTokens?: number): number | undefined {
  if (!usedTokens || !windowTokens || usedTokens < 0 || windowTokens <= 0) return undefined;
  return Math.min(usedTokens / windowTokens, 1);
}
