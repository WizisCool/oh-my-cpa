import { formatCurrency } from '../../types/currencyDisplay';
import { useDisplayCurrency } from '../../types/CurrencyDisplayContext';
import { tokenAccountingMessage } from './TokenAccountingNote';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';

import { NonStreamOutlined, WebsocketOutlined, ThunderboltFilled, BulbOutlined, CopyOutlined, DollarOutlined, RightOutlined, SwapOutlined } from '../icons';
import { formatRequestTimestamp } from './requestTimestamp';
import { ProviderBrandIcon } from '../LobeIcon';
import { useT } from '../../i18n';
import { useOpenPriceEditor } from '../pricing/PricingEditorContext';
import { copyText } from '../../utils/clipboard';
import { maskKeyText } from '../../utils/maskKey';
import { cacheScaleMix, formatCacheRate } from '../../theme/cacheScale';
import { durationScaleMix } from '../../theme/durationScale';
import { effortBadgeName, effortColor, effortStep } from '../../theme/effortScale';
import type { UsageEvent } from '../../types/usageEvents';
import {
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../../types/usageEventIdentity';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import {
  eventCacheRate,
  eventTokensPerSecond,
  tpsCalculationHintKey,
  formatEventDuration,
  hasMeasurableTTFT,
  isFastTierEvent,
  fastTierHintKey,
  requestTransport,
} from '../../types/usageEventMetrics';
import {
  eventKeyLabel,
  eventResultLabelKey,
  eventUserAgentLabel,
} from '../../types/usageEventLabels';
import { requestColumnAlignClass } from './requestColumns';
import { ModelMark } from '../ModelMark';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { formatTokens, formatTokensFull } from '../../types/tokenDisplay';
import { useToast } from '../feedback';
import { isRangeCheckboxClick, rowClickIntent } from '../../types/rowSelection';
import './RequestList.css';
import './requestMarks.css';

export interface RequestRowProps {
  event: UsageEvent;
  credentials: CredentialIndex;
  providerIcons?: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  /** Logos published by installed plugins, keyed by the OAuth provider they register. */
  pluginLogos?: PluginOAuthLogos;
  multiPortalKeys?: ReadonlySet<string>;
  /** Titles plugins give the OAuth providers they register. */
  pluginTitles?: ReadonlyMap<string, string>;
  /** The provider catalog read has not settled, so a resolved name is a placeholder for now. */
  isProviderCatalogUnknown?: boolean;
  onOpen: (id: number) => void;
  isSelected?: boolean;
  /** Whether the row is picked. */
  isChecked?: boolean;
  /** Whether a choice is under way: the row shows its checkbox, and a plain click picks it. */
  isSelecting?: boolean;
  /** A pick of the row; `isRange` is a Shift click, which runs from the last row picked. */
  onToggleSelect: (id: number, isRange: boolean) => void;
}

