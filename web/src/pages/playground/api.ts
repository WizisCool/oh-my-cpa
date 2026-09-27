import { XStream } from '@ant-design/x-sdk';
import { requestResponse, ApiError } from '../../api/client';
import type { ChatRequest, StreamEvent } from './state';

export async function streamChat(request: ChatRequest, signal: AbortSignal, onEvent: (event: StreamEvent) => void): Promise<void> {
  const response = await requestResponse('/playground/chat', { method: 'POST', headers: { Accept: 'text/event-stream' }, body: JSON.stringify(request), signal });
  if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('invalid_gateway_response');
  let hasTerminalEvent = false;
  // XStream handles fragmented UTF-8 and SSE framing; OMC retains ownership of
  // authentication and cancellation instead of letting an SDK retry paid requests.
  for await (const frame of XStream({ readableStream: response.body })) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!frame.event || !frame.data) continue;
    if (!['meta', 'delta', 'thought', 'usage', 'done', 'error'].includes(frame.event)) throw new Error('invalid_gateway_response');
    const event = { ...JSON.parse(frame.data), type: frame.event } as StreamEvent;
    onEvent(event);
    if (event.type === 'done' || event.type === 'error') { hasTerminalEvent = true; break; }
  }
  if (!hasTerminalEvent) throw new Error('stream_incomplete');
}
export function failureCode(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.data as { code?: string } | undefined)?.code;
    return code ?? (error.status === 401 ? 'session_expired' : 'gateway_unavailable');
  }
  return error instanceof Error ? error.message : 'gateway_unavailable';
}
