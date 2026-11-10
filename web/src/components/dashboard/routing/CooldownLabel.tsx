import React from 'react';
import { StatusLabel } from '../../common/StatusLabel';
import { useT } from '../../../i18n';
import type { UsageRoutingCooldown } from '../../../types/usageRouting';
import { formatRemaining } from './routingIdentity';

const UNIT_KEYS = { s: 'routing.unit_s', min: 'routing.unit_min', h: 'routing.unit_h' } as const;

/**
 * Local visibility-aware ticker scoped strictly to mounted cooldown badges so the parent
 * `RoutingPanel` and `RoutingMap` never re-render every second just to advance a countdown label.
 */
function useCooldownNow(initialNowMs: number, skewMs: number, untilAtMs: number): number {
  const [nowMs, setNowMs] = React.useState(initialNowMs);

  React.useEffect(() => {
    setNowMs(Date.now() + skewMs);
  }, [initialNowMs, skewMs]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const current = Date.now() + skewMs;
      setNowMs(current);
      const remainingMs = untilAtMs - current;
      if (remainingMs <= 0) return;
      // Cooldowns shown in seconds (under 120s) step each second; longer cooldowns step every 15s.
      const stepMs = remainingMs <= 120_000 ? 1_000 : 15_000;
      timer = setTimeout(schedule, stepMs);
    };
    const onVisibility = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'visible') schedule();
    };
    schedule();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [skewMs, untilAtMs]);

  return nowMs;
}

/**
 * A resting credential's state and how long it rests, from the time CPA reported.
 * The cause is named only as precisely as the record says: a quota CPA flagged, a
 * 429, or otherwise a cooldown of unstated cause.
 */
export const CooldownLabel = React.memo(function CooldownLabel({
  cooldown,
  nowMs,
  skewMs = 0,
}: {
  cooldown: UsageRoutingCooldown;
  nowMs: number;
  skewMs?: number;
}) {
  const t = useT();
  const liveNowMs = useCooldownNow(nowMs, skewMs, cooldown.until_at_ms);
  const remaining = formatRemaining(cooldown.until_at_ms - liveNowMs);
  const cause = cooldown.quota_exceeded
    ? t('routing.quota_exceeded')
    : cooldown.status_code === 429
      ? t('routing.rate_limited')
      : t('routing.resting');
  return (
    <StatusLabel tone="warn">
      {t('routing.back_in', { cause, value: remaining.value, unit: t(UNIT_KEYS[remaining.unit]) })}
    </StatusLabel>
  );
});
