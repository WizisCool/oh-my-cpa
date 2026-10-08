import { ApiError, requestResponse } from '../../api/client';
import { observeServerClock } from '../../types/serverClock';
import type { Capability, Conversation, Operation, QuestionReply } from './state';

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
  const response = await requestResponse('/agent/session', { signal });
  // The turns below carry the server's timestamps; this is where its clock is read to count from them.
  observeServerClock(response);
  return response.json();
}

export async function resetSession(revision: number): Promise<Conversation> {
  return (await requestResponse('/agent/session/reset', { method: 'POST', body: JSON.stringify({ revision }) })).json();
}

export async function getOperation(id: string, signal?: AbortSignal): Promise<Operation> {
  return (await requestResponse(`/agent/operations/${encodeURIComponent(id)}`, { signal })).json();
}

/**
 * The operator's one decision on a prepared operation: allow or deny. A secret or an answer rides
 * along only when the operation asks for it.
 */
export async function decideOperation(id: string, approve: boolean, input: { secret?: string; answer?: { answers: QuestionReply[] } } = {}): Promise<Operation> {
  return (await requestResponse(`/agent/operations/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ approve, ...input }),
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

/**
 * The bytes of the images a conversation's turns reference, as data URLs keyed by image id. An
 * export embeds them so the file stands on its own; one that cannot be read is left out of the map
 * and of the export rather than failing it.
 */
export async function readTurnImages(turns: readonly { images?: readonly { id: string }[] }[]): Promise<Map<string, string>> {
  const read = new Map<string, string>();
  await Promise.all(turns.flatMap(turn => turn.images ?? []).map(async image => {
    try {
      const blob = await (await requestResponse(`/agent/images/${encodeURIComponent(image.id)}`)).blob();
      read.set(image.id, await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('image unreadable'));
        reader.readAsDataURL(blob);
      }));
    } catch {
      // Left out: the export says what the conversation holds, minus what could not be read.
    }
  }));
  return read;
}
