import { getCredentialProviderMetadata } from './providerMetadata';
import type { QuotaItem } from './quota';

/**
 * The fields a credential reports about who it is. Both shapes that carry a credential
 * into a projection - a CPA auth file and a request record's credential index - satisfy it,
 * so one identity rule serves every surface that draws a credential.
 */
export interface CredentialProviderSource {
  name?: string;
  provider?: string;
  type?: string;
  oauth_provider?: string;
}

/**
 * One credential's rendering identity.
 *
 * `provider` is the key artwork and names resolve from, already canonicalized: the login
 * portal that issued the credential when a plugin declares one, otherwise its family.
 * `family` stays behind it as the fallback, so a portal that publishes no artwork of its
 * own still draws its family's mark instead of a placeholder.
 */
export interface CredentialBrandIdentity {
  provider: string;
  family?: string;
  /** The credential file or account label; read only when the key itself names no brand. */
  hint?: string;
  /** Other proven names the record carries, in fallback order. */
  aliases?: readonly string[];
}

function normalizedKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** The family a credential authenticates with, before any issuing portal is considered. */
export function credentialProviderFamily(file: CredentialProviderSource | undefined): string {
  return (file?.type || file?.provider || 'unknown').trim().toLowerCase();
}

/**
 * The OAuth login portal that issued a credential, when the gateway reports one and a
 * plugin declares it as a portal of its own.
 *
 * A multi-portal plugin fronts several brands with one credential shape, so the portal is
 * the only evidence of which brand a credential belongs to. A single-portal plugin, an
 * identifier no plugin declares, and a gateway that reports nothing all leave the
 * credential filed under its family, exactly as before portals were reported.
 */
export function credentialPortalKey(
  file: CredentialProviderSource | undefined,
  multiPortalKeys?: ReadonlySet<string>,
): string | undefined {
  const portal = normalizedKey(file?.oauth_provider);
  return portal && multiPortalKeys?.has(portal) ? portal : undefined;
}

/**
 * The identity every credential surface renders: the portal that issued the credential over
 * its family.
 *
 * This is the one place a credential's brand is decided. A surface that holds a credential
 * comes through here, so the portal travels with the credential instead of each row model
 * re-deriving it. `family` is the caller's own reading of the credential's family, because a
 * request record and an auth file name it differently.
 */
export function credentialBrandIdentity(
  family: string,
  file: CredentialProviderSource | undefined,
  multiPortalKeys?: ReadonlySet<string>,
  aliases: readonly (string | undefined)[] = [],
): CredentialBrandIdentity {
  const normalizedFamily = normalizedKey(family) || 'unknown';
  const portal = credentialPortalKey(file, multiPortalKeys);
  const provider = portal || normalizedFamily;
  return {
    provider,
    family: normalizedFamily,
    hint: file?.name?.trim() || undefined,
    aliases: aliases.map(normalizedKey).filter((key) => key && key !== provider && key !== normalizedFamily),
  };
}

/**
 * The provider key a credential is grouped, filtered and titled under.
 *
 * Only known aliases are canonicalized. Unknown provider keys stay untouched because
 * inventing a family for them would make an unrelated credential share a filter. A
 * credential issued through one portal of a multi-portal plugin is filed under that
 * portal, which carries its own name and logo; without a reported portal it stays under
 * its type, as on a gateway that does not report one.
 */
export function canonicalDisplayProviderKey(
  file: CredentialProviderSource,
  quota?: QuotaItem,
  multiPortalKeys?: ReadonlySet<string>,
): string {
  const portal = credentialPortalKey(file, multiPortalKeys);
  if (portal) return portal;
  const family = credentialProviderFamily(file);
  const observed = family !== 'unknown' ? family : normalizedKey(quota?.provider) || 'unknown';
  const metadata = getCredentialProviderMetadata(observed);
  return metadata.id || observed || 'unknown';
}
