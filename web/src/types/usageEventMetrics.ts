import { DEFAULT_TPS_CALCULATION_MODE, type TpsCalculationMode } from './tpsCalculation';
import type {
  UsageEvent,
} from './usageEvents';

export function eventPageMetrics(events: UsageEvent[]) {
  return {
    count: events.length,
    failed: events.filter((event) => event.failed).length,
    tokens: events.reduce((sum, event) => sum + event.tokens.total, 0),
    latency: events.length ? events.reduce((sum, event) => sum + event.latency_ms, 0) / events.length : null,
  };
}

/** Colour a verdict may carry. Matches the legend-dot tones in the theme. */
export type VerdictTone = 'success' | 'warn' | 'danger' | 'neutral';

/**
 * The success share at or above which a rate reads as healthy.
 */
export const SUCCESS_RATE_HEALTHY_PERCENT = 80;

/**
 * The success share below which a rate reads as broken rather than merely degraded.
 */
export const SUCCESS_RATE_DEGRADED_PERCENT = 50;

/**
 * successRateTone classifies a success rate on the console's one published band.
 *
 * Every surface that shows a rate reads this: the dashboard's request tile and the provider rows.
 * A rate therefore carries the same colour wherever it appears, and there is no second rule to
 * disagree with this one. See docs/design.md §Status pip semantics.
 *
 * An *absent* rate - `null` on the wire, printed as an em dash - carries no verdict and stays
 * neutral rather than reading as a fault: a window that served nothing has no rate to judge. A
 * numeric 0% is the opposite case, a measured total outage, and takes the alarm end of the band.
 *
 *   no requests, or an unreadable rate -> neutral (nothing to judge)
 *   at or above 80%                    -> success
 *   at or above 50%, below 80%         -> warn
 *   below 50%, including exactly 0%    -> danger
 */
export function successRateTone(successRate: number | null | undefined): VerdictTone {
  if (successRate === null || successRate === undefined) return 'neutral';
  if (!Number.isFinite(successRate)) return 'neutral';
  if (successRate >= SUCCESS_RATE_HEALTHY_PERCENT) return 'success';
  if (successRate >= SUCCESS_RATE_DEGRADED_PERCENT) return 'warn';
  return 'danger';
}

export function formatEventDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export interface EventCacheRateResult {
  rate: number;
  cached: number;
  hasData: boolean;
}

/**
 * eventCacheRate calculates the prompt cache hit percentage matching the dashboard's
 * cacheRateParts convention:
 * - OpenAI-style: input tokens already includes the cached prefix (cache_read <= input)
 * - Anthropic-style: input tokens counts only new tokens, prompt = input + cache_read
 * Returns the raw rate (0..100), the cached token count, and whether the record
 * carried token data at all. Presentation (one decimal, the sub-100% cap, the em
 * dash for no data) lives in theme/cacheScale.ts, which imports nothing so this
 * module stays loadable on its own by the test harness.
 *
 * Cache-write tokens are deliberately not in the denominator. CPA reports them
 * only for providers whose accounting treats cache buckets as separate from
 * input, but the persisted row carries no canonical breakdown to prove which
 * convention produced its raw counts, so widening the denominator here would be
 * a guess. See docs/design.md §2 for the deferred work.
 */
export function eventCacheRate(tokens?: UsageEvent['tokens']): EventCacheRateResult {
  if (!tokens) {
    return { rate: 0, cached: 0, hasData: false };
  }
  const cached = Math.max(0, tokens.cache_read || tokens.cached || 0);
  if (cached === 0) {
    return { rate: 0, cached: 0, hasData: true };
  }
  let prompt = Math.max(0, tokens.input || (tokens.total - tokens.output));
  if (prompt <= 0 && tokens.total > 0) {
    prompt = tokens.total;
  }
  let denominator = prompt;
  if (cached > prompt) {
    denominator = prompt + cached;
  }
  if (denominator <= 0) {
    return { rate: 0, cached: 0, hasData: false };
  }
  const rate = Math.min(100, Math.max(0, (cached / denominator) * 100));
  return { rate, cached, hasData: true };
}

export type TpsCalculationBasis = TpsCalculationMode | 'fallback_total';

export function tpsCalculationHintKey(basis: TpsCalculationBasis) {
  return basis === 'exclude_ttft' ? 'events.tps_hint_ttft'
    : basis === 'include_ttft' ? 'events.tps_hint_total' : 'events.tps_hint_fallback';
}

export interface EventTokensPerSecondResult {
  tps: number | null;
  formatted: string;
  basis: TpsCalculationBasis | null;
}

