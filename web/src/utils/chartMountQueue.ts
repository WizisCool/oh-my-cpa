export type ScheduleChartTask = (task: () => void) => () => void;

interface ChartMountJob {
  mount: () => void;
}

/** Keep expensive initializations in separate tasks so input and paint can run between them. */
export function createChartMountQueue(scheduleTask: ScheduleChartTask): (mount: () => void) => () => void {
  const jobs = new Set<ChartMountJob>();
  let cancelTask: (() => void) | undefined;

  function scheduleNext(): void {
    if (cancelTask || jobs.size === 0) return;
    cancelTask = scheduleTask(() => {
      cancelTask = undefined;
      const job = jobs.values().next().value;
      if (!job) return;
      jobs.delete(job);
      try {
        job.mount();
      } finally {
        scheduleNext();
      }
    });
  }

  return (mount) => {
    const job = { mount };
    jobs.add(job);
    scheduleNext();
    return () => {
      jobs.delete(job);
      if (jobs.size === 0) {
        cancelTask?.();
        cancelTask = undefined;
      }
    };
  };
}

// A task after rAF leaves a paint opportunity before each chart; a hidden tab naturally pauses.
const enqueueChartMount = createChartMountQueue((task) => {
  let taskId: ReturnType<typeof setTimeout> | undefined;
  const frameId = requestAnimationFrame(() => { taskId = setTimeout(task, 0); });
  return () => {
    cancelAnimationFrame(frameId);
    if (taskId !== undefined) clearTimeout(taskId);
  };
});

export { enqueueChartMount };
