/** Bounded upstream observations, independent of canonical tokens and OMC prices. */
export interface StructuredUsageDetails {
  tokens?: StructuredTokenUsage;
  cache_details?: CacheUsageDetails;
  tool_usage_details?: ToolUsageDetails;
  web_search_requests?: number;
  image_count?: number;
  requested_image_details?: ImageUsageDetails;
  image_details?: ImageUsageDetails;
  media_counts?: MediaUsageCounts;
  iterations?: IterationUsageDetails[];
  cost_details?: UpstreamCostDetails;
  speed?: string;
  inference_geo?: string;
  upstream_service_tier?: string;
  is_partial?: boolean;
}

export interface StructuredTokenUsage {
  cache_creation_5m_tokens?: number;
  cache_creation_30m_tokens?: number;
  cache_creation_1h_tokens?: number;
  cache_creation_12h_tokens?: number;
  text_input_tokens?: number;
  image_input_tokens?: number;
  audio_input_tokens?: number;
  video_input_tokens?: number;
  file_input_tokens?: number;
  cached_text_tokens?: number;
  text_output_tokens?: number;
  image_output_tokens?: number;
  audio_output_tokens?: number;
  accepted_prediction_tokens?: number;
  rejected_prediction_tokens?: number;
}

export interface CacheUsageDetails {
  mode?: string;
  ttl?: string;
  retention?: string;
  ephemeral_5m_input_tokens?: number;
  ephemeral_30m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
  ephemeral_12h_input_tokens?: number;
  by_ttl?: Record<string, number>;
}

export interface ToolUsageDetails {
  web_search_calls?: number;
  web_search_queries?: number;
  web_fetch_calls?: number;
  num_search_results?: number;
  num_sources_used?: number;
  num_server_side_tools_used?: number;
  tool_calls_requested?: number;
  tool_calls_executed?: number;
  x_search_calls?: number;
  x_posts_fetched?: number;
  x_users_fetched?: number;
  code_execution_calls?: number;
  file_search_calls?: number;
  mcp_calls?: number;
  document_search_calls?: number;
  image_generation_calls?: number;
  extra?: Record<string, number>;
}

export interface ImageUsageDetails {
  size?: string;
  resolution?: string;
  image_size?: string;
  aspect_ratio?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  response_format?: string;
  mime_type?: string;
  input_fidelity?: string;
}

export interface MediaUsageCounts {
  prompt_media?: number;
  completion_media?: number;
  prompt_audio?: number;
  audio_seconds?: number;
}

export interface IterationUsageDetails {
  type?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  reasoning_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  cache_creation?: CacheUsageDetails;
}

export interface UpstreamCostDetails {
  cost?: number;
  upstream_inference_cost?: number;
  upstream_inference_prompt_cost?: number;
  upstream_inference_completions_cost?: number;
  cost_in_usd_ticks?: number;
  is_byok?: boolean;
}
