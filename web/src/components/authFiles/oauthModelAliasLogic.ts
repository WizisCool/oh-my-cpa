import type { ManagementOAuthModelAlias } from '../../types/managementOAuthModelAlias';

export const OAUTH_MODEL_ALIAS_ENTRY_LIMIT = 512;
export const OAUTH_MODEL_ALIAS_FIELD_LIMIT = 512;
export const OAUTH_MODEL_ALIAS_PROVIDER_LIMIT = 64;

const PROVIDER_ALIASES: Record<string, string> = {
  'anti-gravity': 'antigravity',
  grok: 'xai',
  'x-ai': 'xai',
  'x.ai': 'xai',
};

const PROVIDER_PATTERN = /^[a-z0-9-]+$/;

export interface ManagementOAuthModelAliasDraft extends ManagementOAuthModelAlias {
  rowKey: string;
}

export type OAuthModelAliasValidationError =
  | 'provider'
  | 'too_many'
  | 'name_alias_required'
  | 'field_too_long'
  | 'alias_same'
  | 'alias_duplicate';

export type OAuthModelAliasValidationResult =
  | { ok: true; provider: string; aliases: ManagementOAuthModelAlias[] }
  | { ok: false; error: OAuthModelAliasValidationError; alias?: string };

export function normalizeOAuthModelAliasProvider(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

export function isValidOAuthModelAliasProvider(value: string): boolean {
  return value.length > 0
    && Array.from(value).length <= OAUTH_MODEL_ALIAS_PROVIDER_LIMIT
    && PROVIDER_PATTERN.test(value);
}

export function createOAuthModelAliasDrafts(
  aliases: ManagementOAuthModelAlias[] = [],
): ManagementOAuthModelAliasDraft[] {
  return aliases.map((entry, index) => ({
    ...entry,
    rowKey: `oauth-alias-${index}`,
  }));
}

export function emptyOAuthModelAliasDraft(rowKey: string): ManagementOAuthModelAliasDraft {
  return { rowKey, name: '', alias: '', fork: false, force_mapping: false, display_name: '' };
}

export function validateOAuthModelAliasDrafts(
  providerValue: string,
  drafts: ManagementOAuthModelAliasDraft[],
): OAuthModelAliasValidationResult {
  const provider = normalizeOAuthModelAliasProvider(providerValue);
  if (!provider || !isValidOAuthModelAliasProvider(provider)) {
    return { ok: false, error: 'provider' };
  }
  if (drafts.length > OAUTH_MODEL_ALIAS_ENTRY_LIMIT) {
    return { ok: false, error: 'too_many' };
  }
  const aliases: ManagementOAuthModelAlias[] = [];
  const seenAliases = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    const alias = draft.alias.trim();
    const displayName = (draft.display_name ?? '').trim();
    if (!name || !alias) {
      return { ok: false, error: 'name_alias_required' };
    }
    if (
      Array.from(name).length > OAUTH_MODEL_ALIAS_FIELD_LIMIT
      || Array.from(alias).length > OAUTH_MODEL_ALIAS_FIELD_LIMIT
      || Array.from(displayName).length > OAUTH_MODEL_ALIAS_FIELD_LIMIT
    ) {
      return { ok: false, error: 'field_too_long' };
    }
    if (name.toLowerCase() === alias.toLowerCase()) {
      return { ok: false, error: 'alias_same', alias };
    }
    const aliasKey = alias.toLowerCase();
    if (seenAliases.has(aliasKey)) {
      return { ok: false, error: 'alias_duplicate', alias };
    }
    seenAliases.add(aliasKey);
    const normalized: ManagementOAuthModelAlias = { name, alias };
    if (draft.fork) normalized.fork = true;
    if (displayName) normalized.display_name = displayName;
    if (draft.force_mapping) normalized.force_mapping = true;
    aliases.push(normalized);
  }
  return { ok: true, provider, aliases };
}

function aliasSignature(aliases: ManagementOAuthModelAlias[]): string {
  return aliases
    .map((entry) => [
      entry.name.trim(),
      entry.alias.trim(),
      entry.fork ? '1' : '0',
      (entry.display_name ?? '').trim(),
      entry.force_mapping ? '1' : '0',
    ].join('\u0001'))
    .join('\u0002');
}

export function oauthModelAliasDraftsEqual(
  left: ManagementOAuthModelAliasDraft[],
  right: ManagementOAuthModelAliasDraft[],
): boolean {
  return aliasSignature(left) === aliasSignature(right);
}
