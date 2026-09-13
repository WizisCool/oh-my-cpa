/**
 * The rules behind the time-window picker.
 *
 * Two of these exist because the picker was wrong in a way that a "does the value
 * reach the URL" assertion cannot see:
 *
 *   - Every preset is listed exactly once, including the selected one. Filtering
 *     the current choice out of its own menu made the operator unable to see which
 *     window they were on and unable to return to it after switching away.
 *   - An absolute range is validated before it is applied, because the server
 *     requires a positive window bounded at now.
 *
 * The list of presets is derived from `EVENT_PRESETS` rather than restated, so a
 * preset added there cannot be silently missing from the menu.
 */
import { EVENT_PRESETS } from '../../types/usageEventView';

/** The presets offered inline; the rest of `EVENT_PRESETS` follows under a divider. */
export const QUICK_PRESETS: readonly string[] = ['15m', '1h', '6h', '24h'];

export interface PresetItem {
  key: string;
  label: string;
}

export interface PresetMenuGroup {
  quick: readonly string[];
  slow: readonly string[];
}

/**
 * splitPresets partitions the configured presets into the quick group and the
 * rest.
 *
 * Only presets that actually exist in `EVENT_PRESETS` are offered, so the menu
 * cannot name a window the query layer would reject.
 */
export function splitPresets(
  presets: Record<string, number> = EVENT_PRESETS,
  quick: readonly string[] = QUICK_PRESETS,
): PresetMenuGroup {
  return {
    quick: quick.filter((value) => value in presets),
    slow: Object.keys(presets).filter((value) => !quick.includes(value)),
  };
}

/**
 * presetMenuKeys returns every preset the menu will contain, in order.
 *
 * It exists so a test can assert the property that matters - each preset appears
 * exactly once, including the selected one - without rendering a dropdown.
 */
export function presetMenuKeys(
  presets: Record<string, number> = EVENT_PRESETS,
  quick: readonly string[] = QUICK_PRESETS,
): string[] {
  const { quick: quickKeys, slow } = splitPresets(presets, quick);
  return [...quickKeys, ...slow].map((value) => `preset:${value}`);
}

/** The keys the dropdown marks as selected, given the committed window. */
export function selectedPresetKeys(isAbsolute: boolean, preset: string | undefined): string[] {
  return isAbsolute ? ['absolute'] : [`preset:${preset ?? ''}`];
}

/**
 * A range draft is either a pair of millisecond bounds or `null`, which stands for
 * "the operator has cleared a side of the picker and nothing can be applied yet".
 */
export type RangePair = [number | null, number | null];

export type RangeValidationError = 'incomplete' | 'reversed' | 'future' | undefined;

export interface RangeValidation {
  /** Whether Apply may be pressed. */
  isValid: boolean;
  /** The message key to show under the picker, if any. */
  errorKey: RangeValidationError;
}

/**
 * validateAbsoluteRange decides whether an absolute window can be applied.
 *
 * A range that is merely incomplete is not reported as an error - the operator has
 * not finished choosing - while a reversed or future range is. Equal ends are
 * refused as reversed on purpose: the server requires a positive window, and
 * "from 14:05 to 14:05" would be rejected as malformed rather than shown as empty.
 *
 * `now` is a parameter so the rule is testable at a fixed instant instead of only
 * at the moment a browser happens to run it.
 */
export function validateAbsoluteRange(range: RangePair, now: number): RangeValidation {
  const [start, end] = range;
  if (start === null || end === null) {
    return { isValid: false, errorKey: 'incomplete' };
  }
  if (start >= end) {
    return { isValid: false, errorKey: 'reversed' };
  }
  if (start > now || end > now) {
    return { isValid: false, errorKey: 'future' };
  }
  return { isValid: true, errorKey: undefined };
}

/** The i18n key for a validation outcome, so the picker and the tests agree. */
export function rangeErrorKey(error: RangeValidationError): string | undefined {
  if (error === 'reversed') return 'events.range_reversed';
  if (error === 'future') return 'events.range_in_future';
  return undefined;
}
