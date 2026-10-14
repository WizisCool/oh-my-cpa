import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ReleaseProduct, SystemUpdateJob, SystemUpdaterResponse } from '../../types/system';

export const UPDATER_QUERY_KEY = ['management-system-updater'] as const;
const UPDATE_POLL_MS = 2000;
/**
 * How long an update is followed while no updater answers. A replacement gets three minutes to
 * prove itself and the updater then replaces itself; past this the updater is gone, and saying
 * so is better than a stage line that never moves.
 */
export const UPDATE_WATCH_LIMIT_MS = 10 * 60_000;

/** How a watched update ended. A null job is an updater that no longer remembers it, or no longer answers. */
export type UpdateOutcome = { job: SystemUpdateJob } | { job: null; product: ReleaseProduct };

interface ConsoleUpdateOptions {
  onFinished: (outcome: UpdateOutcome) => void;
}

/**
 * The updater's state for the version card, and the one update this page is following.
 *
 * A console update restarts the server this page talks to, and the updater then replaces itself,
 * so for a while every read fails or answers that no updater exists. While an update is being
 * followed those answers are not shown: the last answer from a working updater stands until the
 * job reports its end, which is what keeps the card from offering an install command in the
 * middle of an update it started.
 */
export function useConsoleUpdate({ onFinished }: ConsoleUpdateOptions) {
  const queryClient = useQueryClient();
  const [watched, setWatched] = React.useState<{ id: string; product: ReleaseProduct } | null>(null);
  const [submittingProduct, setSubmittingProduct] = React.useState<ReleaseProduct | null>(null);
  const lastReadyRef = React.useRef<SystemUpdaterResponse>();
  const lastAnsweredAtRef = React.useRef(0);
  const onFinishedRef = React.useRef(onFinished);
  onFinishedRef.current = onFinished;

  const { data, dataUpdatedAt, errorUpdatedAt } = useQuery({
    queryKey: UPDATER_QUERY_KEY,
    queryFn: api.getSystemUpdater,
    retry: false,
    meta: { silent: true },
    refetchInterval: (query) => (watched || (query.state.data?.job && !query.state.data.job.finished) ? UPDATE_POLL_MS : false),
  });
  if (data?.state === 'ready') lastReadyRef.current = data;
  const updater = watched && data?.state !== 'ready' ? lastReadyRef.current ?? data : data;

  React.useEffect(() => {
    if (data?.state === 'ready') {
      // A failed read leaves the previous answer in place, so the time of the answer, not of
      // this pass, is what the limit below is measured from.
      lastAnsweredAtRef.current = dataUpdatedAt;
      const job = data.job;
      if (!watched) {
        // An update started elsewhere, or before this page was reloaded, is followed too.
        if (job && !job.finished) setWatched({ id: job.id, product: job.product });
        return;
      }
      if (job?.id !== watched.id) {
        setWatched(null);
        onFinishedRef.current({ job: null, product: watched.product });
        return;
      }
      if (job.finished) {
        setWatched(null);
        onFinishedRef.current({ job });
        return;
      }
    }
    if (watched && Date.now() - lastAnsweredAtRef.current >= UPDATE_WATCH_LIMIT_MS) {
      setWatched(null);
      // The answer still held is the running job this gives up on; left in place it would be
      // taken for an update in progress and followed again.
      lastReadyRef.current = undefined;
      void queryClient.resetQueries({ queryKey: UPDATER_QUERY_KEY });
      onFinishedRef.current({ job: null, product: watched.product });
    }
  }, [data, dataUpdatedAt, errorUpdatedAt, watched, queryClient]);

  const apply = React.useCallback(async (product: ReleaseProduct) => {
    setSubmittingProduct(product);
    try {
      const accepted = await api.applySystemUpdate(product);
      lastReadyRef.current = accepted;
      queryClient.setQueryData(UPDATER_QUERY_KEY, accepted);
      if (accepted.job) setWatched({ id: accepted.job.id, product: accepted.job.product });
    } finally {
      setSubmittingProduct(null);
    }
  }, [queryClient]);

  return { updater, submittingProduct, apply };
}
