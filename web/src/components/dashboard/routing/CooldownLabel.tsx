import { StatusLabel } from '../../common/StatusLabel';
import { useT } from '../../../i18n';
import type { UsageRoutingCooldown } from '../../../types/usageRouting';
import { formatRemaining } from './routingIdentity';

const UNIT_KEYS = { s: 'routing.unit_s', min: 'routing.unit_min', h: 'routing.unit_h' } as const;

/**
 * A resting credential's state and how long it rests, from the time CPA reported.
 * The cause is named only as precisely as the record says: a quota CPA flagged, a
 * 429, or otherwise a cooldown of unstated cause.
 */
export function CooldownLabel({ cooldown, nowMs }: { cooldown: UsageRoutingCooldown; nowMs: number }) {
  const t = useT();
  const remaining = formatRemaining(cooldown.until_at_ms - nowMs);
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
}
