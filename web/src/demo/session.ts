import type { Conversation } from '../agent/types';

const CONVERSATION_STORAGE_KEY = 'omc-demo-agent-conversation:v1';

let stored: Conversation | undefined;

function isValidStoredConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.revision !== 'number') return false;
  if (!Array.isArray(record.turns)) return false;
  return record.turns.every(
    (turn) => typeof turn === 'object' && turn !== null && !Array.isArray(turn)
      && typeof (turn as Record<string, unknown>).id === 'string'
      && typeof (turn as Record<string, unknown>).user === 'string',
  );
}

function readPersistedConversation(): Conversation | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    if (typeof window.localStorage === 'undefined') return undefined;
    const raw = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isValidStoredConversation(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function persistConversation(conversation: Conversation | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    if (typeof window.localStorage === 'undefined') return;
    if (conversation) {
      window.localStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(conversation));
    } else {
      window.localStorage.removeItem(CONVERSATION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

export function readDemoConversation(): Conversation | undefined {
  if (!stored) stored = readPersistedConversation();
  return stored;
}

export function writeDemoConversation(conversation: Conversation): void {
  stored = conversation;
  persistConversation(conversation);
}

/** Starts over from the conversation given, keeping its identity and moving its revision on. */
export function resetDemoConversation(current: Conversation): Conversation {
  stored = { ...current, turns: [], omitted: 0, revision: current.revision + 1, active_run_id: undefined };
  persistConversation(stored);
  return stored;
}

export function clearDemoConversationStorage(): void {
  stored = undefined;
  persistConversation(undefined);
}

let question = '';

/** The replayable question as the page offers it in the reading language. */
export function readDemoQuestion(): string {
  return question;
}

export function writeDemoQuestion(text: string): void {
  question = text.trim();
}
