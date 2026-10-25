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
  | 'devin'
  | 'meta'
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
  suggested_source?: string; // e.g. "DeepSeek", "Command Code GOAT", "OpenAI"
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
  /** 'unsupported' means the gateway is older than CPA v8, which the console requires. */
  cpa_management_api?: 'v8' | 'unsupported' | 'disabled' | 'unknown';
  cpa_base_url?: string;
  database_status?: string;
}
