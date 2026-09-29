import { EventType } from '@ag-ui/core';
import { requestResponse } from '../api/client';
import { buildRunInput, parseAgentEvent } from './protocol';
import type { AgentEvent, AgentRunRequest } from './protocol';
import { readSSE } from './sse';

/**
 * Posts a run and yields its events as they arrive.
 *
 * Built on the console's own request path, so authentication, the one error shape and the 401
 * hook stay where every other request has them. A frame this build cannot read ends the run with
 * `stream_incomplete` rather than being skipped, because a skipped event may be the interrupt the
 * operator has to answer.
 */
export async function* runAgent(request: AgentRunRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const response = await requestResponse('/agent/run', {
    method: 'POST',
    headers: { Accept: 'text/event-stream' },
    body: JSON.stringify(buildRunInput(request)),
    signal,
  });
  if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
    throw new Error('invalid_stream');
  }
  for await (const frame of readSSE(response.body, signal)) {
    const event = parseAgentEvent(frame.data);
    if (!event) throw new Error('stream_incomplete');
    yield event;
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) return;
  }
}
