'use client';

import { useEffect } from 'react';

/** Remembers the reader's docs language so the landing page and `/docs/` open in it next time. */
export function LocaleMemory({ lang }: { lang: string }) {
  useEffect(() => {
    try {
      localStorage.setItem('omc-docs-locale', lang);
    } catch {
      // Storage can be unavailable (private mode); the language still follows the URL.
    }
  }, [lang]);
  return null;
}
