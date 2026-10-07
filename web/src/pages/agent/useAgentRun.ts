import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isAbortError } from '../../api/client';
import { applyAgentEvent, EMPTY_FRAME, invalidatedKeys } from '../../agent/runReducer';
import type { RunFrame } from '../../agent/runReducer';
import { cancelRun, discoverRun } from '../../agent/reconnect';
import { runAgent } from '../../agent/transport';
import { DECLARED_TOOLS } from '../../agent/types';
import type { Conversation } from '../../agent/types';
import { pageContextEntries } from '../../agent/pageContext';
import type { PageContext } from '../../agent/pageContext';
import { createID } from '../playground/state';
import { failureCode } from './api';

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

/** What the model is told each display tool is for; the schema is always the server's own. */
const DISPLAY_TOOL_DECLARATIONS = DECLARED_TOOLS.map(name => ({ name, description: `OMC console renders ${name}` }));

export interface AgentRunControls {
  isRunning: boolean;
  /** The message the current run was started with, shown until the server's stored turn replaces it. */
  pendingMessage: string;
  /** Whether the current run continues the stored turn that was waiting on a decision. */
  isResuming: boolean;
  /** What the run has produced so far. */
  frame: RunFrame;
  errorCode: string;
  /** When the current run started, so the activity strip can count from the run rather than from the message. */
  startedAtMS: number;
  /** The stored turn the current run's message replaces, hidden while the run is in flight. */
  replacedTurnID: string;
  /**
   * Sends a new message, optionally in place of the newest turn. Resolves when the run settles;
   * rejects when the server refused it before accepting.
   */
  send: (message: string, replaceTurn?: string) => Promise<void>;
  /** Continues the stored turn from the interrupts the operator has decided. */
  resume: (interruptIDs: string[]) => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

interface AgentRunOptions {
  conversation: Conversation | undefined;
  model: string;
  fingerprint: string;
  /** Empty for the model's own default. */
  reasoningEffort: string;
  language: string;
  /** Where the operator is; sent with a new message, never with a continuation. */
  pageContext?: PageContext;
  /** Writes a conversation the server has already persisted, so no refetch is needed for it. */
  onConversation: (conversation: Conversation) => void;
}

/** A message the server refused before it persisted the turn; the composer takes it back. */
export class RunRejectedError extends Error {
  constructor(readonly code: string, readonly text: string) {
    super(code);
  }
}

function newRunID(): string { return createID('run'); }

/**
 * Drives one Agent run over AG-UI (ADR 0041).
 *
 * The turn's authoritative state lives on the server: this hook folds the event stream into a
 * frame for display, writes back the conversation the run reports in its final snapshot, and
 * re-reads the session only when the run did not report one - a stopped run, a dropped stream. A
 * run the server refuses before `RUN_STARTED` never touched the conversation, so a new message is
 * handed back to the caller instead of being lost behind a response that looked like acceptance.
 */
export function useAgentRun(options: AgentRunOptions): AgentRunControls {
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = React.useState(false);
  const [pendingMessage, setPendingMessage] = React.useState('');
  const [isResuming, setIsResuming] = React.useState(false);
  const [frame, setFrame] = React.useState<RunFrame>(EMPTY_FRAME);
  const [errorCode, setErrorCode] = React.useState('');
  const [startedAtMS, setStartedAtMS] = React.useState(0);
  const [replacedTurnID, setReplacedTurnID] = React.useState('');

  const controllerRef = React.useRef<AbortController>();
  const runIDRef = React.useRef('');
  const publishTimerRef = React.useRef<ReturnType<typeof setTimeout>>();
  // The live frame. Held outside React state so a burst of tokens costs one render per
  // publish interval rather than one per token.
  const frameRef = React.useRef<RunFrame>(EMPTY_FRAME);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const flush = React.useCallback(() => {
    publishTimerRef.current = undefined;
    setFrame(frameRef.current);
  }, []);

  const schedule = React.useCallback(() => {
    if (publishTimerRef.current) return;
    publishTimerRef.current = setTimeout(flush, AGENT_PUBLISH_INTERVAL_MS);
  }, [flush]);

  React.useEffect(() => () => {
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    const controller = controllerRef.current;
    controller?.abort();
    controllerRef.current = undefined;
  }, []);

  const stop = React.useCallback(() => {
    const controller = controllerRef.current;
    if (controller && runIDRef.current) void cancelRun('agent', runIDRef.current, controller.signal).catch(() => {});
  }, []);

  const execute = React.useCallback(async (message: string, resume: string[], recoveryID?: string, replaceTurn = '') => {
    const { conversation: current, model, fingerprint, reasoningEffort, language, pageContext } = optionsRef.current;
    if (controllerRef.current || !current) throw new RunRejectedError('agent_busy', message);
    const isResume = message === '';
    const runID = recoveryID ?? newRunID();
    runIDRef.current = runID;
    const controller = new AbortController();
    controllerRef.current = controller;
    frameRef.current = EMPTY_FRAME;
    setFrame(EMPTY_FRAME);
    setIsResuming(isResume);
    setErrorCode('');
    setStartedAtMS(recoveryID ? current.turns.find(turn => turn.status === 'running')?.started_at_ms ?? Date.now() : Date.now());
    setPendingMessage(message);
    setReplacedTurnID(replaceTurn);
    setIsRunning(true);
    let rejection: RunRejectedError | undefined;

    try {
      const events = runAgent({
        threadId: current.id,
        runId: runID,
        ...(isResume ? {} : { message: { id: newRunID(), content: message } }),
        tools: DISPLAY_TOOL_DECLARATIONS,
        language,
        ...(isResume ? {} : { page: pageContextEntries(pageContext) }),
        forwardedProps: {
          revision: current.revision,
          model,
          client_key_fingerprint: fingerprint,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(replaceTurn ? { replace_turn: replaceTurn } : {}),
        },
        ...(isResume ? { resume: resume.map(interruptId => ({ interruptId, status: 'resolved' as const })) } : {}),
      }, controller.signal, () => {
        frameRef.current = EMPTY_FRAME;
        schedule();
      }, !!recoveryID);
      for await (const event of events) {
        if (controller.signal.aborted) break;
        frameRef.current = applyAgentEvent(frameRef.current, event);
        // A capability that changed something names the views it invalidated; refreshing them
        // here is what keeps the rest of the console consistent with what the agent just did.
        for (const key of invalidatedKeys(event)) void queryClient.invalidateQueries({ queryKey: [key] });
        schedule();
      }
      if (controllerRef.current !== controller) return;
      const settled = frameRef.current;
      if (settled.snapshot) optionsRef.current.onConversation(settled.snapshot);
      if (!settled.isAccepted && settled.errorCode && !recoveryID) {
        rejection = new RunRejectedError(settled.errorCode, message);
      } else if (settled.errorCode && !settled.snapshot) {
        setErrorCode(settled.errorCode);
      } else if (!settled.isFinished && !controller.signal.aborted) {
        setErrorCode('stream_incomplete');
      }
    } catch (cause) {
      // A stop is the operator's own decision, and the conversation the server saved already
      // records it; reporting it as a failure would contradict the reason they pressed it.
      if (!isAbortError(cause) && !controller.signal.aborted) {
        const code = failureCode(cause);
        if (!frameRef.current.isAccepted && !recoveryID) rejection = new RunRejectedError(code, message);
        else setErrorCode(code);
      }
    } finally {
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = undefined;
      }
      if (controllerRef.current !== controller) return;
      controller.abort();
      const settled = frameRef.current;
      frameRef.current = EMPTY_FRAME;
      setFrame(EMPTY_FRAME);
      setIsResuming(false);
      setPendingMessage('');
      setReplacedTurnID('');
      if (controllerRef.current === controller) controllerRef.current = undefined;
      setIsRunning(false);
      // A run that reported its final snapshot has already been written to the cache, and the
      // server persisted it before emitting it. Every other ending leaves the stored turn unknown
      // to this tab, and the stored turn is authoritative, so it is re-read rather than guessed at.
      if (!settled.snapshot) void queryClient.invalidateQueries({ queryKey: ['agent-session'] });
    }
    if (rejection) throw rejection;
  }, [queryClient, schedule]);

  React.useEffect(() => {
    if (controllerRef.current || !options.conversation) return;
    if (options.conversation.active_run_id) {
      void execute('', [], options.conversation.active_run_id).catch(() => {});
      return;
    }
    if (!options.conversation.turns.some(turn => turn.status === 'running')) return;
    const controller = new AbortController();
    void discoverRun('agent', controller.signal).then(active => {
      if (active && !controller.signal.aborted && !controllerRef.current) {
        void execute('', [], active.id).catch(() => {});
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [options.conversation, execute]);

  return {
    isRunning,
    pendingMessage,
    isResuming,
    frame,
    errorCode,
    startedAtMS,
    replacedTurnID,
    send: React.useCallback((message: string, replaceTurn?: string) => execute(message, [], undefined, replaceTurn), [execute]),
    resume: React.useCallback((interruptIDs: string[]) => execute('', interruptIDs), [execute]),
    stop,
    clearError: React.useCallback(() => setErrorCode(''), []),
  };
}
