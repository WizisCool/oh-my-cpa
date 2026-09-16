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
