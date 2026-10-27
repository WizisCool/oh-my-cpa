import React from 'react';

import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import type { ScrollSmoothing } from '../utils/scrollSmoothing';

/**
 * useScrollSmoothing installs the console-wide wheel and keyboard glide once and keeps it switched by
 * the resolved console motion policy, because preferences can change while the console is open.
 *
 * The engine is loaded on demand: nothing on the first paint scrolls, and until it arrives the
 * browser's own scroll is what the reader gets, which is the state with the layer switched off.
 */
export function useScrollSmoothing(): void {
  const isReducedMotion = usePrefersReducedMotion();
  const smoothingRef = React.useRef<ScrollSmoothing | null>(null);
  const isActive = !isReducedMotion;
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
