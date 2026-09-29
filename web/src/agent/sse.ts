/** One server-sent event: its name when it has one, and its data lines joined. */
export interface SSEFrame {
  event?: string;
  data: string;
}

/**
 * Reads a server-sent-event stream frame by frame.
 *
 * Network chunks split anywhere - inside a multi-byte character, inside a line, between the two
 * newlines that end a frame - so bytes are decoded in streaming mode and lines are only read once
 * complete. Comments (keepalives) and frames without data are skipped; the `id` and `retry` fields
 * are ignored because neither console stream reconnects: a dropped run is re-read from the server's
 * stored state, never replayed.
 */
export async function* readSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SSEFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = (): SSEFrame | undefined => {
    const frame = data.length > 0 ? { ...(event ? { event } : {}), data: data.join('\n') } : undefined;
    event = undefined;
    data = [];
    return frame;
  };
  const readLine = (line: string): SSEFrame | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    return undefined;
  };
  let isFinished = false;
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r\n|\r|\n/);
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        const width = buffer.startsWith('\r\n', newline) ? 2 : 1;
        // A lone CR at the very end may be the first half of a CRLF still in flight.
        if (!done && width === 1 && buffer[newline] === '\r' && newline === buffer.length - 1) break;
        buffer = buffer.slice(newline + width);
        const frame = readLine(line);
        if (frame) yield frame;
        newline = buffer.search(/\r\n|\r|\n/);
      }
      if (done) {
        isFinished = true;
        if (buffer) {
          const frame = readLine(buffer);
          if (frame) yield frame;
          buffer = '';
        }
        return;
      }
    }
  } finally {
    // A consumer that stops early - a terminal event, an abort - releases the body rather than
    // leaving the connection draining into nothing.
    if (isFinished) reader.releaseLock();
    else void reader.cancel().catch(() => undefined);
  }
}
