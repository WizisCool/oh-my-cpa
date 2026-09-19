import React, { useState } from 'react';
import {
  Card,
  Row,
  Col,
  Button,
  Tag,
  Typography,
  Alert,
  Descriptions,
  Spin,
  App as AntdApp,
} from 'antd';
import {
  SyncOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudServerOutlined,
  FieldTimeOutlined,
  SafetyCertificateOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import type { SystemInfoResponse } from '../types/system';

const { Text, Paragraph } = Typography;

export const SystemPage: React.FC = () => {
  const t = useT();
  const isDemo = isDemoMode();
  const { message } = AntdApp.useApp();
  const [downloading, setDownloading] = useState(false);

  const {
    data: sysInfo,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<SystemInfoResponse>({
    queryKey: ['management-system-info'],
    queryFn: api.getSystemInfo,
    staleTime: 15000,
  });

  const handleDownloadDiagnostics = async () => {
    setDownloading(true);
    try {
      const blob = await api.downloadSystemDiagnostics();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `omc-diagnostics-${Date.now()}.json`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      message.success(t('sys.download_success'));
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('sys.download_failed', { msg }));
    } finally {
      setDownloading(false);
    }
  };

  const formatUptime = (seconds: number) => {
    if (!seconds || seconds < 0) return '0s';
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  if (isLoading) {
    return (
      <div className="terminal-page system-page" style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="terminal-page system-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('sys.title')}</h1>
          <p className="terminal-subtitle">{t('sys.subtitle')}</p>
        </div>

        <Button
          size="small"
          icon={<SyncOutlined spin={isFetching} />}
          onClick={() => void refetch()}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          description={error instanceof ApiError ? error.message : String(error)}
        />
      )}

      {/* Row 1: Versions and Component Topology */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {/* Versions & Updates */}
        <Col xs={24} md={12}>
          <Card
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <DashboardOutlined />
                <span>{t('sys.version_card')}</span>
              </div>
            }
            style={{ height: '100%' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">{t('sys.omc_version')}:</Text>
                <Tag color="blue" style={{ fontFamily: 'monospace' }}>
                  {sysInfo?.omc_version || 'v0.1.0'}
                </Tag>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">{t('sys.cpa_version')}:</Text>
                <Tag color="cyan" style={{ fontFamily: 'monospace' }}>
                  {sysInfo?.cpa_version || 'unknown'}
                </Tag>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary">{t('sys.latest_version')}:</Text>
                <span style={{ fontFamily: 'monospace' }}>
                  {sysInfo?.latest_version || sysInfo?.cpa_version || '-'}
                </span>
              </div>

              <div style={{ marginTop: 8 }}>
                {sysInfo?.update_available ? (
                  <Alert
                    type="info"
                    showIcon
                    description={t('sys.update_available', { version: sysInfo.latest_version || '' })}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CheckCircleOutlined style={{ color: 'var(--ant-color-success)' }} />
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      {t('sys.is_latest')}
                    </Text>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </Col>

        {/* Component Topology & Health */}
        <Col xs={24} md={12}>
          <Card
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CloudServerOutlined />
                <span>{t('sys.topology_card')}</span>
              </div>
            }
            style={{ height: '100%' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* CPA Gateway */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('sys.component_cpa')}</div>
                  <div style={{ fontSize: 12, color: 'var(--meta)', fontFamily: 'monospace' }}>
                    {sysInfo?.cpa.endpoint_masked}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {sysInfo?.cpa.status === 'connected' ? (
                    <Tag color="success" icon={<CheckCircleOutlined />}>
                      {sysInfo.cpa.latency_ms > 0
                        ? t('sys.cpa_latency', { ms: sysInfo.cpa.latency_ms })
                        : t('shell.connected')}
                    </Tag>
                  ) : (
                    <Tag color="error" icon={<CloseCircleOutlined />}>
                      {t('shell.offline')}
                    </Tag>
                  )}
                </div>
              </div>

              {/* SQLite DB */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('sys.component_db')}</div>
                  <div style={{ fontSize: 12, color: 'var(--meta)' }}>
                    {t('sys.db_mode')}
                  </div>
                </div>
                <div>
                  {sysInfo?.database.status === 'ok' ? (
                    <Tag color="success">{t('inst.db_ok')}</Tag>
                  ) : (
                    <Tag color="error">{t('inst.db_error')}</Tag>
                  )}
                </div>
              </div>

              {/* Collector */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{t('sys.component_collector')}</div>
                  <div style={{ fontSize: 12, color: 'var(--meta)' }}>
                    {t('sys.collector_mode', {
                      mode: sysInfo?.collector.mode || 'auto',
                      gaps: sysInfo?.collector.ingest_gaps || 0,
                    })}
                  </div>
                </div>
                <div>
                  <Tag color={sysInfo?.collector.status === 'active' ? 'processing' : 'default'}>
                    {sysInfo?.collector.status || 'disabled'}
                  </Tag>
                </div>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Row 2: Runtime Metrics & Redacted Diagnostics Export */}
      <Row gutter={[16, 16]}>
        {/* Runtime info */}
        <Col xs={24} md={12}>
          <Card
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FieldTimeOutlined />
                <span>{t('sys.runtime_card')}</span>
              </div>
            }
            style={{ height: '100%' }}
          >
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('sys.runtime_go')}>
                <span style={{ fontFamily: 'monospace' }}>{sysInfo?.runtime.go_version}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('sys.runtime_os')}>
                <span style={{ fontFamily: 'monospace' }}>{sysInfo?.runtime.os_arch}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('sys.runtime_uptime')}>
                {formatUptime(sysInfo?.uptime_seconds || 0)}
              </Descriptions.Item>
              <Descriptions.Item label={t('sys.runtime_goroutines')}>
                <span className="mono-num">{sysInfo?.runtime.num_goroutines || 0}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('sys.runtime_mem')}>
                <span className="mono-num">{sysInfo?.runtime.alloc_mb || 0} MB</span>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        {/* Diagnostics Export */}
        <Col xs={24} md={12}>
          <Card
            title={
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SafetyCertificateOutlined />
                <span>{t('sys.diag_card')}</span>
              </div>
            }
            style={{ height: '100%' }}
          >
            <Paragraph type="secondary" style={{ fontSize: 13, lineHeight: 1.6 }}>
              {t('sys.diag_desc')}
            </Paragraph>

            <div style={{ marginTop: 24 }}>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                loading={downloading}
                disabled={isDemo}
                title={isDemo ? t('demo.blocked') : undefined}
                onClick={handleDownloadDiagnostics}
              >
                {t('sys.download_diag')}
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
};
