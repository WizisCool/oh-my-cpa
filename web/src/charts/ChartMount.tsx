import React from 'react';
import { enqueueChartMount } from '../utils/chartMountQueue';
import type { MountPriority } from '../performance/frameScheduler';

export interface ChartMountProps {
  priority?: MountPriority;
  children: React.ReactNode;
}

/**
 * Reserve geometry in the caller; defer only creation, never an existing chart's data updates.
 * Ready charts within the same 8ms frame budget commit together in one React batch rather than
 * forcing per-chart `flushSync` style/layout passes.
 */
export const ChartMount: React.FC<ChartMountProps> = ({ priority = 'p1', children }) => {
  const [isReady, setIsReady] = React.useState(false);
  React.useEffect(() => enqueueChartMount(() => {
    setIsReady(true);
  }, priority), [priority]);
  return isReady ? <>{children}</> : null;
};
