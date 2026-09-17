import { LOBE_ICON_CATALOG } from './lobeIconCatalog';

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

interface TocCandidate {
  kw: string;
  iconId: string;
  len: number;
  priority: number;
}

// Flatten the vendored icon catalog into one prioritised lookup list at module
// load, so a model-name lookup never walks the icon namespace.
const TOC_CANDIDATES: TocCandidate[] = (() => {
  const list: TocCandidate[] = [];
  const seen = new Set<string>();

  const add = (kw: string | undefined, iconId: string, priority: number) => {
    const clean = (kw || '').trim().toLowerCase().replace(/[\s\-_]/g, '');
    if (!clean || clean.length < 2) return;
    const key = `${clean}::${iconId}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ kw: clean, iconId, len: clean.length, priority });
  };

  for (const item of LOBE_ICON_CATALOG) {
    // 1. Exact ID (e.g. Minimax, OpenCode, DeepSeek) has highest priority
    add(item.id, item.id, 2);
    // 2. Title, docsUrl, and parenthesized Chinese/alias names from fullTitle
    add(item.title, item.id, 1);
    add(item.docsUrl, item.id, 1);
    if (item.fullTitle) {
      add(item.fullTitle, item.id, 1);
      const m = item.fullTitle.match(/\(([^)]+)\)/);
      if (m && m[1]) add(m[1], item.id, 1);
    }
  }

  // Sort by priority desc, then length desc (longer, specific names match first)
  list.sort((a, b) => b.priority - a.priority || b.len - a.len);
  return list;
})();

// Minimal aliases for acronyms and terms where the model/brand acronym differs from icon ID
const COMMON_ALIASES: Record<string, string> = {
  'gpt': 'OpenAI',
  'chatgpt': 'OpenAI',
  'glm': 'Zhipu',
  '智谱': 'Zhipu',
  '通义': 'Qwen',
  '千问': 'Qwen',
  '百炼': 'Bailian',
  '月之暗面': 'Moonshot',
  '海螺': 'Minimax',
  '阶跃': 'Stepfun',
  '跃问': 'Stepfun',
  '百川': 'Baichuan',
  '硅基': 'SiliconCloud',
  '豆包': 'Doubao',
  '火山': 'Volcengine',
  '混元': 'Hunyuan',
  '腾讯': 'Tencent',
  '讯飞': 'Spark',
  '星火': 'Spark',
  '零一': 'ZeroOne',
  '百度': 'Baidu',
  '文心': 'Wenxin',
  '商汤': 'SenseNova',
  '日日新': 'SenseNova',
  '深度求索': 'DeepSeek',
  'llama': 'Meta',
  'google': 'Gemini',
  'anthropic': 'Claude',
  'claude': 'Claude',
  'gemini': 'Gemini',
  'antigravity': 'Antigravity',
  'kimi': 'Kimi',
  'moonshot': 'Kimi',
  'xai': 'XAI',
  'grok': 'XAI',
  'codex': 'Codex',
  'vertex': 'Google',
};

const KNOWN_PROVIDER_ICONS = PROVIDER_ICON_IDS;

export function getProviderDefaultIcon(family: string, name?: string, baseURL?: string): string {
  const f = (family || '').toLowerCase().trim();
  const n = (name || '').toLowerCase().trim();
  const url = (baseURL || '').toLowerCase().trim();

  // 1. If name is provided and matches a known provider family directly
  if (n && KNOWN_PROVIDER_ICONS[n]) {
    return KNOWN_PROVIDER_ICONS[n];
  }

  // 2. Direct match on provider family name (unless it's the generic openai-compatibility adapter)
  if (KNOWN_PROVIDER_ICONS[f] && !f.includes('compat')) {
    return KNOWN_PROVIDER_ICONS[f];
  }

  // 3. Match against name first (for specific brand identification like Cline, Inception, CodeBuddy, DeepSeek)
  if (n) {
    const cleanName = n.replace(/[\s\-_./:]/g, '');
    for (const c of TOC_CANDIDATES) {
      if (c.len >= 3 && cleanName.includes(c.kw)) {
        return c.iconId;
      }
    }
    for (const [kw, iconId] of Object.entries(COMMON_ALIASES)) {
      const cleanKw = kw.replace(/[\s\-_]/g, '');
      if (n.includes(kw) || cleanName.includes(cleanKw)) {
        return iconId;
      }
    }
  }

  // 4. Combined match (excluding generic 'compat' token so openai-compatibility doesn't falsely match OpenAI)
  const familyClean = f.includes('compat') ? '' : f;
  const combined = `${familyClean} ${n} ${url}`.trim();
  const normalized = combined.replace(/[\s\-_./:]/g, '');

  if (normalized) {
    for (const c of TOC_CANDIDATES) {
      if (c.len >= 4 && normalized.includes(c.kw)) {
        return c.iconId;
      }
    }
    for (const [kw, iconId] of Object.entries(COMMON_ALIASES)) {
      const cleanKw = kw.replace(/[\s\-_]/g, '');
      if (combined.includes(kw) || normalized.includes(cleanKw)) {
        return iconId;
      }
    }
    for (const c of TOC_CANDIDATES) {
      if (c.len < 4 && normalized.includes(c.kw)) {
        return c.iconId;
      }
    }
  }

  // Fallback by family
  if (f.includes('claude') || f.includes('anthropic')) return 'Claude';
  if (f.includes('gemini') || f.includes('google')) return 'Gemini';
  if (f.includes('codex')) return 'Codex';
  if (f.includes('antigravity')) return 'Antigravity';
  if (f.includes('xai') || f.includes('grok')) return 'XAI';
  if (f.includes('kimi') || f.includes('moonshot')) return 'Kimi';
  if (f.includes('qwen')) return 'Qwen';
  if (f.includes('deepseek')) return 'DeepSeek';
  if (f.includes('meta')) return 'Meta';
  if (f.includes('devin')) return 'Devin';
  return DEFAULT_PROVIDER_ICON_ID;
}
