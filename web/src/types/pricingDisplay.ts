/**
 * Pure helpers for showing prices and request costs. They carry no React so the logic suite can
 * pin them, and every figure they print derives from what the server stored: the editor's preview
 * mirrors the server's tier rule, but a recorded request's amount is always the stored one.
 */
import type { ModelPrice, PriceTier, PricingMode, UpstreamModel } from './pricing';

/** Trims trailing zeros while keeping at least `minDecimals`, so $3 reads "$3.00" and $0.075 stays exact. */
function trimDecimals(value: number, maxDecimals: number, minDecimals: number): string {
  const fixed = value.toFixed(maxDecimals);
  if (!fixed.includes('.')) return fixed;
  let [whole, fraction] = fixed.split('.');
  fraction = fraction.replace(/0+$/, '');
  while (fraction.length < minDecimals) fraction += '0';
  if (whole === '-0') whole = '0';
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A per-1M rate: exact to six decimals, never rounded to a cent, because $0.075 and $0.08 are different prices. */
export function formatRatePer1M(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `$${trimDecimals(rate, 6, 2)}`;
}

/**
 * A money amount sized to its magnitude. A request usually costs a fraction of a cent and a month
 * costs dollars; one fixed precision either hides the first or clutters the second.
 */
export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  const magnitude = Math.abs(usd);
  if (magnitude === 0) return '$0.00';
  if (magnitude >= 100) return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (magnitude >= 1) return `$${usd.toFixed(2)}`;
  if (magnitude >= 0.01) return `$${trimDecimals(usd, 4, 2)}`;
  return `$${trimDecimals(usd, 6, 2)}`;
}

/** USD nanos, the unit the server stores request costs in. */
export function nanosToUsd(nanos: number | null | undefined): number | null {
  if (nanos === null || nanos === undefined || !Number.isFinite(nanos)) return null;
  return nanos / 1_000_000_000;
}

export function formatMultiplier(multiplier: number): string {
  return `×${trimDecimals(multiplier, 4, 0)}`;
}

/** HHMM as the clock face reads it: 1600 → "16:00", 0 → "00:00". */
export function formatHHMM(value: number): string {
  const hours = Math.floor(value / 100);
  const minutes = value % 100;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function hasTimeWindow(tier: PriceTier): tier is PriceTier & { utc_start: number; utc_end: number } {
  return typeof tier.utc_start === 'number' && typeof tier.utc_end === 'number';
}

function isValidHHMM(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 2359 && value % 100 < 60;
}

/** The zone a tier's window is read in. */
export function tierTimeZone(tier: Pick<PriceTier, 'time_zone'>): string {
  return tier.time_zone || 'UTC';
}

const CLOCK_FORMATS = new Map<string, Intl.DateTimeFormat | null>();

/**
 * The minute of the day an instant falls on in a zone, or null for a zone the runtime does not
 * know. Reading the zone's own wall clock is what makes a window follow daylight saving.
 */
export function minuteOfDayIn(timestampMs: number, zone: string): number | null {
  let format = CLOCK_FORMATS.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    } catch {
      format = null;
    }
    CLOCK_FORMATS.set(zone, format);
  }
  if (!format) return null;
  const parts = format.formatToParts(timestampMs);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const minute = (read('hour') % 24) * 60 + read('minute');
  return Number.isFinite(minute) ? minute : null;
}

/**
 * How many minutes a clock in `to` is ahead of one in `from` at an instant, around the clock face.
 * It only ever moves an "HH:mm" for display, so a whole-day difference is the same as none.
 */
export function clockShiftMinutes(from: string, to: string, timestampMs: number): number {
  const source = minuteOfDayIn(timestampMs, from);
  const target = minuteOfDayIn(timestampMs, to);
  if (source === null || target === null) return 0;
  return (((target - source) % 1440) + 1440) % 1440;
}

