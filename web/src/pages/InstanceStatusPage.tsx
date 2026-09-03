import React from 'react';
import { Card, Descriptions, Tag, Button, Typography, Row, Col, Alert, Space } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  SyncOutlined,
  ApiOutlined,
  DatabaseOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { getAppConfig } from '../types/config';
import { useT } from '../i18n';

const { Title, Text, Paragraph } = Typography;

export const InstanceStatusPage: React.FC = () => {
  const t = useT();
  const config = getAppConfig();
  const queryClient = useQueryClient();

  const { data: health, refetch, isFetching } = useQuery({
    queryKey: ['health'],
    queryFn: api.getHealth,
  });

  const discoverMutation = useMutation({
    mutationFn: api.discoverDefaultInstance,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
  });

  const isOnline = health?.status === 'ok' || health?.status === 'healthy';

  return (
    <div className="terminal-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('inst.title')}</h1>
        </div>
      </div>

      <Row gutter={[20, 20]}>
        {/* Connection Status Card */}
        <Col xs={24} md={12}>
          <Card
            title={
              <Space>
                <ApiOutlined />
                <span>{t('inst.conn_title')}</span>
              </Space>
            }
            className="terminal-panel"
            style={{ height: '100%' }}
            extra={
              <Button
                icon={<SyncOutlined spin={isFetching || discoverMutation.isPending} />}
                onClick={() => {
                  refetch();
                  discoverMutation.mutate();
                }}
                loading={isFetching || discoverMutation.isPending}
                size="small"
              >
                {t('inst.test_scan')}
              </Button>
            }
          >
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {isOnline ? (
                  <CheckCircleFilled style={{ color: 'var(--success)', fontSize: '24px' }} />
                ) : (
                  <CloseCircleFilled style={{ color: 'var(--danger)', fontSize: '24px' }} />
                )}
                <div>
                  <Text strong style={{ fontSize: '16px', display: 'block' }}>
                    {isOnline ? t('inst.conn_ok') : t('inst.conn_bad')}
                  </Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    {t('inst.conn_note')}
                  </Text>
                </div>
              </div>
            </div>

            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('inst.probe')}>
                <Tag color={isOnline ? 'success' : 'error'}>{health?.status || 'unknown'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('inst.omc_version')}>
                <code>{health?.version || 'v0.1.0-dev'}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t('inst.cpa_endpoint')}>
                <code>{health?.cpa_base_url || t('inst.cpa_endpoint_default')}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t('inst.database')}>
                <Space>
                  <DatabaseOutlined />
                  <span>{t('inst.database_val')}</span>
                </Space>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        {/* Runtime Base Path Card */}
        <Col xs={24} md={12}>
          <Card
            title={
              <Space>
                <SafetyCertificateOutlined />
                <span>{t('inst.proxy_title')}</span>
              </Space>
            }
            className="terminal-panel"
            style={{ height: '100%' }}
          >
            <Alert
              message={t('inst.proxy_alert_title')}
              description={t('inst.proxy_alert_desc')}
              type="info"
              showIcon
              style={{ marginBottom: '16px' }}
            />

            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('inst.base_path')}>
                <code>{config.basePath || '/'}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t('inst.api_root')}>
                <code>{config.apiBaseUrl}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t('inst.media_mount')}>
                <code>{config.mediaBaseUrl}</code>
              </Descriptions.Item>
              <Descriptions.Item label={t('inst.proxy_advice')}>
                <span>{t('inst.proxy_advice_val')}</span>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      {/* Guide Note Card */}
      <Card className="terminal-panel" style={{ marginTop: '20px' }}>
        <Title level={5}>{t('inst.faq_title')}</Title>
        <Paragraph style={{ color: 'var(--muted)', fontSize: '13px', lineHeight: 1.6 }}>
          {t('inst.faq_body')}
        </Paragraph>
      </Card>
    </div>
  );
};
