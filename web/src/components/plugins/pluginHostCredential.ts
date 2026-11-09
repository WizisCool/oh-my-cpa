/**
 * Where a plugin page written for CPAMC looks for the management credential.
 *
 * CPAMC keeps its connection state in browser storage under `cli-proxy-auth`, and the
 * plugins that embed into it read the credential from there. The console mirrors the
 * gateway credential into the same entry so those pages open signed in, exactly as they
 * do under CPAMC, instead of asking the operator for a key the console already holds.
 *
 * CPAMC stores that state obfuscated: the JSON is XORed with a host-scoped salt and
 * base64-encoded behind an `enc::v2::` prefix. CPAMC itself describes this as
 * "not a security boundary", only as a way to keep the value from being read at a
 * glance, so the console writes the same shape rather than inventing a second one.
 */
export const CPAMC_AUTH_STORAGE_KEY = 'cli-proxy-auth';

const CPAMC_OBFUSCATION_PREFIX = 'enc::v2::';
const CPAMC_OBFUSCATION_SALT = 'cli-proxy-api-webui::secure-storage';

/** The storage value CPAMC would hold for a remembered connection to this origin. */
export function cpamcAuthStorageValue(origin: string, managementKey: string): string {
  const state = { state: { apiBase: origin, managementKey, rememberPassword: true }, version: 0 };
  return CPAMC_OBFUSCATION_PREFIX + obfuscateBase64(JSON.stringify(state), `${CPAMC_OBFUSCATION_SALT}|${new URL(origin).host}`);
}

function obfuscateBase64(value: string, key: string): string {
  const data = new TextEncoder().encode(value);
  const keyBytes = new TextEncoder().encode(key);
  let binary = '';
  for (let index = 0; index < data.length; index += 1) {
    binary += String.fromCharCode(data[index] ^ keyBytes[index % keyBytes.length]);
  }
  return btoa(binary);
}

type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;

/** Writes the console's gateway credential where a CPAMC-native plugin page reads it. */
export function mirrorCPAMCCredential(storage: WritableStorage, origin: string, managementKey: string): void {
  if (!managementKey) {
    storage.removeItem(CPAMC_AUTH_STORAGE_KEY);
    return;
  }
  storage.setItem(CPAMC_AUTH_STORAGE_KEY, cpamcAuthStorageValue(origin, managementKey));
}

/** Withdraws the mirrored credential when the console session ends. */
export function clearMirroredCPAMCCredential(): void {
  try {
    window.localStorage.removeItem(CPAMC_AUTH_STORAGE_KEY);
  } catch {
    // A browser that blocks storage cannot be holding the mirrored credential either.
  }
}
