import { ApiError, requestResponse } from '../../api/client';
import type { Capability, Conversation, Operation } from './state';

/**
 * The Agent page's own endpoint surface.
 *
 * Declared beside the page rather than added to `api/client.ts` because these routes are the
 * agent's runtime protocol - a stream, a session document, and approval decisions - not the
 * console's management API. They still go through `requestResponse`, so authentication,
 * one-error-shape handling and the 401 hook stay in one place. Requests the console already
 * declares (client keys, the gateway model directory) are read through `api` instead of being
 * restated here.
 */

export async function getSession(signal?: AbortSignal): Promise<Conversation> {
  return (await requestResponse('/agent/session', { signal })).json();
}

export async function resetSession(revision: number): Promise<Conversation> {
  return (await requestResponse('/agent/session/reset', { method: 'POST', body: JSON.stringify({ revision }) })).json();
}

export async function getOperation(id: string, signal?: AbortSignal): Promise<Operation> {
  return (await requestResponse(`/agent/operations/${encodeURIComponent(id)}`, { signal })).json();
}

export async function decideOperation(id: string, approve: boolean, challenge: string, secret: string): Promise<Operation> {
  return (await requestResponse(`/agent/operations/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ approve, challenge, secret }),
  })).json();
}

export async function startOperationOAuth(id: string): Promise<{ url: string; user_code: string }> {
  return (await requestResponse(`/agent/operations/${encodeURIComponent(id)}/oauth`, {
    method: 'POST',
    body: JSON.stringify({}),
  })).json();
}

/**
 * The registry as the signed-in operator sees it.
 *
 * The same list the agent's model is offered, which is the point: an operator approving a
 * destructive step should be reading the capabilities the agent actually holds, not a
 * hand-written summary that can drift from the written registry.
 */
/**
 * The code behind a rejected request.
 *
 * The agent's error vocabulary is its own: its rejections come from the runtime and the
 * executor, not from the gateway's chat surface, so the mapping back to a sentence lives with
 * the requests that produce those codes rather than in the pure presentation module.
 */
export function failureCode(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.data as { code?: string } | undefined)?.code;
    return code ?? (error.status === 401 ? 'session_expired' : 'gateway_unavailable');
  }
  return error instanceof Error ? error.message : 'gateway_unavailable';
}

export async function getCapabilities(signal?: AbortSignal): Promise<Capability[]> {
  const body = await (await requestResponse('/capabilities', { signal })).json() as { capabilities?: Capability[] };
  return body.capabilities ?? [];
}
