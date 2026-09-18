import type { CredentialIndex } from './usageEventIdentity';
import { resolveCredential } from './usageEventIdentity';
import type {
  UsageEvent,
} from './usageEvents';

/**
 * The bucket a record lands in when the dimension it is grouped by is absent.
 *
 * A record with no source or no user agent still belongs in the list, and
 * "unknown" is a fact about it worth being able to see, so it gets a bucket of
 * its own rather than being dropped or folded into a named one.
 */
export const UNKNOWN_EVENT_GROUP = 'unknown';

export interface EventSourceIdentity {
  /** The half used to bucket records. Lower-cased so two spellings of one name
   *  are one source, and never empty. */
  key: string;
  /** The half the header prints. */
  label: string;
}

/**
 * eventProviderIdentity is the provider half of a record's source identity.
 *
 * The name comes from the provider-name resolver, so the header names the line
 * the way the providers page does. A provider that cannot be resolved keeps
 * CPA's own key, which is still the record's true identity and never an
 * invention.
 */
export function eventProviderIdentity(
  event: Pick<UsageEvent, 'provider'>,
  resolveProviderName: (providerKey: string | null | undefined) => string,
  unknownLabel: string,
): EventSourceIdentity {
  const label = resolveProviderName(event.provider)?.trim() || '';
  if (!label) return { key: UNKNOWN_EVENT_GROUP, label: unknownLabel };
  return { key: label.toLowerCase(), label };
}

/**
 * eventCredentialIdentity is the auth-source half.
 *
 * An ambiguous credential is never resolved to a guessed file name: two
 * credentials of one provider must not merge into one header, because the header
 * is the only thing telling them apart. It still names the stored index, which is
 * a real identity and keeps the two buckets distinct.
 */
export function eventCredentialIdentity(
  event: UsageEvent,
  credentials: CredentialIndex,
  unknownLabel: string,
): EventSourceIdentity {
  const label = resolveCredential(event, credentials).name?.trim() || '';
  if (!label) return { key: UNKNOWN_EVENT_GROUP, label: unknownLabel };
  return { key: label.toLowerCase(), label };
}

/**
 * providersWithMultipleAuthSources names the providers this page served through
 * more than one credential.
 *
 * It is what makes "distinguish the auth source when needed" a decision rather
 * than a decoration: a provider whose records all arrived through one credential
 * gains nothing from repeating that credential on every header, while a provider
 * split across two must say which is which or the two buckets look identical.
 * The answer is computed from the whole page because "only one credential" is a
 * property of the provider, not of whichever bucket is being rendered.
 */
export function providersWithMultipleAuthSources(
  events: readonly UsageEvent[],
  credentials: CredentialIndex,
  resolveProviderName: (providerKey: string | null | undefined) => string,
  unknownLabel: string,
): Set<string> {
  const sourcesByProvider = new Map<string, Set<string>>();
  for (const event of events) {
    const provider = eventProviderIdentity(event, resolveProviderName, unknownLabel).key;
    const credential = eventCredentialIdentity(event, credentials, unknownLabel).key;
    const sources = sourcesByProvider.get(provider) ?? new Set<string>();
    sources.add(credential);
    sourcesByProvider.set(provider, sources);
  }
  const multiple = new Set<string>();
  for (const [provider, sources] of sourcesByProvider) {
    if (sources.size > 1) multiple.add(provider);
  }
  return multiple;
}

/**
 * formatEventSourceGroupTitle renders one source header.
 *
 * The separator is only worth printing when there are two things to separate, so
 * a single-credential provider reads as the provider alone.
 */
export function formatEventSourceGroupTitle(
  providerLabel: string,
  credentialLabel: string,
  hasMultipleAuthSources: boolean,
): string {
  return hasMultipleAuthSources ? `${providerLabel} / ${credentialLabel}` : providerLabel;
}

/**
 * eventUserAgentGroupKey buckets records by the client they came from.
 *
 * The stored value is already the short product label the persistence path
 * reduced the raw header to, so it is used verbatim; nothing here re-parses a
 * header or expands what was deliberately minimised.
 */
export function eventUserAgentGroupKey(event: Pick<UsageEvent, 'user_agent'>): string {
  return event.user_agent?.trim().toLowerCase() || UNKNOWN_EVENT_GROUP;
}
