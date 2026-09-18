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
 * Share of failures a window may carry before it is worth looking at.
 *
 * A gateway fanning out to several upstreams always produces some noise:
 * provider 429s, a timeout that the next retry absorbs, a request the caller
 * cancelled. At 98% success the old thresholds painted the indicator amber,
 * which trained the operator to ignore it. Upstream noise is not a verdict.
 */
export const SUCCESS_ROUTINE_FAILURE_PERCENT = 5;

/**
 * Share of failures above which the window is treated as broken rather than
 * degraded. Deliberately far from the routine band so the two never blur.
 */
export const SUCCESS_ELEVATED_FAILURE_PERCENT = 20;

/**
 * Requests a window needs before a failure rate may escalate on its own. Two
 * failures out of four is a 50% rate and tells nobody anything, so a window
 * this small stays neutral unless the failure count itself is damning.
 */
export const SUCCESS_VERDICT_MIN_SAMPLE = 20;

/**
 * Failures that make a window conclusive without a full sample. Nine failures
 * out of ten requests is an outage whatever the sample size, and a small window
 * must still be able to say so.
 */
export const SUCCESS_VERDICT_MIN_FAILURES = 3;

/**
 * successRateVerdict decides whether a window needs attention, which is not the
 * same question as whether anything failed.
 *
 * The thresholds are on the *failure* rate rather than the success rate: "98%"
 * is a number nobody reasons about, "2% of requests failed" is a decision.
 *
 *   no traffic                    -> neutral  (nothing to judge)
 *   no failures                   -> success  (clean window)
 *   no evidence yet               -> neutral  (below the sample floor and the
 *                                              failure floor: a coin flip on
 *                                              four requests is not a trend)
 *   within the routine band       -> neutral  (upstream noise)
 *   above the elevated band       -> danger   (broken)
 *   otherwise                     -> warn
 */
export function successRateVerdict(total: number, failed: number): VerdictTone {
  const samples = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (samples === 0) return 'neutral';
  const failures = Number.isFinite(failed) ? Math.min(Math.max(0, Math.floor(failed)), samples) : 0;
  if (failures === 0) return 'success';
  // A verdict needs evidence: either a real sample, or enough failures that the
  // rate cannot be a fluke.
  if (samples < SUCCESS_VERDICT_MIN_SAMPLE && failures < SUCCESS_VERDICT_MIN_FAILURES) return 'neutral';
  const failurePercent = (failures / samples) * 100;
  if (failurePercent <= SUCCESS_ROUTINE_FAILURE_PERCENT) return 'neutral';
  if (failurePercent > SUCCESS_ELEVATED_FAILURE_PERCENT) return 'danger';
  return 'warn';
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
