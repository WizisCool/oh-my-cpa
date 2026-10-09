import React from 'react';
import { cancelRun, discoverRun } from '../../agent/reconnect';
import { isAbortError } from '../../api/client';
import { failureCode, streamChat } from './api';
import { applyEvent, createID, editedTurn, retriedTurn } from './state';
import type { Turn } from './state';
import { isDemoMode } from '../../types/demoMode';

/**
 * How often a streaming answer is published to the transcript.
 *
 * The same cadence as the Agent's run loop (`AGENT_PUBLISH_INTERVAL_MS`): a stream delivers one
 * frame per token, and publishing each one re-renders the transcript hundreds of times for one
 * answer. Coalescing holds it at 25 paints a second however fast the gateway is.
 */
export const PLAYGROUND_PUBLISH_INTERVAL_MS = 40;

export interface PlaygroundRun {
  turns: Turn[];
  lastRunID: string;
  isRunning: boolean;
  /** Starts a new turn at the end of the conversation. */
  send: (turn: Turn) => void;
  /** Replays the last turn's request snapshot in its place. */
  retry: (turn: Turn) => void;
  /** Replays the last turn with its message's text replaced. */
  edit: (turn: Turn, text: string) => void;
  stop: () => void;
  recover: (signal: AbortSignal, onRecover?: (turn: Turn) => void) => Promise<void>;
  /** Replaces the conversation; refused while a turn is streaming. */
  replaceTurns: (turns: Turn[], lastRunID?: string) => void;
}

/**
 * The conversation and the one stream that may be writing to it.
 *
 * The streaming turn lives in a ref and is published on a cadence, and every other turn keeps
 * its object identity while it streams: the transcript memoises each turn on that identity, so a
 * new token re-renders the answer it belongs to and nothing above it.
 *
 * Exactly one request is in flight at a time. A second `send` while one is running is refused
 * here rather than trusted to the button state, because the button is not the only way in (Enter,
 * a retry, a suggestion) and a double submission is a second paid request.
 */
export function usePlaygroundRun(language?: string): PlaygroundRun {
  const languageRef = React.useRef(language);
  languageRef.current = language;
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [lastRunID, setLastRunID] = React.useState('');
  const lastRunIDRef = React.useRef('');
  const [isRunning, setIsRunning] = React.useState(false);
  const controllerRef = React.useRef<AbortController>();
  const liveRef = React.useRef<Turn>();
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>();
  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearTimeout(timerRef.current);
      controllerRef.current?.abort();
      controllerRef.current = undefined;
    };
  }, []);

  const publish = React.useCallback(() => {
    timerRef.current = undefined;
    const live = liveRef.current;
    if (!live || !isMountedRef.current) return;
    setTurns(previous => previous.map(item => (item.id === live.id ? live : item)));
  }, []);

  const run = React.useCallback(async (turn: Turn, shouldReplaceLast: boolean, isRecovery = false, replacesID?: string) => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    liveRef.current = turn;
    setIsRunning(true);
    lastRunIDRef.current = turn.id;
    setLastRunID(turn.id);
    setTurns(previous => isRecovery ? [...previous.filter(item => item.id !== turn.id && item.id !== replacesID), turn] : (shouldReplaceLast ? [...previous.slice(0, -1), turn] : [...previous, turn]));

    try {
      await streamChat(turn.request, controller.signal, event => {
        if (controllerRef.current !== controller || !liveRef.current) return;
        liveRef.current = applyEvent(liveRef.current, event);
        timerRef.current ??= setTimeout(publish, PLAYGROUND_PUBLISH_INTERVAL_MS);
      }, { id: turn.id, turn: { keyLabel: turn.keyLabel, replaces_id: replacesID }, isRecovery, language: languageRef.current, replay: () => {
        if (controllerRef.current !== controller) return;
        liveRef.current = { ...turn, reply: '', thought: undefined, status: 'running', events: [], eventBytes: 0, isTruncated: false };
        publish();
      } });
    } catch (error) {
      const live = liveRef.current;
      if (controllerRef.current === controller && live?.id === turn.id) {
        const now = Date.now();
        liveRef.current = isAbortError(error)
          ? { ...live, status: 'cancelled', endedAt: now, durationMS: now - turn.startedAt }
          : applyEvent(live, { type: 'error', code: failureCode(error) }, now);
      }
    } finally {
      if (controllerRef.current !== controller) return;
      controller.abort();
      clearTimeout(timerRef.current);
      publish();
      liveRef.current = undefined;
      if (controllerRef.current === controller) controllerRef.current = undefined;
      if (isMountedRef.current) setIsRunning(false);
    }
  }, [publish]);

  const send = React.useCallback((turn: Turn) => { void run(turn, false); }, [run]);
  const retry = React.useCallback((turn: Turn) => {
    void run(retriedTurn(turn, createID('turn'), Date.now()), true, false, turn.id);
  }, [run]);
  const edit = React.useCallback((turn: Turn, text: string) => {
    void run(editedTurn(turn, text, createID('turn'), Date.now()), true, false, turn.id);
  }, [run]);
  const stop = React.useCallback(() => {
    const controller = controllerRef.current;
    const live = liveRef.current;
    if (!controller || !live) return;
    // A replay runs in this page and has no server run to cancel: ending it is the whole stop.
    if (isDemoMode()) controller.abort();
    else void cancelRun('playground', live.id, controller.signal).catch(() => {});
  }, []);
  const recover = React.useCallback(async (signal: AbortSignal, onRecover?: (turn: Turn) => void) => {
    if (controllerRef.current) return;
    try {
      const active = await discoverRun<Turn & { replaces_id?: string }>('playground', signal);
      if (!active?.request || signal.aborted || controllerRef.current || !isMountedRef.current || !active.is_running && lastRunIDRef.current === active.id) return;
      const turn = { ...active.request, id: active.id, startedAt: active.started_at_ms, status: 'running' as const };
      onRecover?.(turn);
      await run(turn, false, true, active.request.replaces_id);
    } catch { /* A missing journal leaves the persisted session authoritative. */ }
  }, [run]);
  const replaceTurns = React.useCallback((next: Turn[], acknowledgedID?: string) => {
    if (controllerRef.current) return;
    setTurns(next);
    if (acknowledgedID !== undefined) { lastRunIDRef.current = acknowledgedID; setLastRunID(acknowledgedID); }
  }, []);

  return { turns, lastRunID, isRunning, send, retry, edit, stop, recover, replaceTurns };
}
