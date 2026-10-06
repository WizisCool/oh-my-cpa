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

import type { ProviderBehaviorSwitch, ProviderModelOptionField } from './providers';

export interface ProviderFamilyMeta {
  /** CPA's family key, as sent to and received from the management API. */
  id: string;
  /** i18n key for the family's protocol label. */
  labelKey: string;
  /**
   * Brand colour for the family tag, as a 6-digit hex value.
   *
   * The renderer hands it to the stylesheet as `--family-color`, which mixes the
   * tag's border and fill from it over the page (`color-mix`), so the tint follows
   * the active palette's surface. These are
   * provider brand identities, not theme palette entries - like the brand colours
   * in `web/src/types/resource.ts`, they do not move with a preset, while the
   * theme's semantic colours (health, accent, surfaces) do.
   */
  color: string;
  /** Brand mark id resolved against the lobe icon catalog. */
  iconId: string;
  /**
   * Substrings that identify the family when only a protocol description or a
   * display name is at hand, e.g. a request record that predates the family tag.
   */
  protocolMatchers: string[];
  /**
   * Whether CPA keeps an entry of this family only when it carries a base URL.
   * CPA drops such an entry without an error, so the form requires the field
   * rather than letting a save report success for a row that never appears.
   */
  requiresBaseURL?: boolean;
  /**
   * Whether CPA's model entry for this family has the `image` flag that opens a
   * model to the image endpoints. Only the OpenAI-compatible model entry declares
   * it; CPA's other families decode their model lists strictly and refuse the
   * whole configuration when the key is present.
   */
  supportsModelImage?: boolean;
  /**
   * Whether CPA's entry for this family has request-scoped error rules, and which
   * request-behaviour switches it has. CPA decodes each family strictly, so the form
   * offers only these; the server holds the same table and refuses anything else
   * (`providerPolicyCapabilitiesFor` in `internal/api/management_provider_policy.go`).
   */
  supportsErrorRules?: boolean;
  behaviorSwitches?: ProviderBehaviorSwitch[];
  /**
   * The model settings this family's entry has beyond the ones every family shares. The server
   * holds the same table (`providerModelOptionFieldsFor` in
   * `internal/api/management_provider_model_options.go`).
   */
  modelOptionFields?: ProviderModelOptionField[];
}

/** In the order the provider list and the family picker present them. */
export const PROVIDER_FAMILIES: ProviderFamilyMeta[] = [
  {
    id: 'openai-compatibility',
    modelOptionFields: ['max_context_length', 'is_compat', 'modalities', 'use_max_completion_tokens'],
    labelKey: 'pro.family_openai_compat',
    color: '#10A37F',
    iconId: 'OpenAI',
    protocolMatchers: ['openai', 'chat completion'],
    supportsModelImage: true,
    supportsErrorRules: true,
    behaviorSwitches: ['support_prompt_cache_key'],
  },
  {
    id: 'codex',
    modelOptionFields: ['max_context_length', 'is_compat', 'support_configuration_update'],
    labelKey: 'pro.family_codex',
    color: '#60A5FA',
    iconId: 'Codex',
    protocolMatchers: ['response'],
    requiresBaseURL: true,
    supportsErrorRules: true,
    behaviorSwitches: ['alpha_search', 'codex_cloaking'],
  },
  {
    id: 'claude',
    modelOptionFields: ['max_context_length', 'is_compat'],
    labelKey: 'pro.family_claude',
    color: '#D97757',
    iconId: 'Anthropic',
    protocolMatchers: ['claude', 'anthropic', 'messages'],
    supportsErrorRules: true,
    behaviorSwitches: ['rebuild_mid_system_message'],
  },
  {
    id: 'gemini',
    modelOptionFields: ['max_context_length', 'is_compat'],
    labelKey: 'pro.family_gemini',
    color: '#A78BFA',
    iconId: 'Gemini',
    protocolMatchers: ['gemini', 'google'],
    supportsErrorRules: true,
  },
  {
    id: 'meta',
    modelOptionFields: ['max_context_length', 'is_compat', 'support_configuration_update'],
    labelKey: 'pro.family_meta',
    color: '#0866FF',
    iconId: 'Meta',
    protocolMatchers: ['meta muse', 'meta'],
    supportsErrorRules: true,
  },
  {
    id: 'xai',
    modelOptionFields: ['max_context_length', 'is_compat', 'support_configuration_update'],
    labelKey: 'pro.family_xai',
    color: '#A1A1AA',
    iconId: 'XAI',
    protocolMatchers: ['xai', 'grok'],
    requiresBaseURL: true,
    supportsErrorRules: true,
  },
  {
    id: 'vertex',
    labelKey: 'pro.family_vertex',
    color: '#4285F4',
    iconId: 'Google',
    protocolMatchers: ['vertex'],
  },
  {
    id: 'interactions',
    modelOptionFields: ['max_context_length', 'is_compat'],
    labelKey: 'pro.family_interactions',
    color: '#34A853',
    iconId: 'Gemini',
    protocolMatchers: ['interactions'],
    supportsErrorRules: true,
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
