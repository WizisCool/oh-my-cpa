import React, { memo } from 'react';
import * as allIcons from '@lobehub/icons';
import { CloudServerOutlined } from '@ant-design/icons';

interface LobeIconProps {
  iconId?: string;
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

export const LobeIcon: React.FC<LobeIconProps> = memo(({
  iconId,
  size = 24,
  className,
  style,
}) => {
  if (!iconId) {
    return <CloudServerOutlined style={{ fontSize: size, ...style }} className={className} />;
  }

  const IconComp = (allIcons as Record<string, any>)[iconId];
  if (!IconComp) {
    return <CloudServerOutlined style={{ fontSize: size, ...style }} className={className} />;
  }

  if (IconComp.Color) {
    const ColorComp = IconComp.Color;
    return <ColorComp size={size} style={style} className={className} />;
  }

  return <IconComp size={size} style={style} className={className} />;
});

export function getProviderDefaultIcon(family: string, name?: string, baseURL?: string): string {
  const n = (name || '').toLowerCase();
  const url = (baseURL || '').toLowerCase();
  const f = (family || '').toLowerCase();

  // Keyword-based detection from name and baseURL
  if (n.includes('deepseek') || url.includes('deepseek')) return 'DeepSeek';
  if (n.includes('claude') || n.includes('anthropic') || url.includes('anthropic')) return 'Claude';
  if (n.includes('gemini') || n.includes('google') || url.includes('generativelanguage')) return 'Gemini';
  if (n.includes('zhipu') || n.includes('智谱') || n.includes('glm') || url.includes('bigmodel')) return 'Zhipu';
  if (n.includes('qwen') || n.includes('通义') || n.includes('dashscope') || url.includes('dashscope')) return 'Qwen';
  if (n.includes('moonshot') || n.includes('kimi') || url.includes('moonshot')) return 'Moonshot';
  if (n.includes('minimax') || n.includes('海螺') || url.includes('minimax')) return 'Minimax';
  if (n.includes('baichuan') || n.includes('百川') || url.includes('baichuan')) return 'Baichuan';
  if (n.includes('stepfun') || n.includes('阶跃') || url.includes('stepfun')) return 'Stepfun';
  if (n.includes('silicon') || n.includes('硅基') || url.includes('siliconflow')) return 'SiliconCloud';
  if (n.includes('groq') || url.includes('groq')) return 'Groq';
  if (n.includes('mistral') || url.includes('mistral')) return 'Mistral';
  if (n.includes('together') || url.includes('together')) return 'Together';
  if (n.includes('perplexity') || url.includes('perplexity')) return 'Perplexity';
  if (n.includes('openrouter') || url.includes('openrouter')) return 'OpenRouter';
  if (n.includes('cohere') || url.includes('cohere')) return 'Cohere';
  if (n.includes('yi') || n.includes('零一') || url.includes('01.ai')) return 'Yi';
  if (n.includes('spark') || n.includes('讯飞') || n.includes('xfyun')) return 'Spark';
  if (n.includes('doubao') || n.includes('豆包') || n.includes('volcengine')) return 'Doubao';
  if (n.includes('tencent') || n.includes('腾讯') || n.includes('hunyuan')) return 'Tencent';
  if (n.includes('meta') || n.includes('llama')) return 'Meta';
  if (n.includes('azure')) return 'Azure';
  if (n.includes('bedrock') || n.includes('aws')) return 'Bedrock';
  if (n.includes('ollama')) return 'Ollama';
  if (n.includes('github') || n.includes('copilot')) return 'Copilot';

  // Fallback by family
  switch (f) {
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'codex':
      return 'OpenAI';
    default:
      return 'OpenAI';
  }
}
