/** Pure rules for storing a pasted credential JSON as an auth file. */

/** Mirrors the gateway's auth file name limit (managementAuthFileNameLimit). */
const MAX_AUTH_FILE_NAME_LENGTH = 255;

export interface PastedAuthSummary {
  type: string;
  email: string;
  suggestedName: string;
}

export type PastedAuthReading =
  | { summary: PastedAuthSummary; isObject?: undefined }
  | { summary?: undefined; isObject: false };

function readField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Replaces what the gateway refuses in a name (path separators, colons, control characters) and whitespace. */
function nameSegment(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\s/\\:\u0000-\u001f\u007f]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * suggestAuthFileName follows CPA's `<type>-<email>.json` naming so a pasted credential
 * lands where a login would have put it. `now` disambiguates a credential without an
 * address, so pasting two of them does not silently replace the first.
 */
export function suggestAuthFileName(type: string, email: string, now: Date): string {
  const parts = [nameSegment(type) || 'auth', nameSegment(email) || String(now.getTime())];
  const stem = parts.join('-').slice(0, MAX_AUTH_FILE_NAME_LENGTH - '.json'.length);
  return `${stem}.json`;
}

/**
 * readPastedAuthJson names what pasted text would be stored as, or reports that it cannot be.
 *
 * Only the provider type and the account's address are read out; token fields are never
 * returned, so nothing here can end up rendered or logged.
 */
export function readPastedAuthJson(text: string, now: Date = new Date()): PastedAuthReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { isObject: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { isObject: false };
  const record = parsed as Record<string, unknown>;
  const type = readField(record, 'type');
  const email = readField(record, 'email');
  return { summary: { type, email, suggestedName: suggestAuthFileName(type, email, now) } };
}

/** Normalises an edited name the way the gateway reads it, adding the required extension. */
export function normalizeAuthFileName(raw: string): string {
  const name = raw.trim();
  if (!name) return '';
  return name.toLowerCase().endsWith('.json') ? name : `${name}.json`;
}

/** Reports whether the gateway would accept the name as an auth file selector. */
export function isValidAuthFileName(name: string): boolean {
  if (!name || name === '.json' || [...name].length > MAX_AUTH_FILE_NAME_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  return !/[/\\:\u0000-\u001f\u007f]/.test(name);
}
