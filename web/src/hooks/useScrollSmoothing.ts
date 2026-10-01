import React from 'react';

import { usePreference, type Preference } from './usePreference';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import {
  DEFAULT_SCROLL_SMOOTHING,
  installScrollSmoothing,
  isScrollSmoothingActive,
  parseScrollSmoothing,
  SCROLL_SMOOTHING_PREFERENCE_KEY,
  type ScrollSmoothing,
  type ScrollSmoothingPreference,
} from '../utils/scrollSmoothing';

/** The stored scroll-smoothing choice, shared by the settings row and the layer it switches. */
export function useScrollSmoothingPreference(): Preference<ScrollSmoothingPreference> {
  return usePreference<ScrollSmoothingPreference>(SCROLL_SMOOTHING_PREFERENCE_KEY, DEFAULT_SCROLL_SMOOTHING, parseScrollSmoothing);
}

/**
 * useScrollSmoothing installs the console-wide wheel and keyboard glide once and keeps it switched by
 * the stored preference and, under `system`, by the reader's reduced-motion setting - re-read live,
 * because either can change while the console is open.
 */
export function useScrollSmoothing(): void {
  const { value: preference } = useScrollSmoothingPreference();
  const prefersReducedMotion = usePrefersReducedMotion();
  const smoothingRef = React.useRef<ScrollSmoothing | null>(null);
  const isActive = isScrollSmoothingActive(preference, prefersReducedMotion);
  const isActiveRef = React.useRef(isActive);
  isActiveRef.current = isActive;

  React.useEffect(() => {
    const smoothing = installScrollSmoothing();
    smoothing.setEnabled(isActiveRef.current);
    smoothingRef.current = smoothing;
    return () => {
      smoothing.dispose();
      smoothingRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    smoothingRef.current?.setEnabled(isActive);
  }, [isActive]);
}