function inWindow(minute: number, startHHMM: number, endHHMM: number): boolean {
  if (!isValidHHMM(startHHMM) || !isValidHHMM(endHHMM) || startHHMM === endHHMM) return false;
  const start = Math.floor(startHHMM / 100) * 60 + (startHHMM % 100);
  const end = Math.floor(endHHMM / 100) * 60 + (endHHMM % 100);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The one spelling service tiers are stored and compared in. */
export function normalizeServiceTier(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * The service tier a request is priced on, by the server's rule: the tier the upstream reported,
 * else the one the request asked for; `auto` and empty name no tier.
 */
export function billedServiceTier(response: string | null | undefined, requested: string | null | undefined): string {
  for (const value of [response, requested]) {
    const tier = normalizeServiceTier(value);
    if (tier !== '' && tier !== 'auto') return tier;
  }
  return '';
}

function hasServiceTiers(tier: PriceTier): boolean {
  return (tier.service_tiers?.length ?? 0) > 0;
}

/**
 * The single tier that governs a request, by the server's rule: every condition a tier carries
 * must hold - the billed service tier among its service tiers, a window on the tier's own clock,
 * never applying in a zone that cannot be read; among those that do, a service-tier tier wins,
 * then the highest prompt threshold, then a windowed tier over an unwindowed one, then list order.
 * Returns -1 for the base rates.
 */
export function selectTier(
  tiers: readonly PriceTier[] | null | undefined,
  inputTokens: number,
  timestampMs: number,
  serviceTier = '',
): number {
  if (!tiers) return -1;
  const billed = normalizeServiceTier(serviceTier);
  let best = -1;
  tiers.forEach((tier, index) => {
    const threshold = tier.min_prompt_tokens ?? 0;
    const windowed = hasTimeWindow(tier);
    const laned = hasServiceTiers(tier);
    if (threshold === 0 && !windowed && !laned) return;
    if (laned && (billed === '' || !tier.service_tiers!.some((name) => normalizeServiceTier(name) === billed))) return;
    if (threshold > 0 && Math.max(inputTokens, 0) < threshold) return;
    if (windowed) {
      const minute = minuteOfDayIn(timestampMs, tierTimeZone(tier));
      if (minute === null || !inWindow(minute, tier.utc_start, tier.utc_end)) return;
    }
    if (best < 0) {
      best = index;
      return;
    }
    const current = tiers[best];
    const currentThreshold = current.min_prompt_tokens ?? 0;
    if (laned !== hasServiceTiers(current)) {
      if (laned) best = index;
      return;
    }
    if (threshold !== currentThreshold ? threshold > currentThreshold : windowed && !hasTimeWindow(current)) {
      best = index;
    }
  });
  return best;
}

export type RateFields = Pick<ModelPrice,
  'prompt_price_per_1m' | 'completion_price_per_1m' | 'cache_read_price_per_1m' | 'cache_write_price_per_1m'>;

export interface PreviewTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * What a request would cost at a price the operator is still editing, in USD. It mirrors the
 * server's formula (uncached prompt, completion, cache read and write, tier laid over the base,
 * both multipliers) in floating point, which is fine for a preview and is never stored.
 */
export function previewCostUsd(
  price: RateFields & { price_multiplier: number; tiers?: PriceTier[] | null },
  tokens: PreviewTokens,
  options: { channelMultiplier?: number; timestampMs?: number; serviceTier?: string } = {},
): { usd: number; tierIndex: number } {
  const tierIndex = selectTier(price.tiers, tokens.input, options.timestampMs ?? Date.now(), options.serviceTier);
  const tier = tierIndex >= 0 && price.tiers ? price.tiers[tierIndex] : undefined;
  const prompt = tier?.prompt_price_per_1m ?? price.prompt_price_per_1m;
  const completion = tier?.completion_price_per_1m ?? price.completion_price_per_1m;
  const cacheRead = tier?.cache_read_price_per_1m ?? price.cache_read_price_per_1m;
  const cacheWrite = tier?.cache_write_price_per_1m ?? price.cache_write_price_per_1m;
  const read = Math.max(tokens.cache_read, 0);
  const write = Math.max(tokens.cache_write, 0);
  let uncached = Math.max(tokens.input, 0);
  uncached -= Math.min(uncached, read);
  uncached -= Math.min(uncached, write);
  const base = (uncached * prompt + Math.max(tokens.output, 0) * completion + read * cacheRead + write * cacheWrite) / 1_000_000;
  return { usd: base * price.price_multiplier * (options.channelMultiplier ?? 1), tierIndex };
}

/** The mode a row is maintained in, for rows from a server that did not send one. */
export function modeOf(price: Pick<ModelPrice, 'source' | 'mode' | 'match_kind'>): PricingMode {
  if (price.mode) return price.mode;
  if (price.source === 'manual') return 'custom';
  return price.match_kind === 'linked' ? 'linked' : 'auto';
}

/** Every tier's rates as numbers, so a table can say how much more the long-context tier charges. */
export function tierRates(price: RateFields, tier: PriceTier): RateFields {
  return {
    prompt_price_per_1m: tier.prompt_price_per_1m ?? price.prompt_price_per_1m,
    completion_price_per_1m: tier.completion_price_per_1m ?? price.completion_price_per_1m,
    cache_read_price_per_1m: tier.cache_read_price_per_1m ?? price.cache_read_price_per_1m,
    cache_write_price_per_1m: tier.cache_write_price_per_1m ?? price.cache_write_price_per_1m,
  };
}

/** Relative change from one rate to another, or null when there is nothing to compare against. */
export function rateDelta(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return (to - from) / from;
}

/** Search is forgiving about separators; automatic price matching remains server-owned. */
export function matchesModelSearch(query: string, ...identities: string[]): boolean {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const haystack = identities.join(' ').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Exact identities rank before prefix matches; canonical slugs are searchable too. */
export function searchUpstreamModels(models: readonly UpstreamModel[], query: string, limit = 50): UpstreamModel[] {
  const matching = models.filter((model) => matchesModelSearch(query, model.id, model.name, model.canonical_slug));
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const needle = normalize(query);
  const rank = (model: UpstreamModel) => {
    if (!needle) return 2;
    const identities = [model.id, model.canonical_slug].flatMap((id) => [normalize(id), normalize(id.slice(id.indexOf('/') + 1))]);
    if (identities.includes(needle)) return 0;
    return identities.some((id) => id.startsWith(needle)) ? 1 : 2;
  };
  matching.sort((left, right) => rank(left) - rank(right)
    || Number(left.id.startsWith('~')) - Number(right.id.startsWith('~'))
    || left.id.localeCompare(right.id));
  return matching.slice(0, limit);
}

/** The author namespace of an OpenRouter id: "anthropic/claude-opus-5.5" → "anthropic". */
export function upstreamAuthor(id: string): string {
  const trimmed = id.startsWith('~') ? id.slice(1) : id;
  const slash = trimmed.indexOf('/');
  return slash > 0 ? trimmed.slice(0, slash) : '';
}

/**
 * Which question a tier answers, as the editor groups them. A long-context tier always has a
 * prompt threshold and may also be limited to a window; a time-of-day tier has only a window; a
 * service tier's own rates (`service`) have no condition beyond the lane's service tiers.
 * The wire tier carries no kind - it is read from the conditions present.
 */
export type TierKind = 'context' | 'window' | 'service';

/**
 * How a tier's rates are entered. Providers publish long-context and off-peak prices as a multiple
 * of the base ("input doubles above 200K", "half price at night"), so a multiple is the default
 * and keeps following the base rates while they are edited; an absolute price is the escape hatch.
 */
export type TierRateUnit = 'multiple' | 'price';

export type RateKey = 'prompt' | 'completion' | 'cacheRead' | 'cacheWrite';

export const RATE_KEYS: readonly RateKey[] = ['prompt', 'completion', 'cacheRead', 'cacheWrite'];

const RATE_FIELD: Record<RateKey, keyof RateFields> = {
  prompt: 'prompt_price_per_1m',
  completion: 'completion_price_per_1m',
  cacheRead: 'cache_read_price_per_1m',
  cacheWrite: 'cache_write_price_per_1m',
};

/** The wire field a rate key reads and writes. */
export function rateField(key: RateKey): keyof RateFields {
  return RATE_FIELD[key];
}

/**
 * One tier as the editor holds it: every field a string so a half-typed value survives
 * re-renders, converted to a `PriceTier` only on save. The window is held as "HH:mm" on the clock
 * of `timeZone`, exactly as it is stored; showing it in another zone is presentation only.
 */
export interface TierDraft {
  key: string;
  kind: TierKind;
  /**
   * The price lane the tier belongs to: '' for standard requests, otherwise an editor-only id
   * shared by every tier of one service-tier lane. Providers publish a priority lane as its own
   * rate card, so a lane holds its own rates and its own long-context steps.
   */
  lane: string;
  /** The lane's upstream service tiers, lowercase; empty on the standard lane. */
  serviceTiers: string[];
  /** A token count as typed: "200000", "200,000", "200K" or "1M". */
  minPromptTokens: string;
  /** Whether a long-context tier is further limited to a window; a time-of-day tier always is. */
  isWindowed: boolean;
  windowStart: string;
  windowEnd: string;
  /** IANA zone the window is read in; "UTC" is saved as a tier without a zone. */
  timeZone: string;
  rateUnit: TierRateUnit;
  prompt: string;
  completion: string;
  cacheRead: string;
  cacheWrite: string;
}

let tierDraftCounter = 0;

function hhmmText(value: number | undefined): string {
  return typeof value === 'number' ? formatHHMM(value) : '';
}

/** Up to twelve significant digits: enough for any published rate, short of float noise. */
function cleanNumber(value: number): number {
  return Number(value.toPrecision(12));
}

function numberText(value: number): string {
  return String(cleanNumber(value));
}

export function newTierDraft(partial: Partial<TierDraft> = {}): TierDraft {
  tierDraftCounter += 1;
  return {
    key: `tier-${tierDraftCounter}`,
    kind: 'context',
    lane: '',
    serviceTiers: [],
    minPromptTokens: '',
    isWindowed: false,
    windowStart: '',
    windowEnd: '',
    timeZone: 'UTC',
    rateUnit: 'multiple',
    prompt: '',
    completion: '',
    cacheRead: '',
    cacheWrite: '',
    ...partial,
  };
}

/** A multiple short enough to read as one, such as 2 or 1.5 or 0.25. */
function isReadableMultiple(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio >= 0 && Math.abs(ratio * 1000 - Math.round(ratio * 1000)) < 1e-6;
}

let laneCounter = 0;

/** A new editor-only lane id. */
export function newLaneId(): string {
  laneCounter += 1;
  return `lane-${laneCounter}`;
}

/** A service-tier list as the server stores it: lowercase, trimmed, sorted, without repeats. */
export function canonicalServiceTiers(names: readonly string[] | null | undefined): string[] {
  return [...new Set((names ?? []).map(normalizeServiceTier))].sort();
}

/** Whether a name can be stored as a service tier: what the server accepts, and never auto. */
export function isValidServiceTierName(name: string): boolean {
  return /^[a-z0-9._-]{1,64}$/.test(name) && name !== 'auto';
}

function isLaneBaseTier(tier: PriceTier): boolean {
  return hasServiceTiers(tier) && (tier.min_prompt_tokens ?? 0) === 0 && !hasTimeWindow(tier);
}

/**
 * Drafts for stored tiers. Given the base they apply over, a tier whose every rate is a readable
 * multiple of the base opens as multiples - how its provider published it - and any other as
 * absolute prices, so nothing is rounded on the way in.
 *
 * Tiers sharing a service-tier list open as one lane. Inside a lane the editor reads rates
 * against the lane's own rates rather than the standard ones: a priority long-context step reads
 * "input doubles" against the priority price. A stored rate the step leaves out bills the
 * standard rate, so where the lane sets its own the draft shows it explicitly, and a rate equal
 * to the lane's opens blank; `tiersFromDrafts` writes the same tiers back. Every lane gets one
 * `service` draft, blank when the lane stores no rates of its own, which saves as nothing.
 */
export function tierDraftsFrom(tiers: readonly PriceTier[] | null | undefined, base?: RateFields | null): TierDraft[] {
  const list = tiers ?? [];
  const laneIds = new Map<string, string>();
  const laneBases = new Map<string, PriceTier>();
  const laneOf = (tier: PriceTier) => {
    const key = canonicalServiceTiers(tier.service_tiers).join(',');
    if (key === '') return '';
    if (!laneIds.has(key)) laneIds.set(key, newLaneId());
    return laneIds.get(key)!;
  };
  for (const tier of list) {
    const lane = laneOf(tier);
    if (lane && isLaneBaseTier(tier) && !laneBases.has(lane)) laneBases.set(lane, tier);
  }
  const drafts = list.map((tier) => {
    const lane = laneOf(tier);
    const hasThreshold = (tier.min_prompt_tokens ?? 0) > 0;
    const windowed = hasTimeWindow(tier);
    const kind: TierKind = lane && !hasThreshold && !windowed ? 'service' : hasThreshold ? 'context' : 'window';
    const laneBase = lane && kind !== 'service' ? laneBases.get(lane) : undefined;
    const reference = laneBase && base ? tierRates(base, laneBase) : base ?? null;
    const shown = (key: RateKey): number | undefined => {
      const field = RATE_FIELD[key];
      const rate = tier[field];
      if (!laneBase) return rate;
      const laneRate = laneBase[field];
      if (rate === undefined) return laneRate === undefined ? undefined : base?.[field];
      return rate === laneRate ? undefined : rate;
    };
    const isMultiple = Boolean(reference) && RATE_KEYS.every((key) => {
      const rate = shown(key);
      if (rate === undefined) return true;
      const from = reference![RATE_FIELD[key]];
      return from > 0 && isReadableMultiple(rate / from);
    });
    const rateText = (key: RateKey) => {
      const rate = shown(key);
      if (rate === undefined) return '';
      return isMultiple ? numberText(rate / reference![RATE_FIELD[key]]) : numberText(rate);
    };
    return newTierDraft({
      kind,
      lane,
      serviceTiers: canonicalServiceTiers(tier.service_tiers),
      minPromptTokens: hasThreshold ? formatTokenCount(tier.min_prompt_tokens!) : '',
      isWindowed: windowed,
      windowStart: hhmmText(tier.utc_start),
      windowEnd: hhmmText(tier.utc_end),
      timeZone: tierTimeZone(tier),
      rateUnit: isMultiple ? 'multiple' : 'price',
      prompt: rateText('prompt'),
      completion: rateText('completion'),
      cacheRead: rateText('cacheRead'),
      cacheWrite: rateText('cacheWrite'),
    });
  });
  for (const [key, lane] of laneIds) {
    if (!laneBases.has(lane)) drafts.push(newTierDraft({ kind: 'service', lane, serviceTiers: key.split(',') }));
  }
  return drafts;
}

/** The lanes the drafts hold besides the standard one, in the order they first appear. */
export function serviceLanes(drafts: readonly TierDraft[]): string[] {
  return [...new Set(drafts.filter((draft) => draft.lane !== '').map((draft) => draft.lane))];
}

/** A draft's rates as prices, read against `reference`; an error when one cannot be read. */
function draftPrices(draft: TierDraft, reference: RateFields | null): Partial<RateFields> | 'rate' | 'base' {
  const prices: Partial<RateFields> = {};
  for (const key of RATE_KEYS) {
    const value = parseRateText(draft[key]);
    if (value === undefined) continue;
    if (Number.isNaN(value)) return 'rate';
    if (draft.rateUnit === 'multiple') {
      if (!reference) return 'base';
      prices[RATE_FIELD[key]] = cleanNumber(value * reference[RATE_FIELD[key]]);
    } else {
      prices[RATE_FIELD[key]] = value;
    }
  }
  return prices;
}

/** The rates a lane's own `service` draft sets, as prices; empty when it sets none. */
function laneOwnPrices(drafts: readonly TierDraft[], lane: string, base: RateFields | null): Partial<RateFields> | null {
  const own = drafts.find((draft) => draft.lane === lane && draft.kind === 'service');
  if (!own) return {};
  const prices = draftPrices(own, base);
  return typeof prices === 'string' ? null : prices;
}

/**
 * The rates a lane's steps are read against: the standard rates with the lane's own laid over
 * them. The standard lane reads the base itself; null while either cannot be read.
 */
export function laneRates(drafts: readonly TierDraft[], lane: string, base: RateFields | null): RateFields | null {
  if (lane === '' || !base) return base;
  const own = laneOwnPrices(drafts, lane, base);
  return own ? { ...base, ...own } : null;
}

/**
 * Switches how a draft's rates are entered, converting what is typed so the price it describes
 * does not change. A rate whose base is zero has no multiple and is cleared.
 */
export function convertTierDraftUnit(draft: TierDraft, base: RateFields, unit: TierRateUnit): TierDraft {
  if (draft.rateUnit === unit) return draft;
  const next: TierDraft = { ...draft, rateUnit: unit };
  for (const key of RATE_KEYS) {
    const value = parseRateText(draft[key]);
    if (value === undefined || Number.isNaN(value)) continue;
    const from = base[RATE_FIELD[key]];
    if (unit === 'price') next[key] = numberText(value * from);
    else next[key] = from > 0 ? numberText(value / from) : '';
  }
  return next;
}

/** A token count as people write it, "272K" for 272,000; any count that is not round stays exact. */
export function formatTokenCount(tokens: number): string {
  if (tokens > 0 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens > 0 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

/**
 * A token count as typed: digits with optional separators, or a K/M suffix in decimal thousands -
 * the unit providers publish context limits in. Undefined when blank, NaN when not a positive
 * whole number of tokens.
 */
export function parseTokenCount(text: string): number | undefined {
  const trimmed = text.trim().replace(/[,_\s]/g, '');
  if (trimmed === '') return undefined;
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(trimmed);
  if (!match) return Number.NaN;
  const scale = match[2] === '' ? 1 : match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  const value = Number(match[1]) * scale;
  return Number.isInteger(cleanNumber(value)) && value > 0 ? cleanNumber(value) : Number.NaN;
}

function parseHHMMText(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 100 + minutes;
}

/**
 * "HH:mm" moved by a number of minutes around the clock face. The editor uses it to show a
 * window kept on a vendor's clock as the console's zone reads it.
 */
export function shiftClockText(value: string, offsetMinutes: number): string {
  const hhmm = parseHHMMText(value);
  if (hhmm === null) return '';
  const minute = Math.floor(hhmm / 100) * 60 + (hhmm % 100);
  const shifted = (((minute + offsetMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
}

/** A non-negative decimal, or undefined when blank; NaN marks a value that is not a number. */
export function parseRateText(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

/** The server's bound on one price's tiers. */
export const MAX_TIERS = 16;

/** The server's bound on one tier's service-tier names. */
export const MAX_SERVICE_TIERS_PER_TIER = 8;

export type TierDraftError = 'condition' | 'window' | 'rate' | 'base' | 'duplicate' | 'service';

/**
 * Converts the editor's tiers, refusing what the server would refuse and what could never apply:
 * a long-context tier needs a positive threshold, a window needs a start and a different end,
 * every rate must be a non-negative number, a multiple needs base rates to multiply, a lane needs
 * valid service-tier names that no other lane claims, and two tiers with the same conditions
 * would leave the second unreachable. The first failing tier is reported by its position in
 * `drafts` so the editor can mark it.
 *
 * A lane step's blank rate keeps the lane's own rate, so it is written out explicitly: the server
 * fills a missing rate from the standard price. A lane's `service` draft with no rates is not
 * written - it would only make standard rates outrank the standard long-context steps.
 *
 * Standard tiers are written before lanes, long-context before time-of-day. The server's rule only
 * falls back to list order between tiers with the same conditions' shape, which always share a
 * kind and a lane, so the grouping never changes which tier governs a request.
 */
export function tiersFromDrafts(
  drafts: readonly TierDraft[],
  base: RateFields | null = null,
): { tiers: PriceTier[] } | { error: TierDraftError; index: number } {
  const lanes = ['', ...serviceLanes(drafts)];
  const claimed = new Map<string, string>();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    if (draft.kind !== 'service') continue;
    const names = canonicalServiceTiers(draft.serviceTiers);
    if (names.length === 0 || names.length > MAX_SERVICE_TIERS_PER_TIER || names.some((name) => !isValidServiceTierName(name))) {
      return { error: 'service', index };
    }
    for (const name of names) {
      if ((claimed.get(name) ?? draft.lane) !== draft.lane) return { error: 'service', index };
      claimed.set(name, draft.lane);
    }
  }
  const order = (draft: TierDraft) => lanes.indexOf(draft.lane) * 3 + (draft.kind === 'service' ? 0 : draft.kind === 'context' ? 1 : 2);
  const converted: Array<{ order: number; tier: PriceTier }> = [];
  const conditions = new Set<string>();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const tier: PriceTier = {};
    if (draft.lane) tier.service_tiers = canonicalServiceTiers(draft.serviceTiers);
    if (draft.kind === 'context') {
      const threshold = parseTokenCount(draft.minPromptTokens);
      if (threshold === undefined || Number.isNaN(threshold)) return { error: 'condition', index };
      tier.min_prompt_tokens = threshold;
    }
    if (draft.kind === 'window' || (draft.kind === 'context' && draft.isWindowed)) {
      const start = parseHHMMText(draft.windowStart);
      const end = parseHHMMText(draft.windowEnd);
      if (start === null || end === null || start === end) return { error: 'window', index };
      tier.utc_start = start;
      tier.utc_end = end;
      // A UTC window is written without a zone, the spelling every tier had before zones: an
      // untouched tier then saves byte-identical and mints no price version.
      if (draft.timeZone && draft.timeZone !== 'UTC') tier.time_zone = draft.timeZone;
    }
    const isLaneStep = draft.lane !== '' && draft.kind !== 'service';
    const reference = isLaneStep ? laneRates(drafts, draft.lane, base) : base;
    const prices = draftPrices(draft, reference);
    if (prices === 'rate') return { error: 'rate', index };
    if (prices === 'base') return { error: 'base', index };
    const laneOwn = isLaneStep ? laneOwnPrices(drafts, draft.lane, base) ?? {} : {};
    for (const key of RATE_KEYS) {
      const field = RATE_FIELD[key];
      const price = prices[field] ?? laneOwn[field];
      if (price !== undefined) tier[field] = price;
    }
    if (draft.kind === 'service' && RATE_KEYS.every((key) => tier[RATE_FIELD[key]] === undefined)) continue;
    const condition = `${(tier.service_tiers ?? []).join(',')}|${tier.min_prompt_tokens ?? 0}|${tier.utc_start ?? ''}|${tier.utc_end ?? ''}|${tier.time_zone ?? ''}`;
    if (conditions.has(condition)) return { error: 'duplicate', index };
    conditions.add(condition);
    converted.push({ order: order(draft), tier });
  }
  return { tiers: converted.map((item, position) => ({ ...item, position })).sort((left, right) => left.order - right.order || left.position - right.position).map((item) => item.tier) };
}

/** One line of a price ladder: when it applies and the four rates a request pays there. */
export interface PriceScheduleRow {
  /** -1 for the base rates, otherwise the tier's index in the price's own list. */
  tierIndex: number;
  tier: PriceTier | null;
  rates: RateFields;
  /** Rates the tier leaves to the base price. */
  inherited: ReadonlySet<RateKey>;
  /** For the base row: the lowest always-on long-context threshold, where the base stops applying. */
  upTo: number | null;
}

/**
 * A price laid out as a ladder: the base rates, then long-context tiers from the lowest threshold
 * up, then time-of-day tiers, then each service-tier lane the same way. It reads what a request pays at each step rather than how the tiers
 * are stored, which is the question an operator setting a price is asking.
 */
export function priceSchedule(price: RateFields, tiers: readonly PriceTier[] | null | undefined): PriceScheduleRow[] {
  const list = tiers ?? [];
  const thresholds = list
    .filter((tier) => (tier.min_prompt_tokens ?? 0) > 0 && !hasTimeWindow(tier) && !hasServiceTiers(tier))
    .map((tier) => tier.min_prompt_tokens!);
  const rows: PriceScheduleRow[] = [{
    tierIndex: -1,
    tier: null,
    rates: { ...price },
    inherited: new Set(),
    upTo: thresholds.length > 0 ? Math.min(...thresholds) : null,
  }];
  // Always-on context tiers form the ladder the base row's `upTo` leads into; a context tier
  // limited to a window only covers its band part of the day, so it follows them with the
  // plain time windows instead of sitting between two always-on steps. Each service-tier lane
  // follows the standard ladder as its own: its own rates, then its steps.
  const lane = (tier: PriceTier) => canonicalServiceTiers(tier.service_tiers).join(',');
  const group = (tier: PriceTier) => (isLaneBaseTier(tier) ? -1 : (tier.min_prompt_tokens ?? 0) > 0 ? (hasTimeWindow(tier) ? 1 : 0) : 2);
  const order = list.map((tier, index) => ({ tier, index })).sort((left, right) => (
    (lane(left.tier) === lane(right.tier) ? 0 : lane(left.tier) < lane(right.tier) ? -1 : 1)
    || group(left.tier) - group(right.tier)
    || (left.tier.min_prompt_tokens ?? 0) - (right.tier.min_prompt_tokens ?? 0)
    || left.index - right.index
  ));
  for (const { tier, index } of order) {
    rows.push({
      tierIndex: index,
      tier,
      rates: tierRates(price, tier),
      inherited: new Set(RATE_KEYS.filter((key) => tier[RATE_FIELD[key]] === undefined)),
      upTo: null,
    });
  }
  return rows;
}
