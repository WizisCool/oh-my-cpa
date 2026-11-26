import type { TFunc } from '../../i18n/catalog';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { RequestCostBreakdown } from '../../types/pricing';
import type { StructuredUsageDetails } from '../../types/structuredUsage';
import type { TokenAccounting, TokenAccountingStatus } from '../../types/tokenAccounting';
import type { TpsCalculationBasis, TpsCalculationMode } from '../../types/tpsCalculation';
import {
  maskCredentialIdentities,
  resolveCredential,
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
  type ProviderResolutionArchive,
} from '../../types/usageEventIdentity';
import { requestGroupName } from '../../types/usageEventLabels';
import { eventTokensPerSecond, hasMeasurableTTFT, requestTransport, resolvedTierHintKey } from '../../types/usageEventMetrics';
import type {
  RequestFailureCode,
  UsageEventDetail,
  UsageEventDetailSection,
  UsageEventResponseHeader,
  UsageEventTokens,
  UsageTransport,
} from '../../types/usageEvents';
import { maskEmailAddresses } from '../../utils/maskAccount';
import { maskKeyText } from '../../utils/maskKey';

/** Bumped when a field is renamed or changes meaning so parsers know the document shape. */
export const REQUEST_RECORD_LOG_SCHEMA = 'omc.request.log.v1';

export type RequestRecordLogFormat = 'log' | 'json';

export interface RequestRecordLogInput {
  detail: UsageEventDetail;
  tpsMode: TpsCalculationMode;
  exportedAt?: Date;
  credentials: CredentialIndex;
  configuredProviders?: ProviderLookupEntry[];
  pluginLogos?: PluginOAuthLogos;
  multiPortalKeys?: ReadonlySet<string>;
  pluginTitles?: ReadonlyMap<string, string>;
  isProviderCatalogUnknown?: boolean;
  archive?: ProviderResolutionArchive;
}

export interface RequestRecordLogErrorEntry {
  id: number;
  timestamp: string;
  timestamp_ms: number;
  status_code: number;
  code?: string;
  retryable: boolean;
  quota_exceeded: boolean;
  quota_reason?: string;
  body?: string;
}

