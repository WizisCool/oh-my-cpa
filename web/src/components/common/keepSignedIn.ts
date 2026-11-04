/**
 * "Keep me signed in" on the sign-in form.
 *
 * Ticked, the server issues the long session instead of the working-day one (see
 * `auth.RememberedSessionLifetime`). The key never leaves the form: what lasts is the HttpOnly
 * session cookie, and rotating the management key still ends it. What this module keeps in
 * `localStorage` is only the operator's last choice, so the box is ticked the way they left it.
 */
const KEEP_SIGNED_IN_KEY = 'omc_keep_signed_in';

export function readKeepSignedIn(): boolean {
  try {
    return window.localStorage.getItem(KEEP_SIGNED_IN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeKeepSignedIn(isKept: boolean): void {
  try {
    window.localStorage.setItem(KEEP_SIGNED_IN_KEY, String(isKept));
  } catch {
    // Blocked storage only forgets the choice; the sign-in itself is unaffected.
  }
}
