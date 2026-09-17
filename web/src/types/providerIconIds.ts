/**
 * The provider family → brand icon table.
 *
 * It lives in its own leaf module because two unrelated consumers need the same
 * entries: `components/LobeIcon.tsx` resolves a provider to a brand mark, and
 * `types/usageEventView.ts` resolves one for a request row. Keeping two copies
 * meant a new provider added to one silently disagreed with the other, and
 * pointing the request-list module at `LobeIcon.tsx` would have dragged the
 * whole icon renderer into a module the logic test harness loads.
 */
export const PROVIDER_ICON_IDS: Record<string, string> = {
  claude: 'Claude',
  anthropic: 'Claude',
  antigravity: 'Antigravity',
  codex: 'Codex',
  xai: 'XAI',
  grok: 'XAI',
  kimi: 'Kimi',
  moonshot: 'Kimi',
  devin: 'Devin',
  meta: 'Meta',
  openai: 'OpenAI',
  gemini: 'Gemini',
  google: 'Gemini',
  vertex: 'Google',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  minimax: 'Minimax',
  stepfun: 'Stepfun',
  baichuan: 'Baichuan',
  zhipu: 'Zhipu',
  doubao: 'Doubao',
  spark: 'Spark',
};

/** The mark shown when a provider cannot be identified. */
export const DEFAULT_PROVIDER_ICON_ID = 'OpenAI';

/** The mark shown when no brand applies at all. */
export const NEUTRAL_PROVIDER_ICON_ID = 'CloudServerOutlined';

/**
 * providerIconId resolves a provider family to a brand mark.
 *
 * Returns undefined rather than a fallback so the two callers can keep their own
 * default: a request row with no brand reads as a neutral server, while the icon
 * picker treats an unknown family as OpenAI.
 */
export function providerIconId(family: string | undefined): string | undefined {
  return PROVIDER_ICON_IDS[(family ?? '').toLowerCase().trim()];
}
