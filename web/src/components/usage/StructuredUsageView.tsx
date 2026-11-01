import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import type { StructuredUsageDetails, CacheUsageDetails } from '../../types/structuredUsage';
import { FactList, type Fact } from '../common/FactList';

const FIELD_LABELS = {
  image_search_calls: 'events.detail_image_search_calls',
  tool_use_prompt_tokens: 'events.detail_tool_use_prompt_tokens',
  google_maps_chunks: 'events.detail_google_maps_chunks',

  cache_creation_5m_tokens: 'events.detail_cache_creation_5m_tokens',
  cache_creation_30m_tokens: 'events.detail_cache_creation_30m_tokens',
  cache_creation_1h_tokens: 'events.detail_cache_creation_1h_tokens',
  cache_creation_12h_tokens: 'events.detail_cache_creation_12h_tokens',
  text_input_tokens: 'events.detail_text_input_tokens',
  image_input_tokens: 'events.detail_image_input_tokens',
  audio_input_tokens: 'events.detail_audio_input_tokens',
  video_input_tokens: 'events.detail_video_input_tokens',
  file_input_tokens: 'events.detail_file_input_tokens',
  cached_text_tokens: 'events.detail_cached_text_tokens',
  text_output_tokens: 'events.detail_text_output_tokens',
  image_output_tokens: 'events.detail_image_output_tokens',
  audio_output_tokens: 'events.detail_audio_output_tokens',
  accepted_prediction_tokens: 'events.detail_accepted_prediction_tokens',
  rejected_prediction_tokens: 'events.detail_rejected_prediction_tokens',
  mode: 'events.detail_mode',
  ttl: 'events.detail_ttl',
  retention: 'events.detail_retention',
  ephemeral_5m_input_tokens: 'events.detail_ephemeral_5m_input_tokens',
  ephemeral_30m_input_tokens: 'events.detail_ephemeral_30m_input_tokens',
  ephemeral_1h_input_tokens: 'events.detail_ephemeral_1h_input_tokens',
  ephemeral_12h_input_tokens: 'events.detail_ephemeral_12h_input_tokens',
  web_search_calls: 'events.detail_web_search_calls',
  web_search_queries: 'events.detail_web_search_queries',
  web_fetch_calls: 'events.detail_web_fetch_calls',
  num_search_results: 'events.detail_num_search_results',
  num_sources_used: 'events.detail_num_sources_used',
  num_server_side_tools_used: 'events.detail_num_server_side_tools_used',
  tool_calls_requested: 'events.detail_tool_calls_requested',
  tool_calls_executed: 'events.detail_tool_calls_executed',
  x_search_calls: 'events.detail_x_search_calls',
  x_posts_fetched: 'events.detail_x_posts_fetched',
  x_users_fetched: 'events.detail_x_users_fetched',
  code_execution_calls: 'events.detail_code_execution_calls',
  file_search_calls: 'events.detail_file_search_calls',
  mcp_calls: 'events.detail_mcp_calls',
  document_search_calls: 'events.detail_document_search_calls',
  image_generation_calls: 'events.detail_image_generation_calls',
  size: 'events.detail_size',
  resolution: 'events.detail_resolution',
  image_size: 'events.detail_image_size',
  aspect_ratio: 'events.detail_aspect_ratio',
  quality: 'events.detail_quality',
  background: 'events.detail_background',
  output_format: 'events.detail_output_format',
  response_format: 'events.detail_response_format',
  mime_type: 'events.detail_mime_type',
  input_fidelity: 'events.detail_input_fidelity',
  prompt_media: 'events.detail_prompt_media',
  completion_media: 'events.detail_completion_media',
  prompt_audio: 'events.detail_prompt_audio',
  audio_seconds: 'events.detail_audio_seconds',
  type: 'events.detail_type',
  model: 'events.detail_model',
  input_tokens: 'events.detail_input_tokens',
  output_tokens: 'events.detail_output_tokens',
  thinking_tokens: 'events.detail_thinking_tokens',
  reasoning_tokens: 'events.detail_reasoning_tokens',
  cache_read_input_tokens: 'events.detail_cache_read_input_tokens',
  cache_creation_input_tokens: 'events.detail_cache_creation_input_tokens',
  cost: 'events.detail_cost',
  upstream_inference_cost: 'events.detail_upstream_inference_cost',
  upstream_inference_prompt_cost: 'events.detail_upstream_inference_prompt_cost',
  upstream_inference_completions_cost: 'events.detail_upstream_inference_completions_cost',
  cost_in_usd_ticks: 'events.detail_cost_in_usd_ticks',
  is_byok: 'events.detail_is_byok',
  speed: 'events.detail_speed',
  inference_geo: 'events.detail_inference_geo',
  upstream_service_tier: 'events.detail_upstream_service_tier',
  web_search_requests: 'events.detail_web_search_requests',
  image_count: 'events.detail_image_count',
} as const satisfies Record<string, MessageKey>;

