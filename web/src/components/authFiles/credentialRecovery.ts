import type { MessageKey } from '../../i18n/catalog';
import type { ManagementAuthFile } from '../../types/managementAuthFile';

const RENEWAL_LABELS = {
  sign_in_required: 'recovery.sign_in_required',
  expired_sign_in_required: 'recovery.expired_sign_in_required',
  retry_scheduled: 'recovery.retry_scheduled',
  awaiting_first_renewal: 'recovery.awaiting_first_renewal',
  renewal_verified: 'recovery.renewal_verified',
} as const satisfies Record<string, MessageKey>;

const STAGE_LABELS = {
  sign_in_required: 'recovery.sign_in_required',
  quota_blocked: 'recovery.quota_blocked',
  loaded: 'recovery.loaded',
  inference_verified: 'recovery.inference_verified',
  renewal_verified: 'recovery.renewal_verified',
} as const satisfies Record<string, MessageKey>;

export function renewalLabel(file: ManagementAuthFile): MessageKey {
  if (file.requires_sign_in) return file.renewal_state === 'expired_sign_in_required'
    ? 'recovery.expired_sign_in_required' : 'recovery.sign_in_required';
  return RENEWAL_LABELS[file.renewal_state as keyof typeof RENEWAL_LABELS] ?? 'recovery.unknown';
}

export function recoveryStageLabel(file: ManagementAuthFile): MessageKey {
  return STAGE_LABELS[file.recovery_stage as keyof typeof STAGE_LABELS] ?? 'recovery.unknown';
}

export function renewalTone(file: ManagementAuthFile): 'warn' | 'success' | 'neutral' {
  if (file.requires_sign_in || file.renewal_state === 'sign_in_required' || file.renewal_state === 'expired_sign_in_required') return 'warn';
  return file.renewal_state === 'renewal_verified' ? 'success' : 'neutral';
}
