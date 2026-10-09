import type { Conversation } from '../agent/types';

/**
 * The demonstration's Agent conversation, for the life of the page.
 *
 * The demonstration's API is read-only, so the session it serves is always the empty one. A
 * replayed turn is kept here instead, and the session read returns it: without that, the first
 * refetch - a window regaining focus is enough - would replace the conversation a visitor is
 * reading with the empty one. Nothing is stored beyond the page; a reload starts over.
 */
let stored: Conversation | undefined;

export function readDemoConversation(): Conversation | undefined {
  return stored;
}

export function writeDemoConversation(conversation: Conversation): void {
  stored = conversation;
}

/** Starts over from the conversation given, keeping its identity and moving its revision on. */
export function resetDemoConversation(current: Conversation): Conversation {
  stored = { ...current, turns: [], omitted: 0, revision: current.revision + 1, active_run_id: undefined };
  return stored;
}

let question = '';

/** The replayable question as the page offers it in the reading language. */
export function readDemoQuestion(): string {
  return question;
}

export function writeDemoQuestion(text: string): void {
  question = text.trim();
}
