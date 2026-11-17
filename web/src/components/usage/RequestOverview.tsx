import React from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import { ArrowRightOutlined, DesktopOutlined, KeyOutlined, SafetyCertificateOutlined, SwapOutlined, ThunderboltFilled } from '../icons';
import { ProviderBrandIcon } from '../LobeIcon';
import { ClientMark } from '../common/ClientMark';
import { CopyButton } from '../common/CopyButton';
import { Tooltip } from '../common/Tooltip';
import { formatTokens, formatTokensFull } from '../../types/tokenDisplay';
import type { TokenNumberStyle } from '../../types/tokenDisplay';
import { formatCacheRate } from '../../theme/cacheScale';
import { effortBadgeName } from '../../theme/effortScale';
import type { UsageEventDetail } from '../../types/usageEvents';
import type { ResolvedProviderInfo } from '../../types/usageEventIdentity';
import {
  eventCacheRate,
  fastTierHintKey,
  formatEventDuration,
  hasMeasurableTTFT,
  isFastTierEvent,
  requestTransport,
  type EventTokensPerSecondResult,
} from '../../types/usageEventMetrics';
import { clientDisplayName, eventClientId } from '../../types/clientAgents';
import { requestFailureCause, tokenComposition, type TokenSegmentKey } from '../../types/requestDetailSummary';
import './RequestList.css';
import { EffortTag, Tag } from '../common/Tag';

type DetailEvent = UsageEventDetail['event'];

export interface RequestOverviewProps {
  event: DetailEvent;
  provider: ResolvedProviderInfo;
  caller?: string;
  /** The credential that answered, already masked: the OAuth account or the provider key. */
  credential?: string;
  rate: EventTokensPerSecondResult;
  durationScaleStyle?: React.CSSProperties;
  tokenStyle: TokenNumberStyle;
  onShowDiagnostics: () => void;
}

const SEGMENT_LABELS: Record<TokenSegmentKey, MessageKey> = {
  cache_read: 'events.token_seg_cache_read',
  input: 'events.token_seg_input',
  reasoning: 'events.token_seg_reasoning',
  output: 'events.token_seg_output',
};

/**
 * The request's first screen: what happened, by which way, how long it took and where the tokens
 * went, each answered by a picture with its reading beside it. Field names and raw values live in
 * the drawer's other tabs; nothing here is the only place a value can be read.
 */
export function RequestOverview({
  event,
  provider,
  caller,
  credential,
  rate,
  durationScaleStyle,
  tokenStyle,
  onShowDiagnostics,
}: RequestOverviewProps) {
  const t = useT();
  const clientId = eventClientId(event);
  return (
    <div className="req-overview">
      {event.failed && <FailureSummary event={event} onShowDiagnostics={onShowDiagnostics} />}
      <section className="req-card" aria-label={t('events.summary_route')}>
        <h3 className="req-card-title">{t('events.summary_route')}</h3>
        <ol className="req-route">
          {/* The route starts at the program that sent the request, named as the list's client
              column names it; the User-Agent it was recognised from is the exact value behind it. */}
          <RouteNode
            icon={<ClientMark id={clientId} category={event.client_agent_category} fallback={<DesktopOutlined />} />}
            label={t('events.col_client')}
            value={clientId && clientDisplayName(clientId, t)}
            tip={event.user_agent?.trim() || undefined}
          />
          <li className="req-route-link" aria-hidden><ArrowRightOutlined /></li>
          <RouteNode
            icon={<ProviderBrandIcon mark={provider} size={18} />}
            label={t('events.provider')}
            value={provider.title}
            badge={provider.isOAuth ? 'OAuth' : undefined}
          />
          <li className="req-route-link" aria-hidden><ArrowRightOutlined /></li>
          <RouteNode
            icon={provider.isOAuth ? <SafetyCertificateOutlined /> : <KeyOutlined />}
            label={t('events.credential')}
            value={credential}
          />
        </ol>
      </section>
      <TimingCard event={event} rate={rate} durationScaleStyle={durationScaleStyle} />
      <TokenCard event={event} tokenStyle={tokenStyle} />
      <SettingsCard event={event} caller={caller} />
    </div>
  );
}

function RouteNode({ icon, label, value, badge, tip }: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  badge?: string;
  /** The exact value behind a normalised one; without it, a truncated value completes itself. */
  tip?: string;
}) {
  const t = useT();
  return (
    <li className="req-route-node">
      <span className="req-route-icon" aria-hidden>{icon}</span>
      <span className="req-route-text">
        <span className="req-route-label">{label}</span>
        {/* A badge reads as part of the value, beside the name, the way the list's provider cell
            prints it; the name gives way before the badge does. */}
        <span className="req-route-value">
          <strong className={value ? undefined : 'terminal-muted'} data-tip={tip ?? value} data-tip-overflow={tip ? undefined : ''}>
            {value || t('events.not_captured')}
          </strong>
          {badge && <Tag size="small" className="req-route-badge">{badge}</Tag>}
        </span>
      </span>
    </li>
  );
}