export const RequestRow = React.memo<RequestRowProps>(
  ({
    event,
    credentials,
    providerIcons = {},
    configuredProviders = [],
    pluginLogos = {},
    multiPortalKeys,
    pluginTitles,
    isProviderCatalogUnknown = false,
    onOpen,
    isSelected = false,
    isChecked = false,
    isSelecting = false,
    onToggleSelect,
  }) => {
    const timeZone = useTimeZone();
    const t = useT();
    const toast = useToast();
    const openPriceEditor = useOpenPriceEditor();
    // The console-wide token unit style: the list scans compactly while every
    // accessible name keeps the exact count.
    const { currency } = useDisplayCurrency();
  const { style: tokenStyle, tpsMode, modelView, showModelIcons } = useTokenDisplayStyle();
    const isCallView = modelView === 'call';
    const callModel = event.model_alias || event.model;
    const requestModel = event.model;
    const hasServedModel = Boolean(event.model_substituted && event.response_model);
    const hasRoutedModel = isCallView && callModel !== requestModel && Boolean(requestModel);
    const displayModel = (isCallView ? callModel : requestModel) || t('events.not_captured');

    const modelTooltip = React.useMemo(() => {
      const parts: string[] = [];
      if (event.model_alias && event.model_alias !== event.model) {
        parts.push(`${t('events.call_model')}: ${event.model_alias}`);
        parts.push(`${t('events.request_model')}: ${event.model}`);
      } else if (event.model) {
        parts.push(isCallView ? `${t('events.call_model')}: ${event.model}` : `${t('events.request_model')}: ${event.model}`);
      }
      if (event.response_model && event.model_substituted) {
        parts.push(`${t('events.served_model')}: ${event.response_model}`);
      }
      return parts.join(' · ');
    }, [event.model, event.model_alias, event.response_model, event.model_substituted, isCallView, t]);

    const providerInfo = resolveProviderInfo(
      event,
      credentials,
      providerIcons,
      configuredProviders,
      pluginLogos,
      isProviderCatalogUnknown,
      pluginTitles,
      multiPortalKeys,
    );

    // Which of the provider's keys answered this request. The server resolves it
    // from CPA's credential lists and omits it when the credential cannot be
    // identified, so an absent value prints no line at all rather than a guess.
    // An OAuth credential has no provider key - its second line names the masked
    // account instead - so the mask is confined to API-key credentials, and is
    // re-rendered here from whatever arrived: this surface can then never print a
    // credential even if a future response carried one.
    const providerKeyMask = providerInfo.isOAuth ? '' : maskKeyText(event.provider_key_mask);

    // 2. Cache rate calculation, plus its stop on the 0–100% colour scale.
    //    The scale stops are design tokens; the badge mixes them in OKLCH via
    //    CSS, so no colour is named here.
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

    const tpsInfo = eventTokensPerSecond(event, tpsMode);
    // Duration is one reading on one ramp: the stops are tokens and CSS mixes them,
    // so no colour is named here. TTFT is request detail, not a verdict on the
    // request, and stays in the secondary ink its label uses.
    const durationScale = durationScaleMix(event.latency_ms);
    const durationScaleStyle = durationScale
      ? ({
          '--duration-from': durationScale.from,
          '--duration-to': durationScale.to,
          '--duration-from-share': durationScale.fromShare,
        } as React.CSSProperties)
      : undefined;
    // The level's place on the effort scale, as a token reference; absent for
    // `none` and for a level the scale does not rank, which keep the neutral badge.
    const effortHue = effortColor(effortStep(event.reasoning_effort));
    const effortLabel = effortBadgeName(event.reasoning_effort);
    const transport = requestTransport(event);
    const isFastTier = isFastTierEvent(event);

    const keyLabel = eventKeyLabel(event);
    const uaLabel = eventUserAgentLabel(event);
    const resultLabel = t(eventResultLabelKey(event));
    const copyRequestId = () => {
      if (!event.request_id) return;
      // The quick-copy control carries no success state of its own, so a silent
      // failure would read exactly like a copy that worked.
      void copyText(event.request_id).then((copied) => {
        if (!copied) toast.error(t('common.copy_failed'));
      });
    };

    const { shortTime: formattedTime, fullTime, isoTime } = React.useMemo(
      () => ({
        ...formatRequestTimestamp(event.timestamp_ms),
        isoTime: new Date(event.timestamp_ms).toISOString(),
      }),
      [event.timestamp_ms, timeZone],
    );

    return (
      <div
        role="button"
        tabIndex={0}
        className={`request-row${isSelected ? ' is-selected' : ''}${isChecked ? ' is-checked' : ''}`}
        // Shift extends a choice, so it must not also start a text selection across the rows.
        onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
        onClick={(e) => {
          const intent = rowClickIntent(e, isSelecting);
          if (intent === 'open') onOpen(event.id);
          else onToggleSelect(event.id, intent === 'range');
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(event.id);
          }
        }}
        aria-label={`${t('common.details')}: ${displayModel}, ${event.request_id || event.id}`}
      >
        {/* The checkbox picks the row; neither a click nor a key on it may also reach the row. */}
        {isSelecting && (
          <label
            className="req-select"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              className="req-select-box"
              checked={isChecked}
              aria-label={t('events.select_row', { id: event.request_id || event.id })}
              onChange={(e) => onToggleSelect(event.id, isRangeCheckboxClick(e.nativeEvent as MouseEvent))}
            />
          </label>
        )}

        {/* Column 1: timestamp */}
        <div className={`req-col req-col-time ${requestColumnAlignClass('time')}`}>
          <time dateTime={isoTime} className="req-time-text" data-request-tooltip={fullTime}>
            {formattedTime}
          </time>
          <div className="req-time-sub">
            <span
              className="req-time-sub-id"
              data-request-tooltip={event.request_id || undefined}
              data-request-tooltip-overflow=""
            >
              {event.request_id || t('events.no_request_id')}
            </span>
            {event.request_id ? (
              <button
                type="button"
                className="req-id-quick-copy"
                data-request-tooltip={t('common.copy')}
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
        <div className={`req-col req-col-result ${requestColumnAlignClass('result')}`}>
          <span className="req-mobile-label">{t('events.col_result')}</span>
          {event.failed && event.fail_status_code ? (
            // The status is what the list knows; the popup reads the upstream's
            // error body for this record when the pill is hovered or focused.
            <span
              className="req-result-pill is-failed has-detail"
              data-request-failure={event.id}
              data-request-tooltip={`HTTP ${event.fail_status_code}`}
            >
              <i className="req-result-bullet" />
              {resultLabel}
            </span>
          ) : (
            <span
              className={`req-result-pill ${event.failed ? 'is-failed' : 'is-success'}`}
              data-request-tooltip={resultLabel}
              data-request-tooltip-overflow=""
            >
              <i className="req-result-bullet" />
              {resultLabel}
            </span>
          )}
        </div>

        {/* Column 3: provider (credential that answered) */}
        <div className={`req-col req-col-provider ${requestColumnAlignClass('provider')}`}>
          <div className="req-provider-icon-wrapper">
            <ProviderBrandIcon mark={providerInfo} size={20} />
          </div>
          <div className="req-provider-content">
            <div className="req-provider-title-row">
              <strong
                className="req-provider-title"
                data-request-tooltip={providerInfo.title}
                data-request-tooltip-overflow=""
              >
                {providerInfo.title}
              </strong>
              {providerInfo.isOAuth && (
                <span className="req-badge-oauth" data-request-tooltip={t('events.oauth_badge')}>
                  OAuth
                </span>
              )}
              {providerInfo.isIdentityUnknown && (
                <span className="req-badge-unresolved" data-request-tooltip={t('events.provider_unresolved')}>
                  {t('events.provider_unresolved_badge')}
                </span>
              )}
            </div>
            {providerInfo.isOAuth && providerInfo.credential && (
              <span
                className="req-provider-credential"
                data-request-tooltip={providerInfo.credential}
                data-request-tooltip-overflow=""
              >
                {providerInfo.credential}
              </span>
            )}
            {providerKeyMask && (
              <span
                className="req-provider-credential req-provider-key"
                data-request-tooltip={providerKeyMask}
                data-request-tooltip-overflow=""
              >
                {providerKeyMask}
              </span>
            )}
          </div>
        </div>

        {/* Column 4: model. The cell is the model's identity and nothing else: how
            the request was made has its own column, so a row is two lines at most. */}
        <div className={`req-col req-col-model ${requestColumnAlignClass('model')}`}>
          <div className="req-model-primary">
            {showModelIcons && (
              <ModelMark
                model={displayModel}
                fallbackModel={event.model}
                size={16}
                className="req-model-mark"
              />
            )}
            <strong
              className="req-model-name"
              data-request-tooltip={modelTooltip || displayModel}
              data-request-tooltip-overflow={modelTooltip ? undefined : ''}
            >
              {displayModel}
            </strong>
            {!event.generate && (
              <span className="req-preflight-badge" data-request-tooltip={t('events.preflight_hint')}>
                {t('events.preflight')}
              </span>
            )}
          </div>
          {/* Substitutions take priority over routing detail to keep the cell
              within two lines; the routed name remains in the primary tooltip. */}
          {hasServedModel && event.response_model ? (
            <span
              className="req-model-served"
              data-testid="request-served-model"
              data-request-tooltip={t('events.served_model_differs', { served: event.response_model })}
            >
              <SwapOutlined className="req-model-served-icon" aria-hidden />
              <span className="req-model-served-name">{event.response_model}</span>
            </span>
          ) : hasRoutedModel ? (
            <span
              className="req-model-routed"
              data-testid="request-routed-model"
              data-request-tooltip={`${t('events.request_model')}: ${requestModel}`}
            >
              <RightOutlined className="req-model-served-icon" aria-hidden />
              <span className="req-model-served-name">{requestModel}</span>
            </span>
          ) : null}
        </div>

        {/* Column 5: mode - the reasoning effort, then a mark per way this request
            departed from an ordinary streamed call: served on the fast lane,
            carried over a WebSocket, or answered in one piece. The requested service tier ("auto") is not
            something operators scan for and stays in the drawer. */}
        <div className={`req-col req-col-mode ${requestColumnAlignClass('mode')}`}>
          <span className="req-mobile-label">{t('events.col_mode')}</span>
          {event.reasoning_effort || isFastTier || transport === 'websocket' || transport === 'http' ? (
            <div className="req-mode-marks">
              {event.reasoning_effort && (
                <span
                  className="req-effort-badge"
                  style={effortHue ? ({ '--effort-hue': effortHue } as React.CSSProperties) : undefined}
                  data-request-tooltip={`${t('events.reasoning_effort')}: ${effortLabel}`}
                >
                  {effortLabel}
                </span>
              )}
              {isFastTier && (
                <span
                  className="req-mode-mark req-fast-icon"
                  role="img"
                  aria-label={t(fastTierHintKey(event), { tier: event.resolved_service_tier ?? '' })}
                  data-testid="request-fast-tier"
                  data-request-tooltip={t(fastTierHintKey(event), { tier: event.resolved_service_tier ?? '' })}
                >
                  <ThunderboltFilled />
                </span>
              )}
              {transport === 'websocket' && (
                <span
                  className="req-mode-mark req-websocket-icon"
                  role="img"
                  aria-label={t('events.websocket_hint')}
                  data-request-tooltip={t('events.websocket_hint')}
                >
                  <WebsocketOutlined />
                </span>
              )}
              {transport === 'http' && (
                <span
                  className="req-mode-mark req-non-stream-icon"
                  role="img"
                  aria-label={t('events.non_stream_hint')}
                  data-request-tooltip={t('events.non_stream_hint')}
                >
                  <NonStreamOutlined />
                </span>
              )}
            </div>
          ) : (
            <span className="req-mode-none">—</span>
          )}
        </div>

        {/* Column 6: output tokens per second */}
        <div className={`req-col req-col-tps ${requestColumnAlignClass('tps')}`}>
          <span className="req-mobile-label">{t('events.col_tps')}</span>
          {tpsInfo.basis !== null ? (
            <span
              className="req-tps-val"
              data-request-tooltip={`${t(tpsCalculationHintKey(tpsInfo.basis))} (${tpsInfo.formatted})`}
            >
              {tpsInfo.formatted}
            </span>
          ) : (
            <span className="req-tps-none">—</span>
          )}
        </div>

        {/* Column 7: total latency */}
        <div className={`req-col req-col-latency ${requestColumnAlignClass('latency')}`}>
          <span className="req-mobile-label">{t('events.col_latency')}</span>
          {durationScaleStyle ? (
            <strong className="req-latency-val req-timing-value" style={durationScaleStyle}>
              {formatEventDuration(event.latency_ms)}
            </strong>
          ) : (
            <strong className="req-latency-val">
              {formatEventDuration(event.latency_ms)}
            </strong>
          )}
          {hasMeasurableTTFT(event) && (
            <span className="req-ttft-val">
              TTFT {formatEventDuration(event.ttft_ms)}
            </span>
          )}
        </div>

        {/* Column 8: tokens (total, input, output, reasoning) */}
        <div className={`req-col req-col-tokens ${requestColumnAlignClass('tokens')}`}>
          <span className="req-mobile-label">{t('events.col_tokens')}</span>
          <div className="req-tokens-total">
            <strong data-request-tooltip={`${formatTokensFull(event.tokens.total)} ${t('dash.unit_tokens')}`}>{formatTokens(event.tokens.total, tokenStyle)}</strong>
            <small>tokens</small>
          </div>
          {/* The line clips an outsized count at the track's edge, so the line itself also
              carries every exact count; a visible count still answers with its own. */}
          <div
            className="req-tokens-breakdown"
            data-request-tooltip={[
              `${t('events.input_tokens')}: ${formatTokensFull(event.tokens.input)}`,
              `${t('events.output_tokens')}: ${formatTokensFull(event.tokens.output)}`,
              ...(event.tokens.reasoning > 0 ? [`${t('events.reasoning_tokens')}: ${formatTokensFull(event.tokens.reasoning)}`] : []),
            ].join(' · ')}
          >
            <span data-request-tooltip={`${t('events.input_tokens')}: ${formatTokensFull(event.tokens.input)}`}>
              ↑ {formatTokens(event.tokens.input, tokenStyle)}
            </span>
            <span data-request-tooltip={`${t('events.output_tokens')}: ${formatTokensFull(event.tokens.output)}`}>
              ↓ {formatTokens(event.tokens.output, tokenStyle)}
            </span>
            {event.tokens.reasoning > 0 && (
              <span
                className="req-tokens-reasoning"
                data-request-tooltip={`${t('events.reasoning_tokens')}: ${formatTokensFull(event.tokens.reasoning)}`}
              >
                <BulbOutlined className="req-token-icon-reasoning" />
                {formatTokens(event.tokens.reasoning, tokenStyle)}
              </span>
            )}
          </div>
        </div>

        {/* Missing prices can be configured for future requests; unresolved
            accounting cannot be repaired by changing the model's price. */}
        <div className={`req-col req-col-cost ${requestColumnAlignClass('cost')}`}>
          <span className="req-mobile-label">{t('events.col_cost')}</span>
          {event.cost_usd != null ? (
            <strong className="req-cost-val">{formatCurrency(event.cost_usd, currency)}</strong>
          ) : (
            <>
              <span
                className="req-cost-none"
                data-request-tooltip={event.token_accounting && event.token_accounting.status !== 'complete' ? tokenAccountingMessage(t, event.token_accounting) : t('events.cost_unpriced')}
              >
                —
              </span>
              {openPriceEditor && event.model && event.pricing_status !== 'legacy_unpriced' && (!event.token_accounting || event.token_accounting.status === 'complete') && (
                <button
                  type="button"
                  className="req-cost-set"
                  aria-label={t('cost.set_price', { model: event.model })}
                  data-request-tooltip={t('cost.set_price', { model: event.model })}
                  // The row opens the record; this control opens the price editor instead.
                  onClick={(e) => {
                    e.stopPropagation();
                    openPriceEditor(event.model);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  data-testid="request-set-price"
                >
                  <DollarOutlined />
                </button>
              )}
            </>
          )}
        </div>
        {/* Column 10: cache hit rate */}
        <div className={`req-col req-col-cache ${requestColumnAlignClass('cache')}`}>
          <span className="req-mobile-label">{t('events.col_cache_rate')}</span>
          {/* One badge for every reading: 0% keeps the pill and the dot — it
              is a real value, not a missing one. Only the no-data case drops
              to the neutral stop. The cached count lives in the tooltip: as a
              second line here it wrapped at six-digit volumes and pushed the
              row taller. */}
          <span
            className={`req-cache-pill${cache.hasData ? '' : ' is-empty'}`}
            style={cacheScaleStyle}
            data-request-tooltip={
              cache.hasData
                ? t('events.cache_rate_tooltip', {
                    rate: cacheLabel,
                    count: cache.cached.toLocaleString(),
                  })
                : t('events.cache_no_data')
            }
          >
            <i className="req-cache-bullet" />
            {cacheLabel}
          </span>
        </div>

        {/* Column 11: caller key, masked, and only for api_key callers;
            every other auth type falls back to the source fingerprint */}
        <div className={`req-col req-col-key ${requestColumnAlignClass('key')}`}>
          <span className="req-mobile-label">{t('events.col_key')}</span>
          <span className="req-key-val" data-request-tooltip={keyLabel} data-request-tooltip-overflow="">
            {keyLabel}
          </span>
        </div>

        {/* Column 12: user agent, already reduced to a client product label
            at ingestion */}
        <div className={`req-col req-col-ua ${requestColumnAlignClass('ua')}`}>
          <span className="req-mobile-label">{t('events.col_ua')}</span>
          <span className="req-ua-val" data-request-tooltip={uaLabel} data-request-tooltip-overflow="">
            {uaLabel}
          </span>
        </div>

        {/* Row Action Chevron */}
        <RightOutlined className="request-chevron" />
      </div>
    );
  },
);




