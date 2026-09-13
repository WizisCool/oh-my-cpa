/**
 * Parsing the provider list's own row ids back into the family and position the
 * status endpoint takes.
 *
 * The list id is a *display* key, and for the OpenAI-compatible family CPA's
 * positional shorthand (`openai-compat`) is not the family name the API uses
 * (`openai-compatibility`). A toggle that forwarded the shorthand would be
 * rejected as an unsupported family, so this mapping is load-bearing and is
 * pinned by a test rather than left to sit inline in the page.
 */

/** The family each list-id prefix addresses, in the API's own spelling. */
export const FAMILY_BY_PROVIDER_ID_PREFIX: Record<string, string> = {
  'openai-compat': 'openai-compatibility',
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini',
};

export interface ProviderID {
  family: string;
  index: number;
}

/**
 * parseProviderID splits an id such as `openai-compat-3`.
 *
 * Returns `undefined` for anything it cannot address, so the caller fails loudly
 * instead of sending a request against a family that does not exist. The index is
 * taken from the last segment rather than a fixed offset, so a future prefix
 * containing a dash still parses, and it is matched as digits rather than passed
 * through `Number`: `Number('')` is `0`, so a trailing dash would otherwise parse
 * as position zero and toggle a provider nobody named.
 */
export function parseProviderID(id: string): ProviderID | undefined {
  const separator = id.lastIndexOf('-');
  if (separator <= 0) return undefined;
  const family = FAMILY_BY_PROVIDER_ID_PREFIX[id.slice(0, separator)];
  if (!family) return undefined;
  const rawIndex = id.slice(separator + 1);
  if (!/^\d+$/.test(rawIndex)) return undefined;
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index)) return undefined;
  return { family, index };
}

/** The body `PATCH /management/providers/status` takes. */
export interface ProviderStatusPayload {
  family: string;
  index: number;
  disabled: boolean;
}

/**
 * providerStatusPayload converts a row's *enabled* state into the request that
 * switches it.
 *
 * The control and the queue reason in "is this provider on"; the endpoint takes
 * the opposite field. Keeping the inversion here, in one named place, is what
 * stops the two from being confused for each other - the confusion inverts every
 * toggle, so switching a provider off would ask for it to be switched on, and the
 * request succeeds while doing the reverse of what was clicked.
 *
 * Returns undefined when the id cannot be addressed, so the caller fails loudly
 * rather than writing to a provider nobody named.
 */
export function providerStatusPayload(
  id: string,
  isEnabled: boolean,
): ProviderStatusPayload | undefined {
  const parsed = parseProviderID(id);
  if (!parsed) return undefined;
  return { family: parsed.family, index: parsed.index, disabled: !isEnabled };
}
