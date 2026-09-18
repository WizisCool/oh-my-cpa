import React from 'react';

import { App as AntdApp } from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';

import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { EVENT_AUTO_REFRESH_MS, EVENT_SYNC_NOTICE_MS } from '../../types/usageEventCadence';
import { eventWindow } from '../../types/usageEventQuery';
import type { UsageEventQuery } from '../../types/usageEvents';
import { shouldPoll } from './pollingPolicy';
import { shouldAnnounceStuckSync, syncOutcomeMessage, syncShortfallReason } from './syncPresentation';

interface IngestStatus {
  enabled?: boolean;
  healthy?: boolean;
  collector?: {
    mode?: string;
    running?: boolean;
    captured?: number;
    coverage_gaps?: number;
    last_error?: string;
  };
  stats?: { pending?: number };
}

/**
 * The pipeline behind the request list: its status, its manual refresh, and the
 * poll that re-reads the list.
 *
 * They are one hook because they share their writers. A manual sync re-reads the
 * list, the facets and the pipeline status, and the poll advances the same
 * counters - so splitting them would mean two owners of one revision.
 *
 * The reader's own layout choices are not here: `isAutoRefresh` is stored view
 * state, passed in, and the hook only acts on it.
 */
export function useUsageEventSync({
  query,
  isAutoRefresh,
  isFetchingRef,
}: {
  query: UsageEventQuery;
  isAutoRefresh: boolean;
  /**
   * The list query's in-flight state, read through a ref rather than closing over
   * it. Naming `isFetching` in the interval's dependency list rebuilt the timer on
   * every fetch, which reset the interval each time and turned a 10-second poll
   * into "10 seconds after the last response finished" - the cadence the operator
   * asked for is wall-clock, not round-trip dependent.
   */
  isFetchingRef: { current: boolean };
}) {
  const t = useT();
  const { message } = AntdApp.useApp();
  // The list's poll counter. Both writers advance it: a manual sync and one tick
  // of the interval below.
  const [refresh, setRefresh] = React.useState(0);

  /**
   * Facets are read on their own window, not on the list's poll counter.
   *
   * `activeWindow` advances on every poll, so keying the facet query on it made
   * each ten-second tick re-issue ten grouped scans - the most expensive query
   * on the page - to answer a question whose answer barely moves. Facets describe
   * which values exist in a window, so they only need re-reading when the window
   * is *redefined* (a new preset or absolute range) or the operator asks for a
   * refresh. `facetWindowRevision` is exactly those two events, and the resolved
   * timestamps still live in the query key, so a genuinely new window is a
   * genuinely new cache entry.
   */
  const [facetWindowRevision, setFacetWindowRevision] = React.useState(0);
  const facetWindow = React.useMemo(
    () => eventWindow(query, Date.now()),
    [query, facetWindowRevision],
  );
  // The revision is part of the key, not only of the params it computes. An
  // absolute range resolves to the same two timestamps on every render, so a
  // revision that only moved the memo would leave the facet entry inside its
  // five-minute staleTime and the dropdowns would keep the counts the operator
  // just asked to have recomputed.
  const facetRevision = facetWindowRevision;

  const ingest = useQuery({
    queryKey: ['usage-ingest-status'],
    queryFn: api.getUsageIngestStatus,
    refetchInterval: 15_000,
  });
  const status = ingest.data as IngestStatus | undefined;

  /**
   * A manual refresh asks the gateway for its newest records first, then re-reads
   * what was stored.
   *
   * The two steps are one action on purpose: refreshing only the reads would
   * redraw exactly the same rows, while the records the operator is looking for
   * are still sitting in CPA's queue. Everything on screen is refreshed after the
   * pull - list, facets and pipeline status - so the page never mixes pre- and
   * post-sync data. The turn finishes either way: when the gateway could not be
   * drained, the stored data is still re-read and the failure is reported on top
   * of it.
   */
  const syncMutation = useMutation({
    mutationFn: () => api.refreshUsageIngest(),
    onSettled: () => {
      setRefresh((value) => value + 1);
      setFacetWindowRevision((value) => value + 1);
      void ingest.refetch();
    },
  });

  // A manual sync is in flight. The poll is held during it so the list cannot be
  // refreshed from data the sync is about to replace, which would show the old
  // page right after the operator asked for the new one.
  const isSyncing = syncMutation.isPending;
  // A sync that is still running after a visible delay has stopped looking like
  // "working on it": say so, so the page never looks frozen.
  const [isSyncStuck, setIsSyncStuck] = React.useState(false);
  React.useEffect(() => {
    if (!isSyncing) {
      setIsSyncStuck(false);
      return;
    }
    const timer = setTimeout(() => setIsSyncStuck(true), EVENT_SYNC_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [isSyncing]);

  // The poll reads the in-flight state through a ref rather than closing over it.
  // Naming `result.isFetching` in the dependency list rebuilt the timer on every
  // fetch, which reset the interval each time and turned a 10-second poll into
  // "10 seconds after the last response finished" - the cadence the operator
  // asked for is wall-clock, not round-trip dependent.

  const isSyncingRef = React.useRef(false);
  isSyncingRef.current = isSyncing;
  React.useEffect(() => {
    if (!isAutoRefresh) return;
    const timer = setInterval(() => {
      // The three reasons to skip a tick live in `pollingPolicy.shouldPoll`: the tab
      // is hidden, a read is already in flight, or a manual sync owns the next
      // refresh. Skipping rather than queueing is what keeps the cadence wall-clock
      // - a queued tick would fire the moment a slow query resolved.
      if (!shouldPoll({
        isAutoRefresh,
        isVisible: document.visibilityState === 'visible',
        isFetching: isFetchingRef.current,
        isSyncing: isSyncingRef.current,
      })) {
        return;
      }
      setRefresh((value) => value + 1);
    }, EVENT_AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isAutoRefresh]);

  const { mutate: requestSync, isPending: isSyncPending } = syncMutation;
  React.useEffect(() => {
    // A sync still running after a visible delay has stopped looking like "working
    // on it" and started looking like a frozen page.
    if (shouldAnnounceStuckSync(isSyncPending, isSyncStuck)) {
      void message.warning(t('events.sync_still_running'), 6);
    }
  }, [isSyncPending, isSyncStuck, message, t]);
  const handleManualRefresh = React.useCallback(() => {
    requestSync(undefined, {
      onSuccess: (outcome) => {
        // Which of the three outcomes this was - and how loudly to say it - is
        // decided in `syncPresentation`. The reported bug lived here: a pull that
        // could not drain CPA was shown as a success because "the request
        // completed" was read as "the records were fetched".
        const outcomeMessage = syncOutcomeMessage({
          ...outcome,
          error: outcome.synced
            ? outcome.error
            : syncShortfallReason(outcome, t('events.sync_unknown_reason')),
        });
        const text = t(outcomeMessage.key, outcomeMessage.vars);
        if (outcomeMessage.tone === 'info') message.info(text);
        else if (outcomeMessage.tone === 'success') message.success(text);
        else message.warning(text, 6);
      },
      onError: (error: unknown) => {
        const msg = error instanceof ApiError ? error.message : String(error);
        message.error(t('events.sync_failed', { msg }));
      },
    });
  }, [message, requestSync, t]);

  return {
    ingest,
    status,
    isSyncing,
    facetWindow,
    facetRevision,
    refresh,
    handleManualRefresh,
  };
}
