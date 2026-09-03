import React from 'react';
import {
  Drawer,
  Descriptions,
  Tag,
  Button,
  Typography,
  Card,
  Alert,
  Skeleton,
  Modal,
  App as AntdApp,
} from 'antd';
import {
  CopyOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../../api/client';
import { useT } from '../../i18n';

const { Text } = Typography;

interface UsageEventDrawerProps {
  eventId: number | null;
  onClose: () => void;
}

export const UsageEventDrawer: React.FC<UsageEventDrawerProps> = ({ eventId, onClose }) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [downloadModalOpen, setDownloadModalOpen] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['usage-event', eventId],
    queryFn: () => api.getUsageEvent(eventId!),
    enabled: eventId != null,
  });

  const event = data?.event;
  const relatedErrors = data?.related_errors || [];

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    message.success(t('res.copied'));
  };

  const handleDownloadLog = async () => {
    if (!eventId || !event?.request_id) return;
    setDownloading(true);
    try {
      const blob = await api.downloadUsageEventRequestLog(eventId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${event.request_id}.log`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setDownloadModalOpen(false);
      message.success(t('events.download_success'));
    } catch {
      message.error(t('common.save_failed', { msg: 'Download failed' }));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Drawer
      title={t('events.details_title')}
      size="large"
      open={eventId != null}
      onClose={onClose}
    >
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : isError ? (
        <Alert
          type="error"
          showIcon
          description={error instanceof Error ? error.message : String(error)}
        />
      ) : event ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Top Key Info */}
          <Card size="small" className="terminal-panel">
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered>
              <Descriptions.Item label="Event Key">
                <span className="mono-num">{event.event_key}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Request ID">
                {event.request_id ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono-num">{event.request_id}</span>
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      onClick={() => handleCopy(event.request_id!)}
                    />
                  </div>
                ) : (
                  '-'
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('events.col_time')}>
                {dayjs(event.timestamp_ms).format('YYYY-MM-DD HH:mm:ss.SSS')}
              </Descriptions.Item>
              <Descriptions.Item label={t('events.col_result')}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {event.failed ? (
                    <Tag color="error">{t('events.filter_failed')}</Tag>
                  ) : (
                    <Tag color="success">{t('events.filter_success')}</Tag>
                  )}
                  {event.generate === false && <Tag>Warm-up</Tag>}
                </div>
              </Descriptions.Item>
              <Descriptions.Item label={t('events.col_latency')}>
                {event.latency_ms} ms {event.ttft_ms != null && `(TTFT: ${event.ttft_ms} ms)`}
              </Descriptions.Item>
              <Descriptions.Item label={t('events.col_resource')}>
                {event.resource_id ? (
                  <Tag color="blue">{event.resource_name || event.resource_id}</Tag>
                ) : (
                  <Text type="secondary">{t('events.unbound')}</Text>
                )}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {/* Token Breakdown */}
          <Card size="small" title={t('events.token_breakdown')} className="terminal-panel">
            <Descriptions column={{ xs: 2, sm: 4 }} size="small" bordered>
              <Descriptions.Item label={t('dash.unit_tokens')}>
                <Text strong className="mono-num">{event.tokens.total}</Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('events.input_tokens')}>
                <span className="mono-num">{event.tokens.input}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('events.output_tokens')}>
                <span className="mono-num">{event.tokens.output}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('events.reasoning_tokens')}>
                <span className="mono-num">{event.tokens.reasoning}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('events.cached_tokens')}>
                <span className="mono-num">{event.tokens.cached}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('events.cache_read_tokens')}>
                <span className="mono-num">{event.tokens.cache_read}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('events.cache_creation_tokens')}>
                <span className="mono-num">{event.tokens.cache_creation}</span>
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {/* Endpoint, Model & Network Profile */}
          <Card size="small" title="Routing & Identity" className="terminal-panel">
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered>
              <Descriptions.Item label={t('events.col_model')}>
                <div>
                  <Text strong>{event.model}</Text>
                  {event.model_alias && (
                    <div style={{ fontSize: 11, color: 'var(--meta)' }}>
                      alias: {event.model_alias}
                    </div>
                  )}
                </div>
              </Descriptions.Item>
              <Descriptions.Item label="Provider">{event.provider || '-'}</Descriptions.Item>
              <Descriptions.Item label="Endpoint">
                <span className="mono-num">{event.endpoint || '-'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Executor Type">{event.executor_type || '-'}</Descriptions.Item>
              <Descriptions.Item label="Auth Type / Index">
                {event.auth_type} / {event.auth_index || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Client IP">{event.client_ip || '-'}</Descriptions.Item>
              <Descriptions.Item label="User Agent">{event.user_agent || '-'}</Descriptions.Item>
              <Descriptions.Item label="Service Tier">
                {event.service_tier || '-'}{' '}
                {event.response_service_tier && `(${event.response_service_tier})`}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {/* Correlated Errors */}
          {relatedErrors.length > 0 && (
            <Card
              size="small"
              title={
                <span style={{ color: 'var(--danger)' }}>
                  <ExclamationCircleOutlined style={{ marginRight: 6 }} />
                  {t('events.correlated_errors')} ({relatedErrors.length})
                </span>
              }
              className="terminal-panel"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {relatedErrors.map((err) => (
                  <div
                    key={err.id}
                    style={{
                      padding: 10,
                      borderRadius: 4,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Tag color="error">Status {err.status_code}</Tag>
                      <Text type="secondary">
                        {dayjs(err.timestamp_ms).format('HH:mm:ss.SSS')}
                      </Text>
                    </div>
                    {err.code && <div><strong>Code:</strong> {err.code}</div>}
                    {err.body && (
                      <div style={{ marginTop: 4 }}>
                        <strong>Error Body:</strong>
                        <pre style={{ margin: '4px 0 0 0', fontSize: 11, whiteSpace: 'pre-wrap' }}>
                          {err.body}
                        </pre>
                      </div>
                    )}
                    {err.quota_reason && (
                      <div style={{ marginTop: 4, color: 'var(--warn)' }}>
                        <strong>Quota Reason:</strong> {err.quota_reason}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Request Log Actions */}
          {event.has_request_log && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => setDownloadModalOpen(true)}
              >
                {t('events.download_log')}
              </Button>
            </div>
          )}

          {/* Download Log Confirmation Modal */}
          <Modal
            open={downloadModalOpen}
            title={t('events.download_log_confirm')}
            onOk={() => void handleDownloadLog()}
            onCancel={() => setDownloadModalOpen(false)}
            confirmLoading={downloading}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Alert
              type="warning"
              showIcon
              description={t('events.download_log_desc')}
              style={{ marginBottom: 16 }}
            />
            <p>
              Request ID: <code className="mono-num">{event.request_id}</code>
            </p>
          </Modal>
        </div>
      ) : null}
    </Drawer>
  );
};
