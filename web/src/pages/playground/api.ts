import { ApiError } from '../../api/client';
import { reconnectRun } from '../../agent/reconnect';
import { PLAYGROUND_EVENT_TYPES } from './state';
import type { ChatRequest, StreamEvent } from './state';

export async function streamChat(request: ChatRequest, signal: AbortSignal, onEvent: (event: StreamEvent) => void, run: { id: string; turn?: unknown; replay: () => void; isRecovery?: boolean }): Promise<void> {
  const frames = reconnectRun({ workspace: 'playground', id: run.id, signal, replay: run.replay,
    ...(run.isRecovery ? {} : { initial: { method: 'POST', body: JSON.stringify({ ...request, recovery_turn: run.turn }) } }),
  });
  for await (const frame of frames) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!frame.event || !frame.data) continue;
    if (!(PLAYGROUND_EVENT_TYPES as readonly string[]).includes(frame.event)) throw new Error('invalid_gateway_response');
    const event = { ...JSON.parse(frame.data), type: frame.event } as StreamEvent;
    onEvent(event);
    if (event.type === 'done' || event.type === 'error') return;
  }
}
export function failureCode(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.data as { code?: string } | undefined)?.code;
    return code ?? (error.status === 401 ? 'session_expired' : 'gateway_unavailable');
  }
  return error instanceof Error ? error.message : 'gateway_unavailable';
}
