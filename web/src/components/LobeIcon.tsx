import React, { memo } from 'react';
import * as allIcons from '@lobehub/icons';
import { toc } from '@lobehub/icons';
import { CloudServerOutlined } from '@ant-design/icons';

interface LobeIconProps {
  iconId?: string;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
  variant?: 'color' | 'mono';
}

export const LobeIcon: React.FC<LobeIconProps> = memo(({
  iconId,
  size = 24,
  className,
  style,
  variant = 'color',
}) => {
  if (!iconId) {
    return <CloudServerOutlined style={{ fontSize: size, ...style }} className={className} />;
  }

  const IconComp = (allIcons as Record<string, any>)[iconId];
  if (!IconComp) {
    return <CloudServerOutlined style={{ fontSize: size, ...style }} className={className} />;
  }

  if (variant !== 'mono' && IconComp.Color) {
    const ColorComp = IconComp.Color;
    return <ColorComp size={size} style={style} className={className} />;
  }

  return <IconComp size={size} style={style} className={className} />;
});

interface TocCandidate {
  kw: string;
  iconId: string;
  len: number;
  priority: number;
}

// Dynamically index all 300+ icons from @lobehub/icons toc catalog
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

  for (const item of toc) {
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
};

export function getProviderDefaultIcon(family: string, name?: string, baseURL?: string): string {
  const n = (name || '').toLowerCase().trim();
  const url = (baseURL || '').toLowerCase().trim();
  const f = (family || '').toLowerCase().trim();
  const combined = `${n} ${url}`.trim();
  const normalized = combined.replace(/[\s\-_./:]/g, '');

  if (normalized) {
    // 1. Direct match against toc catalog for names with >= 4 characters (e.g. Minimax, OpenCode, FastGPT)
    for (const c of TOC_CANDIDATES) {
      if (c.len >= 4 && normalized.includes(c.kw)) {
        return c.iconId;
      }
    }

    // 2. Common aliases & acronyms (e.g. gpt -> OpenAI, glm -> Zhipu, 通义 -> Qwen)
    for (const [kw, iconId] of Object.entries(COMMON_ALIASES)) {
      const cleanKw = kw.replace(/[\s\-_]/g, '');
      if (combined.includes(kw) || normalized.includes(cleanKw)) {
        return iconId;
      }
    }

    // 3. Shorter toc candidates (len 2-3)
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
  return 'OpenAI';
}
