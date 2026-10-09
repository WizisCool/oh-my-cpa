import { EventType } from '@ag-ui/core';
import { buildRunInput, parseAgentEvent } from './protocol';
import type { AgentEvent, AgentRunRequest } from './protocol';
import { reconnectRun } from './reconnect';
import { isDemoMode } from '../types/demoMode';

/**
 * Posts a run and yields its events as they arrive.
 *
 * Built on the console's own request path, so authentication, the one error shape and the 401
 * hook stay where every other request has them. A frame this build cannot read ends the run with
 * `stream_incomplete` rather than being skipped, because a skipped event may be the interrupt the
 * operator has to answer.
 *
 * The demonstration calls no model: it replays a recorded run as the same events instead
 * (ADR 0092). The replay is loaded on demand, so a self-hosted console never fetches it.
 */
export async function* runAgent(request: AgentRunRequest, signal: AbortSignal, replay: () => void = () => {}, isRecovery = false): AsyncGenerator<AgentEvent> {
  if (isDemoMode()) {
    const { replayAgentRun } = await import('../demo/agentReplay');
    yield* replayAgentRun(request, signal);
    return;
  }
  const frames = reconnectRun({ workspace: 'agent', id: request.runId, signal, replay,
    ...(isRecovery ? {} : { initial: { method: 'POST', body: JSON.stringify(buildRunInput(request)) } }),
  });
  for await (const frame of frames) {
    const event = parseAgentEvent(frame.data);
    if (!event) throw new Error('stream_incomplete');
    yield event;
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) return;
  }
}
