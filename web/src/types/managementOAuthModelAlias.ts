export interface ManagementOAuthModelAlias {
  name: string;
  alias: string;
  fork?: boolean;
  display_name?: string;
  force_mapping?: boolean;
}

export interface ManagementOAuthModelAliasesResponse {
  aliases: Record<string, ManagementOAuthModelAlias[]>;
}

export interface ManagementOAuthModelAliasMutationResponse {
  status: string;
  provider: string;
  aliases: ManagementOAuthModelAlias[];
}

/** CPA's per-provider OAuth model exclusion rules, as the gateway applies them. */
export interface ManagementOAuthExcludedModelsResponse {
  excluded_models: Record<string, string[]>;
}

export interface ManagementOAuthExcludedModelsMutationResponse {
  status: string;
  provider: string;
  models: string[];
}

export interface ManagementOAuthProviderModel {
  id: string;
  display_name?: string;
}

/** `available` is false for a provider CPA keeps no model catalog for. */
export interface ManagementOAuthProviderModelsResponse {
  provider: string;
  available: boolean;
  models: ManagementOAuthProviderModel[];
}
