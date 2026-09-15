/**
 * Request-record types shared by the dashboard drill-down, the event table and
 * every later analytics page. The filter vocabulary matches the server's
 * UsageEventFilter so a new facet only needs adding in one place.
 */

export interface UsageEventTokens {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

export interface UsageEvent {
  id: number;
  event_key: string;
  request_id?: string;
  timestamp_ms: number;
  provider: string;
  endpoint?: string;
  executor_type?: string;
  auth_type?: string;
  auth_index?: string;
  api_group_key?: string;
  api_group_label?: string;
  /** Display mask of the caller key (sk-12345••••••••7890). Empty for records
   *  ingested before the mask column existed: those rows keep only the
   *  fingerprint, which cannot be turned back into a readable mask. */
  api_key_mask?: string;
  /** Operator-assigned name for the caller key, resolved server-side from
   *  `api_group_key`. Display only: the fingerprint stays the filter identity, so
   *  a rename never changes what a saved filter selects. Absent when the key has
   *  not been named, and the mask is shown instead. */
  api_key_alias?: string;
  /** Client product label, redacted and shortened on the persistence path. */
  user_agent?: string | null;
  source?: string;
  model: string;
  model_alias?: string;
  reasoning_effort?: string;
  service_tier?: string;
  response_service_tier?: string;
  failed: boolean;
  generate: boolean;
  /** Whether the request was streamed (SSE/chunked). Null/absent for historical rows. */
  stream?: boolean | null;
  latency_ms: number;
  ttft_ms?: number | null;
  tokens: UsageEventTokens;
  /** Set when the credential is already triaged in Oh My CPA. */
  resource_id?: string | null;
  resource_name?: string | null;
  has_request_log: boolean;
  /** Request-time locked USD cost; absent means no price was known at ingestion. */
  cost_usd?: number | null;
  pricing_status?: 'priced' | 'unpriced' | 'legacy_unpriced' | 'invalid_price';
  price_version_id?: number | null;
}

export interface UsageEventPage {
  window: { from: number; to: number; preset?: string };
  items: UsageEvent[];
  next_cursor?: string;
  has_more: boolean;
  limit: number;
  /**
   * How many matching records were ingested after the `since` the request
   * carried. Only present when `since` was sent.
   *
   * Anchored on an ingestion id, not a request time: the list is sorted by
   * request time, so a request that started earlier and finished later arrives
   * below the first page. It is still genuinely new, and counting the loaded rows
   * would report "nothing new" while records were flowing in.
   */
  arrived_count?: number;
}

export interface UsageEventRelatedError {
  id: number;
  status_code: number;
  code?: string;
  body: string;
  retryable: boolean;
  quota_exceeded: boolean;
  quota_reason?: string;
  timestamp_ms: number;
}

export interface UsageEventDetail {
  event: UsageEvent & {
    endpoint?: string;
    client_ip?: string | null;
    x_forwarded_for?: string | null;
  };
  related_errors?: UsageEventRelatedError[];
  partial_errors?: string[];
}

export interface UsageFacetValue {
  value: string;
  requests: number;
  /** Display label for key-shaped facets (api_group_keys): the stored value is
   *  a fingerprint, the mask is what a human recognises. */
  mask?: string;
  /** Operator-assigned name for a key-shaped facet, preferred over the mask when
   *  the key has been named. Resolved from the same fingerprint as `value`, so
   *  the option label and the identity it filters by cannot diverge. */
  alias?: string;
}

export interface UsageFacets {
  models: UsageFacetValue[];
  providers: UsageFacetValue[];
  api_group_keys: UsageFacetValue[];
  auth_indexes: UsageFacetValue[];
  sources: UsageFacetValue[];
  executors: UsageFacetValue[];
  /** Closed vocabularies CPA reports, which is what a dropdown is for. Endpoint
   *  and user agent are absent by design: both are long free-form values, so
   *  they get a typed substring field instead of a capped list. */
  model_aliases: UsageFacetValue[];
  auth_types: UsageFacetValue[];
  reasoning_efforts: UsageFacetValue[];
  service_tiers: UsageFacetValue[];
}

export const USAGE_FACET_KEYS = [
  'models',
  'providers',
  'api_group_keys',
  'auth_indexes',
  'sources',
  'executors',
  'model_aliases',
  'auth_types',
  'reasoning_efforts',
  'service_tiers',
] as const;

/**
 * isUsageFacetsResponse checks that every facet the panel offers is present as an
 * array.
 *
 * A server that predates a facet returns it as `undefined`, and the dropdown then
 * renders empty — which reads as "this window contains no models", a completely
 * different statement from "these options could not be loaded". The check lets the
 * panel say the latter.
 */
export function isUsageFacetsResponse(value: unknown): value is UsageFacetsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const facets = (value as { facets?: unknown }).facets;
  if (typeof facets !== 'object' || facets === null) return false;
  return USAGE_FACET_KEYS.every((key) => Array.isArray((facets as Record<string, unknown>)[key]));
}

