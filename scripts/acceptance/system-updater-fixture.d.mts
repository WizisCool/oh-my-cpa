import type { ReleaseProduct, SystemUpdateJob, SystemUpdateStage, SystemUpdaterResponse, SystemUpdaterState } from '../../web/src/types/system';
export const SYSTEM_UPDATER_CONTRACT: {
  version: number;
  ready: SystemUpdaterResponse;
  not_installed: SystemUpdaterResponse;
  accepted: { body: { product: ReleaseProduct }; status: number; job: SystemUpdateJob };
  refusals: { id: string; body: { product: string }; status: number; response: Record<string, unknown> }[];
};
export interface SystemUpdaterFixture {
  (url: URL, method: string, body?: string | null): { status: number; json: SystemUpdaterResponse | Record<string, unknown> };
  /** Moves the admitted job to a stage, the way the sidecar does on its own. */
  advance(stage: SystemUpdateStage, error?: string): void;
}
export function createSystemUpdaterFixture(options?: { state?: SystemUpdaterState }): SystemUpdaterFixture;
