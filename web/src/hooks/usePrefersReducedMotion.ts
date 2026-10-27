import React from 'react';
import { isMotionReduced, subscribeMotionPreference } from '../utils/motionPreference';

/** The resolved OMC preference, following live system changes only in `system` mode. */
export function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribeMotionPreference, isMotionReduced, () => false);
}
