import React from 'react';
import { Alert, App as AntdApp, Button, Descriptions, Drawer, Empty, Modal, Skeleton, Tabs } from 'antd';
import { ArrowRightOutlined, CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import {
  resolveCredential,
  requestGroupName,
  formatEventDuration,
  type CredentialIndex,
} from '../../types/usageEventView';

interface UsageEventDrawerProps {
  eventId: number | null;
  credentials: CredentialIndex;
  onClose: () => void;
}

export const UsageEventDrawer: React.FC<UsageEventDrawerProps> = ({ eventId, onClose, credentials }) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [downloadModalOpen, setDownloadModalOpen] = React.useState(false);
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
    try {
      await navigator.clipboard.writeText(text);
      message.success(t('res.copied'));
    } catch {
      message.error(t('events.copy_failed'));
    }
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
  return (
    <Drawer
      title={t('events.details_title')}
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
              <h2>{event.model || t('events.not_captured')}</h2>
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
            <div>
              <span>{t('events.ttft')}</span>
              <strong>{formatEventDuration(event.ttft_ms)}</strong>
            </div>
            <div>
              <span>{t('events.col_tokens')}</span>
              <strong>{event.tokens.total.toLocaleString()}</strong>
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
                    {section(
                      t('events.timing'),
                      fields([
                        [t('events.duration'), `${event.latency_ms.toLocaleString()} ms`],
                        [
                          t('events.ttft'),
                          event.ttft_ms == null ? missing : `${event.ttft_ms.toLocaleString()} ms`,
                        ],
                      ]),
                    )}
                    {section(
                      t('events.token_breakdown'),
                      fields([
                        [t('events.input_tokens'), event.tokens.input.toLocaleString()],
                        [t('events.output_tokens'), event.tokens.output.toLocaleString()],
                        [t('events.reasoning_tokens'), event.tokens.reasoning.toLocaleString()],
                        [t('events.cached_tokens'), event.tokens.cached.toLocaleString()],
                        [t('events.cache_read_tokens'), event.tokens.cache_read.toLocaleString()],
                        [t('events.cache_creation_tokens'), event.tokens.cache_creation.toLocaleString()],
                        [t('events.total_tokens'), event.tokens.total.toLocaleString()],
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
