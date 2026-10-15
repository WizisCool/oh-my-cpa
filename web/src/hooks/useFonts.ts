import React from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';
import { applyFonts } from '../theme/fontLibrary';
import {
  DEFAULT_FONT_ROLES,
  FONT_PREFERENCE_KEY,
  FONT_ROLES,
  FONTS_QUERY_KEY,
  libraryIdOf,
  parseFontRoles,
  serializeFontRoles,
  type FontRole,
  type FontRoles,
} from '../types/fonts';
import { usePreference } from './usePreference';

const parseStoredRoles = (raw: unknown) => parseFontRoles(raw);

/** The deployment's font library. */
export function useFontLibrary(isEnabled = true) {
  return useQuery({
    queryKey: FONTS_QUERY_KEY,
    queryFn: api.getFonts,
    enabled: isEnabled,
    staleTime: 60_000,
    meta: { silent: true },
  });
}

/** The two role choices, stored as the `omc_fonts` preference. */
export function useFontRoles() {
  const preference = usePreference<FontRoles>(FONT_PREFERENCE_KEY, DEFAULT_FONT_ROLES, parseStoredRoles);
  const { value, set } = preference;
  const setRole = React.useCallback((role: FontRole, ref: string) => set(serializeFontRoles({ ...value, [role]: ref }) as FontRoles), [set, value]);
  return { ...preference, setRole };
}

/**
 * Keeps the document painted in the chosen faces. The library is read only when a role
 * uses one of its families: a console on the built-in typefaces makes no extra request.
 */
export function useConsoleFonts(): void {
  // `loaded`, not `ready`: before sign-in the preference read fails, and painting the
  // defaults then would undo the first frame's stored choice on the sign-in screen.
  const { value: roles, loaded: ready } = useFontRoles();
  const usesLibrary = FONT_ROLES.some((role) => libraryIdOf(roles[role]) !== undefined);
  const library = useFontLibrary(ready && usesLibrary);
  React.useEffect(() => {
    if (!ready) return;
    if (!usesLibrary) {
      applyFonts(roles, []);
      return;
    }
    if (library.data) applyFonts(roles, library.data);
  }, [ready, roles, usesLibrary, library.data]);
}
