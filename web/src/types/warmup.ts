export interface WarmupPolicy {
  reset_mode: 'off' | 'weekly' | 'all';
  daily_enabled: boolean;
  daily_time: string;
  model: string;
}
export interface WarmupSettings {
  providers: Record<'codex' | 'claude', WarmupPolicy>;
  models: Record<'codex' | 'claude', string[]>;
  timezone: string;
  revision: string;
}
export interface WarmupResult {
  request_id: string;
  status: 'activated' | 'pending' | 'skipped' | 'failed' | 'uncertain' | 'executing';
  reason?: string;
  model: string;
  trigger: string;
  started_at_ms: number;
  finished_at_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
}
export interface WarmupCredential {
  auth_index: string;
  name: string;
  provider: 'codex' | 'claude';
  inherit: boolean;
  policy: WarmupPolicy;
  models: string[];
  timezone: string;
  revision: string;
  next_at_ms?: number;
  reason?: string;
  state: {
    protocol_verified: boolean;
    verified_model?: string;
    protocol_pause?: { model: string; reason: 'protocol_unsupported' | 'unexpected_tool' };
    last_result?: WarmupResult;
    observation?: { observed_at_ms: number; paid_fallback: 'enabled' | 'disabled' | 'unknown' };
  };
}
export const DEFAULT_WARMUP_POLICY: WarmupPolicy = {
  reset_mode: 'off', daily_enabled: false, daily_time: '06:00', model: '',
};
export function canSaveWarmupPolicy(policy: WarmupPolicy): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(policy.daily_time)
    && (policy.reset_mode === 'off' && !policy.daily_enabled || Boolean(policy.model));
}
