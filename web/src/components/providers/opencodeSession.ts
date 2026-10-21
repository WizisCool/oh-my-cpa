import type { FormHeaderItem } from './managementProviders';

/**
 * OpenCode identifies a conversation by the `x-opencode-session` request header;
 * a request without one can be refused or lose the prompt-cache affinity pinned
 * per conversation. Its lanes differ only by base path, so the endpoint is
 * recognized by host and keeps working when OpenCode publishes another lane.
 *
 * CPA expands `$CPA-SESSION-ID` in a credential's custom headers into the session
 * id of the request it is serving, so the fix is one stored header entry.
 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';
export const OPENCODE_SESSION_HEADER_VALUE = '$CPA-SESSION-ID';

const OPENCODE_HOST = 'opencode.ai';

/** True for an absolute HTTPS URL on OpenCode's own host, whichever lane its path selects. */
export function isOpenCodeEndpoint(baseURL: string): boolean {
  const trimmed = baseURL.trim();
  if (!trimmed) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname.toLowerCase().replace(/\.$/, '') === OPENCODE_HOST;
}

function isSessionHeader(row: { key: string }): boolean {
  return row.key.trim().toLowerCase() === OPENCODE_SESSION_HEADER;
}

/**
 * What the header list currently says about the session header.
 *
 * The save writes one map entry per trimmed key and keeps the last row naming it,
 * while HTTP reads the header case-insensitively. A blank row after a filled one
 * therefore saves a blank value, and two spellings with different ids leave the
 * value this console cannot state. Both are `missing` or `conflict` here rather
 * than a mapping the editor pretends to see.
 */
export type OpenCodeSessionState = 'missing' | 'conflict' | 'mapped';

export function openCodeSessionState(headers: FormHeaderItem[]): OpenCodeSessionState {
  const values = new Set<string>();
  let hasBlankRow = false;
  for (const row of headers) {
    if (!isSessionHeader(row)) continue;
    const value = row.value.trim();
    if (value === '') hasBlankRow = true;
    else values.add(value);
  }
  if (values.size > 1) return 'conflict';
  if (values.size === 0 || hasBlankRow) return 'missing';
  return 'mapped';
}

/**
 * Gives every session-header row the one value the request should carry: the
 * operator's own id when they configured one, `$CPA-SESSION-ID` otherwise. A
 * blank row therefore cannot win on save, and unrelated headers are untouched.
 *
 * Two different configured ids are left exactly as they are - choosing between
 * them is the operator's decision, not this button's.
 */
export function withOpenCodeSessionHeader(
  headers: FormHeaderItem[],
  newRowId: string,
): FormHeaderItem[] {
  const state = openCodeSessionState(headers);
  if (state !== 'missing') return headers;
  const configured = headers.find((row) => isSessionHeader(row) && row.value.trim() !== '')?.value.trim();
  const value = configured ?? OPENCODE_SESSION_HEADER_VALUE;
  if (!headers.some(isSessionHeader)) {
    return [...headers, { id: newRowId, key: OPENCODE_SESSION_HEADER, value }];
  }
  return headers.map((row) => (isSessionHeader(row) ? { ...row, value } : row));
}
