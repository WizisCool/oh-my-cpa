import type { WarmupCredential, WarmupPolicy, WarmupResult, WarmupSettings } from '../../web/src/types/warmup';
export const WARMUP_CONTRACT: {
  version: number;
  default_policy: WarmupPolicy;
  credential: WarmupCredential;
  paused_credential: WarmupCredential;
  result: WarmupResult;
  cases: { id: string; body: Record<string, unknown>; status: number; response: Record<string, unknown> }[];
};
export function createWarmupFixture(options?: { authIndex?: string; provider?: 'claude' | 'codex'; name?: string; isProtocolPaused?: boolean }):
  (url: URL, method: string, body: string | null) => {
    status: number;
    json: WarmupSettings | WarmupCredential | WarmupResult | Record<string, unknown>;
  };
