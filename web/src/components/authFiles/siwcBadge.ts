import type { TagTone } from '../common/Tag';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import { isSIWCPending, type SIWCSession } from '../../hooks/useSIWCBindings';
import type { MessageKey } from '../../i18n';

export type SIWCBadgeState = 'bind' | 'off' | 'active' | 'rebind' | 'pending';

/**
 * What a Codex row says about its SIWC partition, or nothing.
 *
 * A credential CPA cannot bind and that holds no partition has nothing to offer, so it carries no
 * badge rather than a permanent "unsupported". A bound partition keeps its badge even where binding
 * is unavailable, because the use switch still applies to it. A locally rejected token outranks
 * the use setting: it is the one state the operator has to act on.
 */
export function siwcBadgeState(file: ManagementAuthFile, session?: SIWCSession): SIWCBadgeState | undefined {
  if ((file.provider || file.type)?.toLowerCase() !== 'codex') return undefined;
  if (isSIWCPending(session)) return 'pending';
  if (file.siwc_bound !== true) return file.siwc_bind_supported === true && !file.runtime_only ? 'bind' : undefined;
  if (file.siwc_status === 'invalid') return 'rebind';
  return file.use_siwc ? 'active' : 'off';
}

export const SIWC_BADGE_TONES: Record<SIWCBadgeState, TagTone> = {
  bind: 'neutral', off: 'neutral', active: 'success', rebind: 'warn', pending: 'accent',
};

export const SIWC_BADGE_LABEL_KEYS: Record<SIWCBadgeState, MessageKey> = {
  bind: 'siwc.badge_unbound', off: 'siwc.badge_off', active: 'siwc.badge_active', rebind: 'siwc.badge_rebind', pending: 'siwc.badge_pending',
};
