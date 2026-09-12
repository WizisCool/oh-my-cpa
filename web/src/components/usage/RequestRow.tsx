import React from 'react';
import { Tooltip } from 'antd';
import { BulbOutlined, CopyOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { LobeIcon, getProviderDefaultIcon } from '../LobeIcon';
import { useT } from '../../i18n';
import { cacheScaleMix, formatCacheRate } from '../../theme/cacheScale';
import type { UsageEvent } from '../../types/usageEvents';
import {
  eventCacheRate,
  eventKeyLabel,
  eventResultLabelKey,
  eventTokensPerSecond,
  eventUserAgentLabel,
  formatEventDuration,
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../../types/usageEventView';
import { requestColumnAlignClass, type RequestColumnId } from './requestColumns';

// The alignment class comes from the shared column definition, so every cell here
// is aligned by the same rule the header uses rather than by a parallel list.
const alignClass = (id: RequestColumnId) => requestColumnAlignClass(id);

export interface RequestRowProps {
  event: UsageEvent;
  credentials: CredentialIndex;
  providerIcons?: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  onOpen: (id: number) => void;
  isSelected?: boolean;
}

export const RequestRow = React.memo<RequestRowProps>(
  ({
    event,
    credentials,
    providerIcons = {},
    configuredProviders = [],
    onOpen,
    isSelected = false,
  }) => {
    const t = useT();

    const providerInfo = resolveProviderInfo(
      event,
      credentials,
      providerIcons,
      configuredProviders,
      getProviderDefaultIcon,
    );

    // 2. Cache rate calculation, plus its stop on the 0–100% colour scale.
    //    The scale stops are design tokens; the badge mixes them in OKLCH via
    //    CSS, so no colour is named here (docs/design.md §2).
    const cache = eventCacheRate(event.tokens);
    const cacheLabel = cache.hasData ? formatCacheRate(cache.rate) : '—';
    const cacheScale = cacheScaleMix(cache.rate);
    const cacheScaleStyle = cache.hasData
      ? ({
          '--cache-rate-from': cacheScale.from,
          '--cache-rate-to': cacheScale.to,
          '--cache-rate-from-share': cacheScale.fromShare,
        } as React.CSSProperties)
      : undefined;

    const tpsInfo = eventTokensPerSecond(event);

    const keyLabel = eventKeyLabel(event);
    const uaLabel = eventUserAgentLabel(event);
    const resultLabel = t(eventResultLabelKey(event));
    const copyRequestId = () => {
      if (!event.request_id || !navigator.clipboard) return;
      void navigator.clipboard.writeText(event.request_id).catch(() => undefined);
    };

    const formattedTime = dayjs(event.timestamp_ms).format('MM-DD HH:mm:ss');
    const fullTime = dayjs(event.timestamp_ms).format('YYYY-MM-DD HH:mm:ss.SSS');

    return (
      <div
        role="button"
        tabIndex={0}
        className={`request-row${isSelected ? ' is-selected' : ''}`}
        onClick={() => onOpen(event.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(event.id);
          }
        }}
        aria-label={`${t('common.details')}: ${event.model}, ${event.request_id || event.id}`}
      >
        {/* Column 1: timestamp */}
        <div className={`req-col req-col-time ${alignClass('time')}`}>
          <Tooltip title={fullTime}>
            <time dateTime={new Date(event.timestamp_ms).toISOString()} className="req-time-text">
              {formattedTime}
            </time>
          </Tooltip>
          <div className="req-time-sub" title={event.request_id}>
            <span>{event.request_id || t('events.no_request_id')}</span>
            {event.request_id ? (
              <button
                type="button"
                className="req-id-quick-copy"
                title={t('common.copy')}
                aria-label={`${t('common.copy')}: ${event.request_id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  copyRequestId();
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <CopyOutlined />
              </button>
            ) : null}
          </div>
        </div>

        {/* Column 2: outcome (success/failure pill) */}
        <div className={`req-col req-col-result ${alignClass('result')}`}>
          <span className="req-mobile-label">{t('events.col_result')}</span>
          <span
            className={`req-result-pill ${event.failed ? 'is-failed' : 'is-success'}`}
            title={resultLabel}
          >
            <i className="req-result-bullet" />
            {resultLabel}
          </span>
        </div>

        {/* Column 3: provider (credential that answered) */}
        <div className={`req-col req-col-provider ${alignClass('provider')}`}>
          <div className="req-provider-icon-wrapper">
            <LobeIcon iconId={providerInfo.iconId} size={20} />
          </div>
          <div className="req-provider-content">
            <div className="req-provider-title-row">
              <strong className="req-provider-title" title={providerInfo.title}>
                {providerInfo.title}
              </strong>
              {providerInfo.isOAuth && (
                <span className="req-badge-oauth" title={t('events.oauth_badge')}>
                  OAuth
                </span>
              )}
            </div>
            {providerInfo.subtitle && (
              <span className="req-provider-sub" title={providerInfo.subtitle}>
                {providerInfo.subtitle}
              </span>
            )}
          </div>
        </div>

        {/* Column 4: model, with reasoning effort underneath */}
        <div className={`req-col req-col-model ${alignClass('model')}`}>
          <div className="req-model-primary">
            <strong
              className="req-model-name"
              title={
                event.model_alias && event.model_alias !== event.model
                  ? `${event.model || ''} · ${t('events.model_alias')}: ${event.model_alias}`
                  : event.model
              }
            >
              {event.model || t('events.not_captured')}
            </strong>
            {!event.generate && (
              <span className="req-preflight-badge" title={t('events.preflight_hint')}>
                {t('events.preflight')}
              </span>
            )}
          </div>
          {/* The requested service tier ("auto") is not a model fact operators
              scan for; the alias and the tier stay in the detail drawer. */}
          <span className="req-model-sub">
            {event.reasoning_effort ? (
              <span
                className="req-effort-badge"
                title={`${t('events.reasoning_effort')}: ${event.reasoning_effort}`}
              >
                {event.reasoning_effort}
              </span>
            ) : (
              '—'
            )}
          </span>
        </div>

        {/* Column 5: total latency */}
        <div className={`req-col req-col-latency ${alignClass('latency')}`}>
          <span className="req-mobile-label">{t('events.col_latency')}</span>
          <strong className="req-latency-val">
            {formatEventDuration(event.latency_ms)}
          </strong>
          <span className="req-ttft-val">
            TTFT {formatEventDuration(event.ttft_ms)}
          </span>
        </div>

        {/* Column 6: generation speed in tokens per second */}
        <div className={`req-col req-col-tps ${alignClass('tps')}`}>
          <span className="req-mobile-label">{t('events.col_tps')}</span>
          {tpsInfo.tps !== null ? (
            <Tooltip
              title={
                tpsInfo.hasTTFT
                  ? `${t('events.tps_hint_ttft')} (${tpsInfo.formatted})`
                  : `${t('events.tps_hint_total')} (${tpsInfo.formatted})`
              }
            >
              <span className="req-tps-val">{tpsInfo.formatted}</span>
            </Tooltip>
          ) : (
            <span className="req-tps-none">—</span>
          )}
        </div>

        {/* Column 7: tokens (total, input, output, reasoning) */}
        <div className={`req-col req-col-tokens ${alignClass('tokens')}`}>
          <span className="req-mobile-label">{t('events.col_tokens')}</span>
          <div className="req-tokens-total">
            <strong>{event.tokens.total.toLocaleString()}</strong>
            <small>tokens</small>
          </div>
          <div className="req-tokens-breakdown">
            <span title={`${t('events.input_tokens')}: ${event.tokens.input.toLocaleString()}`}>
              ↑ {event.tokens.input.toLocaleString()}
            </span>
            <span title={`${t('events.output_tokens')}: ${event.tokens.output.toLocaleString()}`}>
              ↓ {event.tokens.output.toLocaleString()}
            </span>
            {event.tokens.reasoning > 0 && (
              <span
                className="req-tokens-reasoning"
                title={`${t('events.reasoning_tokens')}: ${event.tokens.reasoning.toLocaleString()}`}
              >
                <BulbOutlined className="req-token-icon-reasoning" />
                {event.tokens.reasoning.toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* Column 8: cost, locked at request time; unpriced stays an em dash
            rather than a fabricated 0 */}
        <div className={`req-col req-col-cost ${alignClass('cost')}`}>
          <span className="req-mobile-label">{t('events.col_cost')}</span>
          {event.cost_usd != null ? (
            <strong className="req-cost-val">${event.cost_usd.toFixed(4)}</strong>
          ) : (
            <Tooltip title={t('events.cost_unpriced')}>
              <span className="req-cost-none">—</span>
            </Tooltip>
          )}
        </div>
        {/* Column 9: cache hit rate */}
        <div className={`req-col req-col-cache ${alignClass('cache')}`}>
          <span className="req-mobile-label">{t('events.col_cache_rate')}</span>
          <Tooltip
            title={
              cache.hasData
                ? t('events.cache_rate_tooltip', {
                    rate: cacheLabel,
                    count: cache.cached.toLocaleString(),
                  })
                : t('events.cache_no_data')
            }
          >
            <div className="req-cache-hit">
              {/* One badge for every reading: 0% keeps the pill, the dot and the
                  count line — it is a real value, not a missing one. Only the
                  no-data case drops to the neutral stop. */}
              <span
                className={`req-cache-pill${cache.hasData ? '' : ' is-empty'}`}
                style={cacheScaleStyle}
              >
                <i className="req-cache-bullet" />
                {cacheLabel}
              </span>
              {cache.hasData && (
                <span className="req-cache-count">
                  {t('events.cache_hit_count', { count: cache.cached.toLocaleString() })}
                </span>
              )}
            </div>
          </Tooltip>
        </div>

        {/* Column 10: caller key, masked, and only for api_key callers;
            every other auth type falls back to the source fingerprint */}
        <div className={`req-col req-col-key ${alignClass('key')}`}>
          <span className="req-mobile-label">{t('events.col_key')}</span>
          <span className="req-key-val" title={keyLabel}>
            {keyLabel}
          </span>
        </div>

        {/* Column 11: user agent, already reduced to a client product label
            at ingestion */}
        <div className={`req-col req-col-ua ${alignClass('ua')}`}>
          <span className="req-mobile-label">{t('events.col_ua')}</span>
          <span className="req-ua-val" title={uaLabel}>
            {uaLabel}
          </span>
        </div>

        {/* Row Action Chevron */}
        <RightOutlined className="request-chevron" />
      </div>
    );
  },
);




