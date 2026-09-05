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
