import type { UsageCostFilter, UsageResultFilter } from './usageEvents';
import {
  USAGE_MULTI_FILTER_KEYS,
  USAGE_RANGE_FILTER_KEYS,
  formatUsageRangeBound,
  usageRangeParamKey,
} from './usageEvents';
import { EVENT_FILTER_KEYS, USAGE_RANGE_MAX, parseUsageRangeBound } from './usageEventQuery';
import type { EventFilterKey } from './usageEventQuery';
import { compareCostBounds, isCostRange } from './usageEvents';

/**
 * A range bound is a number for latency and tokens, and a decimal string for
 * cost. Cost is a string because a nano-dollar amount cannot survive a round
 * trip through a double, and rounding it would silently change the constraint.
 */
export type RangeBound = number | string;

/** The range fields the drawer exposes, with their i18n label and unit keys. */
export const RANGE_FIELDS = [
  { key: 'latency', labelKey: 'events.col_latency', unitKey: 'events.unit_ms' },
  { key: 'tokens', labelKey: 'events.col_tokens', unitKey: 'events.unit_tokens' },
  { key: 'cost', labelKey: 'events.col_cost', unitKey: 'events.unit_usd' },
] as const;

export type RangeFieldKey = (typeof RANGE_FIELDS)[number]['key'];

/**
 * The committed view the drawer edits: the result verdict plus the flat filter
 * parameters. `result` rides alongside the parameters rather than inside them
 * because it is a top-level query field, not a repeated filter dimension - but
 * the drawer has to be able to change it, or the panel would be a liar about
 * showing every filter that is shaping the list.
 */
export interface UsageEventsView {
  result: UsageResultFilter;
  params: Partial<Record<EventFilterKey, string[]>>;
}

/**
 * A draft is the drawer's working copy. Every editable field is present from the
 * start (never `undefined` mid-edit) so binding an input to it cannot flip the
 * control between controlled and uncontrolled.
 */
export interface UsageEventsFilterDraft {
  multi: Partial<Record<EventFilterKey, string[]>>;
  text: Partial<Record<EventFilterKey, string>>;
  ranges: Partial<Record<RangeFieldKey, { min?: RangeBound; max?: RangeBound }>>;
  cost: UsageCostFilter;
  result: UsageResultFilter;
}

export const EMPTY_FILTER_DRAFT: UsageEventsFilterDraft = {
  multi: {},
  text: {},
  ranges: {},
  cost: 'all',
  result: 'all',
};

/** Which keys carry a multi-value selection rather than free text. */
const MULTI_KEYS = new Set<string>(USAGE_MULTI_FILTER_KEYS);

/** Which range a wire key belongs to, and which side of it. */
function rangeSideOf(key: EventFilterKey): { range: RangeFieldKey; side: 'min' | 'max' } | undefined {
  for (const range of USAGE_RANGE_FILTER_KEYS) {
    if (usageRangeParamKey(range, 'min') === key) return { range, side: 'min' };
    if (usageRangeParamKey(range, 'max') === key) return { range, side: 'max' };
  }
  return undefined;
}

/**
 * draftFromView lifts the committed view into a draft.
 *
 * Committed values arrive as strings because that is what a URL holds; the
 * drawer needs them typed. Values the console cannot honour are dropped here
 * rather than rendered as an empty field that still filters the list.
 */
export function draftFromView(view: UsageEventsView): UsageEventsFilterDraft {
  const draft: UsageEventsFilterDraft = {
    multi: {},
    text: {},
    ranges: {},
    cost: 'all',
    result: view.result,
  };
  for (const key of EVENT_FILTER_KEYS) {
    const values = view.params[key];
    if (!values?.length) continue;
    if (MULTI_KEYS.has(key)) {
      draft.multi[key] = [...values];
      continue;
    }
    if (key === 'cost') {
      const value = values[0];
      if (value === 'priced' || value === 'unpriced') draft.cost = value;
      continue;
    }
    const rangeSide = rangeSideOf(key);
    if (rangeSide) {
      const parsed = parseUsageRangeBound(rangeSide.range, values[0]);
      if (parsed !== undefined) {
        draft.ranges[rangeSide.range] = { ...draft.ranges[rangeSide.range], [rangeSide.side]: parsed };
      }
      // A model alias is a repeatable dimension like any other facet, so it lands
      // in `multi`. A text box would silently do nothing for it, because the
      // serialiser reads the multi list.
      continue;
    }
    draft.text[key] = values[0];
  }
  return draft;
}

