import { readSSE } from './sse';
import type { SSEFrame } from './sse';

function failureStatus(error: unknown): number | undefined {
  return error instanceof Error && error.name === 'ApiError' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}

export function isConnectionFailure(error: unknown): boolean {
  const status = failureStatus(error);
  // A coded facade error is a completed refusal, not a broken socket. Replaying its journal
  // would reproduce that same error forever rather than recover a running request.
  if (status !== undefined && status !== 0 && error instanceof Error && 'data' in error &&
      typeof error.data === 'object' && error.data !== null && 'code' in error.data && typeof error.data.code === 'string') return false;
  return error instanceof TypeError || status === 0 || status !== undefined && (status >= 500 || status === 408 || status === 429);
}

export interface BrowserRun<T = unknown> {
  id: string;
  started_at_ms: number;
  is_running: boolean;
  request?: T;
}

type ResponseRequest = (path: string, options?: RequestInit) => Promise<Response>;

export function createRunConnection(requestResponse: ResponseRequest) {
  async function currentRun<T>(workspace: string, signal?: AbortSignal): Promise<BrowserRun<T> | undefined> {
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 45_000);
    try {
      const response = await requestResponse(`/${workspace}/runs/active`, { signal: connection.signal });
      const body = await response.json() as { run?: BrowserRun<T> | null };
      return body.run ?? undefined;
    } catch (error) {
      if (connection.signal.aborted && !signal?.aborted) throw new TypeError('run_discovery_idle');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      connection.abort();
    }
  }

  function waitForConnection(signal: AbortSignal, delay: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('online', finish); signal.removeEventListener('abort', abort); };
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
      if (signal.aborted) { abort(); return; }
      window.addEventListener('online', finish, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      if (navigator.onLine) timer = setTimeout(finish, delay);
    });
  }

  /** Retry a subscription, never a generation. Acceptance of a lost POST is unknown, so it is
   * followed only by GETs. A missing journal never starts a replacement paid task. */
  async function* reconnectRun(options: {
    workspace: string;
    id: string;
    signal: AbortSignal;
    initial?: RequestInit;
    replay: () => void;
    waitForRetry?: (signal: AbortSignal, delay: number) => Promise<void>;
  }): AsyncGenerator<SSEFrame> {
    let shouldPost = !!options.initial;
    let attempt = 0;
    while (!options.signal.aborted) {
      const connection = new AbortController();
      const abort = () => connection.abort();
      options.signal.addEventListener('abort', abort, { once: true });
      const headerTimeout = setTimeout(abort, 45_000);
      try {
        const isInitialPost = shouldPost;
        shouldPost = false;
        const response = await requestResponse(isInitialPost ? `/${options.workspace}/${options.workspace === 'agent' ? 'run' : 'chat'}` : `/${options.workspace}/runs/${encodeURIComponent(options.id)}`, {
          ...(isInitialPost ? options.initial : {}),
          headers: { Accept: 'text/event-stream', ...(isInitialPost ? options.initial?.headers : {}), 'X-OMC-Run-ID': options.id },
          signal: connection.signal,
        });
        clearTimeout(headerTimeout);
        if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new TypeError('invalid_stream');
        if (attempt > 0 || !options.initial) options.replay();
        shouldPost = false;
        for await (const frame of readSSE(response.body, connection.signal, 45_000)) {
          yield frame;
          if (frame.event === 'done' || frame.event === 'error') return;
          try {
            const event = JSON.parse(frame.data) as { type?: string };
            if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') return;
          } catch { /* The protocol parser reports malformed frames to its caller. */ }
        }
      } catch (error) {
        if (options.signal.aborted) throw error;
        if (!connection.signal.aborted && !isConnectionFailure(error)) throw error;
      } finally {
        clearTimeout(headerTimeout);
        options.signal.removeEventListener('abort', abort);
        connection.abort();
      }
      attempt += 1;
      await (options.waitForRetry ?? waitForConnection)(options.signal, Math.min(500 * 2 ** Math.min(attempt - 1, 4), 8000));
    }
    throw new DOMException('Aborted', 'AbortError');
  }

  /** Stop is a server command. Losing its response retries only this idempotent cancellation;
   * aborting an HTTP subscriber alone never means that an upstream request was cancelled. */
  async function cancelRun(workspace: string, id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await requestResponse(`/${workspace}/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal });
        return;
      } catch (error) {
// Stop may beat POST admission. A truly lost journal ends its subscription, whose
        // signal also ends these retries; returning at the first 404 could leave work running.
        if (failureStatus(error) !== 404 && !isConnectionFailure(error)) throw error;
        await waitForConnection(signal, 500);
      }
    }
  }

  /** Discovery is retried only on connectivity failures, and is aborted with the view. */
  async function discoverRun<T>(workspace: string, signal: AbortSignal): Promise<BrowserRun<T> | undefined> {
    let attempt = 0;
    while (!signal.aborted) {
      try { return await currentRun<T>(workspace, signal); }
      catch (error) {
        if (signal.aborted || !isConnectionFailure(error)) throw error;
        await waitForConnection(signal, Math.min(500 * 2 ** Math.min(attempt++, 4), 8000));
      }
    }
    throw new DOMException('Aborted', 'AbortError');
  }

  return { currentRun, reconnectRun, cancelRun, discoverRun };
}
