import type { QuotaItem } from '../../types/quota';

export function isKnownQuotaCooldownReason(reason: string | undefined): boolean {
  if (!reason?.trim()) return false;
  if (reason.trim() === 'credential_quota') return true;
  try {
    const diagnostic: unknown = JSON.parse(reason);
    if (!diagnostic || typeof diagnostic !== 'object') return false;
    const error = 'error' in diagnostic ? diagnostic.error : diagnostic;
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'credential_quota');
  } catch {
    return false;
  }
}

export function compactCooldownDiagnostic(item: QuotaItem): string | null {
  const reason = item.active_cooldown?.reason;
  // Only an identified quota condition is redundant with the status. Unknown upstream
  // failures must remain readable, even while CPA has put the credential on cooldown.
  if (!item.active_cooldown?.is_active || !reason?.trim() || isKnownQuotaCooldownReason(reason)) return null;
  return reason;
}
