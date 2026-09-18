import type {
  UsageEvent,
} from './usageEvents';

/** One provider-filter dropdown label: the operator's name for the line, plus
 *  the window's request count that makes the option worth reading. */
export function providerFacetLabel(name: string, requests: number): string {
  return `${name} (${requests})`;
}

/** api_group_label is a grouping category, NOT a user-assigned API key name.
 *  An api_key group resolves to the name the operator gave it, then to its
 *  display mask, and never to the stored fingerprint: records from before the
 *  mask column existed have no readable key form at all and resolve to
 *  undefined. */
export function requestGroupName(event: UsageEvent): string | undefined {
  const category = event.api_group_label?.trim().toLowerCase();
  if (category === 'api_key' || category === 'apikey') {
    return event.api_key_alias?.trim() || event.api_key_mask?.trim() || undefined;
  }
  const key = event.api_group_key?.trim();
  return key && key !== 'unknown' ? key : undefined;
}

/** Result-capsule label key for one record: the stored failed flag is the only
 *  success signal, so the capsule can never disagree with the filter counts. */
export function eventResultLabelKey(event: Pick<UsageEvent, 'failed'>): string {
  return event.failed ? 'events.filter_failed' : 'events.filter_success';
}

/** The client label for the list's UA column. The stored value is the one the
 *  ingestion/persistence path already reduced to a short product label, so the
 *  list shows it verbatim; a record captured without one reads as an em dash. */
export function eventUserAgentLabel(event: Pick<UsageEvent, 'user_agent'>): string {
  const value = event.user_agent?.trim();
  return value || '—';
}

/** The caller key for the list's Key column.
 *
 *  Only an `api_key` group is a caller key, and the operator-assigned alias is
 *  the most readable form of one. The stored display mask is the fallback: it is
 *  recognisable and, unlike the fingerprint, was never meant to be hidden. A
 *  record ingested before the mask column existed shows an em dash rather than a
 *  fingerprint. `provider` and `endpoint` groups carry a provider name or a
 *  public URL, which is not a key, so they fall through to the source
 *  fingerprint instead - an alias cannot belong to them because it is stored
 *  against a caller-key identity. */
export function eventKeyLabel(event: UsageEvent): string {
  const category = event.api_group_label?.trim().toLowerCase();
  if (category === 'api_key' || category === 'apikey') {
    return event.api_key_alias?.trim() || event.api_key_mask?.trim() || '—';
  }
  return event.source?.trim() || '—';
}

/** One filter-dropdown label. Key-shaped facets carry a mask so the list reads
 *  as caller keys instead of stored fingerprints, and now prefer the
 *  operator-assigned alias when one exists. The alias is resolved server-side
 *  from the same fingerprint that is the option's value, so the dropdown and the
 *  rows it filters name the key the same way. */
export function usageFacetLabel(value: { value: string; requests: number; mask?: string; alias?: string }): string {
  return `${value.alias?.trim() || value.mask?.trim() || value.value} (${value.requests})`;
}
