import React from 'react';
import { usePreference } from '../../hooks/usePreference';
import { applyKeyOrder, parseRankOrder, rankedKeys, ranksOf } from '../../types/displayOrder';
import type { RoutingTier } from '../../types/routingPlan';

export const ROUTING_CARD_ORDER_PREFERENCE = 'routing_card_order';
const NO_RANKS: Record<string, string> = {};

/**
 * Where each member is drawn inside its tier, as the operator dragged it.
 *
 * Priority decides the tiers and is the routing plan's business; this order is presentation only,
 * never part of a plan, and a member it does not rank follows the ranked ones in the tier's own
 * order. A write ranks every member on the board, so ranks of removed members do not linger.
 *
 * An arrangement the operator just made is held until the stored order arrives: the drop has to
 * show it in the frame the drag lets go, not a tick later, or the cards slide back and then jump.
 */
export function useRoutingCardOrder(tiers: readonly RoutingTier[]) {
  const { value: ranks, loaded, set } = usePreference<Record<string, string>>(ROUTING_CARD_ORDER_PREFERENCE, NO_RANKS, parseRankOrder);
  const [held, setHeld] = React.useState<{ ranks: Record<string, string>; keys: readonly string[] } | null>(null);
  const order = React.useMemo(
    () => (held?.ranks === ranks ? held.keys : rankedKeys(tiers.flatMap((tier) => tier.memberKeys), ranks)),
    [held, ranks, tiers],
  );
  const arranged = React.useMemo(
    () => tiers.map((tier) => ({ ...tier, memberKeys: applyKeyOrder(tier.memberKeys, (key) => key, order) })),
    [order, tiers],
  );
  /** Stores the arrangement given as each tier's keys, in tier order. */
  const arrange = React.useCallback((next: readonly RoutingTier[]) => {
    if (!loaded) return;
    const keys = next.flatMap((tier) => tier.memberKeys);
    const current = arranged.flatMap((tier) => tier.memberKeys);
    if (keys.length === current.length && keys.every((key, index) => key === current[index])) return;
    const hold = { ranks, keys };
    setHeld(hold);
    void Promise.resolve(set(ranksOf(keys))).finally(() => setHeld((value) => (value === hold ? null : value)));
  }, [arranged, loaded, ranks, set]);
  return { arranged, arrange, loaded };
}
