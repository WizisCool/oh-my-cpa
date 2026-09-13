/**
 * Whether an operator-typed URL may be rendered as a link.
 *
 * This is the frontend half of the rule the provider save endpoint enforces
 * (`normalizeProviderWebsite` in `internal/api/management_providers.go`), and it
 * exists for the same reason: the value becomes an `href`, so the scheme is the
 * security boundary. A `javascript:` or `data:` URL would run script with the
 * session's authority, and a relative value would silently point at this console
 * instead of at the destination the operator meant.
 *
 * It is a validation for feedback, not the enforcement point. The server refuses
 * anything that is not an absolute http/https URL regardless of what arrives, so
 * a stale bundle or a hand-made request cannot widen what is stored.
 */
export function isSafeExternalURL(raw: string | null | undefined): boolean {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.hostname !== '';
}

/** The URL to render for a link target, or undefined when there is none. */
export function safeExternalURL(raw: string | null | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  return isSafeExternalURL(trimmed) ? trimmed : undefined;
}
