import React from 'react';
import { Card, Typography, Row, Col, Input, Select, Space, Button } from 'antd';
import {
  SearchOutlined,
  FilterOutlined,
  ThunderboltFilled,
  SyncOutlined,
} from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;

interface ResourceStatsHeroProps {
  unclaimedCount: number;
  claimedCount: number;
  totalCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  driverFilter: string;
  onDriverFilterChange: (d: string) => void;
  onSync: () => void;
  isSyncing: boolean;
}

export const ResourceStatsHero: React.FC<ResourceStatsHeroProps> = ({
  unclaimedCount,
  claimedCount,
  totalCount,
  searchQuery,
  onSearchChange,
  driverFilter,
  onDriverFilterChange,
  onSync,
  isSyncing,
}) => {
  return (
    <div style={{ marginBottom: '24px' }}>
      {/* Hero Banner Card */}
      <Card
        style={{
          borderRadius: '16px',
          border: '1px solid #e2e8f0',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          color: '#ffffff',
          boxShadow: '0 4px 20px rgba(15, 23, 42, 0.08)',
          marginBottom: '16px',
        }}
        bodyStyle={{ padding: '28px 32px' }}
      >
        <Row gutter={[32, 24]} align="middle">
          {/* Left Column: Mission Statement */}
          <Col xs={24} lg={15}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  backgroundColor: '#1677FF30',
                  color: '#60a5fa',
                  padding: '2px 10px',
                  borderRadius: '12px',
                  fontSize: '12px',
                  fontWeight: 600,
                }}
              >
                <ThunderboltFilled /> 资源身份中枢
              </span>
            </div>

            <Title level={2} style={{ color: '#ffffff', margin: '0 0 10px 0', fontSize: '24px', letterSpacing: '-0.5px' }}>
              AI 接入点整理与命名
            </Title>

            <Paragraph style={{ color: '#94a3b8', fontSize: '14px', lineHeight: 1.6, margin: 0, maxWidth: '620px' }}>
              CPA 原生将所有 Responses 端点统一归类为 <code>Codex</code>。在这里，你可以为你的{' '}
              <strong style={{ color: '#e2e8f0' }}>OpenCode Go</strong>、<strong style={{ color: '#e2e8f0' }}>GPT Plus 个人号</strong>、
              <strong style={{ color: '#e2e8f0' }}>Command Code GOAT</strong> 以及各类中转站，配置清晰的业务名称、品牌图标与用途。
            </Paragraph>
          </Col>

          {/* Right Column: Key Metrics */}
          <Col xs={24} lg={9}>
            <Row gutter={12}>
              <Col span={8}>
                <div
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '12px',
                    padding: '16px 12px',
                    textAlign: 'center',
                  }}
                >
                  <Text style={{ color: '#f59e0b', fontSize: '24px', fontWeight: 700, display: 'block' }}>
                    {unclaimedCount}
                  </Text>
                  <Text style={{ color: '#94a3b8', fontSize: '12px' }}>待整理端点</Text>
                </div>
              </Col>

              <Col span={8}>
                <div
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '12px',
                    padding: '16px 12px',
                    textAlign: 'center',
                  }}
                >
                  <Text style={{ color: '#10b981', fontSize: '24px', fontWeight: 700, display: 'block' }}>
                    {claimedCount}
                  </Text>
                  <Text style={{ color: '#94a3b8', fontSize: '12px' }}>已认领线路</Text>
                </div>
              </Col>

              <Col span={8}>
                <div
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '12px',
                    padding: '16px 12px',
                    textAlign: 'center',
                  }}
                >
                  <Text style={{ color: '#60a5fa', fontSize: '24px', fontWeight: 700, display: 'block' }}>
                    {totalCount}
                  </Text>
                  <Text style={{ color: '#94a3b8', fontSize: '12px' }}>总接入数</Text>
                </div>
              </Col>
            </Row>
          </Col>
        </Row>
      </Card>

      {/* Filter and Search Bar */}
      <Card
        style={{
          borderRadius: '12px',
          border: '1px solid #e2e8f0',
          background: '#ffffff',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.02)',
        }}
        bodyStyle={{ padding: '16px 20px' }}
      >
        <Row gutter={[16, 12]} align="middle" justify="space-between">
          <Col xs={24} sm={14} md={12}>
            <Input
              prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
              placeholder="搜索资源名称、接入点 Base URL、Auth Index..."
              allowClear
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              size="middle"
              style={{ borderRadius: '8px' }}
            />
          </Col>

          <Col xs={24} sm={10} md={12} style={{ textAlign: 'right' }}>
            <Space wrap>
              <Select
                value={driverFilter}
                onChange={onDriverFilterChange}
                style={{ width: 180 }}
                placeholder="全部协议驱动"
                suffixIcon={<FilterOutlined style={{ color: '#94a3b8' }} />}
                options={[
                  { label: '全部 CPA 驱动类型', value: 'all' },
                  { label: 'Codex (Responses)', value: 'codex' },
                  { label: 'Claude (Anthropic)', value: 'claude' },
                  { label: 'Gemini (Google)', value: 'gemini' },
                  { label: 'OpenAI 兼容提供商', value: 'openai-compatibility' },
                  { label: 'Auth Files (OAuth 凭据)', value: 'auth-file' },
                ]}
              />

              <Button
                icon={<SyncOutlined spin={isSyncing} />}
                onClick={onSync}
                loading={isSyncing}
                style={{ borderRadius: '6px' }}
              >
                刷新发现
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>
    </div>
  );
};
