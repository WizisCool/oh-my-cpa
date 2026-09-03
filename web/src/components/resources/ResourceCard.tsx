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
import { useT } from '../../i18n';
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
  const t = useT();
  const [copied, setCopied] = React.useState(false);

  const handleCopyUrl = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (resource.base_url) {
      navigator.clipboard.writeText(resource.base_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const cardColor = resource.color || '#007aff';
  const isCustomized = Boolean(resource.custom_display_name);

  const menuItems: MenuProps['items'] = [
    {
      key: 'claim',
      label: t('res.claim_keep'),
      icon: <CheckCircleOutlined />,
      onClick: () => onQuickClaim?.(resource),
    },
    {
      key: 'ignore',
      label: t('res.ignore'),
      icon: <EyeInvisibleOutlined />,
      danger: true,
      onClick: () => onIgnore?.(resource),
    },
  ];

  // Friendly display for CPA technical driver
  const renderDriverBadge = () => {
    const driver = resource.cpa_driver || 'unknown';
    const protocol = resource.protocol_display || resource.protocol_driver || t('res.unknown_protocol');

    let color = 'default';
    if (driver === 'codex') color = 'purple';
    else if (driver === 'claude') color = 'orange';
    else if (driver === 'gemini') color = 'blue';
    else if (driver === 'openai-compatibility') color = 'cyan';

    return (
      <Tooltip title={t('res.driver_tooltip', { driver })}>
        <Tag color={color} style={{ marginRight: 0, fontSize: '12px', borderRadius: '4px' }}>
          {protocol} · CPA: {driver}
        </Tag>
      </Tooltip>
    );
  };

  return (
    <Card
      hoverable
      className="resource-card terminal-panel"
      style={{
        borderRadius: '4px',
        border: isCustomized ? `1px solid ${cardColor}` : '1px solid var(--border)',
        background: 'var(--surface)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
      styles={{
        body: {
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
        },
      }}
    >
      {/* Top Header Row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', marginBottom: '14px' }}>
        {/* Icon Avatar */}
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: '4px',
            backgroundColor: `${cardColor}15`,
            color: cardColor,
            border: `1px solid ${cardColor}30`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
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
                lineHeight: 1.3,
                wordBreak: 'break-word',
              }}
            >
              {resource.display_name}
            </Text>
            {isCustomized ? (
              <Tag color="success" style={{ margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                {t('res.customized')}
              </Tag>
            ) : (
              <Tag color="warning" style={{ margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                {t('res.pending')}
              </Tag>
            )}
          </div>

          {resource.suggested_source && (
            <div style={{ marginTop: '4px' }}>
              <Text type="secondary" style={{ fontSize: '12px' }}>
                {t('res.source', { source: resource.suggested_source })}
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
            style={{ color: 'var(--muted)' }}
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
              <Tooltip title={t('res.auth_index_tooltip')}>
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
                backgroundColor: 'var(--bg)',
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-soft)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                <LinkOutlined style={{ color: 'var(--muted)', fontSize: '12px' }} />
                <Text
                  style={{
                    fontSize: '12px',
                    fontFamily: 'monospace',
                  }}
                  ellipsis={{ tooltip: resource.base_url }}
                >
                  {resource.base_url}
                </Text>
              </div>
              <Tooltip title={copied ? t('res.copied') : t('res.copy_url')}>
                <Button
                  type="text"
                  size="small"
                  icon={copied ? <CheckCircleOutlined style={{ color: 'var(--success)' }} /> : <CopyOutlined />}
                  onClick={handleCopyUrl}
                  style={{ height: '22px', width: '22px', padding: 0 }}
                />
              </Tooltip>
            </div>
          ) : resource.cpa_resource_name ? (
            <div
              style={{
                backgroundColor: 'var(--bg)',
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid var(--border-soft)',
              }}
            >
              <Text type="secondary" style={{ fontSize: '12px', fontFamily: 'monospace' }}>
                {t('res.credential_file', { name: resource.cpa_resource_name })}
              </Text>
            </div>
          ) : null}

          {/* User Notes if present */}
          {resource.notes && (
            <Paragraph
              type="secondary"
              ellipsis={{ rows: 2 }}
              style={{ fontSize: '12px', margin: '4px 0 0 0' }}
            >
              {resource.notes}
            </Paragraph>
          )}
        </Space>
      </div>

      {/* Action Footer */}
      <div
        style={{
          borderTop: '1px solid var(--border-soft)',
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
            borderRadius: '4px',
            fontWeight: 500,
          }}
        >
          {t('res.organize')}
        </Button>
      </div>
    </Card>
  );
};
