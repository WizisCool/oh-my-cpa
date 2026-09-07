import React from 'react';
import { Tooltip } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { LobeIcon, getProviderDefaultIcon } from '../LobeIcon';
import { useT } from '../../i18n';
import type { UsageEvent } from '../../types/usageEvents';
import {
  eventCacheRate,
  eventTokensPerSecond,
  formatEventDuration,
  requestGroupName,
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

    // 4. Caller name
    const caller = requestGroupName(event);

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
          <div className="req-time-primary">
            <span className={`req-status-dot ${event.failed ? 'is-failed' : 'is-success'}`} />
            <Tooltip title={fullTime}>
              <time dateTime={new Date(event.timestamp_ms).toISOString()} className="req-time-text">
                {formattedTime}
              </time>
            </Tooltip>
          </div>
          <div className="req-time-sub" title={event.request_id}>
            {event.request_id || t('events.no_request_id')}
          </div>
        </div>

        {/* Column 2: 提供商（认证文件） */}
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

        {/* Column 3: 模型[推理强度] */}
        <div className="req-col req-col-model">
          <div className="req-model-primary">
            <strong className="req-model-name" title={event.model}>
              {event.model || t('events.not_captured')}
            </strong>
            {event.reasoning_effort && (
              <span className="req-effort-badge" title={`推理强度: ${event.reasoning_effort}`}>
                [{event.reasoning_effort}]
              </span>
            )}
            {!event.generate && (
              <span className="req-preflight-badge" title="预检请求 (非生成)">
                {t('events.preflight')}
              </span>
            )}
          </div>
          {event.model_alias && event.model_alias !== event.model ? (
            <span className="req-model-sub" title={`模型别名: ${event.model_alias}`}>
              别名: {event.model_alias}
            </span>
          ) : (
            <span className="req-model-sub">
              {event.service_tier || (event.failed ? t('events.filter_failed') : t('events.filter_success'))}
            </span>
          )}
        </div>

        {/* Column 4: 延时 */}
        <div className="req-col req-col-latency">
          <strong className="req-latency-val">{formatEventDuration(event.latency_ms)}</strong>
          <span className="req-ttft-val">
            TTFT {formatEventDuration(event.ttft_ms)}
          </span>
        </div>

        {/* Column 5: TPS 生成速度 */}
        <div className="req-col req-col-tps">
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

        {/* Column 6: Token（总数，输入，输出，推理） */}
        <div className="req-col req-col-tokens">
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

        {/* Column 6: 缓存率 */}
        <div className="req-col req-col-cache">
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

        {/* Column 7: 执行器 */}
        <div className="req-col req-col-executor">
          <span className="req-executor-badge" title={`执行器: ${event.executor_type || 'default'}`}>
            {event.executor_type || 'default'}
          </span>
          <span className="req-caller-sub" title={caller || event.auth_type || '—'}>
            {caller || event.auth_type || '—'}
          </span>
        </div>

        {/* Row Action Chevron */}
        <RightOutlined className="request-chevron" />
      </button>
    );
  },
);
