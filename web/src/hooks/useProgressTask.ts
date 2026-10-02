import React from 'react';
import { beginProgressTask } from '../utils/progressTasks';

/**
 * Counts the calling component's lifetime as work in flight for the loading bar.
 *
 * A Suspense fallback is mounted exactly while its module downloads, so mounting one is the start
 * of that task and unmounting it is the end. `isActive` covers work with a narrower span than the
 * component, such as a sign-in request.
 */
export function useProgressTask(isActive = true) {
  React.useEffect(() => {
    if (!isActive) return;
    return beginProgressTask();
  }, [isActive]);
}
