import React from 'react';
import { Provider as LibraryMotionProvider } from '@rc-component/motion';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import { usePreference, type Preference } from './usePreference';
import {
  DEFAULT_REDUCED_MOTION,
  parseReducedMotion,
  REDUCED_MOTION_PREFERENCE_KEY,
  setReducedMotionPreference,
  type ReducedMotionPreference,
} from '../utils/motionPreference';

export function useReducedMotionPreference(): Preference<ReducedMotionPreference> {
  return usePreference(REDUCED_MOTION_PREFERENCE_KEY, DEFAULT_REDUCED_MOTION, parseReducedMotion);
}

/** Apply optimistic writes and rollbacks before paint, including to portals outside the app root. */
export const MotionPreferenceSync: React.FC = () => {
  const { value } = useReducedMotionPreference();
  React.useLayoutEffect(() => { setReducedMotionPreference(value); }, [value]);
  React.useLayoutEffect(() => () => { setReducedMotionPreference(DEFAULT_REDUCED_MOTION); }, []);
  return null;
};

/** Keep the provider mounted so changing motion preserves page state and portalled control lifecycles. */
export const MotionProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const isReducedMotion = usePrefersReducedMotion();
  return React.createElement(LibraryMotionProvider, { motion: !isReducedMotion }, children);
};
