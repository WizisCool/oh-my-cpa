import React from 'react';
import { App as AntdApp, Button, Checkbox, Dropdown, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  AppstoreOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  MoreOutlined,
  ProfileOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { credentialProviderIconId } from '../../components/common/providerMetadata';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import {
  deriveAuthFileIdentity,
  hasAuthFileStatusWarning,
  isAuthFileDisabled,
  isAuthFileProblem,
} from '../../components/authFiles/authFileLogic';
import styles from './OAuthCredentialRecord.module.css';

const { Text } = Typography;

interface OAuthCredentialRecordProps {
  file: ManagementAuthFile;
  identityKey: string;
  displayProvider: string;
  pluginLogo?: string;
  selected: boolean;
  compact: boolean;
  busy: boolean;
  canTargetFile: boolean;
  onSelect: (checked: boolean) => void;
  onToggle: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onShowModels: () => void;
  onShowDetails: () => void;
  quotaContent?: React.ReactNode;
  identityDiagnostic?: React.ReactNode;
  reauthAction?: React.ReactNode;
}

export const OAuthCredentialRecord: React.FC<OAuthCredentialRecordProps> = ({
  file,
  identityKey,
  displayProvider,
  pluginLogo,
  selected,
  compact,
  busy,
  canTargetFile,
  onSelect,
  onToggle,
  onDownload,
  onDelete,
  onEdit,
  onShowModels,
  onShowDetails,
  quotaContent,
  identityDiagnostic,
  reauthAction,
}) => {
  const t = useT();
  const { modal } = AntdApp.useApp();
  const isDemo = isDemoMode();
  const identity = deriveAuthFileIdentity(file);
  const disabled = isAuthFileDisabled(file);
  const problem = isAuthFileProblem(file);
  const hasWarning = hasAuthFileStatusWarning(file);
  const iconId = credentialProviderIconId(displayProvider, file.name);

  const status = file.runtime_only
    ? { color: undefined, label: t('af.runtime_only_badge') }
    : disabled
      ? { color: 'error', label: t('af.disabled') }
      : problem
        ? { color: 'warning', label: t('af.status_problem') }
        : { color: 'success', label: t('af.enabled') };

  const actionButton = (
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    options?: { danger?: boolean; disabled?: boolean },
  ) => (
    <Tooltip title={label}>
      <Button
        type="text"
        size="small"
        danger={options?.danger}
        icon={icon}
        disabled={options?.disabled}
        onClick={onClick}
        aria-label={`${label}: ${file.name}`}
        className={styles['record-action']}
      >
        {!compact && label}
      </Button>
    </Tooltip>
  );

  return (
    <article
      className={`${styles.record} ${compact ? styles['record-compact'] : styles['record-expanded']}`}
      data-testid="oauth-credential-record"
      data-identity={identityKey}
      data-file-name={file.name}
      data-auth-index={file.auth_index ?? ''}
    >
      <div className={styles['record-identity']}>
        {!file.runtime_only && (
          <Checkbox
            checked={selected}
            disabled={busy || !canTargetFile}
            onChange={(event) => onSelect(event.target.checked)}
            aria-label={t('af.select_one', { name: file.name })}
          />
        )}
        <div className={styles['record-icon']}>
          <ProviderBrandIcon iconId={iconId} logo={pluginLogo} size={18} />
        </div>
        <div className={styles['record-copy']}>
          <Text strong className={styles['record-primary']} title={identity.primary}>
            {identity.primary}
          </Text>
          <Text type="secondary" className={styles['record-secondary']} title={identity.secondary || file.name}>
            {identity.secondary || file.name}
          </Text>
          <span className={styles['record-identity-meta']}>
            {!iconId && <Tag>{displayProvider}</Tag>}
            <span
              className={`${styles['record-status']} ${styles[`status-${status.color || 'neutral'}`]}`}
            >
              {status.label}
            </span>
            {file.runtime_only && <Tag>{t('af.status_virtual_badge')}</Tag>}
            <Text
              type="secondary"
              className={styles['record-auth-index']}
              title={`${t('af.detail_auth_index')} ${file.auth_index || '—'}`}
            >
              {compact ? (file.auth_index || '—') : `${t('af.detail_auth_index')}: ${file.auth_index || '—'}`}
            </Text>
          </span>
        </div>
      </div>

      <div className={styles['record-management']}>
        <Space size={6} wrap={false} className={styles['record-metrics']}>
          <Text className={styles['metric-success']}>
            {compact ? `✓ ${file.success}` : t('dash.success_n', { n: file.success })}
          </Text>
          <Text type="secondary">·</Text>
          <Text className={file.failed > 0 ? styles['metric-failed'] : styles['metric-muted']}>
            {compact ? `✕ ${file.failed}` : t('dash.failure_n', { n: file.failed })}
          </Text>
        </Space>
        <div className={styles['record-routing']}>
          {file.priority !== undefined && file.priority !== 0 && (
            <Tag>{t('omc.priority_value', { n: file.priority })}</Tag>
          )}
          {file.weight !== undefined && file.weight !== 1 && (
            <Tag>{t('omc.weight_value', { n: file.weight })}</Tag>
          )}
          {file.note && (
            <Tooltip title={file.note}>
              <span className={styles['record-note']}>{file.note}</span>
            </Tooltip>
          )}
        </div>
        {hasWarning && file.status_message && (
          <Tooltip title={file.status_message}>
            <Text type="warning" className={styles['record-warning']}>
              <WarningOutlined /> {file.status_message}
            </Text>
          </Tooltip>
        )}
        {identityDiagnostic}
        {reauthAction && <div className={styles['record-reauth']}>{reauthAction}</div>}
      </div>

      <div className={styles['record-quota']}>
        {quotaContent}
      </div>

      <div className={styles['record-actions']}>
        <Switch
          size="small"
          checked={!disabled}
          disabled={busy || file.runtime_only || !canTargetFile}
          onChange={onToggle}
          aria-label={t('af.status_toggle_label', { name: file.name })}
        />
        {actionButton(t('common.details'), <ProfileOutlined />, onShowDetails, { disabled: busy })}
        {actionButton(t('af.models_btn'), <AppstoreOutlined />, onShowModels, { disabled: busy || file.runtime_only })}
        {actionButton(t('common.edit'), <EditOutlined />, onEdit, { disabled: busy || !canTargetFile })}
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              {
                key: 'download',
                icon: <DownloadOutlined />,
                label: t('af.download_one', { name: file.name }),
                disabled: busy || file.runtime_only || isDemo || !canTargetFile,
              },
              {
                key: 'delete',
                icon: <DeleteOutlined />,
                label: t('af.delete_one', { name: file.name }),
                danger: true,
                disabled: busy || file.runtime_only || isDemo || !canTargetFile,
              },
            ],
            onClick: ({ key }) => {
              if (key === 'download') {
                onDownload();
                return;
              }
              if (key === 'delete') {
                modal.confirm({
                  title: t('af.delete_one_title'),
                  content: file.name,
                  okText: t('common.delete'),
                  cancelText: t('common.cancel'),
                  okButtonProps: { danger: true },
                  onOk: onDelete,
                });
              }
            },
          }}
        >
          <Button
            type="text"
            size="small"
            icon={<MoreOutlined />}
            aria-label={`${t('keys.actions_more')}: ${file.name}`}
            className={styles['record-action']}
          >
            {!compact && t('keys.actions_more')}
          </Button>
        </Dropdown>
      </div>
    </article>
  );
};
