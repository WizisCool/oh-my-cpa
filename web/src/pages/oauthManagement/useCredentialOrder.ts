import { usePreference } from '../../hooks/usePreference';
import { parseGroupedOrder } from '../../types/displayOrder';

export const CREDENTIAL_ORDER_PREFERENCE = 'omc_credential_order';
const NO_ORDER: Record<string, string[]> = {};

/** Each provider section's credential file names in the order the operator dragged them into. */
export function useCredentialOrder() {
  return usePreference<Record<string, string[]>>(CREDENTIAL_ORDER_PREFERENCE, NO_ORDER, parseGroupedOrder);
}
