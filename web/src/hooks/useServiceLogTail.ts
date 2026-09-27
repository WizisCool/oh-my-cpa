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
 * process, so resuming is exact: no overlap to de-duplicate, and a restart shows up as a
 * sequence lower than the one held, which is treated as a fresh start.
 */
export function useServiceLogTail(enabled: boolean): ServiceLogTail {
  const [records, setRecords] = React.useState<ServiceLogRecord[]>([]);
  const [phase, setPhase] = React.useState<ServiceLogPhase>('pending');
  const [hasGap, setHasGap] = React.useState(false);
  const [meta, setMeta] = React.useState<Pick<ServiceLogPage, 'capacity' | 'started_at_ms'>>({});
  const [message, setMessage] = React.useState('');
  const [paused, setPaused] = React.useState(false);

  const lastSeq = React.useRef(0);
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
      const restarted = (page.latest_seq ?? 0) < lastSeq.current;
      const fresh = page.records.filter((record) => record.seq > (restarted ? 0 : lastSeq.current));
      lastSeq.current = page.latest_seq ?? lastSeq.current;
      setMeta({ capacity: page.capacity, started_at_ms: page.started_at_ms });
      if (page.gap && !reset) setHasGap(true);
      setRecords((previous) => {
        const base = reset || restarted ? [] : previous;
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
