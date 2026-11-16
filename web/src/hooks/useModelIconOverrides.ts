import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '../api/queryKeys';
import { CUSTOM_ICONS_QUERY_KEY } from '../types/customIcons';
import { EMPTY_MODEL_ICONS, MODEL_ICONS_PREFERENCE, parseModelIcons, withModelIcon } from '../types/modelIcons';
import { usePreference, type PreferenceWrite } from './usePreference';

/**
 * The console-owned model icon overrides, keyed by the advertised call name.
 *
 * Like the provider overlay this is one preference document, so each write merges into the
 * document as the cache holds it now rather than into this render's snapshot: a picker
 * confirms several renders after the row that opened it.
 */
export function useModelIconOverrides() {
  const queryClient = useQueryClient();
  const { value: modelIcons, set } = usePreference<Record<string, string>>(MODEL_ICONS_PREFERENCE, EMPTY_MODEL_ICONS, parseModelIcons);

  const write = React.useCallback((model: string, icon: string): Promise<PreferenceWrite> => {
    if (!model) return Promise.resolve({ ok: false });
    const current = parseModelIcons(queryClient.getQueryData<Record<string, unknown>>(QUERY_KEYS.preferences)?.[MODEL_ICONS_PREFERENCE]);
    return set(withModelIcon(current, model, icon)).then((result) => {
      if (result.ok) {
        // Reference counts and the identity directory both project this document.
        void queryClient.invalidateQueries({ queryKey: CUSTOM_ICONS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.identityDirectory });
      }
      return result;
    });
  }, [queryClient, set]);

  const writeModelIcon = React.useCallback((model: string, icon: string) => write(model, icon), [write]);
  const resetModelIcon = React.useCallback((model: string) => write(model, ''), [write]);

  return { modelIcons, writeModelIcon, resetModelIcon };
}
