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
 * One tier as the editor holds it: every field a string or null so a half-typed value survives
 * re-renders, converted to a `PriceTier` only on save.
 */
export interface TierDraft {
  key: string;
  minPromptTokens: string;
  /** "HH:mm", or empty for no window. */
  utcStart: string;
  utcEnd: string;
  prompt: string;
  completion: string;
  cacheRead: string;
  cacheWrite: string;
}

let tierDraftCounter = 0;

function hhmmText(value: number | undefined): string {
  return typeof value === 'number' ? formatHHMM(value) : '';
}

function rateText(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : '';
}

export function newTierDraft(partial: Partial<TierDraft> = {}): TierDraft {
  tierDraftCounter += 1;
  return {
    key: `tier-${tierDraftCounter}`,
    minPromptTokens: '', utcStart: '', utcEnd: '', prompt: '', completion: '', cacheRead: '', cacheWrite: '',
    ...partial,
  };
}

export function tierDraftsFrom(tiers: readonly PriceTier[] | null | undefined): TierDraft[] {
  return (tiers ?? []).map((tier) => newTierDraft({
    minPromptTokens: tier.min_prompt_tokens ? String(tier.min_prompt_tokens) : '',
    utcStart: hhmmText(tier.utc_start),
    utcEnd: hhmmText(tier.utc_end),
    prompt: rateText(tier.prompt_price_per_1m),
    completion: rateText(tier.completion_price_per_1m),
    cacheRead: rateText(tier.cache_read_price_per_1m),
    cacheWrite: rateText(tier.cache_write_price_per_1m),
  }));
}

function parseHHMMText(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 100 + minutes;
}

/** A non-negative decimal, or undefined when blank; NaN marks a value that is not a number. */
export function parseRateText(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

export type TierDraftError = 'condition' | 'window' | 'rate';

/**
 * Converts the editor's tiers, refusing what the server would refuse: a tier needs a prompt
 * threshold or a complete, non-empty time window, and every rate it sets must be a non-negative
 * number. The first failing tier is reported by index so the editor can mark it.
 */
export function tiersFromDrafts(drafts: readonly TierDraft[]): { tiers: PriceTier[] } | { error: TierDraftError; index: number } {
  const tiers: PriceTier[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const tier: PriceTier = {};
    const threshold = draft.minPromptTokens.trim();
    if (threshold !== '') {
      const value = Number(threshold);
      if (!Number.isInteger(value) || value <= 0) return { error: 'condition', index };
      tier.min_prompt_tokens = value;
    }
    const hasStart = draft.utcStart.trim() !== '';
    const hasEnd = draft.utcEnd.trim() !== '';
    if (hasStart || hasEnd) {
      const start = parseHHMMText(draft.utcStart);
      const end = parseHHMMText(draft.utcEnd);
      if (start === null || end === null || start === end) return { error: 'window', index };
      tier.utc_start = start;
      tier.utc_end = end;
    }
    if (tier.min_prompt_tokens === undefined && tier.utc_start === undefined) return { error: 'condition', index };
    const rates: Array<[keyof PriceTier, string]> = [
      ['prompt_price_per_1m', draft.prompt], ['completion_price_per_1m', draft.completion],
      ['cache_read_price_per_1m', draft.cacheRead], ['cache_write_price_per_1m', draft.cacheWrite],
    ];
    for (const [field, text] of rates) {
      const rate = parseRateText(text);
      if (rate === undefined) continue;
      if (Number.isNaN(rate)) return { error: 'rate', index };
      (tier as Record<string, number>)[field] = rate;
    }
    tiers.push(tier);
  }
  return { tiers };
}
