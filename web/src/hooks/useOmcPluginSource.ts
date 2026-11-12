import { useQueryClient } from '@tanstack/react-query';
import { invalidateQueriesSilently } from '../utils/progressSources';
import { usePreference } from './usePreference';

const PLUGIN_SOURCE_PREFERENCE = 'omc_plugin_source_enabled';
const parsePluginSourceEnabled = (raw: unknown) => (typeof raw === 'boolean' ? raw : undefined);

/**
 * The one switch for Oh My CPA's own plugin registry.
 *
 * The registry's address is compiled in and the server's store and configuration reads keep it
 * in place; this preference is what the server consults, so switching it off removes the address
 * from `plugins.store-sources` on the next plugin read. The two plugin queries are invalidated
 * once the write lands because the store they cached was read under the previous answer.
 */
export function useOmcPluginSource() {
  const queryClient = useQueryClient();
  const preference = usePreference<boolean>(PLUGIN_SOURCE_PREFERENCE, true, parsePluginSourceEnabled);
  const setEnabled = async (enabled: boolean) => {
    const outcome = await preference.set(enabled);
    if (outcome.ok) {
      void invalidateQueriesSilently(queryClient, { queryKey: ['management-plugin-store'] });
      void invalidateQueriesSilently(queryClient, { queryKey: ['management-plugin-settings'] });
    }
    return outcome;
  };
  return { isEnabled: preference.value, isLoaded: preference.loaded, setEnabled };
}
