/**
 * The provider families the console manages, and the presentation constants each
 * one carries.
 *
 * The family is the console's own grouping: it decides the row's localized
 * protocol label, its brand colour and mark, and which family the add/edit form
 * writes to. Keeping it as one table means a new family is a row here plus its
 * i18n label, rather than another branch in the provider list, the protocol
 * resolver and the form's options at once.
 *
 * The ids must match the families CPA exposes as credential lists (see
 * `internal/api/management_providers.go`).
 */

export interface ProviderFamilyMeta {
  /** CPA's family key, as sent to and received from the management API. */
  id: string;
  /** i18n key for the family's protocol label. */
  labelKey: string;
  /** Brand colour used for the family tag. */
  color: string;
  /** Brand mark id resolved against the lobe icon catalog. */
  iconId: string;
  /**
   * Substrings that identify the family when only a protocol description or a
   * display name is at hand, e.g. a request record that predates the family tag.
   */
  protocolMatchers: string[];
}

/** In the order the provider list and the family picker present them. */
export const PROVIDER_FAMILIES: ProviderFamilyMeta[] = [
  {
    id: 'openai-compatibility',
    labelKey: 'pro.family_openai_compat',
    color: '#10A37F',
    iconId: 'OpenAI',
    protocolMatchers: ['openai', 'chat completion'],
  },
  {
    id: 'codex',
    labelKey: 'pro.family_codex',
    color: '#60A5FA',
    iconId: 'Codex',
    protocolMatchers: ['response'],
  },
  {
    id: 'claude',
    labelKey: 'pro.family_claude',
    color: '#D97757',
    iconId: 'Anthropic',
    protocolMatchers: ['claude', 'anthropic', 'messages'],
  },
  {
    id: 'gemini',
    labelKey: 'pro.family_gemini',
    color: '#A78BFA',
    iconId: 'Gemini',
    protocolMatchers: ['gemini', 'google'],
  },
  {
    id: 'meta',
    labelKey: 'pro.family_meta',
    color: '#0866FF',
    iconId: 'Meta',
    protocolMatchers: ['meta muse', 'meta'],
  },
];

const FAMILIES_BY_ID = new Map(PROVIDER_FAMILIES.map((family) => [family.id, family]));

/** lookupProviderFamily resolves an exact family id. */
export function lookupProviderFamily(family: string | undefined): ProviderFamilyMeta | undefined {
  return FAMILIES_BY_ID.get((family ?? '').toLowerCase().trim());
}

/**
 * matchProviderFamily resolves a family from a family id, a protocol
 * description or a display name, in that order of confidence.
 *
 * The exact id wins outright, because a family tag CPA sent is authoritative
 * while a matcher is a guess. Matchers exist for the rows that carry no family
 * tag at all - a usage record names the protocol it was served over, not the
 * credential family behind it.
 */
export function matchProviderFamily(family?: string, protocol?: string): ProviderFamilyMeta | undefined {
  const exact = lookupProviderFamily(family);
  if (exact) return exact;

  const familyText = (family ?? '').toLowerCase().trim();
  const protocolText = (protocol ?? '').toLowerCase().trim();
  if (!familyText && !protocolText) return undefined;

  for (const candidate of PROVIDER_FAMILIES) {
    for (const matcher of candidate.protocolMatchers) {
      if (familyText.includes(matcher) || protocolText.includes(matcher)) {
        return candidate;
      }
    }
  }
  return undefined;
}