// Only this request's own record speaks here. The correlated errors are every failure on the same
// credential within two minutes, so the first of them can belong to another request; they stay in
// the diagnostics, labelled as correlated.
function FailureSummary({ event, onShowDiagnostics }: { event: DetailEvent; onShowDiagnostics: () => void }) {
  const t = useT();
  const status = event.fail_status_code;
  const body = event.fail_body;
  const cause = requestFailureCause(status, event.fail_code);
  return (
    <section className="req-failure" aria-label={t('events.error_banner_title')}>
      <div className="req-failure-head">
        <strong className="req-failure-title">{t(`events.cause_${cause}` as MessageKey)}</strong>
        <span className="req-failure-evidence">
          {status ? `HTTP ${status}` : t('events.filter_failed')}
        </span>
      </div>
      <p className="req-failure-hint">{t(`events.cause_${cause}_hint` as MessageKey)}</p>
      {body && <pre className="req-failure-body">{body}</pre>}
      <div className="req-failure-actions">
        {body && <CopyButton showLabel text={body} label={t('events.copy_error')} />}
        <Button size="sm" variant="link" onClick={onShowDiagnostics}>
          {t('events.view_diagnostics')} →
        </Button>
      </div>
    </section>
  );
}

function TimingCard({ event, rate, durationScaleStyle }: { event: DetailEvent; rate: EventTokensPerSecondResult; durationScaleStyle?: React.CSSProperties }) {
  const t = useT();
  const latency = event.latency_ms ?? 0;
  if (latency <= 0) return null;
  const isSplit = hasMeasurableTTFT(event) && event.ttft_ms != null;
  const ttft = isSplit ? event.ttft_ms! : 0;
  const generation = Math.max(0, latency - ttft);
  // A sliver stays visible: a 2% floor keeps a 20 ms first token from vanishing beside a minute.
  const ttftShare = isSplit ? Math.min(98, Math.max(2, (ttft / latency) * 100)) : 0;
  return (
    <section className="req-card" aria-label={t('events.summary_timing')} style={durationScaleStyle}>
      <div className="req-card-head">
        <h3 className="req-card-title">{t('events.summary_timing')}</h3>
        <strong className={durationScaleStyle ? 'req-card-reading req-timing-value' : 'req-card-reading'} style={durationScaleStyle}>
          {formatEventDuration(latency)}
        </strong>
      </div>
      <div className="req-bar" role="img" aria-label={isSplit
        ? `${t('events.timing_wait')} ${formatEventDuration(ttft)}, ${t('events.timing_generate')} ${formatEventDuration(generation)}`
        : `${t('events.duration')} ${formatEventDuration(latency)}`}
      >
        {isSplit && <span className="req-bar-seg is-wait" style={{ width: `${ttftShare}%` }} />}
        <span className="req-bar-seg is-generate" style={{ width: `${100 - ttftShare}%` }} />
      </div>
      <dl className="req-legend">
        {isSplit && (
          <div>
            <dt><i className="req-swatch is-wait" />{t('events.timing_wait')}</dt>
            <dd>{formatEventDuration(ttft)}</dd>
          </div>
        )}
        {/* Unsplit, the bar is the total the card's head already reads, so it needs no line here. */}
        {isSplit && (
          <div>
            <dt><i className="req-swatch is-generate" />{t('events.timing_generate')}</dt>
            <dd>{formatEventDuration(generation)}</dd>
          </div>
        )}
        {rate.basis !== null && (
          <div>
            <dt>{t('events.timing_speed')}</dt>
            <dd>{rate.formatted}</dd>
          </div>
        )}
      </dl>
      {!isSplit && <p className="req-card-note">{t('events.timing_unsplit')}</p>}
    </section>
  );
}

