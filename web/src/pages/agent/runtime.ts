import React from 'react';
import { createMessageQueue, useExternalStoreRuntime } from '@assistant-ui/react';
import type { AssistantRuntime, ThreadMessageLike } from '@assistant-ui/react';
import type { Conversation } from '../../agent/types';
import { decideOperation } from './api';
import type { Operation } from './state';
import { agentThreadMessages, appendMessageText, storedMessages } from './thread';
import type { LiveRun } from './thread';
import type { AgentRunControls } from './useAgentRun';
import { RunRejectedError } from './useAgentRun';

interface AgentRuntimeOptions {
  conversation: Conversation | undefined;
  run: AgentRunControls;
  /** Sending is refused (demo, no target, a decision open); typing stays possible. */
  isSendDisabled: boolean;
  isDisabled: boolean;
  /** A message the server refused before accepting: the composer takes it back. */
  onRejected: (text: string, code: string) => void;
  /** An operation the operator just decided; the page records it and continues the run. */
  onDecided: (operation: Operation) => void;
}

/**
 * The ExternalStore adapter: the only module that knows assistant-ui's runtime API (ADR 0041).
 *
 * OMC's own state - the stored conversation and the live run's frame - is converted to messages
 * here and handed to the framework to render; every action the framework offers comes back
 * through a callback into OMC's code. A new message, a stop, an approval, an answer: each one
 * lands in `useAgentRun` or on the decision endpoint, never in state the framework owns.
 */
export function useAgentThreadRuntime({ conversation, run, isSendDisabled, isDisabled, onRejected, onDecided }: AgentRuntimeOptions): AssistantRuntime {
  const callbacksRef = React.useRef({ run, onRejected, onDecided });
  callbacksRef.current = { run, onRejected, onDecided };

  // Messages sent while a run is in flight wait here and go out, in order, once it settles. The
  // server still runs one turn at a time; the queue is only what lets the operator keep typing.
  const queue = React.useMemo(() => createMessageQueue({
    run: message => {
      const text = appendMessageText(message);
      void callbacksRef.current.run.send(text)
        .catch((cause: unknown) => {
          if (cause instanceof RunRejectedError) {
            // A refusal is likely to refuse the next message for the same reason, so the queue
            // pauses rather than draining into the same wall.
            queue.notifyCancelled();
            callbacksRef.current.onRejected(cause.text, cause.code);
          }
        });
    },
    cancel: () => callbacksRef.current.run.stop(),
  }), []);

  // The queue follows the run's own edges, whoever started it: a resumption holds queued messages
  // back exactly as a queued send does, and the next one goes out when either settles.
  const wasRunningRef = React.useRef(false);
  React.useEffect(() => {
    if (run.isRunning && !wasRunningRef.current) queue.notifyBusy();
    if (!run.isRunning && wasRunningRef.current) queue.notifyIdle();
    wasRunningRef.current = run.isRunning;
  }, [run.isRunning, queue]);

  const turns = conversation?.turns;
  const stored = React.useMemo(() => storedMessages(turns ?? []), [turns]);
  const live = React.useMemo<LiveRun | undefined>(
    () => (run.isRunning ? { frame: run.frame, pendingMessage: run.pendingMessage, isResuming: run.isResuming } : undefined),
    [run.isRunning, run.frame, run.pendingMessage, run.isResuming],
  );
  const messages = React.useMemo(() => agentThreadMessages(conversation, stored, live), [conversation, stored, live]);

  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: message => message,
    isRunning: run.isRunning,
    isDisabled,
    isSendDisabled,
    queue: queue.adapter,
    onNew: async message => {
      queue.adapter.enqueue(message);
    },
    onCancel: async () => {
      callbacksRef.current.run.stop();
    },
    // An approval is decided on the console's own decision endpoint; the secret, when the
    // operation asks for one, goes there and nowhere else - never into a run request.
    onRespondToToolApproval: async ({ approvalId, approved, text }) => {
      const operation = await decideOperation(approvalId, approved, approved && text ? { secret: text } : {});
      callbacksRef.current.onDecided(operation);
    },
    // A question is answered by the question panel through the same endpoint; the panel hands the
    // decided operation back here so the run continues through one path.
    onResumeToolCall: ({ payload }) => {
      const operation = (payload as { operation?: Operation } | undefined)?.operation;
      if (operation) callbacksRef.current.onDecided(operation);
    },
  });
}
