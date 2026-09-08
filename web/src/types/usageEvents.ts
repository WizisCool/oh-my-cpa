/**
 * Request-record types shared by the dashboard drill-down, the event table and
 * every later analytics page. The filter vocabulary matches the server's
 * UsageEventFilter so a new facet only needs adding in one place.
 */

export interface UsageEventTokens {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  cache_read: number;
  cache_creation: number;
  total: number;
}

export interface UsageEvent {
  id: number;
  event_key: string;
  request_id?: string;
  timestamp_ms: number;
  provider: string;
  endpoint?: string;
  executor_type?: string;
  auth_type?: string;
  auth_index?: string;
  api_group_key?: string;
  api_group_label?: string;
  /** Client product label, redacted and shortened on the persistence path. */
  user_agent?: string | null;
  source?: string;
  model: string;
  model_alias?: string;
  reasoning_effort?: string;
  service_tier?: string;
  response_service_tier?: string;
  failed: boolean;
  generate: boolean;
  latency_ms: number;
  ttft_ms?: number | null;
  tokens: UsageEventTokens;
  /** Set when the credential is already triaged in Oh My CPA. */
  resource_id?: string | null;
  resource_name?: string | null;
  has_request_log: boolean;
}

export interface UsageEventPage {
  window: { from: number; to: number; preset?: string };
  items: UsageEvent[];
  next_cursor?: string;
  has_more: boolean;
  limit: number;
}

export interface UsageEventRelatedError {
  id: number;
  status_code: number;
  code?: string;
  body: string;
  retryable: boolean;
  quota_exceeded: boolean;
  quota_reason?: string;
  timestamp_ms: number;
}

export interface UsageEventDetail {
  event: UsageEvent & {
    endpoint?: string;
    client_ip?: string | null;
    x_forwarded_for?: string | null;
  };
  related_errors?: UsageEventRelatedError[];
  partial_errors?: string[];
}

export interface UsageFacetValue {
  value: string;
  requests: number;
}

export interface UsageFacets {
  models: UsageFacetValue[];
  providers: UsageFacetValue[];
  api_group_keys: UsageFacetValue[];
  auth_indexes: UsageFacetValue[];
  sources: UsageFacetValue[];
  executors: UsageFacetValue[];
}

export interface UsageFacetsResponse {
  window: { from: number; to: number; bucket_ms: number };
  facets: UsageFacets;
}

export type UsageResultFilter = 'all' | 'success' | 'failed';

export interface UsageEventQuery {
  preset?: string;
  from?: number;
  to?: number;
  model?: string;
  model_alias?: string;
  api_key?: string;
  auth_index?: string;
  provider?: string;
  source?: string;
  auth_type?: string;
  executor?: string;
  result?: UsageResultFilter;
  request_id?: string;
  cursor?: string;
  limit?: number;
}

export function usageEventParams(query: UsageEventQuery): string {
  const search = new URLSearchParams();
  const assign = (key: string, value: string | number | undefined) => {
    if (value === undefined || value === '') return;
    search.set(key, String(value));
  };
  if (query.from !== undefined && query.to !== undefined) {
    assign('from', query.from);
    assign('to', query.to);
  } else {
    assign('preset', query.preset);
  }
  assign('model', query.model);
  assign('model_alias', query.model_alias);
  assign('api_key', query.api_key);
  assign('auth_index', query.auth_index);
  assign('provider', query.provider);
  assign('source', query.source);
  assign('auth_type', query.auth_type);
  assign('executor', query.executor);
  assign('result', query.result);
  assign('request_id', query.request_id);
  assign('cursor', query.cursor);
  assign('limit', query.limit);
  return search.toString();
}
