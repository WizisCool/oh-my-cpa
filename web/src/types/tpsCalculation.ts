export type TpsCalculationMode = 'exclude_ttft' | 'include_ttft';

export const DEFAULT_TPS_CALCULATION_MODE: TpsCalculationMode = 'exclude_ttft';
export const TPS_CALCULATION_PREFERENCE = 'omc_tps_calculation_mode';

export function parseTpsCalculationMode(raw: unknown): TpsCalculationMode | undefined {
  return raw === 'exclude_ttft' || raw === 'include_ttft' ? raw : undefined;
}
