import React from 'react';
import { usePreference } from '../../hooks/usePreference';
import { applyKeyOrder, moveKey, parseRankOrder, rankedKeys, ranksOf, type DropSide } from '../../types/displayOrder';
import type { ProviderItem } from '../../types/providers';

export const PROVIDER_ORDER_PREFERENCE = 'provider_order';
const NO_RANKS: Record<string, string> = {};

/**
 * The providers in the order the operator dragged them into, and the move that rearranges them.
 *
 * The document ranks positional ids, which the server re-keys with the names and icons when a
 * delete moves later entries down. A provider it does not rank (one added since) follows the ranked
 * ones in the gateway's own order. A move rewrites every rank from the whole list, filters
 * notwithstanding, so ranks of deleted rows do not linger.
 */
export function useProviderOrder(providers: readonly ProviderItem[]) {
  const { value: ranks, loaded, set } = usePreference<Record<string, string>>(PROVIDER_ORDER_PREFERENCE, NO_RANKS, parseRankOrder);
  const ordered = React.useMemo(
    () => applyKeyOrder(providers, (provider) => provider.id, rankedKeys(providers.map((provider) => provider.id), ranks)),
    [providers, ranks],
  );
  const move = React.useCallback((key: string, target: string, side: DropSide) => {
    if (!loaded) return undefined;
    const order = ordered.map((provider) => provider.id);
    const next = moveKey(order, key, target, side);
    return next === order ? undefined : set(ranksOf(next));
  }, [loaded, ordered, set]);
  return { ordered, move, loaded };
}
