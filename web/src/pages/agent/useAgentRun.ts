import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { XStream } from '@ant-design/x-sdk';
import { isAbortError, requestResponse } from '../../api/client';
import { failureCode } from './api';
import { appendStreamPart, appendToolPart, parseRunEvent } from './state';
import type { Conversation, Trace, TurnPart } from './state';

/**
 * How often a growing answer is published to the transcript.
 *
 * A stream arrives one token at a time - often several hundred frames for one answer - and each
 * published frame re-renders the conversation. Coalescing at the Playground's own cadence keeps
 * the transcript at 25 updates a second no matter how fast the gateway is, which is the
 * difference between a streaming answer and a page that repaints on every token. The trailing
 * frame is flushed before the run settles, so an answer is never left one frame short.
 */
export const AGENT_PUBLISH_INTERVAL_MS = 40;

export interface AgentRunControls {
  isRunning: boolean;
  /** The message the current run was started with, shown until the server's stored turn replaces it. */
  pendingMessage: string;
  /** Whether the current run continues the stored turn that was waiting on a decision. */
  isResuming: boolean;
  /** What the run has produced so far, in the order it arrived - the same parts the server stores. */
  parts: TurnPart[];
  traces: Trace[];
  errorCode: string;
  /** When the current run started, so the activity strip can count from the run rather than from the message. */
  startedAtMS: number;
  run: (message: string) => void;
  stop: () => void;
  clearError: () => void;
}

interface AgentRunOptions {
  conversation: Conversation | undefined;
  model: string;
  fingerprint: string;
  /** Empty for the model's own default. */
  reasoningEffort: string;
  /** Writes a conversation the server has already persisted, so no refetch is needed for it. */
  onConversation: (conversation: Conversation) => void;
  /** Called when a new message is refused before the server accepted it, so it can be put back. */
  onRejected: (message: string) => void;
}

/**
 * Drives one Agent run against `/agent/run`.
 *
 * The turn's authoritative state lives on the server: this hook streams the deltas for display,
 * writes back the conversation the run reports when it ends, and re-reads the session only when
 * the run did not report one - a stopped run, a dropped stream, a rejected request. Resumption is
 * the same request with an empty message, which is why `run('')` means "continue where the
 * conversation stopped" rather than "send an empty message".
 */
