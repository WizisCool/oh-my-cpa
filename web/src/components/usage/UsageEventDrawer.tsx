import React from 'react';
import { Alert, App as AntdApp, Button, Descriptions, Drawer, Empty, Modal, Skeleton, Tabs, Tooltip } from 'antd';
import {
  ArrowRightOutlined,
  BlockOutlined,
  CopyOutlined,
  DownloadOutlined,
  DownOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { copyText } from '../../utils/clipboard';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { formatTokens, formatTokensFull } from '../../types/tokenDisplay';
import type { UsageEvent } from '../../types/usageEvents';
import {
  resolveCredential,
  type CredentialIndex,
} from '../../types/usageEventIdentity';
import {
  formatEventDuration,
  hasMeasurableTTFT,
  isNonStreamingEvent,
} from '../../types/usageEventMetrics';
import { requestGroupName } from '../../types/usageEventLabels';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';

export interface UsageEventDrawerProps {
  eventId: number | null;
  credentials: CredentialIndex;
  onClose: () => void;
  events?: UsageEvent[];
  onSelectEvent?: (id: number) => void;
}

export const UsageEventDrawer: React.FC<UsageEventDrawerProps> = ({
  eventId,
  onClose,
  credentials,
  events,
  onSelectEvent,
}) => {
  const t = useT();
  // The drawer's token cards follow the console's unit style; the values are
  // exact counts, so the full form is what this surface prints.
  const { style: tokenStyle } = useTokenDisplayStyle();
  const { message } = AntdApp.useApp();
  const [downloadModalOpen, setDownloadModalOpen] = React.useState(false);

  // The drawer and the download confirmation over it are two overlays on one stack, so Back
  // closes the confirmation first and the record second - the order the reader sees them in.
  useOverlayHistory({ isOpen: eventId != null, onClose });
  useOverlayHistory({
    isOpen: downloadModalOpen && eventId != null,
    onClose: () => setDownloadModalOpen(false),
  });
  const [downloading, setDownloading] = React.useState(false);
  const [tab, setTab] = React.useState('overview');
  React.useEffect(() => {
    setTab('overview');
    setDownloadModalOpen(false);
  }, [eventId]);
  const result = useQuery({
    queryKey: ['usage-event', eventId],
    queryFn: () => api.getUsageEvent(eventId!),
    enabled: eventId != null,
  });
  const event = result.data?.event;
  const identity = event ? resolveCredential(event, credentials) : undefined;
  const errors = result.data?.related_errors || [];
  const missing = <span className="terminal-muted">{t('events.not_captured')}</span>;
  const value = (text: string | null | undefined) => text || missing;
  const fields = (items: Array<[string, React.ReactNode]>) => (
    <Descriptions
      size="small"
      column={1}
      colon={false}
      items={items.map(([label, children], index) => ({ key: index, label, children }))}
    />
  );
  const section = (title: string, content: React.ReactNode) => (
    <section className="request-detail-section">
      <h3>{title}</h3>
      {content}
    </section>
  );
  const copy = async (text: string) => {
    if (await copyText(text)) {
      message.success(t('res.copied'));
      return;
    }
    message.error(t('events.copy_failed'));
  };
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
      message.success(t('events.download_success'));
    } catch {
      message.error(t('events.download_failed'));
    } finally {
      setDownloading(false);
    }
  };

  const currentIndex = events && eventId != null ? events.findIndex((e) => e.id === eventId) : -1;
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
            size="small"
            type="text"
            icon={<UpOutlined />}
            disabled={!hasPrev}
            onClick={handlePrev}
            title={`${t('events.prev_item')} ([)`}
            aria-label={t('events.prev_item')}
          />
          <Button
            size="small"
            type="text"
            icon={<DownOutlined />}
            disabled={!hasNext}
            onClick={handleNext}
            title={`${t('events.next_item')} (])`}
            aria-label={t('events.next_item')}
          />
        </div>
      )}
    </div>
  );

  const latency = event?.latency_ms ?? 0;
  const isMeasurable = hasMeasurableTTFT(event);
  const ttft = isMeasurable && event?.ttft_ms != null ? event.ttft_ms : 0;
  const streamTime = Math.max(0, latency - ttft);
  const ttftPercent = latency > 0 && ttft > 0 ? Math.min(100, Math.max(2, (ttft / latency) * 100)) : 0;
  const streamPercent = latency > 0 && streamTime > 0 ? Math.min(100 - ttftPercent, Math.max(2, (streamTime / latency) * 100)) : 0;

  return (
    <Drawer
      title={drawerTitle}
      size={720}
      open={eventId != null}
      onClose={onClose}
      className="request-detail"
      closable={{ 'aria-label': t('common.close') }}
    >
      {result.isLoading ? (
        <Skeleton active={false} paragraph={{ rows: 12 }} />
      ) : result.isError ? (
        <Alert
          type="error"
          showIcon
          title={t('events.load_error')}
          description={result.error instanceof Error ? result.error.message : undefined}
          action={<Button onClick={() => void result.refetch()}>{t('common.retry')}</Button>}
        />
      ) : event ? (
        <>
          <div className="request-detail-hero">
            <div className="request-detail-heading">
              <div className="request-detail-model-row">
                <h2>{event.model || t('events.not_captured')}</h2>
                {isNonStreamingEvent(event) && (
                  <Tooltip title={t('events.non_stream_hint')}>
                    <span className="req-non-stream-icon" aria-label={t('events.non_stream_hint')}>
                      <BlockOutlined />
                    </span>
                  </Tooltip>
                )}
              </div>
              <span className={`request-result ${event.failed ? 'is-failed' : ''}`}>
                <i />
                {t(event.failed ? 'events.filter_failed' : 'events.filter_success')}
              </span>
            </div>
            <div className="request-detail-id">
              <span>{event.request_id || t('events.no_request_id')}</span>
              {event.request_id && (
                <Button
                  size="small"
                  type="text"
                  icon={<CopyOutlined />}
                  aria-label={t('events.copy_id')}
                  onClick={() => void copy(event.request_id!)}
                />
              )}
            </div>
            <p className="request-window">{dayjs(event.timestamp_ms).format('YYYY-MM-DD HH:mm:ss.SSS')}</p>
          </div>
          <div className="request-detail-metrics">
            <div>
              <span>{t('events.duration')}</span>
              <strong>{formatEventDuration(event.latency_ms)}</strong>
            </div>
            {isMeasurable && (
              <div>
                <span>{t('events.ttft')}</span>
                <strong>{formatEventDuration(event.ttft_ms)}</strong>
              </div>
            )}
            <div>
              <span>{t('events.col_tokens')}</span>
              {/* The headline is compact to match every other token readout; the exact count is the
                  accessible name, so the rounding never becomes the only number available. */}
              <strong title={formatTokensFull(event.tokens.total)}>{formatTokens(event.tokens.total, tokenStyle)}</strong>
            </div>
            <div>
              <span>{t('events.col_cost')}</span>
              <strong>{event.cost_usd != null ? `$${event.cost_usd.toFixed(4)}` : '—'}</strong>
            </div>
          </div>
          <Tabs
            activeKey={tab}
            onChange={setTab}
            animated={false}
            items={[
              {
                key: 'overview',
                label: t('events.overview'),
                children: (
                  <>
                    {event.failed && (
                      <div className="req-overview-error-card">
                        <div className="req-overview-error-top">
                          <span className="req-overview-error-status">
                            {errors.length > 0 ? `HTTP: ${errors[0].status_code}` : t('events.filter_failed')}
                          </span>
                          <span className="req-overview-error-code">
                            {errors.length > 0 ? errors[0].code || 'ERROR' : t('events.error_banner_title')}
                          </span>
                          <div className="req-overview-error-btns">
                            {errors.length > 0 && errors[0].body && (
                              <Button
                                size="small"
                                type="text"
                                icon={<CopyOutlined />}
                                onClick={() => void copy(errors[0].body || '')}
                              >
                                {t('events.copy_error')}
                              </Button>
                            )}
                            <Button
                              size="small"
                              type="link"
                              onClick={() => setTab('diagnostics')}
                            >
                              {t('events.view_diagnostics')} →
                            </Button>
                          </div>
                        </div>
                        {errors.length > 0 && errors[0].quota_reason && (
                          <div className="req-overview-error-reason">{errors[0].quota_reason}</div>
                        )}
                        {errors.length > 0 && errors[0].body && (
                          <pre className="req-overview-error-body">{errors[0].body}</pre>
                        )}
                      </div>
                    )}
                    <div className="request-source-chain" aria-label={t('events.routing')}>
                      <div>
                        <span>{t('events.caller')}</span>
                        <strong>{value(requestGroupName(event))}</strong>
                      </div>
                      <ArrowRightOutlined />
                      <div>
                        <span>{t('events.provider')}</span>
                        <strong>{value(event.provider)}</strong>
                      </div>
                      <ArrowRightOutlined />
                      <div>
                        <span>{t('events.credential')}</span>
                        <strong>{value(identity?.name)}</strong>
                      </div>
                    </div>
                    {section(
                      t('events.routing'),
                      fields([
                        [t('events.provider'), value(event.provider)],
                        [t('events.credential'), value(identity?.name)],
                        [
                          t('events.identity_basis'),
                          identity ? t(`events.credential_${identity.kind}`) : missing,
                        ],
                        [t('events.resource_name'), value(event.resource_name)],
                        [t('events.source'), value(event.source)],
                        [t('events.auth_index'), value(event.auth_index)],
                        [t('events.auth_type'), value(event.auth_type)],
                        [t('events.caller'), value(requestGroupName(event))],
                        [t('events.api_group_key'), value(event.api_group_key)],
                        [t('events.group_category'), value(event.api_group_label)],
                        [t('events.resource_id'), value(event.resource_id)],
                        [t('events.executor'), value(event.executor_type)],
                        [t('events.endpoint'), value(event.endpoint)],
                      ]),
                    )}
                    {section(
                      t('events.request_parameters'),
                      fields([
                        [t('events.col_model'), value(event.model)],
                        [t('events.model_alias'), value(event.model_alias)],
                        [t('events.reasoning_effort'), value(event.reasoning_effort)],
                        [t('events.service_tier'), value(event.service_tier)],
                        [t('events.response_tier'), value(event.response_service_tier)],
                        [
                          t('events.generation'),
                          t(event.generate ? 'events.generation_yes' : 'events.preflight'),
                        ],
                        [t('events.event_key'), value(event.event_key)],
                      ]),
                    )}
                  </>
                ),
              },
              {
                key: 'usage',
                label: t('events.performance'),
                children: (
                  <>
                    {latency > 0 && (
                      <div className="req-waterfall-box">
                        <div className="req-waterfall-header">
                          <h4>{t('events.waterfall_title')}</h4>
                          <span className="req-waterfall-total">{formatEventDuration(latency)}</span>
                        </div>
                        {isMeasurable && ttft > 0 ? (
                          <>
                            <div className="req-waterfall-track">
                              <div
                                className="req-waterfall-seg-ttft"
                                style={{ width: `${ttftPercent}%` }}
                                title={`TTFT: ${formatEventDuration(ttft)} (${Math.round((ttft / latency) * 100)}%)`}
                              />
                              <div
                                className="req-waterfall-seg-stream"
                                style={{ width: `${streamPercent}%` }}
                                title={`${t('events.waterfall_stream')}: ${formatEventDuration(streamTime)} (${Math.round((streamTime / latency) * 100)}%)`}
                              />
                            </div>
                            <div className="req-waterfall-legend">
                              <div className="req-waterfall-legend-item">
                                <span className="req-waterfall-pip req-waterfall-pip-ttft" />
                                <span>{t('events.waterfall_ttft')}</span>
                                <strong>{formatEventDuration(ttft)}</strong>
                              </div>
                              <div className="req-waterfall-legend-item">
                                <span className="req-waterfall-pip req-waterfall-pip-stream" />
                                <span>{t('events.waterfall_stream')}</span>
                                <strong>{formatEventDuration(streamTime)}</strong>
                              </div>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="req-waterfall-track">
                              <div
                                className="req-waterfall-seg-total"
                                style={{ width: '100%' }}
                                title={`${t('events.duration')}: ${formatEventDuration(latency)}`}
                              />
                            </div>
                            <div className="req-waterfall-legend">
                              <div className="req-waterfall-legend-item">
                                <span className="req-waterfall-pip req-waterfall-pip-total" />
                                <span>{t('events.duration')}</span>
                                <strong>{formatEventDuration(latency)}</strong>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    <div className="req-token-cards-grid">
                      <div className="req-token-card">
                        <span>{t('events.total_tokens')}</span>
                        <strong title={formatTokensFull(event.tokens.total)}>{formatTokens(event.tokens.total, tokenStyle)}</strong>
                      </div>
                      <div className="req-token-card">
                        <span>{t('events.input_tokens')}</span>
                        <strong title={formatTokensFull(event.tokens.input)}>{formatTokens(event.tokens.input, tokenStyle)}</strong>
                      </div>
                      <div className="req-token-card">
                        <span>{t('events.output_tokens')}</span>
                        <strong title={formatTokensFull(event.tokens.output)}>{formatTokens(event.tokens.output, tokenStyle)}</strong>
                      </div>
                      {event.tokens.reasoning > 0 && (
                        <div className="req-token-card">
                          <span>{t('events.reasoning_tokens')}</span>
                          <strong title={formatTokensFull(event.tokens.reasoning)}>{formatTokens(event.tokens.reasoning, tokenStyle)}</strong>
                        </div>
                      )}
                      <div className="req-token-card">
                        <span>{t('events.cached_tokens')}</span>
                        <strong title={formatTokensFull(event.tokens.cached)}>{formatTokens(event.tokens.cached, tokenStyle)}</strong>
                      </div>
                    </div>
                    {section(
                      t('events.timing'),
                      fields([
                        [t('events.duration'), `${event.latency_ms.toLocaleString()} ms`],
                        ...(isMeasurable && event.ttft_ms != null
                          ? [[t('events.ttft'), `${event.ttft_ms.toLocaleString()} ms`] as [string, string]]
                          : []),
                      ]),
                    )}
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
                    {section(
                      t('events.col_cost'),
                      fields([
                        [
                          t('events.col_cost'),
                          event.cost_usd != null ? (
                            <strong style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
                              ${event.cost_usd.toFixed(6)}
                            </strong>
                          ) : (
                            <span className="terminal-muted">{t('events.cost_unpriced')}</span>
                          ),
                        ],
                      ]),
                    )}
                    <p className="request-detail-note">{t('events.token_note')}</p>
                  </>
                ),
              },
              {
                key: 'diagnostics',
                label: `${t('events.diagnostics')}${errors.length ? ` (${errors.length})` : ''}`,
                children: (
                  <>
                    {section(
                      t('events.network'),
                      fields([
                        [t('events.client_ip'), value(event.client_ip)],
                        ['X-Forwarded-For', value(event.x_forwarded_for)],
                        ['User-Agent', value(event.user_agent)],
                      ]),
                    )}
                    {section(
                      t('events.correlated_errors'),
                      <>
                        <p className="request-detail-note">{t('events.correlation_note')}</p>
                        {!!result.data?.partial_errors?.length && (
                          <Alert
                            type="warning"
                            showIcon
                            title={t('events.partial_errors')}
                            description={result.data.partial_errors.join(' · ')}
                          />
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
                          : !result.data?.partial_errors?.length && (
                              <Empty
                                image={Empty.PRESENTED_IMAGE_SIMPLE}
                                description={t('events.no_correlated_errors')}
                              />
                            )}
                      </>,
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
            ]}
          />
        </>
      ) : null}
      <Modal
        open={downloadModalOpen && eventId != null}
        title={t('events.download_log_confirm')}
        onOk={() => void download()}
        onCancel={() => setDownloadModalOpen(false)}
        confirmLoading={downloading}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <Alert type="warning" showIcon description={t('events.download_log_desc')} />
        <p className="request-detail-id">Request ID: {event?.request_id}</p>
      </Modal>
    </Drawer>
  );
};
