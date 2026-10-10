/**
 * Reasoning-effort colour scale: one cool hue sweep, quiet at the bottom and
 * saturated at the top.
 *
 * Effort is an ordinal reading - each level is more thinking than the one below
 * it - so it gets a sequential scale rather than one colour per name. The sweep
 * runs teal → blue → violet → magenta → pink and never enters green, amber or
 * red: those hues are verdicts in this console, and a request that thought hard
 * did not succeed, degrade or fail by doing so.
 *
 * The level's own name is always printed beside the colour, so the hue only
 * speeds up a scan the text already answers. See docs/design.md §2.
 */

/**
 * The levels the upstream vendors publish, lowest first. OpenAI's ladder runs
 * `none` to `xhigh` and Anthropic's `low` to `max`; the two agree wherever they
 * overlap, so one order serves both.
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** How many levels carry a colour: every one above `none`. */
export const EFFORT_STEPS = EFFORT_LEVELS.length - 1;

/**
 * effortStep places a recorded effort on the scale: 0 for `none`, 1 to
 * `EFFORT_STEPS` for a level that reasons, and null for a value the scale does
 * not know.
 *
 * A provider-specific level (`ultra`, a token budget, `auto`) stays unranked
 * rather than being guessed into a slot: painting it as the top step would
 * state an order nobody published.
 */
export function effortStep(effort: string | undefined | null): number | null {
  const index = EFFORT_LEVELS.indexOf((effort ?? '').trim().toLowerCase() as EffortLevel);
  return index < 0 ? null : index;
}

/**
 * effortColor returns the scale colour for a step as a CSS token reference, or
 * null for the two readings that stay neutral: `none`, which is the absence of
 * reasoning, and an unranked level.
 */
export function effortColor(step: number | null): string | null {
  return step !== null && step >= 1 && step <= EFFORT_STEPS ? `var(--effort-${step})` : null;
}