export interface UsageFacetsResponse {
  window: { from: number; to: number; bucket_ms: number };
  facets: UsageFacets;
}

/**
 * UsageIngestRefresh is what one manual "pull CPA now" request achieved.
 *
 * `synced` is the only field that means "stored data is current". Everything
 * else exists so the page can say what actually happened instead of reporting a
 * re-read of unchanged rows as a successful refresh.
 */
export interface UsageIngestRefresh {
  /** False when this deployment runs no collector, so nothing can be pulled. */
  enabled: boolean;
  /** True only when the queue was drained and every captured record was decoded. */
  synced: boolean;
  mode?: string;
  captured?: number;
  decoded?: number;
  pending?: number;
  decode_incomplete?: boolean;
  error?: string;
  auth_rejected?: boolean;
}

/**
 * parseUsageIngestRefresh reads the refresh response defensively.
 *
 * An unrecognized body must never read as a confirmed sync: that would turn a
 * broken response into the exact lie the refresh button exists to avoid. For the
 * same reason an absent `enabled` flag is not treated as "ingestion disabled" -
 * only the server actually saying so is.
 */
export function parseUsageIngestRefresh(value: unknown): UsageIngestRefresh {
  if (typeof value !== 'object' || value === null) {
    return { enabled: true, synced: false, error: 'unrecognized refresh response' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== 'boolean' || typeof record.synced !== 'boolean') {
    return { enabled: true, synced: false, error: 'unrecognized refresh response' };
  }
  return {
    enabled: record.enabled,
    synced: record.synced,
    auth_rejected: record.auth_rejected === true,
    decode_incomplete: record.decode_incomplete === true,
    mode: typeof record.mode === 'string' ? record.mode : undefined,
    captured: typeof record.captured === 'number' ? record.captured : undefined,
    decoded: typeof record.decoded === 'number' ? record.decoded : undefined,
    pending: typeof record.pending === 'number' ? record.pending : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
  };
}

export type UsageResultFilter = 'all' | 'success' | 'failed';

/** Whether a record carries a locked request price. Deliberately a two-value
 *  question rather than the four stored `pricing_status` values: a request whose
 *  price was unknown when it ran can never be repriced, so "unpriced" is a
 *  permanent property of the record and not a state it later leaves. */
export type UsageCostFilter = 'all' | 'priced' | 'unpriced';

/** Dimensions whose several selected values mean "any of these" (OR). Two
 *  different dimensions still mean AND, which is what makes the panel narrow as
 *  the operator adds a filter and widen as they remove one. */
export const USAGE_MULTI_FILTER_KEYS = [
  'model',
  'model_alias',
  'provider',
  'auth_index',
  'source',
  'api_key',
  'executor',
  'auth_type',
  'reasoning',
  'service_tier',
] as const;
export type UsageMultiFilterKey = (typeof USAGE_MULTI_FILTER_KEYS)[number];

/** Dimensions that hold one literal substring rather than a chosen value. */
export const USAGE_TEXT_FILTER_KEYS = ['q', 'endpoint', 'ua', 'request_id'] as const;
export type UsageTextFilterKey = (typeof USAGE_TEXT_FILTER_KEYS)[number];

/** Inclusive numeric bounds. `min`/`max` are separate keys because either side
 *  may stand alone, and a bound of zero is a real bound rather than "unset". */
export const USAGE_RANGE_FILTER_KEYS = ['latency', 'tokens', 'cost'] as const;
export type UsageRangeFilterKey = (typeof USAGE_RANGE_FILTER_KEYS)[number];

export function usageRangeParamKey(range: UsageRangeFilterKey, side: 'min' | 'max') {
  return `${range}_${side}`;
}

/**
 * A range bound is a number for latency and tokens, and a decimal string for
 * cost. Cost stays a string because a nano-dollar amount cannot round trip
 * through a double, and rounding it would silently change the constraint.
 */
export type RangeBound = number | string;

/**
 * isCostRange reports whether a range is the money dimension.
 *
 * Cost is the one range whose values are decimal strings rather than integers, so
 * every generic range path - formatting, comparison, validation - has to ask
 * rather than assume. Naming the test once keeps those paths from drifting apart.
 */
export function isCostRange(range: UsageRangeFilterKey): boolean {
  return range === 'cost';
}

/**
 * The largest amount the cost column can hold, expressed at nano-dollar precision.
 * It is int64's limit scaled to nanos, because that is the actual constraint: the
 * value is stored and compared as an integer count of nano-dollars, so a larger
 * bound cannot be represented and must be refused rather than rounded.
 */
const COST_MAX_NANOS = '9223372036854775807';

/**
 * The ceiling each range field accepts, in its own unit, as a *field* affordance.
 * It sits far above anything a real window produces and exists to catch a slipped
 * decimal point at the control, where it is reported as a validation error. URL
 * parsing deliberately does not apply it - see parseUsageRangeBound.
 */
export const USAGE_RANGE_MAX: Record<UsageRangeFilterKey, number> = {
  latency: 86_400_000,
  tokens: 1_000_000_000,
  cost: 1_000_000,
};

/** Cost is decimal USD at nano-dollar precision, which is the precision the cost
 *  column is stored in. It is carried as a string rather than a number so a small
 *  fractional amount (".0000001") never round-trips through binary floating point
 *  and never reaches the wire in exponential notation. */
export const USAGE_COST_DECIMALS = 9;

/**
 * formatUsageRangeBound renders a bound for the wire and the URL.
 *
 * It formats; it does not round. Every value reaching it has already been through
 * parseUsageRangeBound, which refuses a fractional latency or token bound rather
 * than silently changing it. Rounding here would turn a rejected input into a
 * slightly different filter, which is worse than surfacing the error.
 */
export function formatUsageRangeBound(value: number | string): string {
  return typeof value === 'string' ? value.trim() : String(value);
}

/**
 * parseUsageRangeBound accepts a bound only if this console can honour it.
 *
 * Cost is validated against the server's own grammar - an optional decimal point
 * with at most nine fractional digits - and returned as a string, so no precision
 * is lost between the field and the query. Everything unparsable, negative, of
 * excessive precision or beyond the field's ceiling is dropped instead of being
 * forwarded as a filter that matches something other than what was typed.
 */
/**
 * parseUsageRangeBound accepts a bound only if it is a value this console can put
 * on the wire losslessly.
 *
 * It deliberately does **not** apply the field ceilings. Those are a typing
 * affordance, reported at the control; applying them here would silently drop a
 * bound that the server supports, and a dropped bound is not a narrower filter -
 * it is no filter at all, so the query would return everything the operator was
 * trying to exclude. Only genuinely unrepresentable input is refused.
 */
export function parseUsageRangeBound(range: UsageRangeFilterKey, raw: string | null): number | string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (isCostRange(range)) return parseCostBound(trimmed);
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  // Bounded by what a JS number can hold exactly, because beyond that the value
  // would change as it travelled: a latency is compared as a 64-bit integer.
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** parseCostBound normalises a decimal USD amount, preserving every digit the
 *  server can store. Returns undefined for anything outside that grammar. */
function parseCostBound(raw: string): string | undefined {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) return undefined;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  // A bare "." or an empty string carries no digits, so it is not an amount.
  if (whole === '' && fraction === '') return undefined;
  // Refused, not rounded: rounding would answer a question about a fraction of a
  // nano-dollar with "no cost at all".
  if (fraction.length > USAGE_COST_DECIMALS) return undefined;
  const normalized = `${whole || '0'}${fraction ? `.${fraction}` : ''}`;
  // Compared as scaled digits against int64's nano limit. Leading zeros are
  // stripped by the scaling, so "0000000000009" is correctly read as nine.
  if (toScaledNanos(normalized).length > COST_MAX_NANOS.length) return undefined;
  if (compareCostBounds(normalized, '9223372036.854775807') > 0) return undefined;
  return normalized;
}

