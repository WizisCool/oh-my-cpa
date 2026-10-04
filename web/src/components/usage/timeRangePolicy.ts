/**
 * The rules behind the request list's preset list.
 *
 * Every preset is listed exactly once, including the selected one. Filtering the
 * current choice out of its own list made the operator unable to see which window
 * they were on and unable to return to it after switching away - a defect a "does
 * the value reach the URL" assertion cannot see.
 *
 * The list is derived from `EVENT_PRESETS` rather than restated, so a preset added
 * there cannot be silently missing from the picker.
 */
import { EVENT_PRESETS } from '../../types/usageEventQuery';

/** The presets listed first; the rest of `EVENT_PRESETS` follows in its own order. */
export const QUICK_PRESETS: readonly string[] = ['15m', '1h', '6h', '24h'];

export interface PresetGroups {
  quick: readonly string[];
  slow: readonly string[];
}

/**
 * splitPresets partitions the configured presets into the quick group and the
 * rest.
 *
 * Only presets that actually exist in `EVENT_PRESETS` are offered, so the picker
 * cannot name a window the query layer would reject.
 */
export function splitPresets(
  presets: Record<string, number> = EVENT_PRESETS,
  quick: readonly string[] = QUICK_PRESETS,
): PresetGroups {
  return {
    quick: quick.filter((value) => value in presets),
    slow: Object.keys(presets).filter((value) => !quick.includes(value)),
  };
}

/**
 * presetKeys returns every preset the picker lists, in order.
 *
 * It exists so a test can assert the property that matters - each preset appears
 * exactly once, including the selected one - without rendering the picker.
 */
export function presetKeys(
  presets: Record<string, number> = EVENT_PRESETS,
  quick: readonly string[] = QUICK_PRESETS,
): string[] {
  const { quick: quickKeys, slow } = splitPresets(presets, quick);
  return [...quickKeys, ...slow];
}