function TokenCard({ event, tokenStyle }: { event: DetailEvent; tokenStyle: TokenNumberStyle }) {
  const t = useT();
  const { segments, unplacedReasoning } = tokenComposition(event.tokens);
  const drawn = segments.reduce((sum, segment) => sum + segment.value, 0);
  const cache = eventCacheRate(event.tokens);
  return (
    <section className="req-card" aria-label={t('events.summary_tokens')}>
      <div className="req-card-head">
        <h3 className="req-card-title">{t('events.summary_tokens')}</h3>
        <strong className="req-card-reading" data-tip={formatTokensFull(event.tokens.total)}>
          {formatTokens(event.tokens.total, tokenStyle)}
        </strong>
      </div>
      {drawn > 0 ? (
        <>
          <div className="req-bar" role="img" aria-label={segments.map((segment) => `${t(SEGMENT_LABELS[segment.key])} ${formatTokensFull(segment.value)}`).join(', ')}>
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={`req-bar-seg is-${segment.key}`}
                style={{ width: `${(segment.value / drawn) * 100}%` }}
              />
            ))}
          </div>
          <dl className="req-legend">
            {segments.map((segment) => (
              <div key={segment.key}>
                <dt><i className={`req-swatch is-${segment.key}`} />{t(SEGMENT_LABELS[segment.key])}</dt>
                <dd data-tip={formatTokensFull(segment.value)}>{formatTokens(segment.value, tokenStyle)}</dd>
              </div>
            ))}
            {cache.hasData && cache.cached > 0 && (
              <div>
                <dt>{t('events.cache_hit_rate')}</dt>
                <dd>{formatCacheRate(cache.rate)}</dd>
              </div>
            )}
          </dl>
        </>
      ) : (
        <p className="req-card-note">{t('events.tokens_none')}</p>
      )}
      {unplacedReasoning > 0 && (
        <p className="req-card-note">
          {t('events.token_unplaced_reasoning', { count: formatTokens(unplacedReasoning, tokenStyle) })}
        </p>
      )}
    </section>
  );
}

function SettingsCard({ event, caller }: { event: DetailEvent; caller?: string }) {
  const t = useT();
  const callModel = event.model_alias || event.model;
  const isRouted = Boolean(event.model_alias && event.model && event.model_alias !== event.model);
  const isSubstituted = Boolean(event.model_substituted && event.response_model);
  const transport = requestTransport(event);
  const isFast = isFastTierEvent(event);
  const tier = event.resolved_service_tier;
  const missing = <span className="terminal-muted">{t('events.not_captured')}</span>;
  return (
    <section className="req-card" aria-label={t('events.summary_settings')}>
      <h3 className="req-card-title">{t('events.summary_settings')}</h3>
      <div className="req-model-path">
        <span className="req-model-step">
          <span className="req-route-label">{t('events.call_model')}</span>
          <strong>{callModel || t('events.not_captured')}</strong>
        </span>
        {isRouted && (
          <>
            <ArrowRightOutlined className="req-model-arrow" aria-hidden />
            <span className="req-model-step">
              <span className="req-route-label">{t('events.request_model')}</span>
              <strong>{event.model}</strong>
            </span>
          </>
        )}
        {isSubstituted && (
          <>
            <ArrowRightOutlined className="req-model-arrow" aria-hidden />
            <span className="req-model-step">
              <span className="req-route-label">{t('events.served_model')}</span>
              <Tooltip title={t('events.served_substituted_hint')}>
                <strong className="req-model-substituted" tabIndex={0}>
                  <SwapOutlined aria-hidden /> {event.response_model}
                </strong>
              </Tooltip>
            </span>
          </>
        )}
      </div>
      <dl className="req-settings">
        <div>
          <dt>{t('events.reasoning_effort')}</dt>
          <dd>
            {effortBadgeName(event.reasoning_effort) ? <EffortTag effort={event.reasoning_effort} /> : missing}
          </dd>
        </div>
        <div>
          <dt>{t('events.setting_tier')}</dt>
          <dd>
            {tier ? (
              <span className="req-setting-tier">
                {isFast && (
                  <span className="req-fast-icon" role="img" aria-label={t(fastTierHintKey(event), { tier })}>
                    <ThunderboltFilled />
                  </span>
                )}
                {tier}
              </span>
            ) : missing}
          </dd>
        </div>
        <div>
          <dt>{t('events.transport')}</dt>
          <dd>{transport ? t(`events.transport_${transport}`) : missing}</dd>
        </div>
        {/* The second row is where the request came in: the endpoint, the key it asked with and
            the address it connected from. */}
        <div>
          <dt>{t('events.endpoint')}</dt>
          <dd className="req-settings-mono">{event.endpoint || missing}</dd>
        </div>
        <div>
          <dt>{t('events.caller')}</dt>
          <dd className="req-settings-mono">{caller || missing}</dd>
        </div>
        <div>
          <dt>{t('events.client_ip')}</dt>
          <dd className="req-settings-mono">{event.client_ip?.trim() || missing}</dd>
        </div>
      </dl>
    </section>
  );
}
