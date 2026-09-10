import React from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Popconfirm,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DownloadOutlined,
  EditOutlined,
  DeleteOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { LobeIcon, getProviderDefaultIcon } from '../LobeIcon';
import { getCredentialProviderMetadata } from '../common/providerMetadata';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import {
  deriveAuthFileIdentity,
  hasAuthFileStatusWarning,
  isAuthFileDisabled,
  isAuthFileProblem,
  providerOf,
} from './authFileLogic';
import styles from '../../pages/authFiles/AuthFilesPage.module.css';

const { Text, Paragraph } = Typography;

export interface AuthFileCardProps {
  file: ManagementAuthFile;
  selected: boolean;
  compact?: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onToggle: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onShowModels: () => void;
}

export const AuthFileCard: React.FC<AuthFileCardProps> = ({
  file,
  selected,
  compact,
  busy,
  onSelect,
  onToggle,
  onDownload,
  onDelete,
  onEdit,
  onShowModels,
}) => {
  const t = useT();
  const provider = providerOf(file);
  const meta = getCredentialProviderMetadata(provider);
  const iconId = meta.iconId || getProviderDefaultIcon(provider, file.name);
  const identity = deriveAuthFileIdentity(file);

  const disabled = isAuthFileDisabled(file);
  const problem = isAuthFileProblem(file);
  const hasWarning = hasAuthFileStatusWarning(file);

  const renderStatusBadge = () => {
    if (file.runtime_only) {
      return (
        <Tag style={{ margin: 0, fontSize: 11 }}>
          {t('af.runtime_only_badge')}
        </Tag>
      );
    }
    if (disabled) {
      return (
        <Tag color="error" style={{ margin: 0, fontSize: 11 }}>
          <span className={`${styles['stat-dot']} ${styles['dot-disabled']}`} style={{ marginRight: 4 }} />
          {t('af.disabled')}
        </Tag>
      );
    }
    if (problem) {
      return (
        <Tag color="warning" style={{ margin: 0, fontSize: 11 }}>
          <span className={`${styles['stat-dot']} ${styles['dot-problem']}`} style={{ marginRight: 4 }} />
          {t('af.status_problem')}
        </Tag>
      );
    }
    return (
      <Tag color="success" style={{ margin: 0, fontSize: 11 }}>
        <span className={`${styles['stat-dot']} ${styles['dot-active']}`} style={{ marginRight: 4 }} />
        {t('af.enabled')}
      </Tag>
    );
  };

  const footerStatusText = file.runtime_only
    ? t('af.status_virtual_badge')
    : disabled
      ? t('af.status_disabled_badge')
      : problem
        ? t('af.status_problem_badge')
        : t('af.status_active');

  return (
    <Card
      size="small"
      className="terminal-panel"
      style={{
        borderColor: selected ? 'var(--accent)' : undefined,
        opacity: disabled ? 0.72 : 1,
        transition: 'border-color 0.15s ease',
      }}
      styles={{
        body: {
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: compact ? '10px 12px' : '14px 16px',
        },
      }}
    >
      {/* Head: Checkbox, Avatar, Type Tag, Status Tag */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {!file.runtime_only && (
          <Checkbox
            checked={selected}
            disabled={busy}
            onChange={(e) => onSelect(e.target.checked)}
            aria-label={t('af.select_one', { name: file.name })}
          />
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-soft)',
            background: 'var(--hover-inset)',
            flexShrink: 0,
          }}
        >
          <LobeIcon iconId={iconId} size={16} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tag style={{ margin: 0, fontSize: 11 }}>{file.type || file.provider || 'unknown'}</Tag>
          {renderStatusBadge()}
        </div>
      </div>

      {/* Primary Identity & Secondary Filename */}
      <div style={{ minWidth: 0 }}>
        <Tooltip title={identity.primary}>
          <Text
            strong
            style={{
              fontSize: 13,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: !identity.isAccountPrimary ? 'var(--font-mono)' : undefined,
            }}
          >
            {identity.primary}
          </Text>
        </Tooltip>
        {identity.secondary && (
          <Text
            type="secondary"
            code
            style={{
              fontSize: 11,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
          >
            {identity.secondary}
          </Text>
        )}
      </div>

      {/* Note Callout */}
      {!compact && file.note && (
        <Paragraph
          type="secondary"
          ellipsis={{ rows: 2 }}
          style={{
            margin: 0,
            fontSize: 11,
            padding: '4px 8px',
            borderLeft: '2px solid var(--border)',
            background: 'var(--hover-inset)',
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
          }}
        >
          {file.note}
        </Paragraph>
      )}

      {/* Status Warning Banner */}
      {hasWarning && file.status_message && (
        <Alert
          type="warning"
          showIcon
          description={file.status_message}
          style={{ padding: '4px 8px', fontSize: 11 }}
        />
      )}

      {/* Requests Telemetry */}
      <Space size={6} wrap style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
        <Text style={{ color: 'var(--success)' }}>
          {t('dash.success_n', { n: file.success })}
        </Text>
        <Text type="secondary">·</Text>
        <Text style={{ color: file.failed > 0 ? 'var(--danger)' : 'var(--muted)' }}>
          {t('dash.failure_n', { n: file.failed })}
        </Text>
        <Text type="secondary">·</Text>
        <Text type="secondary">auth: {file.auth_index || '—'}</Text>
        {file.priority !== undefined && file.priority > 0 && (
          <Tag style={{ margin: 0, fontSize: 10 }}>P:{file.priority}</Tag>
        )}
        {file.weight !== undefined && file.weight !== 1 && (
          <Tag style={{ margin: 0, fontSize: 10 }}>W:{file.weight}</Tag>
        )}
      </Space>

      {/* Footer Actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 6,
          marginTop: 'auto',
          paddingTop: 8,
          borderTop: '1px solid var(--border-soft)',
        }}
      >
        <Text
          type="secondary"
          style={{
            marginRight: 'auto',
            fontSize: 9,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.08em',
          }}
        >
          {footerStatusText}
        </Text>

        <Button
          type="text"
          size="small"
          icon={<AppstoreOutlined />}
          onClick={onShowModels}
          title={t('af.models_btn')}
          aria-label={t('af.models_btn')}
          style={{ fontSize: 12, padding: '0 4px' }}
        >
          {t('af.models_btn')}
        </Button>

        <Button
          type="text"
          size="small"
          icon={<EditOutlined />}
          onClick={onEdit}
          title={t('common.edit')}
          aria-label={t('common.edit')}
          disabled={busy}
          style={{ fontSize: 12, padding: '0 4px' }}
        >
          {t('common.edit')}
        </Button>

        <Button
          type="text"
          size="small"
          icon={<DownloadOutlined />}
          disabled={busy || file.runtime_only}
          onClick={onDownload}
          title={t('af.download_one', { name: file.name })}
          aria-label={t('af.download_one', { name: file.name })}
        />

        <Popconfirm
          title={t('af.delete_one_title')}
          onConfirm={onDelete}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
          disabled={busy || file.runtime_only}
        >
          <Button
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            disabled={busy || file.runtime_only}
            title={t('af.delete_one', { name: file.name })}
            aria-label={t('af.delete_one', { name: file.name })}
          />
        </Popconfirm>

        <Switch
          size="small"
          checked={!disabled}
          disabled={busy || file.runtime_only}
          onChange={onToggle}
          aria-label={t('af.status_toggle_label', { name: file.name })}
        />
      </div>
    </Card>
  );
};
