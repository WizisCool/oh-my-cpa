'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ComponentProps } from 'react';
import { SiteLink } from '@/components/site-link';

type SiteRootProviderProps = Omit<ComponentProps<typeof RootProvider>, 'components' | 'theme'>;

// Switching language remounts the `[lang]` root layout on the client, which re-renders the theme
// script. React warns about script tags rendered on the client and never runs them, so the script is
// executable only in the server HTML; `suppressHydrationWarning` on it covers the type mismatch.
const THEME_SCRIPT_TYPE = typeof window === 'undefined' ? 'text/javascript' : 'text/plain';

export function SiteRootProvider(props: SiteRootProviderProps) {
  return (
    <RootProvider
      {...props}
      components={{ Link: SiteLink }}
      theme={{ storageKey: 'omc-site-theme', scriptProps: { type: THEME_SCRIPT_TYPE } }}
    />
  );
}
