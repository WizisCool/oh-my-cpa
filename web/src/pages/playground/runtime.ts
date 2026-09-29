import React from 'react';
import { useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, AssistantRuntime, AttachmentAdapter, ThreadMessageLike } from '@assistant-ui/react';
import { extractThinking } from './state';
import type { Turn } from './state';

/** The stored Playground turn a message was made from, for its own views to read. */
export interface PlaygroundMessageCustom {
  turn: Turn;
  [key: string]: unknown;
}

function messageStatus(turn: Turn): NonNullable<ThreadMessageLike['status']> {
  switch (turn.status) {
    case 'running':
      return { type: 'running' };
    case 'success':
      return { type: 'complete', reason: 'stop' };
    case 'cancelled':
      return { type: 'incomplete', reason: 'cancelled' };
    default:
      return { type: 'incomplete', reason: 'error', error: turn.error?.code ?? 'gateway_unavailable' };
  }
}

/**
 * The Playground's turns as assistant-ui messages.
 *
 * The turn - request snapshot, stream events, timings - stays the Playground's own; the messages
 * carry it in their metadata for the views, plus the plain text the framework's copy action reads.
 * Ids are the turn's, so a streaming answer keeps its message while it grows.
 */
export function playgroundMessages(turns: Turn[]): ThreadMessageLike[] {
  return turns.flatMap(turn => {
    const text = turn.user.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n');
    const reply = turn.thought !== undefined ? turn.reply : extractThinking(turn.reply).reply;
    return [
      { id: `${turn.id}:user`, role: 'user' as const, content: [{ type: 'text' as const, text }], metadata: { custom: { turn } satisfies PlaygroundMessageCustom } },
      {
        id: `${turn.id}:assistant`,
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: reply }],
        status: messageStatus(turn),
        metadata: { custom: { turn } satisfies PlaygroundMessageCustom },
      },
    ];
  });
}

/** The text and images a composer submission carries. */
export function submissionContent(message: AppendMessage): { text: string; images: string[] } {
  const text = message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n');
  const images = (message.attachments ?? []).flatMap(attachment => (attachment.content ?? []).flatMap(part => (part.type === 'image' ? [part.image] : [])));
  return { text, images };
}

interface PlaygroundRuntimeOptions {
  turns: Turn[];
  isRunning: boolean;
  isDisabled: boolean;
  isSendDisabled: boolean;
  attachments: AttachmentAdapter;
  onSend: (text: string, images: string[]) => void;
  onReload: () => void;
  onEdit: (text: string) => void;
  onCancel: () => void;
}

/**
 * The Playground's ExternalStore adapter. Sending, regenerating and editing the last message all
 * land in `usePlaygroundRun`, which keeps its one-request-at-a-time rule and its OpenAI-shaped
 * protocol; the framework only renders and routes the operator's actions.
 */
export function usePlaygroundThreadRuntime(options: PlaygroundRuntimeOptions): AssistantRuntime {
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const messages = React.useMemo(() => playgroundMessages(options.turns), [options.turns]);
  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: message => message,
    isRunning: options.isRunning,
    isDisabled: options.isDisabled,
    isSendDisabled: options.isSendDisabled,
    adapters: { attachments: options.attachments },
    onNew: async message => {
      const { text, images } = submissionContent(message);
      optionsRef.current.onSend(text, images);
    },
    onReload: async () => {
      optionsRef.current.onReload();
    },
    onEdit: async message => {
      optionsRef.current.onEdit(submissionContent(message).text);
    },
    onCancel: async () => {
      optionsRef.current.onCancel();
    },
  });
}
