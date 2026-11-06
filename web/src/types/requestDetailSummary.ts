import type { UsageEvent } from './usageEvents';
import { outputTotalWithReasoning } from './tpsCalculation';

/**
 * What a failed request most likely ran into, in the operator's terms rather than the upstream's
 * status line, read from the request's own status. The cause only chooses the plain-language
 * explanation the drawer leads with; the status and body stay on screen beside it, so a misread
 * cause never hides the evidence.
 */
export type RequestFailureCause =
  | 'rate_limited'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'timeout'
  | 'unavailable'
  | 'upstream'
  | 'unknown';

export function requestFailureCause(status: number | null | undefined): RequestFailureCause {
  if (!status) return 'unknown';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

export type TokenSegmentKey = 'cache_read' | 'input' | 'reasoning' | 'output';

export interface TokenSegment {
  key: TokenSegmentKey;
  value: number;
}

export interface TokenComposition {
  /** Drawn segments, in reading order, each with a positive count. */
  segments: TokenSegment[];
  /** Reasoning the record reports but whose place in the totals cannot be proven; shown, not drawn. */
  unplacedReasoning: number;
}

/**
 * Where a request's tokens went, as parts that add up without double counting.
 *
 * Cache reads follow the cache-rate badge's convention (`eventCacheRate`): inside the input count
 * unless they exceed it, in which case the provider reported them beside it. Reasoning follows the
 * TPS rule (`outputTotalWithReasoning`): split out of the output only when the totals prove whether
 * it was inside or beside it. When they prove neither, it is listed but not drawn, because a bar
 * that guessed would show a share the record never established.
 */
export function tokenComposition(tokens: UsageEvent['tokens'] | undefined): TokenComposition {
  if (!tokens) return { segments: [], unplacedReasoning: 0 };
  const input = Math.max(0, tokens.input || 0);
  const output = Math.max(0, tokens.output || 0);
  const reasoning = Math.max(0, tokens.reasoning || 0);
  const cacheRead = Math.max(0, tokens.cache_read || tokens.cached || 0);
  const freshInput = cacheRead <= input ? input - cacheRead : input;

  let textOutput = output;
  let placedReasoning = 0;
  let unplacedReasoning = 0;
  if (reasoning > 0) {
    const scope = outputTotalWithReasoning({
      // Cache reads reported beside the input are part of the prompt the total counts.
      inputTokens: cacheRead > input ? input + cacheRead : input,
      outputTokens: output,
      reasoningTokens: reasoning,
      totalTokens: tokens.total,
    });
    if (scope.isAccountingValid && scope.outputTokens === output && reasoning <= output) {
      // Inside the output: the visible text is what remains of it.
      textOutput = output - reasoning;
      placedReasoning = reasoning;
    } else if (scope.isAccountingValid && scope.outputTokens === output + reasoning) {
      placedReasoning = reasoning;
    } else {
      unplacedReasoning = reasoning;
    }
  }

  const segments: TokenSegment[] = [
    { key: 'cache_read' as const, value: cacheRead },
    { key: 'input' as const, value: freshInput },
    { key: 'reasoning' as const, value: placedReasoning },
    { key: 'output' as const, value: textOutput },
  ].filter((segment) => segment.value > 0);
  return { segments, unplacedReasoning };
}
