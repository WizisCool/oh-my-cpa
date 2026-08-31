import React from 'react';
import { Card, Tag, Button, Typography, Space, Tooltip, Dropdown, MenuProps } from 'antd';
import {
  EditOutlined,
  CopyOutlined,
  CheckCircleOutlined,
  EyeInvisibleOutlined,
  MoreOutlined,
  LinkOutlined,
  KeyOutlined,
} from '@ant-design/icons';
import { DiscoveredResource } from '../../types/resource';
import { PresetIcon } from '../icons/PresetIcon';

const { Text, Paragraph } = Typography;

interface ResourceCardProps {
  resource: DiscoveredResource;
  onEdit: (resource: DiscoveredResource) => void;
  onQuickClaim?: (resource: DiscoveredResource) => void;
  onIgnore?: (resource: DiscoveredResource) => void;
}

export const ResourceCard: React.FC<ResourceCardProps> = ({
  resource,
  onEdit,
  onQuickClaim,
  onIgnore,
}) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopyUrl = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (resource.base_url) {
      navigator.clipboard.writeText(resource.base_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const cardColor = resource.color || '#1677FF';
  const isCustomized = Boolean(resource.custom_display_name);

  const menuItems: MenuProps['items'] = [
    {
      key: 'claim',
      label: '快速认领 (保持当前名称)',
      icon: <CheckCircleOutlined />,
      onClick: () => onQuickClaim?.(resource),
    },
    {
      key: 'ignore',
      label: '暂不整理 / 忽略',
      icon: <EyeInvisibleOutlined />,
      danger: true,
      onClick: () => onIgnore?.(resource),
    },
  ];

  // Friendly display for CPA technical driver
  const renderDriverBadge = () => {
    const driver = resource.cpa_driver || 'unknown';
    const protocol = resource.protocol_display || resource.protocol_driver || '未知协议';

    let color = 'default';
    if (driver === 'codex') color = 'purple';
    else if (driver === 'claude') color = 'orange';
    else if (driver === 'gemini') color = 'blue';
    else if (driver === 'openai-compatibility') color = 'cyan';

    return (
      <Tooltip title={`底层技术驱动：CPA 将此接入点作为 [${driver}] 适配器加载`}>
        <Tag color={color} style={{ marginRight: 0, fontSize: '12px', borderRadius: '4px' }}>
          {protocol} · CPA: {driver}
        </Tag>
      </Tooltip>
    );
  };

  return (
    <Card
      hoverable
      className="resource-card"
      style={{
        borderRadius: '12px',
        border: isCustomized ? `1px solid ${cardColor}40` : '1px solid #e2e8f0',
        transition: 'all 0.25s ease',
        background: '#ffffff',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
      bodyStyle={{
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
      }}
    >
      {/* Top Header Row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', marginBottom: '14px' }}>
        {/* Icon Avatar */}
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '10px',
            backgroundColor: `${cardColor}15`,
            color: cardColor,
            border: `1px solid ${cardColor}30`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            boxShadow: `0 2px 6px ${cardColor}15`,
          }}
        >
          <PresetIcon name={resource.icon} size={24} />
        </div>

        {/* Name & Source */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <Text
              strong
              style={{
                fontSize: '16px',
                color: '#0f172a',
                lineHeight: 1.3,
                wordBreak: 'break-word',
              }}
            >
              {resource.display_name}
            </Text>
            {isCustomized ? (
              <Tag color="success" style={{ margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                已自定义
              </Tag>
            ) : (
              <Tag color="warning" style={{ margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                待认领
              </Tag>
            )}
          </div>

          {resource.suggested_source && (
            <div style={{ marginTop: '4px' }}>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                来源推荐: <span style={{ color: '#475569', fontWeight: 500 }}>{resource.suggested_source}</span>
              </Text>
            </div>
          )}
        </div>

        {/* More Actions Menu */}
        <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
          <Button
            type="text"
            size="small"
            icon={<MoreOutlined />}
            style={{ color: '#94a3b8' }}
            onClick={(e) => e.stopPropagation()}
          />
        </Dropdown>
      </div>

      {/* Technical Driver & Details */}
      <div style={{ marginBottom: '14px', flex: 1 }}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {/* Driver Tag */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {renderDriverBadge()}
            {resource.cpa_auth_index && (
              <Tooltip title="CPA 运行时稳定凭据索引 (auth_index)">
                <Text type="secondary" style={{ fontSize: '11px', fontFamily: 'monospace' }}>
                  <KeyOutlined style={{ marginRight: '4px' }} />
                  {resource.cpa_auth_index.slice(0, 10)}
                </Text>
              </Tooltip>
            )}
          </div>

          {/* Endpoint Base URL */}
          {resource.base_url ? (
            <div
              style={{
                backgroundColor: '#f8fafc',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid #f1f5f9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                <LinkOutlined style={{ color: '#94a3b8', fontSize: '12px' }} />
                <Text
                  style={{
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    color: '#334155',
                  }}
                  ellipsis={{ tooltip: resource.base_url }}
                >
                  {resource.base_url}
                </Text>
              </div>
              <Tooltip title={copied ? '已复制！' : '复制端点 URL'}>
                <Button
                  type="text"
                  size="small"
                  icon={copied ? <CheckCircleOutlined style={{ color: '#10b981' }} /> : <CopyOutlined />}
                  onClick={handleCopyUrl}
                  style={{ height: '22px', width: '22px', padding: 0 }}
                />
              </Tooltip>
            </div>
          ) : resource.cpa_resource_name ? (
            <div
              style={{
                backgroundColor: '#f8fafc',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid #f1f5f9',
              }}
            >
              <Text type="secondary" style={{ fontSize: '12px', fontFamily: 'monospace' }}>
                凭据文件: {resource.cpa_resource_name}
              </Text>
            </div>
          ) : null}

          {/* User Notes if present */}
          {resource.notes && (
            <Paragraph
              type="secondary"
              ellipsis={{ rows: 2 }}
              style={{ fontSize: '12px', margin: '4px 0 0 0', color: '#64748b' }}
            >
              📝 {resource.notes}
            </Paragraph>
          )}
        </Space>
      </div>

      {/* Action Footer */}
      <div
        style={{
          borderTop: '1px solid #f1f5f9',
          paddingTop: '12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Text type="secondary" style={{ fontSize: '11px' }}>
          {resource.cpa_resource_type}
        </Text>

        <Button
          type="primary"
          ghost
          icon={<EditOutlined />}
          size="middle"
          onClick={() => onEdit(resource)}
          style={{
            borderColor: cardColor,
            color: cardColor,
            borderRadius: '6px',
            fontWeight: 500,
          }}
        >
          立即整理 / 命名
        </Button>
      </div>
    </Card>
  );
};
