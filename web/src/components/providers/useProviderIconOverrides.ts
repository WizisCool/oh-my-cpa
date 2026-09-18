import React from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { usePreference } from '../../hooks/usePreference';
import {
  EMPTY_PROVIDER_ICONS,
  PROVIDER_ICONS_PREFERENCE,
  parseProviderIcons,
  providerIconIdPrefix,
  shiftProviderIconsAfterDelete,
} from '../../types/providerIcons';

/**
 * The console-owned brand-icon overrides, keyed to CPA's positional provider ids.
 *
 * The overlay is stored as one preference document, so every write has to merge
 * into the document as the cache holds it *now* rather than into a render's
 * snapshot: a write that happens on a mutation's confirmation runs several
 * renders after the control that started it.
 */
export function useProviderIconOverrides() {
  const queryClient = useQueryClient();

  // Stored icon preferences
  const { value: providerIcons, set: setProviderIcons } = usePreference<Record<string, string>>(
    PROVIDER_ICONS_PREFERENCE,
    EMPTY_PROVIDER_ICONS,
    parseProviderIcons,
  );

  /**
   * currentProviderIcons reads the icon map as the preference cache holds it
   * now.
   *
   * A write that happens on a mutation's confirmation runs several renders
   * after the drawer that started it, so merging into this render's
   * `providerIcons` would drop an override another control stored in between.
   * Reading the cache is what keeps the merge additive.
   */
  const currentProviderIcons = React.useCallback(
    () =>
      parseProviderIcons(
        queryClient.getQueryData<Record<string, unknown>>(['preferences'])?.[PROVIDER_ICONS_PREFERENCE],
      ),
    [queryClient],
  );

  /**
   * writeProviderIcon stores one override under one provider id.
   *
   * The id is the row's own positional one: the table resolves an id key first,
   * so an override stored only under a display name could be shadowed by the id
   * the row reads first - and a display name is not unique, so two credentials
   * sharing one would overwrite each other's mark.
   */
  const writeProviderIcon = React.useCallback(
    (id: string, icon: string) => {
      if (!id) return;
      setProviderIcons({ ...currentProviderIcons(), [id]: icon });
    },
    [currentProviderIcons, setProviderIcons],
  );

  /**
   * shiftCachedProviderIcons replays a provider delete's re-keying of the icon
   * overlay into this console's cache, without writing it back.
   *
   * The stored document is already re-keyed server-side as part of the delete,
   * so keeping the deleted row's override in this cache would only matter as the
   * baseline of the next icon write, which would then restore the key the delete
   * removed. Writing only the cache - rather than PUTting the whole document from
   * a client that may not be the one that authored it - is what keeps this from
   * overwriting an override another console stored in the meantime.
   */
  const shiftCachedProviderIcons = React.useCallback(
    (id: string) => {
      const idPrefix = providerIconIdPrefix(id);
      if (!idPrefix) return;
      // Evaluated only against a document that is already loaded: creating the
      // cache entry here would publish it as fresh, and every other preference
      // would then read as unset until the page was reloaded.
      const cached = queryClient.getQueryData<Record<string, unknown>>(['preferences']);
      if (!cached) return;
      const deletedIndex = Number(id.slice(idPrefix.length));
      queryClient.setQueryData<Record<string, unknown>>(['preferences'], {
        ...cached,
        [PROVIDER_ICONS_PREFERENCE]: shiftProviderIconsAfterDelete(
          parseProviderIcons(cached[PROVIDER_ICONS_PREFERENCE]),
          idPrefix,
          deletedIndex,
        ),
      });
    },
    [queryClient],
  );

  return { providerIcons, writeProviderIcon, shiftCachedProviderIcons };
}
