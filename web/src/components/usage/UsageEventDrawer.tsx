import { StructuredUsageView } from './StructuredUsageView';
import { formatCurrency } from '../../types/currencyDisplay';
import { useDisplayCurrency } from '../../types/CurrencyDisplayContext';
import { TokenAccountingNote } from './TokenAccountingNote';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import React from 'react';
import { Tabs } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { FactList } from '../common/FactList';
import { ParagraphPlaceholder } from '../common/ContentPlaceholder';
import {
  NonStreamOutlined,
  WebsocketOutlined,
  DownloadOutlined,
  DownOutlined,
  SwapOutlined,
  ThunderboltFilled,
  UpOutlined,
} from '../icons';
import { useQuery } from '@tanstack/react-query';
import { groupResponseHeaders, responseHeadersText } from '../../types/responseHeaderGroups';
import dayjs from '../../utils/time';
import { api, ApiError } from '../../api/client';
import { displayEffortName } from '../../theme/effortScale';
import { durationScaleMix } from '../../theme/durationScale';
import { useT } from '../../i18n';
import { maskKeyText } from '../../utils/maskKey';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { ModelMark } from '../ModelMark';
import { formatTokens, formatTokensFull } from '../../types/tokenDisplay';
import type { UsageEvent } from '../../types/usageEvents';
import {
  maskCredentialIdentities,
  resolveCredential,
  resolveProviderInfo,
  type CredentialIndex,
  type ProviderLookupEntry,
} from '../../types/usageEventIdentity';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { RequestOverview } from './RequestOverview';
import {
  formatEventDuration,
  eventTokensPerSecond,
  tpsCalculationHintKey,
  hasMeasurableTTFT,
  isFastTierEvent,
  fastTierHintKey,
  resolvedTierHintKey,
  requestTransport,
} from '../../types/usageEventMetrics';
import { requestGroupName } from '../../types/usageEventLabels';
import { requestFailureCause } from '../../types/requestDetailSummary';
import { CostBreakdownView } from '../pricing/CostBreakdownView';
import { useToast } from '../feedback';
import { LoadFailure, Notice } from '../feedback';
import { EmptyState } from '../common/EmptyState';
import { AppDrawer } from '../common/AppDrawer';
import { CopyButton } from '../common/CopyButton';
import './UsageEventDrawer.css';
import './requestMarks.css';
import { Tooltip } from '../common/Tooltip';
import { AppModal } from '../common/AppModal';

export interface UsageEventDrawerProps {
  eventId: number | null;
  credentials: CredentialIndex;
  onClose: () => void;
  events?: UsageEvent[];
  onSelectEvent?: (id: number) => void;
  /** The provider marks and names the request list resolves its rows with, so both agree. */
  providerIcons?: Record<string, string>;
  configuredProviders?: ProviderLookupEntry[];
  pluginLogos?: PluginOAuthLogos;
  multiPortalKeys?: ReadonlySet<string>;
  pluginTitles?: ReadonlyMap<string, string>;
  isProviderCatalogUnknown?: boolean;
}

