/**
 * How a replay is paced.
 *
 * A recording is drawn on the cadence of the run it was taken from - a pause while the model
 * thinks, text arriving a few characters at a time, a call that takes as long as it took - so
 * the transcript shows a run happening rather than a finished answer appearing. Tests pass a
 * pace that does not wait.
 */
export type Pace = (milliseconds: number, signal: AbortSignal) => Promise<void>;

/** Waits on the wall clock, and ends with the same `AbortError` a cancelled request raises. */
export const wallClockPace: Pace = (milliseconds, signal) => new Promise((resolve, reject) => {
  const abort = () => {
    clearTimeout(timer);
    reject(new DOMException('Aborted', 'AbortError'));
  };
  if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', abort);
    resolve();
  }, milliseconds);
  signal.addEventListener('abort', abort, { once: true });
});

/** Cuts text into deltas of whole characters, so a surrogate pair is never split across two. */
export function chunkText(text: string, size: number): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += size) chunks.push(characters.slice(index, index + size).join(''));
  return chunks;
}

export const REPLAY_FRAME_MS = 30;
/** The pause before a model round writes anything: the request is out and nothing is back yet. */
export const REPLAY_ROUND_PAUSE_MS = 550;
/** A call's floor, so one that took milliseconds is still seen running. */
export const REPLAY_CALL_FLOOR_MS = 420;

/** The languages a recording is written in; every other reading language takes the English one. */
export type RecordingLanguage = 'zh' | 'en';

export function recordingLanguage(language: string | undefined): RecordingLanguage {
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** Answer text per frame: Chinese carries more per character, so it is written fewer at a time. */
export function answerChunkSize(language: RecordingLanguage): number {
  return language === 'zh' ? 3 : 9;
}
