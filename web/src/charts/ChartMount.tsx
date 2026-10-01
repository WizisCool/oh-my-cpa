import React from 'react';
import { flushSync } from 'react-dom';
import { enqueueChartMount } from '../utils/chartMountQueue';

/** Reserve geometry in the caller; defer only creation, never an existing chart's data updates. */
export const ChartMount: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [isReady, setIsReady] = React.useState(false);
  React.useEffect(() => enqueueChartMount(() => {
    // Commit this chart in its own task rather than allowing concurrent React to batch the queue.
    flushSync(() => setIsReady(true));
  }), []);
  return isReady ? <>{children}</> : null;
};
