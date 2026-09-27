import React from 'react';
import { isAbortError } from '../../api/client';
import { failureCode, streamChat } from './api';
import { applyEvent, createID, retriedTurn } from './state';
import type { Turn } from './state';

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
  isRunning: boolean;
  /** Starts a new turn at the end of the conversation. */
  send: (turn: Turn) => void;
  /** Replays the last turn's request snapshot in its place. */
  retry: (turn: Turn) => void;
  stop: () => void;
  /** Replaces the conversation; refused while a turn is streaming. */
  replaceTurns: (turns: Turn[]) => void;
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
export function usePlaygroundRun(): PlaygroundRun {
  const [turns, setTurns] = React.useState<Turn[]>([]);
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
    };
  }, []);

  const publish = React.useCallback(() => {
    timerRef.current = undefined;
    const live = liveRef.current;
    if (!live || !isMountedRef.current) return;
    setTurns(previous => previous.map(item => (item.id === live.id ? live : item)));
  }, []);

  const run = React.useCallback(async (turn: Turn, shouldReplaceLast: boolean) => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    liveRef.current = turn;
    setIsRunning(true);
    setTurns(previous => (shouldReplaceLast ? [...previous.slice(0, -1), turn] : [...previous, turn]));

    try {
      await streamChat(turn.request, controller.signal, event => {
        if (controllerRef.current !== controller || !liveRef.current) return;
        liveRef.current = applyEvent(liveRef.current, event);
        timerRef.current ??= setTimeout(publish, PLAYGROUND_PUBLISH_INTERVAL_MS);
      });
    } catch (error) {
      const live = liveRef.current;
      if (live?.id === turn.id) {
        const now = Date.now();
        liveRef.current = isAbortError(error)
          ? { ...live, status: 'cancelled', endedAt: now, durationMS: now - turn.startedAt }
          : applyEvent(live, { type: 'error', code: failureCode(error) }, now);
      }
    } finally {
      clearTimeout(timerRef.current);
      publish();
      liveRef.current = undefined;
      if (controllerRef.current === controller) controllerRef.current = undefined;
      if (isMountedRef.current) setIsRunning(false);
    }
  }, [publish]);

  const send = React.useCallback((turn: Turn) => { void run(turn, false); }, [run]);
  const retry = React.useCallback((turn: Turn) => {
    void run(retriedTurn(turn, createID('turn'), Date.now()), true);
  }, [run]);
  const stop = React.useCallback(() => controllerRef.current?.abort(), []);
  const replaceTurns = React.useCallback((next: Turn[]) => {
    if (controllerRef.current) return;
    setTurns(next);
  }, []);

  return { turns, isRunning, send, retry, stop, replaceTurns };
}
