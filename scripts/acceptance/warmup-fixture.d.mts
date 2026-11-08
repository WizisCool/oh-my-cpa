import type { WarmupRun, WarmupRunResponse, WarmupStateView, WarmupTask } from '../../web/src/types/warmup';
export const WARMUP_CONTRACT: {
  version: number;
  state: WarmupStateView;
  run: WarmupRun;
  cases: { id: string; body: Record<string, unknown>; status: number; response: Record<string, unknown> }[];
};
export function createWarmupFixture(options?: { initialTasks?: WarmupTask[] }):
  (url: URL, method: string, body: string | null) => {
    status: number;
    json: WarmupStateView | WarmupRunResponse | Record<string, unknown>;
  };