export function useAgentRun(options: AgentRunOptions): AgentRunControls {
  const { onRejected } = options;
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = React.useState(false);
  const [pendingMessage, setPendingMessage] = React.useState('');
  const [isResuming, setIsResuming] = React.useState(false);
  const [parts, setParts] = React.useState<TurnPart[]>([]);
  const [traces, setTraces] = React.useState<Trace[]>([]);
  const [errorCode, setErrorCode] = React.useState('');
  const [startedAtMS, setStartedAtMS] = React.useState(0);

  const controllerRef = React.useRef<AbortController>();
  const publishTimerRef = React.useRef<ReturnType<typeof setTimeout>>();
  // The live frame. Held outside React state so a burst of tokens costs one render per
  // publish interval rather than one per token.
  const frameRef = React.useRef<{ parts: TurnPart[]; traces: Trace[]; round: number | undefined }>({ parts: [], traces: [], round: undefined });
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const flush = React.useCallback(() => {
    publishTimerRef.current = undefined;
    setParts(frameRef.current.parts);
    setTraces(frameRef.current.traces);
  }, []);

  const schedule = React.useCallback(() => {
    if (publishTimerRef.current) return;
    publishTimerRef.current = setTimeout(flush, AGENT_PUBLISH_INTERVAL_MS);
  }, [flush]);

  React.useEffect(() => () => {
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    controllerRef.current?.abort();
  }, []);

  const stop = React.useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const run = React.useCallback(async (message: string) => {
    const { conversation: current, model: activeModel, fingerprint: activeFingerprint, reasoningEffort } = optionsRef.current;
    if (controllerRef.current || !current) return;
    const isResume = message === '';
    const controller = new AbortController();
    controllerRef.current = controller;
    frameRef.current = { parts: [], traces: [], round: undefined };
    setParts([]);
    setTraces([]);
    setIsResuming(isResume);
    setErrorCode('');
    setStartedAtMS(Date.now());
    setPendingMessage(message);
    setIsRunning(true);
    let isAccepted = false;
    let isTerminal = false;
    // The runtime saves the turn it failed on before it reports the failure, so a failure is a
    // reason to re-read the session, not a reason to skip it. Only the run that reported its own
    // final conversation has nothing left for this tab to learn.
    let hasReportedState = false;

    try {
      const response = await requestResponse('/agent/run', {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
        body: JSON.stringify({
          conversation_id: current.id,
          revision: current.revision,
          message,
          model: activeModel,
          client_key_fingerprint: activeFingerprint,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
        throw new Error('invalid_stream');
      }
      isAccepted = true;

      for await (const frame of XStream({ readableStream: response.body })) {
        if (controller.signal.aborted) break;
        if (!frame.data) continue;
        const event = parseRunEvent(frame.data);
        if (!event) throw new Error('stream_incomplete');
        if (event.type === 'thought' || event.type === 'delta') {
          // Rebuilt the way the server records it, so the live turn and the saved one match.
          const frame = frameRef.current;
          const isNewRound = event.round !== frame.round;
          frame.round = event.round;
          frame.parts = appendStreamPart(frame.parts, event.type === 'thought' ? 'thought' : 'text', event.content ?? '', isNewRound);
          schedule();
          continue;
        }
        if (event.type === 'tool' && event.trace) {
          const { trace } = event;
          frameRef.current.traces = [...frameRef.current.traces.filter(item => item.id !== trace.id), trace];
          frameRef.current.parts = appendToolPart(frameRef.current.parts, trace.id);
          // A capability that changed something names the views it invalidated; refreshing them
          // here is what keeps the rest of the console consistent with what the agent just did.
          for (const key of trace.result.invalidates ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
          schedule();
          continue;
        }
        if (event.type === 'error') {
          isTerminal = true;
          setErrorCode(event.content ?? 'operation_failed');
          continue;
        }
        if (event.type === 'state' && event.conversation) {
          isTerminal = true;
          hasReportedState = true;
          optionsRef.current.onConversation(event.conversation);
        }
      }
      if (!isTerminal) throw new Error('stream_incomplete');
    } catch (cause) {
      // A stop is the operator's own decision, and the conversation the server saved already
      // records it; reporting it as a failure would contradict the reason they pressed it.
      if (!isAbortError(cause) && !controller.signal.aborted) setErrorCode(failureCode(cause));
      // A message the server never accepted is not in the conversation, so it goes back to the
      // composer rather than being lost with the failed request.
      if (!isAccepted && !isResume) onRejected(message);
    } finally {
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = undefined;
      }
      frameRef.current = { parts: [], traces: [], round: undefined };
      setParts([]);
      setTraces([]);
      setIsResuming(false);
      setPendingMessage('');
      if (controllerRef.current === controller) controllerRef.current = undefined;
      setIsRunning(false);
      // A run that reported its own final state has already been written to the cache, and the
      // server persisted that conversation before it emitted it. Every other ending - a stopped
      // run, a failure the runtime reported instead of a conversation, a dropped stream, a rejected
      // request - leaves the stored turn unknown to this tab, and the stored turn is authoritative,
      // so it is re-read rather than guessed at.
      if (!hasReportedState) void queryClient.invalidateQueries({ queryKey: ['agent-session'] });
    }
  }, [onRejected, queryClient, schedule]);

  return {
    isRunning,
    pendingMessage,
    isResuming,
    parts,
    traces,
    errorCode,
    startedAtMS,
    run: React.useCallback((message: string) => { void run(message); }, [run]),
    stop,
    clearError: React.useCallback(() => setErrorCode(''), []),
  };
}
