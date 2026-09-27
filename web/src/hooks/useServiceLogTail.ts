import React from 'react';
import { api, describeError } from '../api/client';
import type { ServiceLogPage, ServiceLogRecord } from '../types/logs';
import { LOG_POLL_INTERVAL_MS } from './useLogTail';

/**
 * MAX_SERVICE_LOG_RECORDS matches the server's default ring, so the page never holds a
 * record the server has already forgotten about for long, nor drops one it still has.
 */
const MAX_SERVICE_LOG_RECORDS = 2000;

export type ServiceLogPhase = 'pending' | 'live' | 'off' | 'error';

export interface ServiceLogTail {
  records: ServiceLogRecord[];
  phase: ServiceLogPhase;
  /** Set once a read reported records lost between two polls. */
  hasGap: boolean;
  capacity?: number;
  startedAtMS?: number;
  message: string;
  paused: boolean;
  setPaused: (next: boolean) => void;
  reload: () => void;
}

/**
 * useServiceLogTail follows Oh My CPA's own log.
 *
 * The position is the server's sequence number, which only grows for the life of the
 * process, so resuming is exact: no overlap to de-duplicate. A restart starts the sequence
 * again, so a position is only meaningful together with the capture it came from: the
 * capture's start time is held beside it, and an answer from a different capture is
 * discarded and replaced by a fresh read rather than merged.
 */
export function useServiceLogTail(enabled: boolean): ServiceLogTail {
  const [records, setRecords] = React.useState<ServiceLogRecord[]>([]);
  const [phase, setPhase] = React.useState<ServiceLogPhase>('pending');
  const [hasGap, setHasGap] = React.useState(false);
  const [meta, setMeta] = React.useState<Pick<ServiceLogPage, 'capacity' | 'started_at_ms'>>({});
  const [message, setMessage] = React.useState('');
  const [paused, setPaused] = React.useState(false);

  const lastSeq = React.useRef(0);
  /** The start time of the capture `lastSeq` belongs to; undefined before the first read. */
  const captureStartedAt = React.useRef<number | undefined>(undefined);
  const generation = React.useRef(0);
  const inFlight = React.useRef(false);

  const fetchPage = React.useCallback(async (reset: boolean) => {
    if (inFlight.current && !reset) return;
    inFlight.current = true;
    const mine = generation.current;
    try {
      const page = await api.getServiceLogs({ after: reset ? undefined : lastSeq.current });
      if (mine !== generation.current) return;
      if (!page.capturing) {
        setPhase('off');
        return;
      }
      if (!reset && captureStartedAt.current !== undefined && page.started_at_ms !== captureStartedAt.current) {
        // The server restarted between reads: this page resumed from a position in a
        // capture that no longer exists. Start over from the new capture instead, as a
        // new generation so any answer still in flight from the old one is dropped.
        generation.current += 1;
        lastSeq.current = 0;
        captureStartedAt.current = undefined;
        inFlight.current = false;
        void fetchPage(true);
        return;
      }
      captureStartedAt.current = page.started_at_ms;
      const fresh = page.records.filter((record) => record.seq > (reset ? 0 : lastSeq.current));
      lastSeq.current = page.latest_seq ?? lastSeq.current;
      setMeta({ capacity: page.capacity, started_at_ms: page.started_at_ms });
      if (page.gap && !reset) setHasGap(true);
      setRecords((previous) => {
        const base = reset ? [] : previous;
        const merged = base.concat(fresh);
        return merged.length > MAX_SERVICE_LOG_RECORDS ? merged.slice(merged.length - MAX_SERVICE_LOG_RECORDS) : merged;
      });
      setPhase('live');
      setMessage('');
    } catch (err: unknown) {
      if (mine !== generation.current) return;
      setPhase('error');
      setMessage(describeError(err));
    } finally {
      if (mine === generation.current) inFlight.current = false;
    }
  }, []);

  const reload = React.useCallback(() => {
    generation.current += 1;
    inFlight.current = false;
    lastSeq.current = 0;
    captureStartedAt.current = undefined;
    setHasGap(false);
    setPhase('pending');
    void fetchPage(true);
  }, [fetchPage]);

  React.useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  React.useEffect(() => {
    if (!enabled || paused || phase === 'off') return;
    const tick = window.setInterval(() => {
      if (document.hidden) return;
      void fetchPage(false);
    }, LOG_POLL_INTERVAL_MS);
    return () => window.clearInterval(tick);
  }, [enabled, paused, phase, fetchPage]);

  return {
    records,
    phase,
    hasGap,
    capacity: meta.capacity,
    startedAtMS: meta.started_at_ms,
    message,
    paused,
    setPaused,
    reload,
  };
}
