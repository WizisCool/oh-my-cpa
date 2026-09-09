import React from 'react';
import { Card, Typography, Row, Col, Input, Select, Space, Button } from 'antd';
import {
  SearchOutlined,
  FilterOutlined,
  ThunderboltFilled,
  SyncOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';

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
  const t = useT();
  return (
    <div style={{ marginBottom: '24px' }}>
      {/* Hero Banner Card */}
      <Card
        className="terminal-panel"
        style={{ marginBottom: '16px' }}
        styles={{ body: { padding: '28px 32px' } }}
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
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  color: 'var(--muted)',
                  padding: '2px 10px',
                  fontSize: '12px',
                  fontWeight: 600,
                }}
              >
                <ThunderboltFilled /> {t('tri.hero_badge')}
              </span>
            </div>

            <Title level={2} style={{ margin: '0 0 10px 0', fontSize: '22px', letterSpacing: '-0.5px' }}>
              {t('tri.hero_title')}
            </Title>

            <Paragraph style={{ color: 'var(--muted)', fontSize: '14px', lineHeight: 1.6, margin: 0, maxWidth: '620px' }}>
              {t('tri.hero_desc')}
            </Paragraph>
          </Col>

          {/* Right Column: Key Metrics */}
          <Col xs={24} lg={9}>
            <Row gutter={12}>
              <Col span={8}>
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    padding: '16px 12px',
                    textAlign: 'center',
                  }}
                >
                  <Text style={{ color: 'var(--warn)', fontSize: '28px', fontWeight: 700, display: 'block' }}>
                    {unclaimedCount}
                  </Text>
                  <Text style={{ color: 'var(--muted)', fontSize: '12px' }}>{t('tri.metric_unclaimed')}</Text>
                </div>
              </Col>

              <Col span={8}>
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    padding: '16px 12px',
                    textAlign: 'center',
                  }}
                >
                  <Text style={{ color: 'var(--success)', fontSize: '28px', fontWeight: 700, display: 'block' }}>
                    {claimedCount}
                  </Text>
                  <Text style={{ color: 'var(--muted)', fontSize: '12px' }}>{t('tri.metric_claimed')}</Text>
                </div>
              </Col>

              <Col span={8}>
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    padding: '16px 12px',
                    textAlign: 'center',
                  }}
                >
                  <Text style={{ color: 'var(--fg)', fontSize: '28px', fontWeight: 700, display: 'block' }}>
                    {totalCount}
                  </Text>
                  <Text style={{ color: 'var(--muted)', fontSize: '12px' }}>{t('tri.metric_total')}</Text>
                </div>
              </Col>
            </Row>
          </Col>
        </Row>
      </Card>

      {/* Filter and Search Bar */}
      <Card className="terminal-panel" styles={{ body: { padding: '16px 20px' } }}>
        <Row gutter={[16, 12]} align="middle" justify="space-between">
          <Col xs={24} sm={14} md={12}>
            <Input
              prefix={<SearchOutlined style={{ color: 'var(--muted)' }} />}
              placeholder={t('tri.search_ph')}
              allowClear
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              size="middle"
            />
          </Col>

          <Col xs={24} sm={10} md={12} style={{ textAlign: 'right' }}>
            <Space wrap>
              <Select
                value={driverFilter}
                onChange={onDriverFilterChange}
                style={{ width: 180 }}
                placeholder={t('tri.driver_ph')}
                suffixIcon={<FilterOutlined style={{ color: 'var(--muted)' }} />}
                options={[
                  { label: t('tri.driver_all'), value: 'all' },
                  { label: 'Codex (Responses)', value: 'codex' },
                  { label: 'Claude (Anthropic)', value: 'claude' },
                  { label: 'Gemini (Google)', value: 'gemini' },
                  { label: t('tri.driver_openai_compat'), value: 'openai-compatibility' },
                  { label: t('tri.driver_authfile'), value: 'auth-file' },
                ]}
              />

              <Button
                icon={<SyncOutlined spin={isSyncing} />}
                onClick={onSync}
                loading={isSyncing}
              >
                {t('tri.refresh_discovery')}
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>
    </div>
  );
};
