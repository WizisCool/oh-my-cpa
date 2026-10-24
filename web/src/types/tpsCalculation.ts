export type TpsCalculationMode = 'exclude_ttft' | 'include_ttft';

export const DEFAULT_TPS_CALCULATION_MODE: TpsCalculationMode = 'include_ttft';
export const TPS_CALCULATION_PREFERENCE = 'omc_tps_calculation_mode';

export function parseTpsCalculationMode(raw: unknown): TpsCalculationMode | undefined {
  return raw === 'exclude_ttft' || raw === 'include_ttft' ? raw : undefined;
}

export type TpsCalculationBasis = TpsCalculationMode | 'exclude_ttft_visible'
  | 'unavailable_timing' | 'unavailable_reasoning' | 'unavailable_accounting';

export interface EventTokensPerSecondResult {
  tps: number | null;
  formatted: string;
  basis: TpsCalculationBasis | null;
}

export function tpsCalculationHintKey(basis: TpsCalculationBasis) {
  const keys = {
    exclude_ttft: 'events.tps_hint_ttft',
    include_ttft: 'events.tps_hint_total',
    exclude_ttft_visible: 'events.tps_hint_visible',
    unavailable_timing: 'events.tps_unavailable_timing',
    unavailable_reasoning: 'events.tps_unavailable_reasoning',
    unavailable_accounting: 'events.tps_unavailable_accounting',
  } as const;
  return keys[basis];
}

export interface TpsObservation {
  isGeneration?: boolean;
  outputTokens?: number;
  reasoningTokens?: number;
  /** False when the server says its output/reasoning counts are invalid or inconsistent. */
  isAccountingValid?: boolean;
  durationMS?: number;
  firstTokenMS?: number | null;
  /** Only an observer of the response body can establish a non-reasoning boundary. */
  firstTokenKind?: 'non_reasoning';
}

export interface TokenTotalObservation {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface OutputTokenTotal {
  outputTokens?: number;
  isAccountingValid: boolean;
}

/**
 * outputTotalWithReasoning establishes the output scope from token totals rather than a
 * provider's field name. Some APIs report reasoning inside output; others report it beside
 * output and include it in the grand total. When those equations do not identify one
 * convention, the rate is unavailable instead of silently dropping or double-counting CoT.
 */
export function outputTotalWithReasoning(tokens?: TokenTotalObservation): OutputTokenTotal {
  const output = tokens?.outputTokens;
  const reasoning = tokens?.reasoningTokens;
  if (output == null || !Number.isSafeInteger(output) || output < 0) return { isAccountingValid: true };
  if (reasoning == null || reasoning === 0) return { outputTokens: output, isAccountingValid: true };
  if (!Number.isSafeInteger(reasoning) || reasoning < 0) return { isAccountingValid: false };
  const input = tokens?.inputTokens;
  const total = tokens?.totalTokens;
  if (input == null || total == null || !Number.isSafeInteger(input) || input < 0
    || !Number.isSafeInteger(total) || total < 0) return { isAccountingValid: false };
  if (total === input + output) return { outputTokens: output, isAccountingValid: true };
  if (total === input + output + reasoning && Number.isSafeInteger(output + reasoning)) {
    return { outputTokens: output + reasoning, isAccountingValid: true };
  }
  return { isAccountingValid: false };
}

/**
 * Rates describe observed delivery, not the model's internal decoding clock. A first-token
 * timestamp alone cannot locate hidden reasoning or prove progressive delivery. Never infer
 * either from speed, model names, or a duration threshold, and never switch denominators.
 */
export function calculateTokensPerSecond(
  observation: TpsObservation,
  mode: TpsCalculationMode = DEFAULT_TPS_CALCULATION_MODE,
): EventTokensPerSecondResult {
  const unavailable = (basis: TpsCalculationBasis | null): EventTokensPerSecondResult => ({ tps: null, formatted: '—', basis });
  const { outputTokens: output, reasoningTokens: reasoning, durationMS: latency, firstTokenMS: first } = observation;
  if (observation.isGeneration === false) return unavailable(null);
  if (observation.isAccountingValid === false) return unavailable('unavailable_accounting');
  if (output == null || !Number.isSafeInteger(output) || output <= 0) return unavailable(null);
  if (reasoning != null && (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > output)) {
    return unavailable('unavailable_accounting');
  }
  if (latency == null || !Number.isFinite(latency) || latency <= 0) return unavailable('unavailable_timing');
  if (mode === 'include_ttft') {
    const tps = output * 1000 / latency;
    return { tps, formatted: `${tps.toFixed(2)} t/s`, basis: 'include_ttft' };
  }
  // A zero reported TTFT means absent upstream, but zero on our own content clock is measured.
  if (first == null || !Number.isFinite(first) || first < 0 || first >= latency
    || (first === 0 && observation.firstTokenKind !== 'non_reasoning')) return unavailable('unavailable_timing');
  if (reasoning == null) return unavailable('unavailable_accounting');
  let numerator = output;
  let basis: TpsCalculationBasis = 'exclude_ttft';
  if (reasoning > 0) {
    if (observation.firstTokenKind !== 'non_reasoning') return unavailable('unavailable_reasoning');
    numerator -= reasoning;
    basis = 'exclude_ttft_visible';
  } else if (observation.firstTokenKind === 'non_reasoning') {
    basis = 'exclude_ttft_visible';
  }
  const duration = latency - first;
  if (numerator <= 0) return unavailable(null);
  const tps = numerator * 1000 / duration;
  if (!Number.isFinite(tps)) return unavailable('unavailable_timing');
  return { tps, formatted: `${tps.toFixed(2)} t/s`, basis };
}