/** toScaledNanos renders an amount as an unsigned integer-difference-free digit
 *  string at nano precision, with leading zeros removed. It is the comparison
 *  primitive: the values are already non-negative, so one string per amount is
 *  enough to order them. */
function toScaledNanos(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const digits = `${whole}${fraction.padEnd(USAGE_COST_DECIMALS, '0')}`.replace(/^0+/, '');
  return digits === '' ? '0' : digits;
}

/**
 * compareCostBounds orders two decimal USD strings without converting them to
 * doubles.
 *
 * The comparison is on scaled digit strings, so it stays exact at the nine
 * fractional digits the column stores. `Number()` would silently collapse two
 * bounds that differ in the last place - the same precision loss the string
 * representation exists to avoid - so every cost comparison in the console goes
 * through here instead.
 */
export function compareCostBounds(left: string, right: string): number {
  const leftDigits = toScaledNanos(left);
  const rightDigits = toScaledNanos(right);
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length < rightDigits.length ? -1 : 1;
  }
  if (leftDigits === rightDigits) return 0;
  return leftDigits < rightDigits ? -1 : 1;
}

export interface UsageEventQuery {
  preset?: string;
  from?: number;
  to?: number;
  result?: UsageResultFilter;
  cost?: UsageCostFilter;
  /** Repeated-parameter dimensions, OR within each list. */
  filters?: Partial<Record<UsageMultiFilterKey, string[]>>;
  /** Literal substring dimensions. */
  text?: Partial<Record<UsageTextFilterKey, string>>;
  /** Inclusive bounds; undefined means that side does not filter. */
  ranges?: Partial<Record<UsageRangeFilterKey, { min?: RangeBound; max?: RangeBound }>>;
  cursor?: string;
  limit?: number;
  /**
   * Asks the server to report how many matching records were ingested after this
   * row id, as `arrived_count`. It does not change which rows come back.
   */
  since?: number;
}

