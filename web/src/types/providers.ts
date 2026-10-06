export interface ClientAPIKeyItem {
  index: number;
  /** The key's display mask, or the key itself for a reader that opted in to the
   *  values (`?include_keys=true`, which only the key page does: it joins this list
   *  against the draft it edits, by the key text). Every other reader renders the
   *  mask, so it never has to hold a credential. */
  key: string;
  /** Legacy keys-page identity, computed under the "client-key" purpose. It does
   *  not match any usage record. */
  fingerprint: string;
  /** The identity this key has in the usage records (`api_group_key`), derived
   *  under the "usage-api-key" purpose. Only this value joins to a request, so it
   *  is what an alias is stored against and what "view requests" filters by.
   *  Absent when the fingerprint could not be computed. */
  usage_fingerprint?: string;
  length: number;
  /** Operator-assigned name; absent when the key is unnamed. */
  alias?: string;
  /** Version a rename must cite; 0 when no alias exists. */
  alias_version: number;
}

/** One key's observed traffic within the queried window. */
export interface ClientKeyUsageItem {
  key_fingerprint: string;
  requests: number;
  failed: number;
  total_tokens: number;
  /** 0 when the window holds no matching record. */
  last_used_ms: number;
}

export interface ProviderKeyEntry {
  index: number;
  api_key: string;
  proxy_url?: string;
  weight?: number;
}

export interface ThinkingSupportConfig {
  levels?: string[];
}

/**
 * A model entry's settings beyond its name, alias, image flag and thinking levels. On a save it
 * states the whole entry: a setting left out is cleared.
 */
export interface ProviderModelOptions {
  display_name?: string;
  max_context_length?: number;
  force_mapping?: boolean;
  is_compat?: boolean;
  support_configuration_update?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  use_max_completion_tokens?: boolean;
  thinking_min?: number;
  thinking_max?: number;
  thinking_zero_allowed?: boolean;
  thinking_dynamic_allowed?: boolean;
}

/** The model settings only some families' entries have; the rest exist on every family. */
export type ProviderModelOptionField =
  | 'max_context_length'
  | 'is_compat'
  | 'support_configuration_update'
  | 'modalities'
  | 'use_max_completion_tokens';

export interface ProviderModelItem {
  name: string;
  alias?: string;
  image?: boolean;
  thinking?: ThinkingSupportConfig;
  options?: ProviderModelOptions;
}

/** How a provider treats a setting the gateway also has globally. */
export type ProviderOverride = 'inherit' | 'enabled' | 'disabled';

export const PROVIDER_ERROR_RULE_ACTIONS = ['stop', 'stop-and-cooldown', 'continue', 'continue-and-cooldown'] as const;
export type ProviderErrorRuleAction = (typeof PROVIDER_ERROR_RULE_ACTIONS)[number];

/** One request-scoped error rule. `action` is a string because a stored rule may name an action
 *  this console does not know; such a rule is shown and kept, not rewritten. */
export interface ProviderErrorRule {
  status: number;
  match?: string[];
  match_regex?: string[];
  action: string;
}

export interface ProviderRuntimePolicy {
  cooling: ProviderOverride;
  /** Absent when the provider inherits the global retry count. */
  request_retry?: number;
  error_rules?: ProviderErrorRule[];
  /** Reported by the server; ignored on a write. */
  supports_error_rules?: boolean;
}

/** The request-behaviour switches a family has; a family reports only its own. */
export interface ProviderBehavior {
  alpha_search?: boolean;
  codex_cloaking?: ProviderOverride;
  rebuild_mid_system_message?: boolean;
  support_prompt_cache_key?: boolean;
}

export type ProviderBehaviorSwitch = keyof ProviderBehavior;

export interface ProviderItem {
  id: string;
  family: string;
  name: string;
  /** The name this provider carries in CPA's own configuration, before any local
   *  custom name replaced it. CPA labels the usage queue with
   *  "openai-compatible-<upstream name>", so a stored request record joins on this
   *  rather than on the custom name. Absent for the families CPA labels by family. */
  upstream_name?: string;
  protocol: string;
  base_url?: string;
  /** The provider's own homepage. Oh My CPA management metadata rather than a CPA
   *  field, so it is stored beside the display name and always an absolute
   *  http/https URL or absent. */
  website?: string;
  prefix?: string;
  priority?: number;
  disable_cooling?: boolean;
  auth_index?: string;
  /** Runtime auth index of every key the provider holds. A request record names the index of the
   *  key that served it, so this - not the family label - is what credits traffic to the row. */
  auth_indexes?: string[];
  models?: string[];
  model_entries?: ProviderModelItem[];
  disabled: boolean;
  key_configured: boolean;
  api_key?: string;
  key_entries?: ProviderKeyEntry[];
  headers?: Record<string, string>;
  proxy_configured?: boolean;
  runtime_policy?: ProviderRuntimePolicy;
  behavior?: ProviderBehavior;
}

export interface SaveProviderKeyItem {
  api_key?: string;
  proxy_url?: string;
  weight?: number;
}

export interface SaveProviderModelItem {
  name: string;
  alias?: string;
  image?: boolean;
  thinking?: ThinkingSupportConfig;
  options?: ProviderModelOptions;
}

export interface SaveProviderPayload {
  family: string;
  name: string;
  base_url?: string;
  prefix?: string;
  priority?: number;
  disable_cooling?: boolean;
  api_key?: string;
  keys?: SaveProviderKeyItem[];
  models?: string[];
  model_entries?: SaveProviderModelItem[];
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Absent leaves the stored website alone; an empty string clears it. */
  website?: string;
  /** Authoritative for cooling, retry and error rules when present; `disable_cooling` is then ignored. */
  runtime_policy?: ProviderRuntimePolicy;
  /** Sets only the switches it names. */
  behavior?: ProviderBehavior;
}
