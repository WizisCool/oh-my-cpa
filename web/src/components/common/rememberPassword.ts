/**
 * "Remember password" on the sign-in form.
 *
 * The management key is never written to page storage: the only store allowed to keep it is the
 * browser's own password manager, which encrypts it, scopes it to this origin and asks the person
 * before saving. What this module remembers in `localStorage` is the operator's choice, a boolean.
 *
 * Checked, the form identifies itself as a sign-in form (a fixed username plus `current-password`)
 * so every browser's manager offers to save and autofill it, and Chromium is handed the credential
 * directly after a successful sign-in, because an SPA that never navigates is easy for its
 * heuristics to miss. Unchecked, the form stops identifying itself and nothing is handed over; a
 * browser may still ask on its own, and the person can decline there.
 */
const REMEMBER_PASSWORD_KEY = 'omc_sign_in_remember';

/** The account name a password manager lists the key under. One per origin, never localized. */
export const PASSWORD_MANAGER_ACCOUNT = 'management-key';

export function readRememberPassword(): boolean {
  try {
    return window.localStorage.getItem(REMEMBER_PASSWORD_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeRememberPassword(isRemembered: boolean): void {
  try {
    window.localStorage.setItem(REMEMBER_PASSWORD_KEY, String(isRemembered));
  } catch {
    // Blocked storage only forgets the choice; the sign-in itself is unaffected.
  }
}

// The Credential Management password type ships only in Chromium, so lib.dom does not declare it.
type PasswordCredentialConstructor = new (data: { id: string; password: string; name?: string }) => Credential;

/** Hands a key that has just signed in to the browser's password manager, where one accepts it. */
export async function offerToPasswordManager(password: string, appName: string): Promise<void> {
  const Constructor = (window as unknown as { PasswordCredential?: PasswordCredentialConstructor }).PasswordCredential;
  if (!Constructor || !navigator.credentials?.store) return;
  try {
    await navigator.credentials.store(new Constructor({ id: PASSWORD_MANAGER_ACCOUNT, password, name: appName }));
  } catch {
    // The person dismissed the prompt or the manager is disabled by policy; both are their call.
  }
}
