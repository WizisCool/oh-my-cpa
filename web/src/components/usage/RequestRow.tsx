import React from 'react';
import { Tooltip } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { LobeIcon, getProviderDefaultIcon } from '../LobeIcon';
import { useT } from '../../i18n';
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

export interface RequestRowProps {
  event: UsageEvent;
  credentials: CredentialIndex;
  providerIcons?: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  onOpen: (id: number) => void;
}

export const RequestRow = React.memo<RequestRowProps>(
  ({
    event,
    credentials,
    providerIcons = {},
    configuredProviders = [],
    onOpen,
  }) => {
    const t = useT();

    // 1. Resolve Provider Info (AI Provider vs OAuth credential)
    const providerInfo = resolveProviderInfo(
      event,
      credentials,
      providerIcons,
      configuredProviders,
      getProviderDefaultIcon,
    );

    // 2. Cache rate calculation
    const cache = eventCacheRate(event.tokens);

    // 3. Tokens Per Second (TPS) calculation
    const tpsInfo = eventTokensPerSecond(event);

    // 4. Caller key / group label shown in the Key column
    const keyLabel = eventKeyLabel(event);
    const uaLabel = eventUserAgentLabel(event);
    const resultLabel = t(eventResultLabelKey(event));

    const formattedTime = dayjs(event.timestamp_ms).format('MM-DD HH:mm:ss');
    const fullTime = dayjs(event.timestamp_ms).format('YYYY-MM-DD HH:mm:ss.SSS');

    return (
      <button
        type="button"
        className="request-row"
        onClick={() => onOpen(event.id)}
        aria-label={`${t('common.details')}: ${event.model}, ${event.request_id || event.id}`}
      >
        {/* Column 1: 时间 */}
        <div className="req-col req-col-time">
          <Tooltip title={fullTime}>
            <time dateTime={new Date(event.timestamp_ms).toISOString()} className="req-time-text">
              {formattedTime}
            </time>
          </Tooltip>
          <div className="req-time-sub" title={event.request_id}>
            {event.request_id || t('events.no_request_id')}
          </div>
        </div>

        {/* Column 2: 结果 (成功/失败 胶囊) */}
        <div className="req-col req-col-result">
          <span className="req-mobile-label">{t('events.col_result')}</span>
          <span
            className={`req-result-pill ${event.failed ? 'is-failed' : 'is-success'}`}
            title={resultLabel}
          >
            <i className="req-result-bullet" />
            {resultLabel}
          </span>
        </div>

        {/* Column 3: 提供商（认证文件） */}
        <div className="req-col req-col-provider">
          <div className="req-provider-icon-wrapper">
            <LobeIcon iconId={providerInfo.iconId} size={20} />
          </div>
          <div className="req-provider-content">
            <div className="req-provider-title-row">
              <strong className="req-provider-title" title={providerInfo.title}>
                {providerInfo.title}
              </strong>
              {providerInfo.isOAuth && (
                <span className="req-badge-oauth" title="OAuth 授权账号">
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

        {/* Column 4: 模型（上：模型名，下：推理强度） */}
        <div className="req-col req-col-model">
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
              <span className="req-preflight-badge" title="预检请求 (非生成)">
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
                [{event.reasoning_effort}]
              </span>
            ) : (
              '—'
            )}
          </span>
        </div>

        {/* Column 5: 延时 */}
        <div className="req-col req-col-latency">
          <span className="req-mobile-label">{t('events.col_latency')}</span>
          <strong className="req-latency-val">{formatEventDuration(event.latency_ms)}</strong>
          <span className="req-ttft-val">
            TTFT {formatEventDuration(event.ttft_ms)}
          </span>
        </div>

        {/* Column 6: TPS 生成速度 */}
        <div className="req-col req-col-tps">
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

        {/* Column 7: Token（总数，输入，输出，推理） */}
        <div className="req-col req-col-tokens">
          <span className="req-mobile-label">{t('events.col_tokens')}</span>
          <div className="req-tokens-total">
            <strong>{event.tokens.total.toLocaleString()}</strong>
            <small>tokens</small>
          </div>
          <div className="req-tokens-breakdown">
            <span title={`输入 Tokens: ${event.tokens.input.toLocaleString()}`}>
              ↑ {event.tokens.input.toLocaleString()}
            </span>
            <span title={`输出 Tokens: ${event.tokens.output.toLocaleString()}`}>
              ↓ {event.tokens.output.toLocaleString()}
            </span>
            {event.tokens.reasoning > 0 && (
              <span
                className="req-tokens-reasoning"
                title={`推理 Tokens: ${event.tokens.reasoning.toLocaleString()}`}
              >
                🧠 {event.tokens.reasoning.toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* Column 8: 缓存率 */}
        <div className="req-col req-col-cache">
          <span className="req-mobile-label">{t('events.col_cache_rate')}</span>
          {cache.hasData && cache.cached > 0 ? (
            <Tooltip
              title={`缓存命中率: ${cache.formatted} (命中 ${cache.cached.toLocaleString()} 缓存 Tokens)`}
            >
              <div className="req-cache-hit">
                <span className="req-cache-pill">
                  <i className="req-cache-bullet" />
                  {cache.formatted}
                </span>
                <span className="req-cache-count">{cache.cached.toLocaleString()} hit</span>
              </div>
            </Tooltip>
          ) : (
            <span className="req-cache-none" title="无缓存命中">
              0%
            </span>
          )}
        </div>

        {/* Column 9: 执行器 */}
        <div className="req-col req-col-executor">
          <span className="req-mobile-label">{t('events.col_executor')}</span>
          <span className="req-executor-badge" title={`执行器: ${event.executor_type || 'default'}`}>
            {event.executor_type || 'default'}
          </span>
          <span className="req-caller-sub" title={event.auth_type || '—'}>
            {event.auth_type || '—'}
          </span>
        </div>

        {/* Column 10: Key（仅 api_key 类别的调用方 Key，掩码展示；其他类别回退到来源指纹） */}
        <div className="req-col req-col-key">
          <span className="req-mobile-label">{t('events.col_key')}</span>
          <span className="req-key-val" title={keyLabel}>
            {keyLabel}
          </span>
        </div>

        {/* Column 11: UA（入库已最小化的客户端产品标签） */}
        <div className="req-col req-col-ua">
          <span className="req-mobile-label">{t('events.col_ua')}</span>
          <span className="req-ua-val" title={uaLabel}>
            {uaLabel}
          </span>
        </div>

        {/* Row Action Chevron */}
        <RightOutlined className="request-chevron" />
      </button>
    );
  },
);