const NUMBERS = new Intl.NumberFormat('en', { maximumSignificantDigits: 17 });

export function StructuredUsageView({ details }: { details?: StructuredUsageDetails | null }) {
  const t = useT();
  const facts = (values?: object | null): Fact[] => Object.entries(values ?? {}).flatMap(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(FIELD_LABELS, key)) return [];
    const label = FIELD_LABELS[key as keyof typeof FIELD_LABELS];
    if (!label || value == null || value === '' || typeof value === 'object') return [];
    return [{ key, label: t(label), value: typeof value === 'number' ? NUMBERS.format(value)
      : typeof value === 'boolean' ? t(value ? 'events.detail_group_yes' : 'events.detail_group_no') : value }];
  });
  const list = (rows: Fact[]) => rows.length ? <FactList emphasis="quiet" facts={rows} /> : null;
  const namedCounters = (label: MessageKey, values?: Record<string, number>) => {
    if (!values || !Object.keys(values).length) return null;
    return <div><h4>{t(label)}</h4>{list(Object.entries(values).map(([key, value]) => ({ key, label: Object.prototype.hasOwnProperty.call(FIELD_LABELS, key) ? t(FIELD_LABELS[key as keyof typeof FIELD_LABELS]) : key, value: NUMBERS.format(value) })))}</div>;
  };
  const cache = (values?: CacheUsageDetails) => <>{list(facts(values))}{namedCounters('events.detail_group_by_ttl', values?.by_ttl)}</>;
  const group = (label: MessageKey, values?: object, extra?: ReactNode) => {
    if (!values) return null;
    return <section className="request-detail-section"><h3>{t(label)}</h3>{list(facts(values))}{extra}</section>;
  };

  return <section className="request-detail-section" aria-label={t('events.detail_group_title')}>
    <h3>{t('events.detail_group_title')}</h3>
    {!details ? <p className="request-detail-note">{t('events.not_captured')}</p> : <>
      <p className="request-detail-note">{t('events.detail_group_note')}</p>
      {details.is_partial && <p role="status" className="request-detail-note">{t('events.detail_group_partial')}</p>}
      {group('events.detail_group_tokens', details.tokens)}
      {group('events.detail_group_cache', details.cache_details, namedCounters('events.detail_group_by_ttl', details.cache_details?.by_ttl))}
      {group('events.detail_group_tools', details.tool_usage_details, namedCounters('events.detail_group_extra', details.tool_usage_details?.extra))}
      {group('events.detail_group_requested_image', details.requested_image_details)}
      {group('events.detail_group_observed_image', details.image_details)}
      {group('events.detail_group_media', details.media_counts)}
      {facts(details).length > 0 && group('events.detail_group_execution', details)}
      {details.iterations?.map((iteration, index) => <section className="request-detail-section" key={index} aria-label={t('events.detail_group_iteration', { n: index + 1 })}>
        <h3>{t('events.detail_group_iteration', { n: index + 1 })}</h3>
        {list(facts(iteration))}
        {cache(iteration.cache_creation)}
        {!Object.keys(iteration).length && <p className="request-detail-note">{t('events.not_captured')}</p>}
      </section>)}
      {group('events.detail_group_costs', details.cost_details, <p className="request-detail-note">{t('events.detail_group_cost_note')}</p>)}
    </>}
  </section>;
}
