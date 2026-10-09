export interface IDSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => void;
}

let fallbackIDCounter = 0;

function formatUUID(bytes: Uint8Array): string {
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * createID works on plain HTTP origins as well as secure origins. `randomUUID`
 * is restricted to a secure context, while `getRandomValues` is not; the final
 * fallback exists only for browsers that expose neither.
 */
export function createID(prefix = 'id', source: IDSource | undefined = typeof globalThis === 'undefined' ? undefined : globalThis.crypto): string {
  try {
    if (typeof source?.randomUUID === 'function') return source.randomUUID();
  } catch {
    // Fall through to the non-secure-context generator.
  }
  try {
    if (typeof source?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      source.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return formatUUID(bytes);
    }
  } catch {
    // Fall through to the timestamp/counter fallback.
  }
  fallbackIDCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIDCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
