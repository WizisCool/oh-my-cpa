import React from 'react';
import { api, ApiError, apiErrorCode } from '../api/client';
import { mergeLogLines, MAX_LOG_BUFFER_LINES } from '../types/logs';

/**
 * LOG_POLL_INTERVAL_MS is how often an unpaused tail asks for more lines.
 *
 * Five seconds, not CPAMC's eight: the tail's whole job is answering "what just
 * happened", and an operator who has already opened the page should not have to
 * wait out a timer to see it.
 */
export const LOG_POLL_INTERVAL_MS = 5000;

/**
 * Tail phases are distinct states, not one "error" bucket. Each has a different
 * operator action: flip a switch, upgrade CPA, fix the connection, or read the
 * message. Collapsing them is how a healthy product gets reported as broken.
 */
export type LogTailPhase = 'pending' | 'live' | 'disabled' | 'unsupported' | 'offline' | 'error';

export interface LogTail {
  lines: string[];
  phase: LogTailPhase;
  /** Lines pushed out of the front of the buffer by newer ones. */
  dropped: number;
  paused: boolean;
  setPaused: (next: boolean) => void;
  /** Detail for the 'error' phase; the other phases carry their own text. */
  message: string;
  reload: () => void;
  truncate: () => Promise<void>;
}

interface Position {
  cursor?: string;
  after?: number;
}

/**
 * useLogTail keeps a rolling view of CPA's log file.
 *
 * The state worth protecting here is the *position*, not the lines: CPA answers
 * with an opaque cursor when it has one and a unix second when it does not, and
 * a page that mixes the two either re-reads history or skips it. In-flight
 * answers are dropped by generation, so a reload cannot be overtaken by the
 * request it was meant to replace.
 */
export function useLogTail(enabled: boolean): LogTail {
  const [lines, setLines] = React.useState<string[]>([]);
  const [dropped, setDropped] = React.useState(0);
  const [phase, setPhase] = React.useState<LogTailPhase>('pending');
  const [paused, setPaused] = React.useState(false);
  const [message, setMessage] = React.useState('');

  const position = React.useRef<Position>({});
  const generation = React.useRef(0);
  const inFlight = React.useRef(false);
  const stopped = React.useRef(false);

  const fetchPage = React.useCallback(async (reset: boolean, force = false) => {
    // The guard exists to stop overlapping *polls*. A reload must never be
    // swallowed by it: it has already bumped the generation, so the request it
    // supersedes will be discarded on arrival, and refusing the reload here is
    // how the tail ends up showing nothing at all.
    if (!force && (inFlight.current || stopped.current)) return;
    inFlight.current = true;
    const mine = generation.current;
    try {
      const page = reset
        ? await api.getLogs({ limit: MAX_LOG_BUFFER_LINES })
        : await api.getLogs({ cursor: position.current.cursor, after: position.current.after, limit: MAX_LOG_BUFFER_LINES });
      if (mine !== generation.current) return;
      position.current = {
        cursor: page.next_cursor || undefined,
        after: page.latest_after || undefined,
      };
      if (reset || page.cursor_reset) {
        setLines(page.lines);
        setDropped(0);
      } else {
        const merged = mergeLogLines(lines, page.lines);
        setLines(merged.lines);
        setDropped((previous) => previous + merged.dropped);
      }
      setPhase('live');
      setMessage('');
    } catch (err: unknown) {
      if (mine !== generation.current) return;
      const code = apiErrorCode(err);
      if (code === 'file_logging_disabled') {
        stopped.current = true;
        setPhase('disabled');
      } else if (code === 'capability_missing') {
        stopped.current = true;
        setPhase('unsupported');
      } else if (code === 'cpa_unavailable' || code === 'cpa_authentication_failed' || (err instanceof ApiError && err.status === 0)) {
        setPhase('offline');
      } else {
        setPhase('error');
        setMessage(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlight.current = false;
    }
  }, [lines]);

  // A ref keeps the interval from being rebuilt on every buffer change, which
  // would restart the countdown and quietly stretch the poll gap under load.
  const fetchRef = React.useRef(fetchPage);
  fetchRef.current = fetchPage;

  const reload = React.useCallback(() => {
    stopped.current = false;
    generation.current += 1;
    position.current = {};
    setPhase('pending');
    void fetchRef.current(true, true);
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    reload();
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled || paused) return;
    const tick = window.setInterval(() => {
      // A hidden tab has no one reading the tail; polling it burns CPA's log
      // reader for nothing. Coming back is covered by the cursor, or by
      // cursor_reset handling if CPA dropped the position.
      if (document.hidden) return;
      void fetchRef.current(false);
    }, LOG_POLL_INTERVAL_MS);
    return () => window.clearInterval(tick);
  }, [enabled, paused]);

  const truncate = React.useCallback(async () => {
    await api.clearLogs();
    position.current = {};
    setLines([]);
    setDropped(0);
    stopped.current = false;
    void fetchRef.current(true);
  }, []);

  return { lines, phase, dropped, paused, setPaused, message, reload, truncate };
}
