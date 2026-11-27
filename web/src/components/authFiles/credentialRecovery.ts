import { apiErrorCode } from '../../api/client';
import type { MessageKey } from '../../i18n/catalog';
import type { ManagementAuthFile } from '../../types/managementAuthFile';

export const VERIFICATION_OUTCOMES = [
  'verified',
  'unconfirmed',
  'verification_not_applied',
  'failed',
] as const;

export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const VERIFICATION_OUTCOME_MESSAGES = {
  verified: 'recovery.verify_success',
  unconfirmed: 'recovery.verify_unconfirmed',
  verification_not_applied: 'recovery.verify_not_applied',
  failed: 'recovery.verify_failed',
} as const satisfies Record<VerificationOutcome, MessageKey>;

export const VERIFICATION_OUTCOME_TONES = {
  verified: 'success',
  unconfirmed: 'warning',
  verification_not_applied: 'warning',
  failed: 'error',
} as const satisfies Record<VerificationOutcome, 'success' | 'warning' | 'error'>;

const VERIFICATION_NOT_APPLIED_OUTCOME: VerificationOutcome = 'verification_not_applied';

export function verificationOutcomeFromResult(result: { verified: boolean }): VerificationOutcome {
  return result.verified ? 'verified' : 'unconfirmed';
}

export function verificationOutcomeFromError(error: unknown): VerificationOutcome {
  return apiErrorCode(error) === VERIFICATION_NOT_APPLIED_OUTCOME ? VERIFICATION_NOT_APPLIED_OUTCOME : 'failed';
}

export function isVerificationNotApplied(outcome: VerificationOutcome | null): boolean {
  return outcome === VERIFICATION_NOT_APPLIED_OUTCOME;
}

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

export type RenewalKind = 'verified' | 'awaiting' | 'retry' | 'reauth' | 'unknown';

export function renewalKind(file: ManagementAuthFile): RenewalKind {
  if (file.requires_sign_in || file.renewal_state === 'sign_in_required' || file.renewal_state === 'expired_sign_in_required') {
    return 'reauth';
  }
  if (file.renewal_state === 'renewal_verified') return 'verified';
  if (file.renewal_state === 'retry_scheduled') return 'retry';
  if (file.renewal_state === 'awaiting_first_renewal') return 'awaiting';
  return 'unknown';
}

export function renewalLabel(file: ManagementAuthFile): MessageKey {
  if (file.requires_sign_in) return file.renewal_state === 'expired_sign_in_required'
    ? 'recovery.expired_sign_in_required' : 'recovery.sign_in_required';
  return RENEWAL_LABELS[file.renewal_state as keyof typeof RENEWAL_LABELS] ?? 'recovery.unknown';
}

/** What the renewal evidence means for the operator, as one sentence under its label. */
export function renewalDetail(file: ManagementAuthFile): MessageKey {
  if (file.refresh_error?.code === 'refresh_outcome_unknown') return 'recovery.refresh_outcome_unknown_hint';
  if (file.requires_sign_in || file.renewal_state === 'sign_in_required' || file.renewal_state === 'expired_sign_in_required') return 'recovery.sign_in_hint';
  return RENEWAL_DETAILS[file.renewal_state as keyof typeof RENEWAL_DETAILS] ?? 'recovery.detail_unknown';
}

export function renewalTone(file: ManagementAuthFile): 'warn' | 'success' | 'neutral' {
  if (file.requires_sign_in || file.renewal_state === 'sign_in_required' || file.renewal_state === 'expired_sign_in_required') return 'warn';
  return file.renewal_state === 'renewal_verified' ? 'success' : 'neutral';
}
