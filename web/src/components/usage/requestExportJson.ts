import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { TpsCalculationMode } from '../../types/tpsCalculation';
import {
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../../types/usageEventIdentity';
import { eventTokensPerSecond } from '../../types/usageEventMetrics';
import type { UsageEvent } from '../../types/usageEvents';
import { maskKeyText } from '../../utils/maskKey';
import type { RequestMaskId } from './requestSelection';

/** Bumped when a field is renamed or changes meaning, so a script can tell which shape it is reading. */
export const REQUEST_EXPORT_SCHEMA = 'omc.requests.v1';

export interface RequestExportDocument {
  schema: typeof REQUEST_EXPORT_SCHEMA;
  exported_at: string;
  count: number;
  /** What was withheld, so an absent field reads as "redacted" and not as "unknown". */
  redacted: RequestMaskId[];
  tps_basis: TpsCalculationMode;
  requests: Record<string, unknown>[];
}

export interface RequestExportInput {
  rows: readonly UsageEvent[];
  masks: ReadonlySet<RequestMaskId>;
  exportedAt: Date;
  tpsMode: TpsCalculationMode;
  credentials: CredentialIndex;
  configuredProviders?: ProviderLookupEntry[];
  pluginLogos?: PluginOAuthLogos;
}

/**
 * buildRequestExport turns the selected records into the document a script reads.
 *
 * The values are the stored ones - milliseconds, token counts, dollars - not the
 * list's formatted text, because the reader is a program. Every field is written
 * by name: a field added to the record later stays out of the file until someone
 * decides which redaction it falls under, where spreading the record would have
 * exported it unredacted by default. The caller key's fingerprint is never
 * written; it is derived from a secret and an analysis has the alias and the mask.
 *
 * A withheld field is absent rather than null, and `redacted` says why. The
 * credential's `auth_index` survives an account redaction on purpose: it is
 * CPA's opaque runtime index, so requests can still be grouped by the account
 * that answered without the file naming it.
 */
export function buildRequestExport(input: RequestExportInput): RequestExportDocument {
  const { masks } = input;
  const requests = input.rows.map((event) => {
    const provider = resolveProviderInfo(
      event,
      input.credentials,
      undefined,
      input.configuredProviders,
      undefined,
      input.pluginLogos,
    );
    const record: Record<string, unknown> = { id: event.id };
    const put = (key: string, value: unknown) => {
      if (value !== undefined && value !== null && value !== '') record[key] = value;
    };

    if (!masks.has('time')) {
      put('timestamp', new Date(event.timestamp_ms).toISOString());
      put('timestamp_ms', event.timestamp_ms);
      if (!masks.has('request_id')) put('request_id', event.request_id);
    }
    put('endpoint', event.endpoint);
    if (!masks.has('result')) {
      put('failed', event.failed);
      put('generate', event.generate);
    }
    if (!masks.has('provider')) {
      put('provider', event.provider);
      put('auth_type', provider.isOAuth ? 'oauth' : event.auth_type);
      put('executor_type', event.executor_type);
      put('auth_index', event.auth_index);
      if (!provider.isOAuth) {
        put('source', event.source);
        put('resource_name', event.resource_name);
        if (!masks.has('provider_key')) put('provider_key_mask', maskKeyText(event.provider_key_mask));
      } else if (!masks.has('provider_account')) {
        put('account', provider.title);
        put('source', event.source);
        put('resource_name', event.resource_name);
      }
    }
    if (!masks.has('model')) {
      put('model', event.model);
      put('model_alias', event.model_alias);
      put('response_model', event.response_model);
      put('model_substituted', event.model_substituted);
    }
    if (!masks.has('mode')) {
      put('reasoning_effort', event.reasoning_effort);
      put('service_tier', event.service_tier);
      put('response_service_tier', event.response_service_tier);
      put('stream', event.stream);
    }
    if (!masks.has('latency')) {
      put('latency_ms', event.latency_ms);
      put('ttft_ms', event.ttft_ms);
    }
    if (!masks.has('tps')) put('tokens_per_second', eventTokensPerSecond(event, input.tpsMode).tps);
    if (!masks.has('tokens')) {
      const { cached, cache_read: cacheRead, cache_creation: cacheCreation, ...counts } = event.tokens;
      put('tokens', masks.has('cache') ? counts : { ...counts, cached, cache_read: cacheRead, cache_creation: cacheCreation });
    }
    if (!masks.has('cost')) {
      put('cost_usd', event.cost_usd);
      put('pricing_status', event.pricing_status);
    }
    if (!masks.has('key')) {
      put('api_key_alias', event.api_key_alias);
      put('api_key_mask', event.api_key_mask);
    }
    if (!masks.has('ua')) put('user_agent', event.user_agent);
    return record;
  });

  return {
    schema: REQUEST_EXPORT_SCHEMA,
    exported_at: input.exportedAt.toISOString(),
    count: requests.length,
    redacted: [...masks].sort(),
    tps_basis: input.tpsMode,
    requests,
  };
}
