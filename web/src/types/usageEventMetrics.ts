import type { MessageKey } from '../i18n/catalog';
import { DEFAULT_TPS_CALCULATION_MODE, type TpsCalculationMode } from './tpsCalculation';
import type {
  UsageEvent,
  UsageTransport,
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
 * disagree with this one.
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

/**
 * Colour a latency verdict may carry. Like `VerdictTone` plus the `slow` step
 * between warn and danger: a request past thirty seconds is unhurried without
 * being the alarm that a full minute is.
 */
export type LatencyTone = 'success' | 'warn' | 'slow' | 'danger' | 'neutral';

/**
 * The boundaries of the console's latency band: at or above 15 s a request is no
 * longer quick, at or above 30 s it is slow, at or above 60 s it is the alarm.
 * The band starts on the one CPMP's realtime panel publishes (its 15 s and 30 s
 * steps) so an operator moving between the two consoles reads one scale.
 */
export const LATENCY_WARN_MS = 15_000;
export const LATENCY_SLOW_MS = 30_000;
export const LATENCY_DANGER_MS = 60_000;

/**
 * latencyTone classifies a request's total latency on the console's one published
 * band, read wherever a duration carries a colour: the request list's latency
 * column, the exported sheet and the detail drawer.
 *
 * An *absent* or unreadable latency carries no verdict and stays neutral, the way
 * a window with no traffic does. A measured 0 ms is a real reading - the fastest
 * one there is - so it takes the quick end of the band rather than the neutral
 * step.
 *
 *   missing, negative or non-finite  -> neutral (nothing to judge)
 *   below 15 s                       -> success
 *   at or above 15 s, below 30 s     -> warn
 *   at or above 30 s, below 60 s     -> slow (orange)
 *   at or above 60 s                 -> danger
 */
export function latencyTone(latencyMs: number | null | undefined): LatencyTone {
  if (latencyMs === null || latencyMs === undefined) return 'neutral';
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return 'neutral';
  if (latencyMs >= LATENCY_DANGER_MS) return 'danger';
  if (latencyMs >= LATENCY_SLOW_MS) return 'slow';
  if (latencyMs >= LATENCY_WARN_MS) return 'warn';
  return 'success';
}

/**
 * latencyBandLabelKey names a band for the operator, so the verdict travels as
 * text as well as hue: the list cell's tooltip and the drawer's duration
 * readouts read it, and a neutral band has nothing to name.
 */
export function latencyBandLabelKey(band: LatencyTone): MessageKey | null {
  switch (band) {
    case 'success': return 'events.latency_band_quick';
    case 'warn': return 'events.latency_band_long';
    case 'slow': return 'events.latency_band_slow';
    case 'danger': return 'events.latency_band_very_slow';
    default: return null;
  }
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
 * a guess.
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

export { tpsCalculationHintKey, type TpsCalculationBasis, type EventTokensPerSecondResult } from './tpsCalculation';
import { calculateTokensPerSecond, outputTotalWithReasoning, type EventTokensPerSecondResult } from './tpsCalculation';

const FAST_SERVICE_TIERS = new Set(['fast', 'priority']);

/** Mode marks consume the server's provider-aware evidence instead of guessing from raw tiers. */
export function isFastTierEvent(event?: Partial<Pick<UsageEvent, 'resolved_service_tier'>>): boolean {
  return FAST_SERVICE_TIERS.has((event?.resolved_service_tier ?? '').trim().toLowerCase());
}

export function fastTierHintKey(event: Pick<UsageEvent, 'resolved_service_tier_source'>): MessageKey {
  if (event.resolved_service_tier_source === 'outbound') return 'events.fast_tier_outbound_hint';
  return event.resolved_service_tier_source === 'request'
    ? 'events.fast_tier_requested_hint'
    : 'events.fast_tier_hint';
}

/** A positive interval is observable; its size does not establish whether delivery was buffered. */
export function hasMeasurableTTFT(
  event?: Partial<Pick<UsageEvent, 'latency_ms' | 'ttft_ms'>>,
): boolean {
  const latency = event?.latency_ms;
  const ttft = event?.ttft_ms;
  return latency != null && ttft != null && Number.isFinite(latency) && Number.isFinite(ttft)
    && ttft > 0 && ttft < latency;
}

/**
 * How CPA carried the request upstream. CPA reports the executor's type name, and
 * its WebSocket executors (`CodexWebsocketsExecutor`, `XAIWebsocketsExecutor`)
 * share a suffix, which wins over the stream flag; otherwise the client's
 * requested streaming mode decides. Delivery speed cannot establish that mode, so
 * a record carrying neither has no transport. The server's `transport` filter
 * applies the same rule.
 */
export function requestTransport(
  event?: Partial<Pick<UsageEvent, 'executor_type' | 'stream'>>,
): UsageTransport | null {
  if (/websocketsexecutor$/i.test(event?.executor_type?.trim() ?? '')) return 'websocket';
  if (event?.stream === true) return 'sse';
  if (event?.stream === false) return 'http';
  return null;
}

/** Canonical accounting establishes whether reasoning is included; legacy counts use their totals. */
export function eventTokensPerSecond(
  event?: Partial<Pick<UsageEvent, 'generate' | 'latency_ms' | 'ttft_ms' | 'tokens' | 'stream' | 'token_accounting' | 'accounting_status'>>,
  mode: TpsCalculationMode = DEFAULT_TPS_CALCULATION_MODE,
): EventTokensPerSecondResult {
  const accounting = event?.token_accounting;
  const breakdown = accounting?.status === 'complete' ? accounting.token_breakdown : undefined;
  let isAccountingValid = (accounting == null || accounting.status === 'complete')
    && (accounting?.status !== 'complete' || breakdown != null)
    && (event?.accounting_status == null || event.accounting_status === 'legacy' || event.accounting_status === 'complete');
  const reasoning = breakdown?.output.reasoning_tokens ?? event?.tokens?.reasoning;
  let output = breakdown?.output.total_tokens;
  if (output == null) {
    const legacy = outputTotalWithReasoning({
      inputTokens: event?.tokens?.input,
      outputTokens: event?.tokens?.output,
      reasoningTokens: reasoning,
      totalTokens: event?.tokens?.total,
    });
    output = legacy.outputTokens;
    isAccountingValid &&= legacy.isAccountingValid;
  }
  return calculateTokensPerSecond({
    isGeneration: event?.generate,
    outputTokens: output,
    reasoningTokens: reasoning,
    isAccountingValid,
    durationMS: event?.latency_ms,
    firstTokenMS: event?.ttft_ms,
  }, mode);
}

export function resolvedTierHintKey(event: Pick<UsageEvent, 'resolved_service_tier_source'>): MessageKey {
  if (event.resolved_service_tier_source === 'outbound') return 'events.resolved_tier_outbound';
  return event.resolved_service_tier_source === 'request'
    ? 'events.resolved_tier_request'
    : 'events.resolved_tier_response';
}
