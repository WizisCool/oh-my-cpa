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

const { Title, Text, Paragraph } = Typography;

export const InstanceStatusPage: React.FC = () => {
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
    <div>
      <div style={{ marginBottom: '24px' }}>
        <Title level={3} style={{ margin: 0, color: '#0f172a' }}>CPA 实例与系统状态</Title>
        <Text type="secondary">查看当前连接的 CLIProxyAPI 实例、子路径挂载与数据同步状态</Text>
      </div>

      <Row gutter={[20, 20]}>
        {/* Connection Status Card */}
        <Col xs={24} md={12}>
          <Card
            title={
              <Space>
                <ApiOutlined style={{ color: '#1677FF' }} />
                <span>CPA 实例连接状态</span>
              </Space>
            }
            style={{ borderRadius: '12px', border: '1px solid #e2e8f0', height: '100%' }}
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
                测试并扫描
              </Button>
            }
          >
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {isOnline ? (
                  <CheckCircleFilled style={{ color: '#52c41a', fontSize: '24px' }} />
                ) : (
                  <CloseCircleFilled style={{ color: '#ff4d4f', fontSize: '24px' }} />
                )}
                <div>
                  <Text strong style={{ fontSize: '16px', display: 'block' }}>
                    {isOnline ? 'CPA 实例连接正常' : '无法连接到后端 / CPA 实例'}
                  </Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    通过 Go 后端安全代理连接，CPA Management Key 不暴露至前端
                  </Text>
                </div>
              </div>
            </div>

            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="后端探针状态">
                <Tag color={isOnline ? 'success' : 'error'}>{health?.status || 'unknown'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Oh My CPA 版本">
                <code>{health?.version || 'v0.1.0-dev'}</code>
              </Descriptions.Item>
              <Descriptions.Item label="CPA 基础端点">
                <code>{health?.cpa_base_url || '内置 / 配置默认'}</code>
              </Descriptions.Item>
              <Descriptions.Item label="数据库引擎">
                <Space>
                  <DatabaseOutlined />
                  <span>SQLite (WAL 模式, 单副本)</span>
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
                <SafetyCertificateOutlined style={{ color: '#722ED1' }} />
                <span>子路径与反向代理环境</span>
              </Space>
            }
            style={{ borderRadius: '12px', border: '1px solid #e2e8f0', height: '100%' }}
          >
            <Alert
              message="二级子路径原生适配"
              description="Oh My CPA 在运行时动态解析挂载路径，无需重新构建前端镜像即可随时切换子路径。"
              type="info"
              showIcon
              style={{ marginBottom: '16px', borderRadius: '8px' }}
            />

            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="当前 Base Path">
                <code>{config.basePath || '/'}</code>
              </Descriptions.Item>
              <Descriptions.Item label="API 根路径">
                <code>{config.apiBaseUrl}</code>
              </Descriptions.Item>
              <Descriptions.Item label="媒体/图标挂载">
                <code>{config.mediaBaseUrl}</code>
              </Descriptions.Item>
              <Descriptions.Item label="反向代理建议">
                <span>Caddy 或 Nginx 保留 <code>/omc</code> 前缀转发至后端</span>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>

      {/* Guide Note Card */}
      <Card
        style={{ marginTop: '20px', borderRadius: '12px', border: '1px solid #e2e8f0' }}
      >
        <Title level={5}>为什么 CPA 统一显示为 Codex？</Title>
        <Paragraph style={{ color: '#64748b', fontSize: '13px', lineHeight: 1.6 }}>
          CLIProxyAPI 在协议层将 OpenAI Responses 规范的所有端点驱动统一命名为 <code>Codex</code>。
          当你在 CPA 中添加了 DeepSeek 官方端点、OpenCode Go、Command Code GOAT 或中转站时，CPA 会将它们都显示为 Codex。
          <br />
          <strong>Oh My CPA 的职责</strong> 是在 CPA 技术层之上建立属于你的个性化资产目录，保存自定义名称、图标与分类，而不改变 CPA 的底层执行机制。
        </Paragraph>
      </Card>
    </div>
  );
};
