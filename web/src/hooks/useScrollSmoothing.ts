import React from 'react';

import { usePreference, type Preference } from './usePreference';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import type { ScrollSmoothing } from '../utils/scrollSmoothing';
import {
  DEFAULT_SCROLL_SMOOTHING,
  isScrollSmoothingActive,
  parseScrollSmoothing,
  SCROLL_SMOOTHING_PREFERENCE_KEY,
  type ScrollSmoothingPreference,
} from '../utils/scrollSmoothingPreference';

/** The stored scroll-smoothing choice, shared by the settings row and the layer it switches. */
export function useScrollSmoothingPreference(): Preference<ScrollSmoothingPreference> {
  return usePreference<ScrollSmoothingPreference>(SCROLL_SMOOTHING_PREFERENCE_KEY, DEFAULT_SCROLL_SMOOTHING, parseScrollSmoothing);
}

/**
 * useScrollSmoothing installs the console-wide wheel and keyboard glide once and keeps it switched by
 * the stored preference and, under `system`, by the reader's reduced-motion setting - re-read live,
 * because either can change while the console is open.
 *
 * The engine is loaded on demand: nothing on the first paint scrolls, and until it arrives the
 * browser's own scroll is what the reader gets, which is the state with the layer switched off.
 */
export function useScrollSmoothing(): void {
  const { value: preference } = useScrollSmoothingPreference();
  const prefersReducedMotion = usePrefersReducedMotion();
  const smoothingRef = React.useRef<ScrollSmoothing | null>(null);
  const isActive = isScrollSmoothingActive(preference, prefersReducedMotion);
  const isActiveRef = React.useRef(isActive);
  isActiveRef.current = isActive;

  React.useEffect(() => {
    let isDisposed = false;
    void import('../utils/scrollSmoothing').then(({ installScrollSmoothing }) => {
      if (isDisposed) return;
      const smoothing = installScrollSmoothing();
      smoothing.setEnabled(isActiveRef.current);
      smoothingRef.current = smoothing;
    });
    return () => {
      isDisposed = true;
      smoothingRef.current?.dispose();
      smoothingRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    smoothingRef.current?.setEnabled(isActive);
  }, [isActive]);
}