/**
 * Minimum residual duration in milliseconds after the first token required
 * to consider that boundary measurable. When latency_ms - ttft_ms < 50ms,
 * TTFT has collapsed onto the total response duration (the proxy observed the whole
 * response in a single chunk rather than a progressive first-token arrival).
 */
export const MIN_STREAMING_GENERATION_WINDOW_MS = 50;

/** The response service tiers an upstream reports for its faster, separately priced lane. */
const FAST_SERVICE_TIERS = new Set(['fast', 'priority']);

/**
 * isFastTierEvent reports whether the upstream served a request on its fast lane.
 *
 * It reads the tier the response reported, never the one the request asked for:
 * a client can ask for `priority` and be served `default`, and the mark is a
 * statement about what happened. OpenAI names the lane `priority` and Anthropic
 * `fast`; both are the same fact to an operator reading the list.
 */
export function isFastTierEvent(event?: Partial<Pick<UsageEvent, 'response_service_tier'>>): boolean {
  return FAST_SERVICE_TIERS.has((event?.response_service_tier ?? '').trim().toLowerCase());
}

/**
 * hasMeasurableTTFT determines whether a usage record carries a genuine, non-collapsed
 * time-to-first-token measurement:
 * - Requires ttft_ms > 0 and latency_ms > 0 with ttft_ms < latency_ms
 * - Requires a residual window (latency_ms - ttft_ms) of at least 50 ms. When the remainder
 *   is below this threshold, the proxy observed the whole payload at completion rather than
 *   a progressive stream (e.g. non-streaming requests without upstream chunking).
 */
export function hasMeasurableTTFT(
  event?: Partial<Pick<UsageEvent, 'latency_ms' | 'ttft_ms'>>,
): boolean {
  if (!event) return false;
  const latency = Number(event.latency_ms);
  const ttft = event.ttft_ms != null ? Number(event.ttft_ms) : null;
  return (
    ttft !== null &&
    Number.isFinite(ttft) &&
    Number.isFinite(latency) &&
    ttft > 0 &&
    latency > 0 &&
    ttft < latency &&
    latency - ttft >= MIN_STREAMING_GENERATION_WINDOW_MS
  );
}

/**
 * isNonStreamingEvent reports whether the non-streaming badge should appear beside a
 * record: either the client requested a non-streamed response and no measurable TTFT was
 * captured, or the residual window collapsed as if the payload arrived in one response.
 *
 * `stream: false` alone is not enough to classify TTFT as unusable. CPA can capture a
 * genuine upstream token boundary even when the client requested a non-streamed response,
 * so a measurable residual window keeps the TTFT readout independently of the selected
 * TPS calculation mode. The badge is therefore gated on hasMeasurableTTFT as well as the recorded mode.
 */
export function isNonStreamingEvent(
  event?: Partial<Pick<UsageEvent, 'stream' | 'latency_ms' | 'ttft_ms'>>,
): boolean {
  if (!event || hasMeasurableTTFT(event)) return false;
  if (event.stream === false) return true;
  const latency = Number(event.latency_ms);
  const ttft = event.ttft_ms != null ? Number(event.ttft_ms) : null;
  return (
    ttft !== null &&
    Number.isFinite(ttft) &&
    Number.isFinite(latency) &&
    latency > 0 &&
    ttft > 0 &&
    ttft <= latency &&
    latency - ttft < MIN_STREAMING_GENERATION_WINDOW_MS
  );
}

/**
 * The selected denominator changes only this derived readout, never the timing observations.
 * A collapsed first-token boundary cannot support subtraction, so exclusion falls back to
 * total latency. The residual may include server-side tools; it is not pure generation time.
 * Client streaming intent does not establish whether the observed boundary is measurable.
 */
export function eventTokensPerSecond(
  event?: Partial<Pick<UsageEvent, 'generate' | 'latency_ms' | 'ttft_ms' | 'tokens' | 'stream'>>,
  mode: TpsCalculationMode = DEFAULT_TPS_CALCULATION_MODE,
): EventTokensPerSecondResult {
  const output = Number(event?.tokens?.output);
  const latency = Number(event?.latency_ms);
  if (!event || event.generate === false || !Number.isFinite(output) || output <= 0 ||
      !Number.isFinite(latency) || latency <= 0) {
    return { tps: null, formatted: '—', basis: null };
  }

  const basis: TpsCalculationBasis = mode === 'include_ttft' ? 'include_ttft'
    : hasMeasurableTTFT(event) ? 'exclude_ttft' : 'fallback_total';
  const durationMs = basis === 'exclude_ttft' ? latency - Number(event.ttft_ms) : latency;
  const tps = (output * 1000) / durationMs;
  return { tps, formatted: `${tps.toFixed(2)} t/s`, basis };
}