export const UsageEventDrawer: React.FC<UsageEventDrawerProps> = ({
  eventId,
  onClose,
  credentials,
  events,
  onSelectEvent,
  providerIcons,
  configuredProviders,
  pluginLogos,
  multiPortalKeys,
  pluginTitles,
  isProviderCatalogUnknown,
}) => {
  useTimeZone();
  const { currency } = useDisplayCurrency();
  const t = useT();
  // The drawer's token cards follow the console's unit style; the values are
  // exact counts, so the full form is what this surface prints.
  const { style: tokenStyle, modelView, tpsMode } = useTokenDisplayStyle();
  const isCallView = modelView === 'call';
  const toast = useToast();
  const [downloadModalOpen, setDownloadModalOpen] = React.useState(false);

  const [downloading, setDownloading] = React.useState(false);
  const [tab, setTab] = React.useState('overview');
  React.useEffect(() => {
    setDownloadModalOpen(false);
    // A record opens on its overview; a panel on its way out keeps the tab it was showing.
    if (eventId != null) setTab('overview');
  }, [eventId]);
  // The panel is still on screen while it slides out, after `eventId` has cleared. It keeps
  // drawing the record it held, so what leaves is the record rather than an emptied sheet.
  const [shownId, setShownId] = React.useState(eventId);
  if (eventId != null && eventId !== shownId) setShownId(eventId);
  const recordId = eventId ?? shownId;
  const result = useQuery({
    queryKey: ['usage-event', recordId],
    queryFn: () => api.getUsageEvent(recordId!),
    enabled: eventId != null,
  });
  const event = result.data?.event;
  const failureCause = requestFailureCause(undefined, event?.fail_code);
  const identity = event ? resolveCredential(event, credentials) : undefined;
  // The credential's readable label. It is the same projection the list prints, so an
  // account and any file name built from it are masked here too; the export is the one
  // place where the operator decides to disclose the address.
  const credentialLabel = identity?.displayName ?? identity?.name;
  // `resource_name` is the discovered auth file's name, so it repeats the same identities
  // the file reports; it is a fact of its own here, not the credential label, so it is
  // masked independently rather than read from the resolved identity.
  const resourceNameLabel = event?.resource_name
    ? maskCredentialIdentities(event.resource_name, event.auth_index ? credentials.get(event.auth_index) : undefined)
    : undefined;
  // The upstream credential that answered, as the record's own response reported
  // it. Re-rendered from whatever arrived so this surface cannot print a value the
  // server never masked, and absent when the credential could not be identified.
  const providerKeyMask = maskKeyText(event?.provider_key_mask);
  // Rendered only when the server identified the credential: a record it cannot
  // attribute prints nothing here, the same as it prints no key line in the list,
  // rather than a row that reads like a fact which failed to load.
  const providerKeyFields: Array<[string, React.ReactNode]> = providerKeyMask
    ? [[t('events.provider_key'), providerKeyMask]]
    : [];
  const headerGroups = groupResponseHeaders(event?.response_headers);
  const errors = result.data?.related_errors || [];
  const isRelatedErrorsPartial = !!result.data?.partial_errors?.includes('related_errors');
  const missing = <span className="terminal-muted">{t('events.not_captured')}</span>;
  const value = (text: string | null | undefined) => text || missing;
  const transport = requestTransport(event);
  const fields = (items: Array<[string, React.ReactNode]>) => (
    <FactList
      emphasis="quiet"
      facts={items.map(([label, content], index) => ({ key: String(index), label, value: content }))}
    />
  );
  const providerInfo = event
    ? resolveProviderInfo(event, credentials, providerIcons, configuredProviders, pluginLogos, isProviderCatalogUnknown, pluginTitles, multiPortalKeys)
    : undefined;
  // The overview names the credential the way the list's provider cell does: an OAuth account,
  // else the provider key that answered, else whatever identifies the credential at all.
  const answeringCredential = providerInfo?.isOAuth
    ? providerInfo.credential || credentialLabel
    : providerKeyMask || credentialLabel;
  const section = (title: string, content: React.ReactNode) => (
    <section className="request-detail-section">
      <h3>{title}</h3>
      {content}
    </section>
  );
  const download = async () => {
    if (eventId == null || !event?.request_id) return;
    setDownloading(true);
    try {
      const blob = await api.downloadUsageEventRequestLog(eventId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${event.request_id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadModalOpen(false);
      toast.success(t('events.download_success'));
    } catch (error) {
      // CPA keeps a per-request file only while request logging is on; its absence
      // is an answer about retention, not an outage to retry.
      const isMissing = error instanceof ApiError
        && (error.data as { code?: string } | null)?.code === 'request_log_not_found';
      // Confirming again cannot produce a file CPA does not hold.
      if (isMissing) setDownloadModalOpen(false);
      toast.error(t(isMissing ? 'events.download_missing' : 'events.download_failed'));
    } finally {
      setDownloading(false);
    }
  };

  const currentIndex = events && recordId != null ? events.findIndex((e) => e.id === recordId) : -1;
  const hasPrev = events != null && currentIndex > 0;
  const hasNext = events != null && currentIndex >= 0 && currentIndex < events.length - 1;
  const prevEvent = hasPrev ? events![currentIndex - 1] : null;
  const nextEvent = hasNext ? events![currentIndex + 1] : null;

  const handlePrev = React.useCallback(() => {
    if (prevEvent && onSelectEvent) {
      onSelectEvent(prevEvent.id);
    }
  }, [prevEvent, onSelectEvent]);

  const handleNext = React.useCallback(() => {
    if (nextEvent && onSelectEvent) {
      onSelectEvent(nextEvent.id);
    }
  }, [nextEvent, onSelectEvent]);

  React.useEffect(() => {
    if (eventId == null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (e.key === '[' || (e.altKey && e.key === 'ArrowUp')) {
        e.preventDefault();
        handlePrev();
      } else if (e.key === ']' || (e.altKey && e.key === 'ArrowDown')) {
        e.preventDefault();
        handleNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [eventId, handlePrev, handleNext]);

  const drawerTitle = (
    <div className="req-drawer-title-wrapper">
      <span className="req-drawer-title-text">{t('events.details_title')}</span>
      {events && events.length > 0 && currentIndex >= 0 && (
        <div className="req-drawer-nav">
          <span className="req-drawer-nav-counter">
            {t('events.record_nav', {
              current: currentIndex + 1,
              total: events.length,
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={<UpOutlined />}
            disabled={!hasPrev}
            onClick={handlePrev}
            data-tip={`${t('events.prev_item')} ([)`}
            aria-label={t('events.prev_item')}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<DownOutlined />}
            disabled={!hasNext}
            onClick={handleNext}
            data-tip={`${t('events.next_item')} (])`}
            aria-label={t('events.next_item')}
          />
        </div>
      )}
    </div>
  );

  const rate = eventTokensPerSecond(event, tpsMode);
  // One duration reading, one ramp. The stops travel as custom properties and CSS mixes them,
  // so every readout in the drawer - the headline and the timing card - asks the same question
  // of the same three values. TTFT is detail and keeps the secondary ink.
  const durationScale = durationScaleMix(event?.latency_ms);
  const durationScaleStyle = durationScale
    ? ({
        '--duration-from': durationScale.from,
        '--duration-to': durationScale.to,
        '--duration-from-share': durationScale.fromShare,
      } as React.CSSProperties)
    : undefined;
  const isMeasurable = hasMeasurableTTFT(event);
  const displayModel = event ? (isCallView ? (event.model_alias || event.model) : event.model) : undefined;

  return (
    <AppDrawer
      widthKey="request_detail"
      title={drawerTitle}
      width="wide"
      open={eventId != null}
      onClose={onClose}
      className="request-detail"
    >
      {result.isLoading ? (
        <ParagraphPlaceholder rows={12} />
      ) : result.isError ? (
        <LoadFailure title={t('events.load_error')} error={result.error} onRetry={() => void result.refetch()} />
      ) : event && providerInfo ? (
        <>
          <header className="request-detail-hero">
            <div className="request-detail-heading">
              <div className="request-detail-model-row">
                <ModelMark model={displayModel} fallbackModel={event.model} size={22} className="req-model-mark" />
                <h2>{displayModel || t('events.not_captured')}</h2>
                {isFastTierEvent(event) && (
                  <Tooltip title={t(fastTierHintKey(event), { tier: event.resolved_service_tier ?? '' })}>
                    <span
                      className="req-mode-mark req-fast-icon"
                      role="img"
                      aria-label={t(fastTierHintKey(event), { tier: event.resolved_service_tier ?? '' })}
                    >
                      <ThunderboltFilled />
                    </span>
                  </Tooltip>
                )}
                {transport === 'websocket' && (
                  <Tooltip title={t('events.websocket_hint')}>
                    <span className="req-websocket-icon" aria-label={t('events.websocket_hint')}>
                      <WebsocketOutlined />
                    </span>
                  </Tooltip>
                )}
                {transport === 'http' && (
                  <Tooltip title={t('events.non_stream_hint')}>
                    <span className="req-non-stream-icon" aria-label={t('events.non_stream_hint')}>
                      <NonStreamOutlined />
                    </span>
                  </Tooltip>
                )}
              </div>
              <span className={`request-result ${event.failed ? 'is-failed' : 'is-success'}`}>
                <i />
                {t(event.failed ? 'events.filter_failed' : 'events.filter_success')}
              </span>
            </div>
            <div className="request-detail-id">
              <time dateTime={new Date(event.timestamp_ms).toISOString()}>
                {dayjs(event.timestamp_ms).format('YYYY-MM-DD HH:mm:ss.SSS')}
              </time>
              <span className="request-detail-id-text">{event.request_id || t('events.no_request_id')}</span>
              {event.request_id && <CopyButton text={event.request_id} label={t('events.copy_id')} />}
            </div>
            <dl className="request-detail-metrics">
              <div>
                <dt>{t('events.duration')}</dt>
                <dd className={durationScaleStyle ? 'req-timing-value' : undefined} style={durationScaleStyle}>
                  {formatEventDuration(event.latency_ms)}
                </dd>
              </div>
              <div>
                <dt>{t('events.timing_speed')}</dt>
                {rate.basis !== null ? (
                  <Tooltip title={t(tpsCalculationHintKey(rate.basis))}>
                    <dd tabIndex={0} aria-label={`${t('events.col_tps')}: ${rate.formatted}. ${t(tpsCalculationHintKey(rate.basis))}`}>{rate.formatted}</dd>
                  </Tooltip>
                ) : (
                  <dd className="terminal-muted">—</dd>
                )}
              </div>
              <div>
                <dt>{t('events.col_tokens')}</dt>
                {/* The headline is compact to match every other token readout; the exact count is the
                    accessible name, so the rounding never becomes the only number available. */}
                <dd data-tip={formatTokensFull(event.tokens.total)}>{formatTokens(event.tokens.total, tokenStyle)}</dd>
              </div>
              <div>
                <dt>{t('events.col_cost')}</dt>
                {event.cost_usd != null ? (
                  <dd>{formatCurrency(event.cost_usd, currency)}</dd>
                ) : (
                  <Tooltip title={t('events.cost_unpriced')}>
                    <dd tabIndex={0} className="terminal-muted">{t('events.cost_unpriced_short')}</dd>
                  </Tooltip>
                )}
              </div>
            </dl>
          </header>
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: 'overview',
                label: t('events.overview'),
                children: (
                  <RequestOverview
                    event={event}
                    provider={providerInfo}
                    caller={requestGroupName(event)}
                    credential={answeringCredential}
                    rate={rate}
                    durationScaleStyle={durationScaleStyle}
                    tokenStyle={tokenStyle}
                    onShowDiagnostics={() => setTab('diagnostics')}
                  />
                ),
              },
              {
                key: 'usage',
                label: t('events.usage_tab'),
                children: (
                  <>
                    <TokenAccountingNote accounting={event.token_accounting} className="request-detail-note" />
                    {section(
                      t('events.token_breakdown'),
                      fields([
                        [t('events.input_tokens'), formatTokensFull(event.tokens.input)],
                        [t('events.output_tokens'), formatTokensFull(event.tokens.output)],
                        [t('events.reasoning_tokens'), formatTokensFull(event.tokens.reasoning)],
                        [t('events.cached_tokens'), formatTokensFull(event.tokens.cached)],
                        [t('events.cache_read_tokens'), formatTokensFull(event.tokens.cache_read)],
                        [t('events.cache_creation_tokens'), formatTokensFull(event.tokens.cache_creation)],
                        [t('events.total_tokens'), formatTokensFull(event.tokens.total)],
                      ]),
                    )}
                    <p className="request-detail-note">{t('events.token_note')}</p>
                    {section(
                      t('cost.title'),
                      <CostBreakdownView breakdown={result.data?.cost_breakdown} model={event.model} costUsd={event.cost_usd} />,
                    )}
                    <StructuredUsageView details={event.structured_usage} />
                  </>
                ),
              },
              {
                key: 'diagnostics',
                label: `${t('events.diagnostics')}${errors.length ? ` (${errors.length})` : ''}`,
                children: (
                  // Sections follow the order a failure is worked out: what the upstream
                  // answered, the headers it answered with, what the credential was
                  // doing around then, who asked, and last the raw log.
                  <>
                    {event.failed && (event.fail_code || event.fail_status_code || event.fail_body)
                      ? section(
                          t('events.fail_reason'),
                          <article className="request-error">
                            <header>
                              <strong>{event.fail_status_code ? `HTTP ${event.fail_status_code}` : t('events.filter_failed')}</strong>
                            </header>
                            {event.fail_code && fields([[
                              t('events.error_code'),
                              failureCause === 'unknown'
                                ? event.fail_code
                                : `${t(`events.cause_${failureCause}`)} (${event.fail_code})`,
                            ]])}
                            {event.fail_body
                              ? <pre>{event.fail_body}</pre>
                              : <p className="request-detail-note">{t('events.fail_no_body')}</p>}
                          </article>,
                        )
                      : null}
                    {section(
                      t('events.response_headers'),
                      headerGroups.length ? (
                        <>
                          <p className="request-detail-note request-header-note">
                            <span>{t('events.response_headers_note')}</span>
                            <CopyButton text={responseHeadersText(event.response_headers ?? [])} label={t('events.response_headers_copy')} />
                          </p>
                          {headerGroups.map((group) => (
                            <div className="request-header-group" key={group.id}>
                              <h4>{t(`events.response_headers_${group.id}`)}</h4>
                              <dl>
                                {group.headers.map((header) => (
                                  <React.Fragment key={header.name}>
                                    <dt>{header.name}</dt>
                                    <dd>{header.value}</dd>
                                  </React.Fragment>
                                ))}
                              </dl>
                            </div>
                          ))}
                        </>
                      ) : (
                        <p className="request-detail-note">{t('events.response_headers_none')}</p>
                      ),
                    )}
                    {section(
                      t('events.correlated_errors'),
                      <>
                        <p className="request-detail-note">{t('events.correlation_note')}</p>
                        {isRelatedErrorsPartial && (
                          <Notice tone="warning" title={t('events.partial_errors')} />
                        )}
                        {errors.length
                          ? errors.map((error) => (
                              <article className="request-error" key={error.id}>
                                <header>
                                  <strong>HTTP {error.status_code}</strong>
                                  <span>{dayjs(error.timestamp_ms).format('MM-DD HH:mm:ss.SSS')}</span>
                                </header>
                                {fields([
                                  [t('events.error_code'), value(error.code)],
                                  [t('events.retryable'), t(error.retryable ? 'events.yes' : 'events.no')],
                                  [
                                    t('events.quota_exceeded'),
                                    t(error.quota_exceeded ? 'events.yes' : 'events.no'),
                                  ],
                                  ...(error.quota_reason
                                    ? [
                                        [t('events.quota_reason'), error.quota_reason] as [
                                          string,
                                          React.ReactNode,
                                        ],
                                      ]
                                    : []),
                                ])}
                                {error.body && <pre>{error.body}</pre>}
                              </article>
                            ))
                          : !isRelatedErrorsPartial && (
                              <EmptyState size="compact" title={t('events.no_correlated_errors')} />
                            )}
                      </>,
                    )}
                    {section(
                      t('events.network'),
                      fields([
                        [t('events.client_ip'), value(event.client_ip)],
                        ['X-Forwarded-For', value(event.x_forwarded_for)],
                        ['User-Agent', value(event.user_agent)],
                      ]),
                    )}
                    {section(
                      t('events.raw_log'),
                      <>
                        <p className="request-detail-note">{t('events.raw_log_note')}</p>
                        <Button
                          aria-label={t('events.download_log')}
                          icon={<DownloadOutlined />}
                          disabled={!event.has_request_log || !event.request_id}
                          onClick={() => setDownloadModalOpen(true)}
                        >
                          {t('events.download_log')}
                        </Button>
                        {(!event.has_request_log || !event.request_id) && (
                          <p className="request-detail-note">{t('events.log_unavailable')}</p>
                        )}
                      </>,
                    )}
                  </>
                ),
              },
              {
                key: 'raw',
                label: t('events.raw_fields'),
                children: (
                  <>
                    <p className="request-detail-note">{t('events.raw_fields_note')}</p>
                    {section(
                      t('events.routing'),
                      fields([
                        [t('events.provider'), value(event.provider)],
                        ...providerKeyFields,
                        [t('events.credential'), value(credentialLabel)],
                        [
                          t('events.identity_basis'),
                          identity ? t(`events.credential_${identity.kind}`) : missing,
                        ],
                        [t('events.resource_name'), value(resourceNameLabel)],
                        [t('events.source'), value(event.source)],
                        [t('events.auth_index'), value(event.auth_index)],
                        [t('events.auth_type'), value(event.auth_type)],
                        [t('events.access_provider'), value(event.access_provider)],
                        [
                          t('events.native_key'),
                          event.access_provider ? t(event.is_native_key ? 'events.native_key_yes' : 'events.native_key_no') : missing,
                        ],
                        [t('events.caller'), value(requestGroupName(event))],
                        [t('events.api_group_key'), value(event.api_group_key)],
                        [t('events.group_category'), value(event.api_group_label)],
                        [t('events.resource_id'), value(event.resource_id)],
                        [t('events.transport'), value(transport && t(`events.transport_${transport}`))],
                        [t('events.executor'), value(event.executor_type)],
                        [t('events.endpoint'), value(event.endpoint)],
                      ]),
                    )}
                    {section(
                      t('events.request_parameters'),
                      fields([
                        [t('events.call_model'), value(event.model_alias || event.model)],
                        [t('events.request_model'), value(event.model)],
                        [
                          t('events.served_model'),
                          event.response_model ? (
                            <span className="request-served-model" data-testid="detail-served-model">
                              <span>{event.response_model}</span>
                              {event.model_substituted && (
                                <Tooltip title={t('events.served_substituted_hint')}>
                                  <span className="request-served-flag">
                                    <SwapOutlined aria-hidden />
                                    {t('events.served_substituted')}
                                  </span>
                                </Tooltip>
                              )}
                            </span>
                          ) : (
                            <span className="terminal-muted">{t('events.served_model_unknown')}</span>
                          ),
                        ],
                        [t('events.reasoning_effort'), value(displayEffortName(event.reasoning_effort))],
                        [t('events.service_tier'), value(event.service_tier)],
                        [t('events.outbound_tier'), value(event.effective_service_tier)],
                        [t('events.response_tier'), value(event.response_service_tier)],
                        [
                          t('events.resolved_tier'),
                          event.resolved_service_tier || event.resolved_service_tier_source === 'outbound'
                            ? t(resolvedTierHintKey(event), { tier: event.resolved_service_tier || '—' })
                            : value(undefined),
                        ],
                        [
                          t('events.generation'),
                          t(event.generate ? 'events.generation_yes' : 'events.preflight'),
                        ],
                        [t('events.event_key'), value(event.event_key)],
                      ]),
                    )}
                    {section(
                      t('events.timing'),
                      fields([
                        [t('events.duration'), `${event.latency_ms.toLocaleString()} ms`],
                        ...(isMeasurable && event.ttft_ms != null
                          ? [[t('events.ttft'), `${event.ttft_ms.toLocaleString()} ms`] as [string, string]]
                          : []),
                      ]),
                    )}
                  </>
                ),
              },
            ]}
          />
        </>
      ) : null}
      <AppModal
        open={downloadModalOpen && eventId != null}
        title={t('events.download_log_confirm')}
        onOk={() => void download()}
        onCancel={() => setDownloadModalOpen(false)}
        confirmLoading={downloading}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <Notice tone="warning" description={t('events.download_log_desc')} />
        <p className="request-detail-id">Request ID: {event?.request_id}</p>
      </AppModal>
    </AppDrawer>
  );
};