/**
 * draftToView lowers a draft back to the committed view, dropping every empty
 * field. Absence - not an empty string - is what "this dimension is not
 * filtering" means everywhere else, so a cleared field must not round trip as a
 * parameter that still applies.
 */
export function draftToView(draft: UsageEventsFilterDraft): UsageEventsView {
  const params: Partial<Record<EventFilterKey, string[]>> = {};
  for (const key of EVENT_FILTER_KEYS) {
    if (MULTI_KEYS.has(key)) {
      const values = draft.multi[key];
      if (values?.length) params[key] = [...values];
      continue;
    }
    if (key === 'cost') {
      if (draft.cost === 'priced' || draft.cost === 'unpriced') params.cost = [draft.cost];
      continue;
    }
    const rangeSide = rangeSideOf(key);
    if (rangeSide) {
      const value = draft.ranges[rangeSide.range]?.[rangeSide.side];
      if (value !== undefined) params[key] = [formatUsageRangeBound(value)];
      continue;
    }
    const text = draft.text[key]?.trim();
    if (text) params[key] = [text];
  }
  return { result: draft.result, params };
}

/**
 * validateFilterDraft reports the fields that cannot be honoured, keyed by the
 * field so each message renders under the control that produced it.
 *
 * A reversed range is rejected rather than silently swapped: the operator either
 * transposed the numbers or meant a different field, and guessing which makes
 * the panel look correct while showing a result set nobody asked for.
 */
export function validateFilterDraft(draft: UsageEventsFilterDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of RANGE_FIELDS) {
    const bounds = draft.ranges[field.key];
    if (!bounds) continue;
    for (const side of ['min', 'max'] as const) {
      const value = bounds[side];
      if (value === undefined) continue;
      // The field ceiling is a typing affordance, so it is reported here and only
      // here: URL parsing accepts anything the wire can carry.
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > USAGE_RANGE_MAX[field.key]) {
        errors[`${field.key}_${side}`] = 'events.range_too_large';
        continue;
      }
      // A stored value outside the grammar is text the operator is still editing,
      // or a stale document. Either way it cannot be honoured, so it is reported
      // rather than forwarded or silently dropped.
      if (parseUsageRangeBound(field.key, String(value)) === undefined) {
        errors[`${field.key}_${side}`] = 'events.range_invalid';
      }
    }
    const { min, max } = bounds;
    if (min === undefined || max === undefined) continue;
    if (errors[`${field.key}_min`] || errors[`${field.key}_max`]) continue;
    // Cost is compared on its scaled digits, so two bounds that differ in the
    // ninth decimal are ordered correctly rather than collapsing to one double.
    const reversed = isCostRange(field.key)
      ? compareCostBounds(String(min), String(max)) > 0
      : Number(min) > Number(max);
    if (reversed) errors[field.key] = 'events.range_reversed';
  }
  return errors;
}

/** Whether the draft would change anything, which is what enables Apply. */
export function isDraftDirty(draft: UsageEventsFilterDraft, view: UsageEventsView): boolean {
  if (draft.result !== view.result) return true;
  const next = draftToView(draft).params;
  for (const key of EVENT_FILTER_KEYS) {
    const before = view.params[key] ?? [];
    const after = next[key] ?? [];
    if (before.length !== after.length) return true;
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] !== after[index]) return true;
    }
  }
  return false;
}