/**
 * usageEventParams serialises a query for the events endpoint.
 *
 * Multi-select travels as a repeated parameter (`model=a&model=b`) rather than a
 * delimited list, because a comma is a legal character in a model name, a source
 * label and a caller mask; splitting on it would corrupt the very values being
 * filtered on. Empty dimensions are omitted entirely so a cleared filter is
 * indistinguishable from one that was never set.
 */
export function usageEventParams(query: UsageEventQuery): string {
  const search = new URLSearchParams();
  const assign = (key: string, value: string | number | undefined, range?: UsageRangeFilterKey) => {
    if (value === undefined || value === '') return;
    // The bound is formatted from the value as held, never through Number().
    // Converting a cost bound to a double first loses the very precision the
    // string exists to preserve: 0.000000001 becomes 1e-9, which the server's
    // decimal parser rejects.
    search.set(key, range === undefined ? String(value) : formatUsageRangeBound(value));
  };
  if (query.from !== undefined && query.to !== undefined) {
    assign('from', query.from);
    assign('to', query.to);
  } else {
    assign('preset', query.preset);
  }
  for (const key of USAGE_MULTI_FILTER_KEYS) {
    for (const value of query.filters?.[key] ?? []) {
      if (value) search.append(key, value);
    }
  }
  for (const key of USAGE_TEXT_FILTER_KEYS) {
    assign(key, query.text?.[key]);
  }
  for (const key of USAGE_RANGE_FILTER_KEYS) {
    assign(usageRangeParamKey(key, 'min'), query.ranges?.[key]?.min, key);
    assign(usageRangeParamKey(key, 'max'), query.ranges?.[key]?.max, key);
  }
  assign('result', query.result);
  assign('cost', query.cost);
  assign('cursor', query.cursor);
  assign('limit', query.limit);
  assign('since', query.since);
  return search.toString();
}

