/** Pure rules for importing a Google service-account key as a Vertex credential. */

/** MAX_VERTEX_KEY_BYTES is far above a real key (about 2.4 KB) and below the upload limit. */
export const MAX_VERTEX_KEY_BYTES = 64 * 1024;

export const DEFAULT_VERTEX_LOCATION = 'us-central1';

const LOCATION_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export type VertexKeyProblem = 'too_large' | 'not_json' | 'no_private_key' | 'no_project';

export interface VertexKeySummary {
  projectId: string;
  email: string;
}

export type VertexKeyReading =
  | { summary: VertexKeySummary; problem?: undefined }
  | { summary?: undefined; problem: VertexKeyProblem };

/**
 * readVertexKey names what a chosen file would be stored as, or why it cannot be.
 *
 * Only the project and the account's address are read out; the private key is checked
 * for presence and never returned, so nothing here can end up rendered or logged.
 */
export function readVertexKey(text: string): VertexKeyReading {
  if (new TextEncoder().encode(text).length > MAX_VERTEX_KEY_BYTES) return { problem: 'too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { problem: 'not_json' };
  const key = parsed as Record<string, unknown>;
  if (typeof key.private_key !== 'string' || key.private_key.trim() === '') return { problem: 'no_private_key' };
  const projectId = typeof key.project_id === 'string' ? key.project_id.trim() : '';
  if (!projectId) return { problem: 'no_project' };
  return { summary: { projectId, email: typeof key.client_email === 'string' ? key.client_email.trim() : '' } };
}

/** An empty location is valid: the gateway then stores its default region. */
export function isValidVertexLocation(location: string): boolean {
  const trimmed = location.trim();
  return trimmed === '' || LOCATION_PATTERN.test(trimmed);
}
