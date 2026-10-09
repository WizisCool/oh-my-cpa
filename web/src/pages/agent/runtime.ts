import React from 'react';
import { createMessageQueue, useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, AssistantRuntime, AttachmentAdapter, ThreadMessageLike } from '@assistant-ui/react';
import type { Conversation, Presentation } from '../../agent/types';
import { decideOperation } from './api';
import type { Operation } from './state';
import { agentThreadMessages, appendMessageImages, appendMessageText, storedMessages } from './thread';
import type { LiveRun } from './thread';
import type { AgentRunControls } from './useAgentRun';
import { RunRejectedError } from './useAgentRun';

/** What a send carries beyond its text: the turn it replaces, that turn's files, the asked-for presentation. */
interface AgentSendOptions {
  turnID: string;
  files: string;
  present?: Presentation;
}

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
  /**
   * What the next sent message carries beyond its text: the turn it replaces when the operator is
   * editing one, the files that turn's message carried - which go out again after the new
   * wording - and the presentation a command asked for. Read, and cleared, as the message is
   * queued.
   */
  takeSendOptions: () => AgentSendOptions;
  /** What the composer may attach: images and text files. */
  attachments: AttachmentAdapter;
}

/**
 * The ExternalStore adapter: the only module that knows assistant-ui's runtime API (ADR 0041).
 *
 * OMC's own state - the stored conversation and the live run's frame - is converted to messages
 * here and handed to the framework to render; every action the framework offers comes back
 * through a callback into OMC's code. A new message, a stop, an approval, an answer: each one
 * lands in `useAgentRun` or on the decision endpoint, never in state the framework owns.
 */
export function useAgentThreadRuntime({ conversation, run, isSendDisabled, isDisabled, onRejected, onDecided, takeSendOptions, attachments }: AgentRuntimeOptions): AssistantRuntime {
  const callbacksRef = React.useRef({ run, onRejected, onDecided, takeSendOptions });
  callbacksRef.current = { run, onRejected, onDecided, takeSendOptions };

  // Messages sent while a run is in flight wait here and go out, in order, once it settles. The
  // server runs one turn at a time, so the queue never interrupts: it has no cancel to steer with,
  // and a send the framework would steer ahead of the run is queued behind it like any other.
  const queue = React.useMemo(() => {
    /**
     * What a queued message was sent with. The options ride on the message itself, so the send
     * that reached the queue with them is the send that goes out with them; the fallback covers a
     * message that arrived by a path of its own.
     */
    const carriedSendOptions = (message: AppendMessage): AgentSendOptions => {
      const carried = (message.metadata?.custom as { sendOptions?: AgentSendOptions } | undefined)?.sendOptions;
      return carried ?? callbacksRef.current.takeSendOptions();
    };
    const created = createMessageQueue({
      run: message => {
        const target = carriedSendOptions(message);
        const text = [appendMessageText(message), target.files].filter(Boolean).join('\n\n');
        void callbacksRef.current.run.send(text, { replaceTurn: target.turnID || undefined, present: target.present, images: appendMessageImages(message) })
          .catch((cause: unknown) => {
            if (cause instanceof RunRejectedError) {
              // A refusal is likely to refuse the next message for the same reason, so the queue
              // pauses rather than draining into the same wall.
              created.notifyCancelled();
              callbacksRef.current.onRejected(cause.text, cause.code);
            }
          });
      },
    });
    // A message's own options are read as it enters the queue, not when it is dispatched: a send
    // that waits behind a run must go out with what the composer held when the operator sent it,
    // not with whatever a later message left behind. `steer` shares the entry point, because the
    // server runs one turn at a time and a steered send waits its turn like any other.
    const stamp = (message: AppendMessage): AppendMessage => ({
      ...message,
      metadata: {
        ...message.metadata,
        custom: { ...message.metadata?.custom, sendOptions: callbacksRef.current.takeSendOptions() },
      },
    });
    const enqueue = (message: AppendMessage) => created.adapter.enqueue(stamp(message));
    // Inherits from the adapter rather than copying it: the queue rewrites the adapter's item
    // lists in place, and the runtime recognises its queue by identity of this one object.
    const adapter: typeof created.adapter = Object.create(created.adapter, {
      enqueue: { value: enqueue },
      steer: { value: enqueue },
    });
    return { ...created, adapter };
  }, []);

  // The runtime reads the queue's items when it is handed its options, so a change to the queue
  // has to re-render the page for the composer to show it.
  React.useSyncExternalStore(queue.subscribe, () => queue.adapter.items);

  // The queue follows the run's own edges, whoever started it: a resumption holds queued messages
  // back exactly as a queued send does, and the next one goes out when either settles.
  const wasRunningRef = React.useRef(false);
  React.useEffect(() => {
    if (run.isRunning && !wasRunningRef.current) queue.notifyBusy();
    if (!run.isRunning && wasRunningRef.current) queue.notifyIdle();
    wasRunningRef.current = run.isRunning;
  }, [run.isRunning, queue]);

  // A retried or edited message takes the newest turn's place, so that turn leaves the transcript
  // as soon as the run starts instead of standing above its own replacement. A refused run clears
  // the id, and the turn - which the server never dropped - is back.
  const replacedTurnID = run.isRunning ? run.replacedTurnID : '';
  const turns = React.useMemo(
    () => (replacedTurnID ? conversation?.turns.filter(turn => turn.id !== replacedTurnID) : conversation?.turns),
    [conversation?.turns, replacedTurnID],
  );
  const stored = React.useMemo(() => storedMessages(turns ?? []), [turns]);
  const live = React.useMemo<LiveRun | undefined>(
    () => (run.isRunning ? { frame: run.frame, pendingMessage: run.pendingMessage, pendingImages: run.pendingImages, replacedTurnID: run.replacedTurnID, isResuming: run.isResuming } : undefined),
    [run.isRunning, run.frame, run.pendingMessage, run.pendingImages, run.replacedTurnID, run.isResuming],
  );
  const messages = React.useMemo(() => agentThreadMessages(conversation, stored, live), [conversation, stored, live]);

  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: message => message,
    isRunning: run.isRunning,
    isDisabled,
    isSendDisabled,
    queue: queue.adapter,
    adapters: { attachments },
    // With a queue, the runtime hands every send to it; `onNew` is only the adapter's required
    // fallback and routes the same way.
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
