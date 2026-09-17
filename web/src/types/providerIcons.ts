/**
 * Shared console preference for per-provider icon overrides, and the keying
 * rules every reader must agree on.
 *
 * usePreference requires reference-stable values across renders (its result is
 * wired into effect deps and React.memo props), so the fallback and parser
 * must live at module scope instead of inline object literals and arrow
 * closures at call sites.
 */
export const PROVIDER_ICONS_PREFERENCE = 'provider_icons';

export const EMPTY_PROVIDER_ICONS: Record<string, string> = {};

export function parseProviderIcons(raw: unknown): Record<string, string> {
  return typeof raw === 'object' && raw ? (raw as Record<string, string>) : EMPTY_PROVIDER_ICONS;
}

/** The two keys an override may legally live under: the row id, then its name. */
export interface ProviderIconKeys {
  id?: string;
  name?: string;
}

/**
 * resolveProviderIcon is the single resolution order for a provider's mark.
 *
 * The row id is the row's identity and wins; the display name is read second so
 * an override stored before the id was known (or by an older build) still
 * applies. Every surface that draws a provider mark - the provider table, the
 * edit drawer, the picker's current selection and the request rows - goes
 * through here, because a second copy of this order is a surface that can
 * silently disagree with the rest.
 */
export function resolveProviderIcon(
  icons: Record<string, string>,
  provider: ProviderIconKeys,
  fallback: string,
): string {
  return (
    (provider.id ? icons[provider.id] : undefined) ||
    (provider.name ? icons[provider.name] : undefined) ||
    fallback
  );
}

/**
 * providerIconIdPrefix splits the positional prefix off a provider row id, e.g.
 * `openai-compat-` from `openai-compat-3`.
 *
 * Returns undefined for an id that is not positional, so a caller fails loudly
 * rather than rewriting keys it cannot address. The prefix is taken from the id
 * itself instead of a family table so a newly added family cannot be left out of
 * the shift by forgetting to list it here.
 */
export function providerIconIdPrefix(id: string): string | undefined {
  const separator = id.lastIndexOf('-');
  if (separator <= 0) return undefined;
  if (!/^\d+$/.test(id.slice(separator + 1))) return undefined;
  return id.slice(0, separator + 1);
}

/**
 * shiftProviderIconsAfterDelete re-keys one family's icon overrides after an
 * entry was deleted, dropping the deleted entry's own override.
 *
 * Overrides are stored under the same positional id the row is addressed by, so
 * without this the deleted provider's mark stays on its id and is inherited by
 * whichever credential moves into that index - the icon appears to "take over"
 * from the record that was removed. Ids of other families are left untouched:
 * the map is shared across families and only this one's positions moved. This
 * mirrors `shiftPositionalProviderIDs` on the server, which keeps the stored
 * document aligned even for a delete this console did not issue.
 */
export function shiftProviderIconsAfterDelete(
  icons: Record<string, string>,
  idPrefix: string,
  deletedIndex: number,
): Record<string, string> {
  const shifted: Record<string, string> = {};
  for (const [id, icon] of Object.entries(icons)) {
    if (!id.startsWith(idPrefix)) {
      shifted[id] = icon;
      continue;
    }
    const rawIndex = id.slice(idPrefix.length);
    if (!/^\d+$/.test(rawIndex)) {
      // An id this family cannot be addressed by is not ours to rewrite.
      shifted[id] = icon;
      continue;
    }
    const index = Number(rawIndex);
    if (index === deletedIndex) continue;
    shifted[index > deletedIndex ? `${idPrefix}${index - 1}` : id] = icon;
  }
  return shifted;
}
