/**
 * How one committed filter value is named for the operator.
 *
 * All three rules exist because the stored value is not the thing the operator
 * recognises, and each wrong resolution makes a filter unreadable in a different
 * way:
 *
 *   - The credential dimension stores a fingerprint, so the chip has to speak the
 *     file name the console shows everywhere else.
 *   - The caller dimension is also a fingerprint. It resolves to the alias when one
 *     exists and falls back to the display mask, which is the same preference the
 *     rows and the dropdown use. A chip that showed the fingerprint would name the
 *     filter in a form the operator never chose and cannot recognise.
 *   - The provider dimension stores CPA's provider key, so it is labelled with the
 *     operator's own name for that line.
 *
 * The function returns the *value* to display, never the sentence around it: the
 * label template comes from the dictionary so every language stays localized.
 */
import type { EventFilterKey } from '../../types/usageEventQuery';
import type { UsageFacets } from '../../types/usageEvents';

export interface ChipDisplayInput {
  key: EventFilterKey;
  /** The raw committed parameter value. */
  value: string;
  /** Resolved credential file names, keyed by auth index. */
  credentialNames: ReadonlyMap<string, string | undefined>;
  /** The caller facet, which is where an alias or a display mask lives. */
  callerFacets: UsageFacets['api_group_keys'] | undefined;
  /** Resolves a stored provider key to the operator's name for that line. */
  resolveProviderName: (value: string) => string;
  /** The dictionary's names for the two cost states. */
  costLabels: { priced: string; unpriced: string };
}

/**
 * chipDisplayValue resolves one committed parameter to what the operator should
 * read.
 *
 * A range bound keeps its raw digits: the number is already the value, and the
 * unit is carried by the label.
 */
export function chipDisplayValue({
  key,
  value,
  credentialNames,
  callerFacets,
  resolveProviderName,
  costLabels,
}: ChipDisplayInput): string {
  if (key === 'auth_index') return credentialNames.get(value) || value;
  if (key === 'api_key') {
    const facet = callerFacets?.find((entry) => entry.value === value);
    // The alias wins over the mask, matching the rows and the dropdown.
    return facet?.alias?.trim() || facet?.mask?.trim() || value;
  }
  if (key === 'provider') return resolveProviderName(value);
  if (key === 'cost') return value === 'priced' ? costLabels.priced : costLabels.unpriced;
  if (key.endsWith('_min') || key.endsWith('_max')) {
    // Cost bounds are nano-dollars on the wire and are shown in dollars, so the
    // sign is added here rather than stored.
    return key.startsWith('cost_') ? `$${value}` : value;
  }
  return value;
}
