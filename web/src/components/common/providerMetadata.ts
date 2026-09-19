import { resolveProviderIcon } from '../../types/providerIconIds';

export interface ProviderMetadata {
  id: string;
  label: string;
  iconId: string;
}

export const CREDENTIAL_PROVIDERS: Record<string, ProviderMetadata> = {
  claude: { id: 'claude', label: 'Claude', iconId: 'Claude' },
  antigravity: { id: 'antigravity', label: 'Antigravity', iconId: 'Antigravity' },
  codex: { id: 'codex', label: 'Codex', iconId: 'Codex' },
  xai: { id: 'xai', label: 'xAI', iconId: 'XAI' },
  grok: { id: 'xai', label: 'xAI', iconId: 'XAI' },
  kimi: { id: 'kimi', label: 'Kimi', iconId: 'Kimi' },
  moonshot: { id: 'kimi', label: 'Kimi', iconId: 'Kimi' },
  devin: { id: 'devin', label: 'Devin', iconId: 'Devin' },
  meta: { id: 'meta', label: 'Meta', iconId: 'Meta' },
  // The CodeBuddy plugin registers `codebuddy` as its provider key; a store build
  // that keeps the plugin's own id instead still has to reach the same mark.
  codebuddy: { id: 'codebuddy', label: 'Codebuddy', iconId: 'CodeBuddy' },
  workbuddy: { id: 'codebuddy', label: 'Codebuddy', iconId: 'CodeBuddy' },
  gemini: { id: 'gemini', label: 'Gemini', iconId: 'Gemini' },
  google: { id: 'gemini', label: 'Gemini', iconId: 'Gemini' },
  vertex: { id: 'vertex', label: 'Vertex AI', iconId: 'Google' },
  qwen: { id: 'qwen', label: 'Qwen', iconId: 'Qwen' },
  deepseek: { id: 'deepseek', label: 'DeepSeek', iconId: 'DeepSeek' },
  minimax: { id: 'minimax', label: 'MiniMax', iconId: 'Minimax' },
  stepfun: { id: 'stepfun', label: 'Stepfun', iconId: 'Stepfun' },
  baichuan: { id: 'baichuan', label: 'Baichuan', iconId: 'Baichuan' },
  zhipu: { id: 'zhipu', label: 'Zhipu', iconId: 'Zhipu' },
  doubao: { id: 'doubao', label: 'Doubao', iconId: 'Doubao' },
  spark: { id: 'spark', label: 'Spark', iconId: 'Spark' },
  openai: { id: 'openai', label: 'OpenAI', iconId: 'OpenAI' },
};

export function getCredentialProviderMetadata(providerKey: string): ProviderMetadata {
  const key = (providerKey || '').toLowerCase().trim();
  if (CREDENTIAL_PROVIDERS[key]) {
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
 * credentialProviderIconId resolves the brand mark every provider surface renders.
 *
 * The named table above is display metadata (label plus mark); this is the floor
 * under it. A provider CPA knows but the table has not named yet - a new OAuth
 * provider, or a plugin registering one - still has a mark in the vendored icon
 * catalog, and falling through to it is what keeps a tab or card from rendering the
 * neutral placeholder while its brand artwork ships in the bundle.
 *
 * An unmatched provider resolves to no mark at all rather than to a default: the
 * caller renders its own neutral placeholder, so an unknown provider is never
 * mislabelled with somebody else's brand.
 */
export function credentialProviderIconId(providerKey: string, hint?: string): string {
  const meta = getCredentialProviderMetadata(providerKey);
  return meta.iconId || resolveProviderIcon(providerKey, hint ?? meta.label) || '';
}
