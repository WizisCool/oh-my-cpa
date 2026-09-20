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

export interface EventTokensPerSecondResult {
  tps: number | null;
  formatted: string;
  hasTTFT: boolean;
}

/**
 * Minimum duration in milliseconds between request start and completion required
 * to consider the generation phase measurable. When latency_ms - ttft_ms < 50ms,
 * TTFT has collapsed onto the total response duration (the proxy observed the whole
 * response in a single chunk rather than a progressive first-token arrival).
 */
export const MIN_STREAMING_GENERATION_WINDOW_MS = 50;

/**
 * hasMeasurableTTFT determines whether a usage record carries a genuine, non-collapsed
 * time-to-first-token measurement:
 * - Requires ttft_ms > 0 and latency_ms > 0 with ttft_ms < latency_ms
 * - Requires a generation window (latency_ms - ttft_ms) of at least 50 ms. When the remainder
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
 * so a measurable residual window keeps both the TTFT readout and the generation-phase
 * metric. The badge is therefore gated on hasMeasurableTTFT as well as the recorded mode.
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
 * eventTokensPerSecond estimates output generation throughput in tokens per second:
 * - When the residual window is measurable (latency_ms - ttft_ms >= 50ms, see hasMeasurableTTFT):
 *   output * 1000 / (latency_ms - ttft_ms), the generation-phase rate
 * - Fallback for a collapsed or missing TTFT: output * 1000 / latency_ms (end-to-end average)
 * - Returns formatted string (e.g. "109.21 t/s") or "—" when not measurable (non-generation, zero output, invalid latency).
 *
 * The recorded `stream` flag deliberately does not select the formula: it is the client's
 * request intent, not what the proxy observed. A `stream: false` call can still carry a
 * genuine first-token time when the upstream streams internally (e.g. OAuth Codex), and a
 * `stream: true` call can still collapse when the upstream delivers one chunk. The flag is
 * accepted in the event shape so callers can pass whole records; only the residual window
 * decides.
 */
export function eventTokensPerSecond(
  event?: Partial<Pick<UsageEvent, 'generate' | 'latency_ms' | 'ttft_ms' | 'tokens' | 'stream'>>,
): EventTokensPerSecondResult {
  if (!event || event.generate === false) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }
  const output = Number(event.tokens?.output);
  if (!Number.isFinite(output) || output <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }
  const latency = Number(event.latency_ms);
  if (!Number.isFinite(latency) || latency <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }

  let durationMs: number;
  let hasTTFT = false;

  if (hasMeasurableTTFT(event)) {
    const ttft = Number(event.ttft_ms);
    durationMs = latency - ttft;
    hasTTFT = true;
  } else {
    durationMs = latency;
    hasTTFT = false;
  }

  if (durationMs <= 0) {
    return { tps: null, formatted: '—', hasTTFT: false };
  }

  const tps = (output * 1000) / durationMs;
  return {
    tps,
    formatted: `${tps.toFixed(2)} t/s`,
    hasTTFT,
  };
}
