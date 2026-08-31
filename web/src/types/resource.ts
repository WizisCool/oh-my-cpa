export type ResourceStatus = 'unclaimed' | 'claimed' | 'ignored' | 'missing';

export type ProtocolDriver =
  | 'codex'
  | 'openai_responses'
  | 'openai_chat_completions'
  | 'anthropic_messages'
  | 'gemini_generate_content'
  | 'vertex'
  | 'claude'
  | 'gemini'
  | 'xai'
  | 'kimi'
  | 'custom'
  | string;

export interface ResourceDetails {
  models?: string[];
  headers?: Record<string, string>;
  proxy_url?: string;
  auth_type?: string;
  email?: string;
  source_file?: string;
  priority?: number;
  prefix?: string;
  raw_config?: Record<string, unknown>;
}

export interface DiscoveredResource {
  id: string;
  cpa_instance_id: string;
  cpa_resource_type: string; // e.g. "codex-api-key", "auth-file", "openai-compatibility"
  cpa_auth_index?: string;
  cpa_resource_name?: string;
  cpa_driver: string; // e.g. "codex", "claude", "gemini"
  protocol_driver: ProtocolDriver;
  protocol_display?: string; // e.g. "OpenAI Responses", "Anthropic Claude", "OpenAI Compatible"
  base_url?: string;
  suggested_source?: string; // e.g. "DeepSeek 官方", "Command Code GOAT", "OpenAI"
  suggested_plan?: string;
  display_name: string; // resolved effective name
  custom_display_name?: string | null;
  icon?: string | null; // e.g. "deepseek", "openai", "claude", "goat", "relay"
  color?: string | null; // hex color e.g. "#1677FF"
  notes?: string | null;
  status: ResourceStatus;
  last_seen_at?: number | string;
  created_at?: number | string;
  updated_at?: number | string;
  details?: ResourceDetails;
}

export interface ResourceOverridePayload {
  display_name?: string;
  icon?: string;
  color?: string;
  notes?: string;
  status?: ResourceStatus;
}

export interface DiscoveryResult {
  status: string;
  discovered_count: number;
  unclaimed_count: number;
  instance_id: string;
  duration_ms?: number;
  errors?: string[];
}

export interface HealthStatus {
  status: string;
  version?: string;
  uptime_seconds?: number;
  cpa_connected?: boolean;
  cpa_base_url?: string;
  database_status?: string;
}

export interface IconPreset {
  key: string;
  name: string;
  category: 'brand' | 'generic' | 'service';
  defaultColor: string;
  description?: string;
}

export const ICON_PRESETS: IconPreset[] = [
  { key: 'deepseek', name: 'DeepSeek', category: 'brand', defaultColor: '#1E88E5', description: 'DeepSeek 官方或兼容线路' },
  { key: 'openai', name: 'OpenAI / GPT', category: 'brand', defaultColor: '#10A37F', description: 'ChatGPT / GPT-4o / Codex' },
  { key: 'claude', name: 'Claude', category: 'brand', defaultColor: '#D97706', description: 'Anthropic Claude Code / API' },
  { key: 'gemini', name: 'Google Gemini', category: 'brand', defaultColor: '#4285F4', description: 'Gemini CLI / Google AI' },
  { key: 'goat', name: 'Command Code GOAT', category: 'service', defaultColor: '#8B5CF6', description: 'GOAT 团队或订阅线路' },
  { key: 'opencode', name: 'OpenCode Go', category: 'service', defaultColor: '#06B6D4', description: 'OpenCode 聚合接入' },
  { key: 'relay', name: '中转站 / 代理', category: 'generic', defaultColor: '#F59E0B', description: '第三方 API 中转站 / 聚合网关' },
  { key: 'code', name: '开发专线', category: 'generic', defaultColor: '#6366F1', description: '日常编程与 IDE Agent 专用' },
  { key: 'shield', name: '官方渠道', category: 'generic', defaultColor: '#059669', description: '官方直连与高可靠专线' },
  { key: 'sparkles', name: '推理旗舰', category: 'generic', defaultColor: '#EC4899', description: 'R1 / o1 / o3 深度推理模型' },
  { key: 'bolt', name: '高频极速', category: 'generic', defaultColor: '#EAB308', description: 'Flash / Mini / Haiku 快速响应' },
  { key: 'custom', name: '自定义接入', category: 'generic', defaultColor: '#64748B', description: '通用服务或未分类线路' },
];

export const COLOR_PRESETS = [
  { hex: '#1677FF', label: '拂晓蓝 (Blue)' },
  { hex: '#10A37F', label: '智脑绿 (OpenAI Green)' },
  { hex: '#D97706', label: '琥珀橙 (Claude Amber)' },
  { hex: '#8B5CF6', label: '极客紫 (Purple)' },
  { hex: '#06B6D4', label: '海青色 (Cyan)' },
  { hex: '#EC4899', label: '品红色 (Magenta)' },
  { hex: '#E11D48', label: '玫瑰红 (Rose)' },
  { hex: '#059669', label: '翡翠绿 (Emerald)' },
  { hex: '#475569', label: '深石板 (Slate)' },
];
