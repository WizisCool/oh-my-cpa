const ACCOUNT_MASK = '•••';

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

/** Masks every occurrence of the account inside a longer label, such as a file name built from it. */
export function maskAccountIn(text: string, account: string): string {
  const trimmed = account.trim();
  return trimmed ? text.split(trimmed).join(maskAccount(trimmed)) : text;
}
