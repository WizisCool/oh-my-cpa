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

function minuteOfDayUTC(timestampMs: number): number {
  const minutes = Math.floor(timestampMs / 60_000) % 1440;
  return minutes < 0 ? minutes + 1440 : minutes;
}

function inWindow(minute: number, startHHMM: number, endHHMM: number): boolean {
  if (!isValidHHMM(startHHMM) || !isValidHHMM(endHHMM) || startHHMM === endHHMM) return false;
  const start = Math.floor(startHHMM / 100) * 60 + (startHHMM % 100);
  const end = Math.floor(endHHMM / 100) * 60 + (endHHMM % 100);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * The single tier that governs a request, by the server's rule: every condition a tier carries
 * must hold; among those that do, the highest prompt threshold wins, then a windowed tier over an
 * unwindowed one, then list order. Returns -1 for the base rates.
 */
export function selectTier(tiers: readonly PriceTier[] | null | undefined, inputTokens: number, timestampMs: number): number {
  if (!tiers) return -1;
  const minute = minuteOfDayUTC(timestampMs);
  let best = -1;
  tiers.forEach((tier, index) => {
    const threshold = tier.min_prompt_tokens ?? 0;
    const windowed = hasTimeWindow(tier);
    if (threshold === 0 && !windowed) return;
    if (threshold > 0 && Math.max(inputTokens, 0) < threshold) return;
    if (windowed && !inWindow(minute, tier.utc_start, tier.utc_end)) return;
    if (best < 0) {
      best = index;
      return;
    }
    const current = tiers[best];
    const currentThreshold = current.min_prompt_tokens ?? 0;
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
  options: { channelMultiplier?: number; timestampMs?: number } = {},
): { usd: number; tierIndex: number } {
  const tierIndex = selectTier(price.tiers, tokens.input, options.timestampMs ?? Date.now());
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
 * prompt threshold and may also be limited to a window; a time-of-day tier has only a window.
 * The wire tier carries no kind - it is read from the conditions present.
 */
export type TierKind = 'context' | 'window';

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
 * re-renders, converted to a `PriceTier` only on save. The window is always held in UTC "HH:mm";
 * showing it in another zone is the editor's presentation, never the stored rule.
 */
export interface TierDraft {
  key: string;
  kind: TierKind;
  /** A token count as typed: "200000", "200,000", "200K" or "1M". */
  minPromptTokens: string;
  /** Whether a long-context tier is further limited to a window; a time-of-day tier always is. */
  isWindowed: boolean;
  utcStart: string;
  utcEnd: string;
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
    minPromptTokens: '',
    isWindowed: false,
    utcStart: '',
    utcEnd: '',
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

/**
 * Drafts for stored tiers. Given the base they apply over, a tier whose every rate is a readable
 * multiple of the base opens as multiples - how its provider published it - and any other as
 * absolute prices, so nothing is rounded on the way in.
 */
export function tierDraftsFrom(tiers: readonly PriceTier[] | null | undefined, base?: RateFields | null): TierDraft[] {
  return (tiers ?? []).map((tier) => {
    const hasThreshold = (tier.min_prompt_tokens ?? 0) > 0;
    const windowed = hasTimeWindow(tier);
    const isMultiple = Boolean(base) && RATE_KEYS.every((key) => {
      const rate = tier[RATE_FIELD[key]];
      if (rate === undefined) return true;
      const from = base![RATE_FIELD[key]];
      return from > 0 && isReadableMultiple(rate / from);
    });
    const rateText = (key: RateKey) => {
      const rate = tier[RATE_FIELD[key]];
      if (rate === undefined) return '';
      return isMultiple ? numberText(rate / base![RATE_FIELD[key]]) : numberText(rate);
    };
    return newTierDraft({
      kind: hasThreshold ? 'context' : 'window',
      minPromptTokens: hasThreshold ? formatTokenCount(tier.min_prompt_tokens!) : '',
      isWindowed: windowed,
      utcStart: hhmmText(tier.utc_start),
      utcEnd: hhmmText(tier.utc_end),
      rateUnit: isMultiple ? 'multiple' : 'price',
      prompt: rateText('prompt'),
      completion: rateText('completion'),
      cacheRead: rateText('cacheRead'),
      cacheWrite: rateText('cacheWrite'),
    });
  });
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
 * "HH:mm" moved by a number of minutes around the clock face. The editor uses it to show a UTC
 * window in the console's zone and to read one typed there back to UTC.
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
export const MAX_TIERS = 8;

export type TierDraftError = 'condition' | 'window' | 'rate' | 'base' | 'duplicate';

/**
 * Converts the editor's tiers, refusing what the server would refuse and what could never apply:
 * a long-context tier needs a positive threshold, a window needs a start and a different end,
 * every rate must be a non-negative number, a multiple needs base rates to multiply, and two tiers
 * with the same conditions would leave the second unreachable. The first failing tier is reported
 * by its position in `drafts` so the editor can mark it.
 *
 * Long-context tiers are written before time-of-day ones. The server's rule only falls back to
 * list order between tiers with the same threshold and windowing, which always share a kind, so
 * the grouping never changes which tier governs a request.
 */
export function tiersFromDrafts(
  drafts: readonly TierDraft[],
  base: RateFields | null = null,
): { tiers: PriceTier[] } | { error: TierDraftError; index: number } {
  const converted: Array<{ kind: TierKind; tier: PriceTier }> = [];
  const conditions = new Set<string>();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const tier: PriceTier = {};
    if (draft.kind === 'context') {
      const threshold = parseTokenCount(draft.minPromptTokens);
      if (threshold === undefined || Number.isNaN(threshold)) return { error: 'condition', index };
      tier.min_prompt_tokens = threshold;
    }
    if (draft.kind === 'window' || draft.isWindowed) {
      const start = parseHHMMText(draft.utcStart);
      const end = parseHHMMText(draft.utcEnd);
      if (start === null || end === null || start === end) return { error: 'window', index };
      tier.utc_start = start;
      tier.utc_end = end;
    }
    const condition = `${tier.min_prompt_tokens ?? 0}|${tier.utc_start ?? ''}|${tier.utc_end ?? ''}`;
    if (conditions.has(condition)) return { error: 'duplicate', index };
    conditions.add(condition);
    for (const key of RATE_KEYS) {
      const value = parseRateText(draft[key]);
      if (value === undefined) continue;
      if (Number.isNaN(value)) return { error: 'rate', index };
      if (draft.rateUnit === 'multiple') {
        if (!base) return { error: 'base', index };
        tier[RATE_FIELD[key]] = cleanNumber(value * base[RATE_FIELD[key]]);
      } else {
        tier[RATE_FIELD[key]] = value;
      }
    }
    converted.push({ kind: draft.kind, tier });
  }
  return {
    tiers: [...converted.filter((item) => item.kind === 'context'), ...converted.filter((item) => item.kind === 'window')]
      .map((item) => item.tier),
  };
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
 * up, then time-of-day tiers. It reads what a request pays at each step rather than how the tiers
 * are stored, which is the question an operator setting a price is asking.
 */
export function priceSchedule(price: RateFields, tiers: readonly PriceTier[] | null | undefined): PriceScheduleRow[] {
  const list = tiers ?? [];
  const thresholds = list
    .filter((tier) => (tier.min_prompt_tokens ?? 0) > 0 && !hasTimeWindow(tier))
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
  // plain time windows instead of sitting between two always-on steps.
  const group = (tier: PriceTier) => ((tier.min_prompt_tokens ?? 0) > 0 ? (hasTimeWindow(tier) ? 1 : 0) : 2);
  const order = list.map((tier, index) => ({ tier, index })).sort((left, right) => (
    group(left.tier) - group(right.tier)
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
