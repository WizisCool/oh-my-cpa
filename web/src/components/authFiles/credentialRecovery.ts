import type { MessageKey } from '../../i18n/catalog';
import type { ManagementAuthFile } from '../../types/managementAuthFile';

const RENEWAL_LABELS = {
  sign_in_required: 'recovery.sign_in_required',
  expired_sign_in_required: 'recovery.expired_sign_in_required',
  retry_scheduled: 'recovery.retry_scheduled',
  awaiting_first_renewal: 'recovery.awaiting_first_renewal',
  renewal_verified: 'recovery.renewal_verified',
} as const satisfies Record<string, MessageKey>;

const RENEWAL_DETAILS = {
  retry_scheduled: 'recovery.detail_retry',
  awaiting_first_renewal: 'recovery.detail_awaiting',
  renewal_verified: 'recovery.detail_verified',
} as const satisfies Record<string, MessageKey>;

export function renewalLabel(file: ManagementAuthFile): MessageKey {
  if (file.requires_sign_in) return file.renewal_state === 'expired_sign_in_required'
    ? 'recovery.expired_sign_in_required' : 'recovery.sign_in_required';
  return RENEWAL_LABELS[file.renewal_state as keyof typeof RENEWAL_LABELS] ?? 'recovery.unknown';
}

/** What the renewal state means for the operator, as one sentence under its label. */
export function renewalDetail(file: ManagementAuthFile): MessageKey {
  if (file.requires_sign_in || file.renewal_state === 'sign_in_required' || file.renewal_state === 'expired_sign_in_required') return 'recovery.sign_in_hint';
  return RENEWAL_DETAILS[file.renewal_state as keyof typeof RENEWAL_DETAILS] ?? 'recovery.detail_unknown';
}

export function renewalTone(file: ManagementAuthFile): 'warn' | 'success' | 'neutral' {
  if (file.requires_sign_in || file.renewal_state === 'sign_in_required' || file.renewal_state === 'expired_sign_in_required') return 'warn';
  return file.renewal_state === 'renewal_verified' ? 'success' : 'neutral';
}
