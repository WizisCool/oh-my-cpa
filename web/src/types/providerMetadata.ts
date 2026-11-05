import { providerIconId, resolveProviderIcon } from './providerIconIds';

export interface ProviderMetadata {
  id: string;
  label: string;
  iconId: string;
}

/**
 * The labels are the brands' own names, deliberately not i18n keys: a product name is a
 * proper noun and reads identically in every catalog, and every row here (Claude, Codex,
 * Antigravity, xAI, Kimi, Devin, Meta, Codebuddy, …) already states it as a literal. The
 * catalogue holds UI copy, which this table has none of.
 */
const CREDENTIAL_PROVIDER_LABELS: Record<string, Omit<ProviderMetadata, 'iconId'>> = {
  claude: { id: 'claude', label: 'Claude' },
  antigravity: { id: 'antigravity', label: 'Antigravity' },
  codex: { id: 'codex', label: 'Codex' },
  xai: { id: 'xai', label: 'xAI' },
  grok: { id: 'xai', label: 'xAI' },
  kimi: { id: 'kimi', label: 'Kimi' },
  moonshot: { id: 'kimi', label: 'Kimi' },
  // An international (kimi.ai) account is the same product on another host, so it shares
  // Kimi's tab and mark instead of standing as a provider of its own.
  'kimi-ai': { id: 'kimi', label: 'Kimi' },
  devin: { id: 'devin', label: 'Devin' },
  meta: { id: 'meta', label: 'Meta' },
  // The CodeBuddy plugin registers `codebuddy` as its provider key; a store build
  // that keeps the plugin's own id instead still has to reach the same mark.
  codebuddy: { id: 'codebuddy', label: 'Codebuddy' },
  workbuddy: { id: 'codebuddy', label: 'Codebuddy' },
  gemini: { id: 'gemini', label: 'Gemini' },
  google: { id: 'gemini', label: 'Gemini' },
  vertex: { id: 'vertex', label: 'Vertex AI' },
  qwen: { id: 'qwen', label: 'Qwen' },
  deepseek: { id: 'deepseek', label: 'DeepSeek' },
  minimax: { id: 'minimax', label: 'MiniMax' },
  stepfun: { id: 'stepfun', label: 'Stepfun' },
  baichuan: { id: 'baichuan', label: 'Baichuan' },
  zhipu: { id: 'zhipu', label: 'Zhipu' },
  doubao: { id: 'doubao', label: 'Doubao' },
  spark: { id: 'spark', label: 'Spark' },
  openai: { id: 'openai', label: 'OpenAI' },
};

export const CREDENTIAL_PROVIDERS: Record<string, ProviderMetadata> = Object.fromEntries(
  Object.entries(CREDENTIAL_PROVIDER_LABELS).map(([key, metadata]) => [key, { ...metadata, iconId: providerIconId(metadata.id) ?? '' }]),
);

export function getCredentialProviderMetadata(providerKey: string): ProviderMetadata {
  const key = (providerKey || '').toLowerCase().trim();
  // Provider keys come from plugins too; `constructor` must not read Object's inherited member.
  if (Object.prototype.hasOwnProperty.call(CREDENTIAL_PROVIDERS, key)) {
    return CREDENTIAL_PROVIDERS[key];
  }
  const capitalized = key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown';
  return {
    id: key || 'unknown',
    label: capitalized,
    iconId: '', // Empty iconId renders neutral fallback icon, never OpenAI!
  };
}

/**
 * providerDisplayName is the one name every provider surface gives a provider key: the
 * title a plugin publishes for a provider it registers, then the brand table above. The
 * dashboard and the OAuth page both read it, so a brand is never spelled from its raw
 * key on one page (`Deepseek`) and by its own name on the other (`DeepSeek`). Titles are
 * keyed by the canonical key, so an alias (`workbuddy`) reads the same as the section the
 * OAuth page files it under (`codebuddy`).
 */
export function providerDisplayName(providerKey: string, pluginTitles?: ReadonlyMap<string, string>): string {
  const metadata = getCredentialProviderMetadata(providerKey);
  return pluginTitles?.get(metadata.id) || metadata.label;
}

/**
 * credentialProviderIconId resolves the brand mark every provider surface renders.
 *
 * The named table above is display metadata (label plus mark); this is the floor
 * under it. A provider CPA knows but the table has not named yet - a new OAuth
 * provider, or a plugin registering one - still has a mark in the vendored icon
 * catalog, and falling through to it is what keeps a tab or card from rendering the
 * neutral placeholder while its brand artwork ships in the bundle.
 *
 * The hint is the credential or account label the caller has, and it is consulted only
 * when the provider key itself is unknown - a generic family CPA labels for the operator
 * (`openai-compatibility`), where the credential's own name is the only evidence of whose
 * account it is. A key the table names always wins over the hint, so an account called
 * "claude-prod" cannot rename the provider it belongs to.
 *
 * An unmatched provider resolves to no mark at all rather than to a default: the
 * caller renders its own neutral placeholder, so an unknown provider is never
 * mislabelled with somebody else's brand.
 */
export function credentialProviderIconId(providerKey: string, hint?: string): string {
  const meta = getCredentialProviderMetadata(providerKey);
  return meta.iconId || resolveProviderIcon(providerKey, hint ?? meta.label) || '';
}