export interface RequestRecordLogDocument {
  schema: typeof REQUEST_RECORD_LOG_SCHEMA;
  exported_at: string;
  request: {
    id: number;
    event_key: string;
    request_id?: string;
    timestamp: string;
    timestamp_ms: number;
    status: 'success' | 'failed';
    failed: boolean;
    generate: boolean;
    stream?: boolean;
    transport?: UsageTransport;
    endpoint?: string;
  };
  model: {
    requested: string;
    alias?: string;
    served?: string;
    substituted?: boolean;
    reasoning_effort?: string;
    service_tier?: string;
    effective_service_tier?: string;
    response_service_tier?: string;
    resolved_service_tier?: string;
    resolved_service_tier_source?: 'request' | 'response' | 'outbound';
  };
  routing: {
    provider: string;
    provider_title?: string;
    is_oauth: boolean;
    credential?: string;
    identity_basis?: 'resource' | 'current_file' | 'source' | 'index' | 'unknown';
    resource_id?: string;
    resource_name?: string;
    auth_type?: string;
    auth_index?: string;
    executor_type?: string;
    source?: string;
    provider_key_mask?: string;
    access_provider?: string;
    is_native_key?: boolean;
    caller?: string;
    api_group_label?: string;
    api_key_alias?: string;
    api_key_mask?: string;
  };
  timing: {
    latency_ms: number;
    ttft_ms?: number;
    tokens_per_second?: number;
    tps_basis?: TpsCalculationBasis;
    tps_mode: TpsCalculationMode;
  };
  tokens: UsageEventTokens & {
    accounting_status?: TokenAccountingStatus;
    token_accounting?: TokenAccounting;
  };
  cost: {
    cost_usd?: number;
    pricing_status?: 'priced' | 'unpriced' | 'legacy_unpriced' | 'invalid_price';
    price_version_id?: number;
    breakdown?: RequestCostBreakdown;
  };
  structured_usage?: StructuredUsageDetails;
  client?: {
    client_agent?: string;
    client_agent_category?: string;
    client_ip?: string;
    x_forwarded_for?: string;
    user_agent?: string;
  };
  upstream?: {
    fail_status_code?: number;
    fail_code?: RequestFailureCode;
    fail_body?: string;
    response_headers?: UsageEventResponseHeader[];
  };
  related_errors?: RequestRecordLogErrorEntry[];
  partial_errors?: UsageEventDetailSection[];
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeRecordFileStem(requestId: string): string {
  const cleaned = requestId.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  return cleaned.slice(0, 80);
}

/**
 * Names a single-record OMC log download distinctly from CPA's `request-<id>.log` so saving both
 * for the same request never collides on disk. Records without a CPA request id fall back to
 * their OMC event id so every record still gets a deterministic filename.
 */
export function requestRecordLogFileName(
  event: Pick<UsageEventDetail['event'], 'id' | 'request_id'>,
  format: RequestRecordLogFormat,
): string {
  const stem = event.request_id ? sanitizeRecordFileStem(event.request_id) : '';
  const base = stem ? `record-${stem}` : `record-event-${event.id}`;
  return `${base}.${format}`;
}

/**
 * Builds an allowlisted, privacy-safe single-record diagnostic snapshot from OMC's stored detail.
 *
 * Every field is copied by name (never spread) so future columns stay out until classified.
 * `api_group_key` is deliberately excluded because it carries an HMAC fingerprint derived from
 * a secret, and OAuth account addresses / file names / keys are always kept in their masked forms.
 */
export function buildRequestRecordLog(input: RequestRecordLogInput): RequestRecordLogDocument {
  const { detail, credentials } = input;
  const event = detail.event;
  const exportedAt = (input.exportedAt ?? new Date()).toISOString();
  const credentialFile = event.auth_index ? credentials.get(event.auth_index) : undefined;
  const identity = resolveCredential(event, credentials);
  const providerInfo = resolveProviderInfo(
    event,
    credentials,
    undefined,
    input.configuredProviders,
    input.pluginLogos,
    input.isProviderCatalogUnknown,
    input.pluginTitles,
    input.multiPortalKeys,
    input.archive,
  );
  const credentialLabel = identity?.displayName ?? identity?.name;
  const providerKeyMask = nonEmpty(maskKeyText(event.provider_key_mask));
  const answeringCredential = nonEmpty(
    providerInfo.isOAuth
      ? providerInfo.credential || credentialLabel
      : providerKeyMask || credentialLabel,
  );
  const maskText = (raw: string) => maskEmailAddresses(maskCredentialIdentities(raw, credentialFile));
  const safeCredential = answeringCredential ? maskText(answeringCredential) : undefined;
  const resourceName = nonEmpty(event.resource_name) ? maskText(event.resource_name!) : undefined;
  const source = nonEmpty(event.source) ? maskText(event.source!) : undefined;
  const apiKeyMask = nonEmpty(maskKeyText(event.api_key_mask));
  const caller = nonEmpty(requestGroupName(event));
  const transport = requestTransport(event);
  const rate = eventTokensPerSecond(event, input.tpsMode);

  const request: RequestRecordLogDocument['request'] = {
    id: event.id,
    event_key: event.event_key,
    ...(nonEmpty(event.request_id) ? { request_id: nonEmpty(event.request_id) } : {}),
    timestamp: new Date(event.timestamp_ms).toISOString(),
    timestamp_ms: event.timestamp_ms,
    status: event.failed ? 'failed' : 'success',
    failed: event.failed,
    generate: event.generate,
    ...(typeof event.stream === 'boolean' ? { stream: event.stream } : {}),
    ...(transport ? { transport } : {}),
    ...(nonEmpty(event.endpoint) ? { endpoint: nonEmpty(event.endpoint) } : {}),
  };

  const model: RequestRecordLogDocument['model'] = {
    requested: event.model,
    ...(nonEmpty(event.model_alias) ? { alias: nonEmpty(event.model_alias) } : {}),
    ...(nonEmpty(event.response_model) ? { served: nonEmpty(event.response_model) } : {}),
    ...(event.model_substituted !== undefined ? { substituted: event.model_substituted } : {}),
    ...(nonEmpty(event.reasoning_effort) ? { reasoning_effort: nonEmpty(event.reasoning_effort) } : {}),
    ...(nonEmpty(event.service_tier) ? { service_tier: nonEmpty(event.service_tier) } : {}),
    ...(nonEmpty(event.effective_service_tier) ? { effective_service_tier: nonEmpty(event.effective_service_tier) } : {}),
    ...(nonEmpty(event.response_service_tier) ? { response_service_tier: nonEmpty(event.response_service_tier) } : {}),
    ...(nonEmpty(event.resolved_service_tier) ? { resolved_service_tier: nonEmpty(event.resolved_service_tier) } : {}),
    ...(event.resolved_service_tier_source ? { resolved_service_tier_source: event.resolved_service_tier_source } : {}),
  };

  const routing: RequestRecordLogDocument['routing'] = {
    provider: event.provider,
    ...(nonEmpty(providerInfo.title) ? { provider_title: maskText(nonEmpty(providerInfo.title)!) } : {}),
    is_oauth: providerInfo.isOAuth,
    ...(safeCredential ? { credential: safeCredential } : {}),
    ...(identity ? { identity_basis: identity.kind } : {}),
    ...(nonEmpty(event.resource_id) ? { resource_id: nonEmpty(event.resource_id) } : {}),
    ...(resourceName ? { resource_name: resourceName } : {}),
    ...(nonEmpty(event.auth_type) ? { auth_type: nonEmpty(event.auth_type) } : {}),
    ...(nonEmpty(event.auth_index) ? { auth_index: nonEmpty(event.auth_index) } : {}),
    ...(nonEmpty(event.executor_type) ? { executor_type: nonEmpty(event.executor_type) } : {}),
    ...(source ? { source } : {}),
    ...(providerKeyMask ? { provider_key_mask: providerKeyMask } : {}),
    ...(nonEmpty(event.access_provider) ? { access_provider: nonEmpty(event.access_provider) } : {}),
    ...(nonEmpty(event.access_provider) && typeof event.is_native_key === 'boolean'
      ? { is_native_key: event.is_native_key }
      : {}),
    ...(caller ? { caller } : {}),
    ...(nonEmpty(event.api_group_label) ? { api_group_label: nonEmpty(event.api_group_label) } : {}),
    ...(nonEmpty(event.api_key_alias) ? { api_key_alias: nonEmpty(event.api_key_alias) } : {}),
    ...(apiKeyMask ? { api_key_mask: apiKeyMask } : {}),
  };

  const timing: RequestRecordLogDocument['timing'] = {
    latency_ms: event.latency_ms,
    ...(hasMeasurableTTFT(event) && event.ttft_ms != null ? { ttft_ms: event.ttft_ms } : {}),
    ...(rate.tps != null ? { tokens_per_second: rate.tps } : {}),
    ...(rate.basis != null ? { tps_basis: rate.basis } : {}),
    tps_mode: input.tpsMode,
  };

  const tokens: RequestRecordLogDocument['tokens'] = {
    input: event.tokens.input,
    output: event.tokens.output,
    reasoning: event.tokens.reasoning,
    cached: event.tokens.cached,
    cache_read: event.tokens.cache_read,
    cache_creation: event.tokens.cache_creation,
    total: event.tokens.total,
    ...(event.accounting_status ? { accounting_status: event.accounting_status } : {}),
    ...(event.token_accounting ? { token_accounting: event.token_accounting } : {}),
  };

  const cost: RequestRecordLogDocument['cost'] = {
    ...(event.cost_usd != null ? { cost_usd: event.cost_usd } : {}),
    ...(event.pricing_status ? { pricing_status: event.pricing_status } : {}),
    ...(event.price_version_id != null ? { price_version_id: event.price_version_id } : {}),
    ...(detail.cost_breakdown ? { breakdown: detail.cost_breakdown } : {}),
  };

  const clientEntries: NonNullable<RequestRecordLogDocument['client']> = {
    ...(nonEmpty(event.client_agent) ? { client_agent: nonEmpty(event.client_agent) } : {}),
    ...(nonEmpty(event.client_agent_category) ? { client_agent_category: nonEmpty(event.client_agent_category) } : {}),
    ...(nonEmpty(event.client_ip) ? { client_ip: nonEmpty(event.client_ip) } : {}),
    ...(nonEmpty(event.x_forwarded_for) ? { x_forwarded_for: nonEmpty(event.x_forwarded_for) } : {}),
    ...(nonEmpty(event.user_agent) ? { user_agent: nonEmpty(event.user_agent) } : {}),
  };

  const responseHeaders = (event.response_headers ?? [])
    .filter((header) => header.name || header.value)
    .map((header) => ({ name: header.name, value: maskText(header.value) }));
  const upstreamEntries: NonNullable<RequestRecordLogDocument['upstream']> = {
    ...(event.failed && event.fail_status_code ? { fail_status_code: event.fail_status_code } : {}),
    ...(event.failed && event.fail_code ? { fail_code: event.fail_code } : {}),
    ...(event.failed && nonEmpty(event.fail_body) ? { fail_body: maskText(event.fail_body!) } : {}),
    ...(responseHeaders.length > 0 ? { response_headers: responseHeaders } : {}),
  };

  const relatedErrors = (detail.related_errors ?? []).map<RequestRecordLogErrorEntry>((item) => ({
    id: item.id,
    timestamp: new Date(item.timestamp_ms).toISOString(),
    timestamp_ms: item.timestamp_ms,
    status_code: item.status_code,
    ...(nonEmpty(item.code) ? { code: nonEmpty(item.code) } : {}),
    retryable: item.retryable,
    quota_exceeded: item.quota_exceeded,
    ...(nonEmpty(item.quota_reason) ? { quota_reason: maskText(nonEmpty(item.quota_reason)!) } : {}),
    ...(nonEmpty(item.body) ? { body: maskText(item.body) } : {}),
  }));

  return {
    schema: REQUEST_RECORD_LOG_SCHEMA,
    exported_at: exportedAt,
    request,
    model,
    routing,
    timing,
    tokens,
    cost,
    ...(event.structured_usage ? { structured_usage: event.structured_usage } : {}),
    ...(Object.keys(clientEntries).length > 0 ? { client: clientEntries } : {}),
    ...(Object.keys(upstreamEntries).length > 0 ? { upstream: upstreamEntries } : {}),
    ...(relatedErrors.length > 0 ? { related_errors: relatedErrors } : {}),
    ...(detail.partial_errors && detail.partial_errors.length > 0 ? { partial_errors: detail.partial_errors } : {}),
  };
}

function appendSection(sections: string[], title: string, lines: string[]): void {
  if (lines.length === 0) return;
  sections.push(`=== ${title} ===\n${lines.join('\n')}`);
}

function kv(label: string, value: string | number | boolean | undefined): string | null {
  if (value === undefined || value === '') return null;
  return `${label}: ${String(value)}`;
}

function presentLines(entries: Array<string | null>): string[] {
  return entries.filter((line): line is string => line !== null);
}

function formatAccountingStatus(status: TokenAccountingStatus | undefined, t: TFunc): string | undefined {
  switch (status) {
    case 'legacy': return t('events.accounting_status_legacy');
    case 'complete': return t('events.accounting_status_complete');
    case 'unsupported': return t('events.accounting_status_unsupported');
    case 'invalid': return t('events.accounting_status_invalid');
    case 'inconsistent': return t('events.accounting_status_inconsistent');
    case 'unclassified': return t('events.accounting_status_unclassified');
    default: return undefined;
  }
}

function formatPricingStatus(
  status: RequestRecordLogDocument['cost']['pricing_status'],
  t: TFunc,
): string | undefined {
  switch (status) {
    case 'priced': return t('events.cost_priced');
    case 'unpriced': return t('events.cost_unpriced_short');
    case 'legacy_unpriced': return t('events.record_log_pricing_legacy_unpriced');
    case 'invalid_price': return t('events.record_log_pricing_invalid_price');
    default: return undefined;
  }
}

/**
 * Formats a structured request-record document as a grep-friendly, localized `.log` text file.
 * JSON exports keep English field names and schema identifiers unchanged.
 */
export function formatRequestRecordLog(doc: RequestRecordLogDocument, t: TFunc): string {
  const sections: string[] = [];
  const boolText = (value: boolean | undefined) => (value === undefined ? undefined : t(value ? 'events.yes' : 'events.no'));

  appendSection(sections, t('events.details_title'), presentLines([
    kv(t('events.record_log_schema'), doc.schema),
    kv(t('events.record_log_exported_at'), doc.exported_at),
    kv(t('events.record_log_event_id'), doc.request.id),
    kv(t('events.col_request_id'), doc.request.request_id),
    kv(t('events.event_key'), doc.request.event_key),
    kv(t('events.col_time'), `${doc.request.timestamp} (${doc.request.timestamp_ms})`),
    kv(t('events.col_result'), t(doc.request.failed ? 'events.filter_failed' : 'events.filter_success')),
    kv(t('events.endpoint'), doc.request.endpoint),
    kv(t('events.transport'), doc.request.transport ? t(`events.transport_${doc.request.transport}`) : undefined),
    kv(t('events.record_log_stream'), boolText(doc.request.stream)),
    kv(t('events.generation'), t(doc.request.generate ? 'events.generation_yes' : 'events.preflight')),
  ]));

  const resolvedTierText = doc.model.resolved_service_tier
    ? (doc.model.resolved_service_tier_source
      ? t(resolvedTierHintKey({ resolved_service_tier_source: doc.model.resolved_service_tier_source }), { tier: doc.model.resolved_service_tier })
      : doc.model.resolved_service_tier)
    : undefined;

  appendSection(sections, t('events.request_parameters'), presentLines([
    kv(t('events.request_model'), doc.model.requested),
    kv(t('events.call_model'), doc.model.alias),
    kv(t('events.served_model'), doc.model.served),
    kv(t('events.served_substituted'), boolText(doc.model.substituted)),
    kv(t('events.reasoning_effort'), doc.model.reasoning_effort),
    kv(t('events.service_tier'), doc.model.service_tier),
    kv(t('events.outbound_tier'), doc.model.effective_service_tier),
    kv(t('events.response_tier'), doc.model.response_service_tier),
    kv(t('events.resolved_tier'), resolvedTierText),
  ]));

  appendSection(sections, t('events.routing'), presentLines([
    kv(t('events.provider'), doc.routing.provider),
    kv(t('events.record_log_provider_name'), doc.routing.provider_title),
    kv(t('events.auth_type'), doc.routing.auth_type),
    kv(t('events.auth_index'), doc.routing.auth_index),
    kv(t('events.executor'), doc.routing.executor_type),
    kv(t('events.credential'), doc.routing.credential),
    kv(t('events.identity_basis'), doc.routing.identity_basis ? t(`events.credential_${doc.routing.identity_basis}`) : undefined),
    kv(t('events.resource_id'), doc.routing.resource_id),
    kv(t('events.resource_name'), doc.routing.resource_name),
    kv(t('events.provider_key'), doc.routing.provider_key_mask),
    kv(t('events.source'), doc.routing.source),
    kv(t('events.access_provider'), doc.routing.access_provider),
    kv(t('events.native_key'), boolText(doc.routing.is_native_key)),
    kv(t('events.caller'), doc.routing.caller),
    kv(t('events.group_category'), doc.routing.api_group_label),
    kv(t('events.record_log_api_key_alias'), doc.routing.api_key_alias),
    kv(t('events.record_log_api_key_mask'), doc.routing.api_key_mask),
  ]));

  const unitMS = t('events.unit_ms');
  appendSection(sections, t('events.record_log_section_timing_tokens'), presentLines([
    kv(t('events.duration'), `${doc.timing.latency_ms} ${unitMS}`),
    doc.timing.ttft_ms != null ? kv(t('events.ttft'), `${doc.timing.ttft_ms} ${unitMS}`) : null,
    doc.timing.tokens_per_second != null
      ? kv(t('events.col_tps'), `${doc.timing.tokens_per_second.toFixed(2)} (${doc.timing.tps_basis ?? doc.timing.tps_mode})`)
      : null,
    kv(t('events.input_tokens'), doc.tokens.input),
    kv(t('events.output_tokens'), doc.tokens.output),
    kv(t('events.reasoning_tokens'), doc.tokens.reasoning),
    kv(t('events.cached_tokens'), doc.tokens.cached),
    kv(t('events.cache_read_tokens'), doc.tokens.cache_read),
    kv(t('events.cache_creation_tokens'), doc.tokens.cache_creation),
    kv(t('events.total_tokens'), doc.tokens.total),
    kv(t('events.record_log_accounting_status'), formatAccountingStatus(doc.tokens.accounting_status, t)),
  ]));

  const billingTierText = doc.cost.breakdown?.service_tier
    ? (doc.cost.breakdown.service_tier_source
      ? t(resolvedTierHintKey({ resolved_service_tier_source: doc.cost.breakdown.service_tier_source }), { tier: doc.cost.breakdown.service_tier })
      : doc.cost.breakdown.service_tier)
    : undefined;

  const costLines = presentLines([
    doc.cost.cost_usd != null ? kv(`${t('events.col_cost')} (USD)`, doc.cost.cost_usd) : null,
    kv(t('events.cost_state'), formatPricingStatus(doc.cost.pricing_status, t)),
    doc.cost.price_version_id != null ? kv(t('events.record_log_price_version'), doc.cost.price_version_id) : null,
    kv(t('events.setting_tier'), billingTierText),
    doc.cost.breakdown?.channel?.channel
      ? kv(t('events.record_log_pricing_channel'), `${doc.cost.breakdown.channel.channel} (x${doc.cost.breakdown.channel.multiplier})`)
      : null,
    doc.cost.breakdown?.invalid_reason ? kv(t('events.record_log_pricing_invalid'), doc.cost.breakdown.invalid_reason) : null,
  ]);
  if (doc.partial_errors?.includes('cost_breakdown')) {
    costLines.push(`${t('events.record_log_note')}: ${t('events.record_log_cost_partial')}`);
  }
  appendSection(sections, t('cost.title'), costLines);

  if (doc.structured_usage) {
    appendSection(sections, t('events.detail_group_title'), [JSON.stringify(doc.structured_usage, null, 2)]);
  }

  if (doc.client) {
    appendSection(sections, t('events.network'), presentLines([
      kv(t('events.col_client'), doc.client.client_agent),
      kv(t('events.record_log_client_category'), doc.client.client_agent_category),
      kv(t('events.client_ip'), doc.client.client_ip),
      kv('X-Forwarded-For', doc.client.x_forwarded_for),
      kv('User-Agent', doc.client.user_agent),
    ]));
  }

  if (doc.upstream) {
    const upstreamLines = presentLines([
      doc.upstream.fail_status_code ? kv(t('events.record_log_http_status'), doc.upstream.fail_status_code) : null,
      kv(t('events.error_code'), doc.upstream.fail_code),
    ]);
    if (doc.upstream.response_headers && doc.upstream.response_headers.length > 0) {
      if (upstreamLines.length > 0) upstreamLines.push('');
      upstreamLines.push(`${t('events.response_headers')}:`);
      for (const header of doc.upstream.response_headers) {
        upstreamLines.push(`  ${header.name}: ${header.value}`);
      }
    }
    if (doc.upstream.fail_body) {
      if (upstreamLines.length > 0) upstreamLines.push('');
      upstreamLines.push(`${t('events.record_log_error_body')}:`);
      upstreamLines.push(doc.upstream.fail_body);
    }
    appendSection(sections, t('events.fail_reason'), upstreamLines);
  }

  if ((doc.related_errors && doc.related_errors.length > 0) || doc.partial_errors?.includes('related_errors')) {
    const errorLines: string[] = [];
    if (doc.partial_errors?.includes('related_errors')) {
      errorLines.push(`${t('events.record_log_note')}: ${t('events.partial_errors')}`);
    }
    for (const [index, item] of (doc.related_errors ?? []).entries()) {
      if (errorLines.length > 0) errorLines.push('');
      errorLines.push(`[#${index + 1}] ${item.timestamp} HTTP ${item.status_code}`);
      for (const detailLine of presentLines([
        kv(t('events.record_log_error_id'), item.id),
        kv(t('events.error_code'), item.code),
        kv(t('events.retryable'), boolText(item.retryable)),
        kv(t('events.quota_exceeded'), boolText(item.quota_exceeded)),
        kv(t('events.quota_reason'), item.quota_reason),
      ])) {
        errorLines.push(`  ${detailLine}`);
      }
      if (item.body) {
        errorLines.push(`  ${t('events.record_log_error_body')}:`);
        for (const bodyLine of item.body.split('\n')) {
          errorLines.push(`    ${bodyLine}`);
        }
      }
    }
    appendSection(sections, t('events.correlated_errors'), errorLines);
  }

  return `${sections.join('\n\n')}\n`;
}

export function buildRequestRecordLogBlob(
  input: RequestRecordLogInput,
  format: RequestRecordLogFormat,
  t: TFunc,
): { blob: Blob; fileName: string; text: string } {
  const doc = buildRequestRecordLog(input);
  const text = format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : formatRequestRecordLog(doc, t);
  const mime = format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8';
  return {
    blob: new Blob([text], { type: mime }),
    fileName: requestRecordLogFileName(input.detail.event, format),
    text,
  };
}
