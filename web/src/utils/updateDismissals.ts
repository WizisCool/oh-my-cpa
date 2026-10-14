import type { ReleaseProduct, SystemProductVersion } from '../types/system';

/**
 * The published tag an operator chose to stop being reminded about, per product.
 *
 * A dismissal names a version rather than switching reminders off, so a release newer than
 * the dismissed one is announced again without anyone having to re-enable anything.
 */
export type UpdateDismissals = Partial<Record<ReleaseProduct, string>>;

export const UPDATE_DISMISSALS_PREFERENCE = 'update_dismissals';

/** Module-scope so `usePreference` sees one stable fallback reference. */
export const NO_UPDATE_DISMISSALS: UpdateDismissals = Object.freeze({});

const RELEASE_PRODUCTS: readonly ReleaseProduct[] = ['omc', 'cpa'];

export function parseUpdateDismissals(raw: unknown): UpdateDismissals | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const dismissals: UpdateDismissals = {};
  for (const product of RELEASE_PRODUCTS) {
    const tag = (raw as Record<string, unknown>)[product];
    if (typeof tag === 'string' && tag !== '') dismissals[product] = tag;
  }
  return dismissals;
}

/** True when the newer release this product reports is the one the operator dismissed. */
export function isUpdateDismissed(version: SystemProductVersion, dismissals: UpdateDismissals): boolean {
  return version.state === 'update_available'
    && version.latest_version !== ''
    && dismissals[version.product] === version.latest_version;
}

/** The products with a newer release the operator has not dismissed. */
export function listPendingUpdates(versions: readonly SystemProductVersion[], dismissals: UpdateDismissals): ReleaseProduct[] {
  return versions
    .filter((version) => version.state === 'update_available' && !isUpdateDismissed(version, dismissals))
    .map((version) => version.product);
}

export function withDismissal(dismissals: UpdateDismissals, product: ReleaseProduct, tag: string | null): UpdateDismissals {
  const next = { ...dismissals };
  if (tag) next[product] = tag;
  else delete next[product];
  return next;
}
