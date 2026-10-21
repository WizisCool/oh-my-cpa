import type { FormHeaderItem } from './managementProviders';

/**
 * OpenCode identifies a conversation from the `x-opencode-session` request
 * header; without one, a request can be refused or lose the prompt-cache
 * affinity OpenCode pins per conversation. Its lanes differ only by base path
 * (`/zen/v1`, `/zen/go/v1`, `/inference/go/openai/v1`), so an endpoint is
 * recognized by host: a path list would be stale the next time OpenCode
 * publishes another lane.
 *
 * CPA expands `$CPA-SESSION-ID` inside a credential's custom headers into the
 * session identifier of the request it is serving, which is the value OpenCode
 * asks for. That makes the fix one stored header entry on the provider, not
 * per-request code in this console.
 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';
export const OPENCODE_SESSION_HEADER_VALUE = '$CPA-SESSION-ID';

const OPENCODE_HOST = 'opencode.ai';

/** Boundary on the dot, so a lookalike host such as `opencode.ai.example.test` is not OpenCode. */
function isOpenCodeHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');
  return host === OPENCODE_HOST || host.endsWith(`.${OPENCODE_HOST}`);
}

/**
 * True when the endpoint names an OpenCode host over HTTPS, whichever lane its
 * path selects. Anything that is not an absolute HTTPS URL stays unrecognized:
 * a base URL the save refuses is not a place to build guidance on.
 */
export function isOpenCodeEndpoint(baseURL: string): boolean {
  const trimmed = baseURL.trim();
  if (!trimmed) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && isOpenCodeHost(url.hostname.toLowerCase());
}

function isSessionHeader(row: { key: string }): boolean {
  return row.key.trim().toLowerCase() === OPENCODE_SESSION_HEADER;
}

/** Only a header carrying a value reaches OpenCode, so a blank row still counts as missing. */
export function hasOpenCodeSessionHeader(headers: FormHeaderItem[]): boolean {
  return headers.some((row) => isSessionHeader(row) && row.value.trim() !== '');
}

/**
 * Adds the session header to a draft, filling a blank row the operator already
 * started instead of leaving a second one behind, and leaving every other entry
 * alone. Idempotent: a filled `x-opencode-session` is the operator's own mapping
 * and is never overwritten.
 */
export function withOpenCodeSessionHeader(
  headers: FormHeaderItem[],
  newRowId: string,
): FormHeaderItem[] {
  if (hasOpenCodeSessionHeader(headers)) return headers;
  const blankIndex = headers.findIndex(isSessionHeader);
  if (blankIndex >= 0) {
    return headers.map((row, index) =>
      index === blankIndex ? { ...row, value: OPENCODE_SESSION_HEADER_VALUE } : row,
    );
  }
  return [
    ...headers,
    { id: newRowId, key: OPENCODE_SESSION_HEADER, value: OPENCODE_SESSION_HEADER_VALUE },
  ];
}
