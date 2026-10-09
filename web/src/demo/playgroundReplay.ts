import type { ChatRequest, StreamEvent } from '../pages/playground/state';
import { PLAYGROUND_EVENT_TYPES } from '../pages/playground/state';
import { answerChunkSize, chunkText, recordingLanguage, REPLAY_FRAME_MS, REPLAY_ROUND_PAUSE_MS, wallClockPace } from './pacing';
import type { Pace } from './pacing';
import recording from './playgroundRecording.json';

const THOUGHT_CHUNK = 14;

/**
 * Replays the recorded Playground answer as the events a live request streams (ADR 0092).
 *
 * The same idea as the Agent's replay: the demonstration calls no model, so this stands where
 * the chat request does and delivers the facade's own event vocabulary - the request's start,
 * reasoning, answer deltas, usage and the end - for the page's reducer to fold. The page decides
 * which message has a recording; this only plays it, for the model the visitor selected.
 */
export async function replayPlaygroundChat(
  request: ChatRequest,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
  language: string | undefined,
  pace: Pace = wallClockPace,
): Promise<void> {
  const emit = (event: StreamEvent) => {
    // The live path refuses an event outside the facade's vocabulary, and so does the replay.
    if (!(PLAYGROUND_EVENT_TYPES as readonly string[]).includes(event.type)) throw new Error('invalid_gateway_response');
    onEvent(event);
  };
  const recorded = recordingLanguage(language);
  const startedAtMS = Date.now();
  emit({ type: 'meta', model: request.model, started_at_ms: startedAtMS });
  await pace(REPLAY_ROUND_PAUSE_MS, signal);
  for (const content of chunkText(recording.thought, THOUGHT_CHUNK)) {
    emit({ type: 'thought', content });
    await pace(REPLAY_FRAME_MS, signal);
  }
  const firstContentMS = Date.now() - startedAtMS;
  for (const content of chunkText(recording.reply[recorded], answerChunkSize(recorded))) {
    emit({ type: 'delta', content });
    await pace(REPLAY_FRAME_MS, signal);
  }
  emit({ type: 'usage', usage: recording.usage });
  emit({ type: 'done', finish_reason: 'stop', duration_ms: Date.now() - startedAtMS, first_content_ms: firstContentMS });
}
