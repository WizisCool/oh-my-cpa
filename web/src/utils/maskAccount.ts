export const ACCOUNT_MASK = '•••';

/**
 * maskAccount hides who a credential belongs to while keeping it recognisable to its owner.
 *
 * An email keeps two leading characters and one trailing character of its local part, plus the whole
 * domain, because the provider and the first letters are how an operator tells their own accounts
 * apart. The filler has a constant length so the mask does not give away how long the name is.
 * Anything that is not an email (a Vertex project id) keeps three characters at the start and two at
 * the end, and a value too short to keep edges is hidden entirely.
 */
export function maskAccount(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const at = trimmed.lastIndexOf('@');
  if (at > 0 && at < trimmed.length - 1) {
    const local = Array.from(trimmed.slice(0, at));
    const head = local.length > 3 ? local.slice(0, 2).join('') + ACCOUNT_MASK + local.slice(-1).join('') : local.slice(0, 1).join('') + ACCOUNT_MASK;
    return `${head}${trimmed.slice(at)}`;
  }
  const runes = Array.from(trimmed);
  return runes.length >= 8 ? runes.slice(0, 3).join('') + ACCOUNT_MASK + runes.slice(-2).join('') : ACCOUNT_MASK;
}

/**
 * Masks every occurrence of the account inside a longer label, such as a file name built from it.
 *
 * The match ignores case: an address is case-insensitive, and CPA derives a file name from the
 * account as it received it, so a name that differs only in casing would otherwise print the
 * whole address. The visible edges and filler come from the account itself, so the same account
 * reads the same way whether it is the label or inside one.
 */
export function maskAccountIn(text: string, account: string): string {
  const trimmed = account.trim();
  if (!trimmed) return text;
  const mask = maskAccount(trimmed);
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A replacer function keeps a `$` in the mask from being read as a replacement pattern; a
  // local part may legally contain one.
  return text.replace(new RegExp(escaped, 'giu'), () => mask);
}

/** The local and domain shape an address is recognised by when the credential is not at hand. */
const ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

/**
 * Masks every address-shaped token in a label, for a surface holding the label but not the
 * credential that would name the address. A label with no address is left whole, so a gateway's
 * own name for a credential is not mangled while the credential read is pending or failed.
 * An address already carrying the mask is left as it is, so a caller may apply this after the
 * credential's own identities without masking the same name twice.
 */
export function maskEmailAddresses(text: string): string {
  return text.replace(ADDRESS, (address, offset: number, source: string) =>
    source[offset - 1] === ACCOUNT_MASK[0] ? address : maskAccount(address));
}
