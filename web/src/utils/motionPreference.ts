/** One console-wide policy for CSS, library animations and imperative gestures. */
export type ReducedMotionPreference = 'on' | 'system' | 'off';

export const REDUCED_MOTION_PREFERENCES: readonly ReducedMotionPreference[] = ['on', 'system', 'off'];
export const REDUCED_MOTION_PREFERENCE_KEY = 'omc_reduced_motion';
export const DEFAULT_REDUCED_MOTION: ReducedMotionPreference = 'system';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function parseReducedMotion(raw: unknown): ReducedMotionPreference | undefined {
  return REDUCED_MOTION_PREFERENCES.includes(raw as ReducedMotionPreference) ? raw as ReducedMotionPreference : undefined;
}

let preference: ReducedMotionPreference = DEFAULT_REDUCED_MOTION;
const LISTENERS = new Set<() => void>();
let systemQuery: MediaQueryList | undefined;

/** Imperative consumers read the same live decision as usePrefersReducedMotion. */
export function isMotionReduced(): boolean {
  if (preference !== 'system') return preference === 'on';
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && (systemQuery ?? window.matchMedia(REDUCED_MOTION_QUERY)).matches;
}

function publishMotionPreference(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.reducedMotion = String(isMotionReduced());
  for (const listener of LISTENERS) listener();
}

export function setReducedMotionPreference(next: ReducedMotionPreference): void {
  preference = next;
  publishMotionPreference();
}

/** The system listener is shared, including by charts mounted after the policy was chosen. */
export function subscribeMotionPreference(listener: () => void): () => void {
  const isFirstSubscriber = LISTENERS.size === 0;
  if (isFirstSubscriber) {
    systemQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY) : undefined;
    systemQuery?.addEventListener('change', publishMotionPreference);
  }
  LISTENERS.add(listener);
  if (isFirstSubscriber) publishMotionPreference();
  return () => {
    LISTENERS.delete(listener);
    if (LISTENERS.size === 0) {
      systemQuery?.removeEventListener('change', publishMotionPreference);
      systemQuery = undefined;
    }
  };
}
