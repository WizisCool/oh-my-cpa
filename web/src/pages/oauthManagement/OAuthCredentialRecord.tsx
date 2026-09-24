import React from 'react';
import { App as AntdApp, Button, Checkbox, Dropdown, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  AppstoreOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  MoreOutlined,
  ProfileOutlined,
  StopOutlined,
  SyncOutlined,
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
  busy: boolean;
  canTargetFile: boolean;
  onSelect: (checked: boolean) => void;
  onToggle: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onShowModels: () => void;
  onShowDetails: () => void;
  onRefreshQuota?: () => void;
  canRefreshQuota?: boolean;
  isRefreshingQuota?: boolean;
  onClearCooldown?: () => void;
  canClearCooldown?: boolean;
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
  busy,
  canTargetFile,
  onSelect,
  onToggle,
  onDownload,
  onDelete,
  onEdit,
  onShowModels,
  onShowDetails,
  onRefreshQuota,
  canRefreshQuota = false,
  isRefreshingQuota = false,
  onClearCooldown,
  canClearCooldown = false,
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

  return (
    <article
      className={`${styles.record} ${styles['record-compact']} ${selected ? styles['record-selected'] : ''} ${disabled ? styles['record-disabled'] : ''}`}
      data-testid="oauth-credential-record"
      data-identity={identityKey}
      data-file-name={file.name}
      data-auth-index={file.auth_index ?? ''}
    >
      {/* 1. Identity & Routing */}
      <div className={styles['record-identity']}>
        {!file.runtime_only && (
          <Checkbox
            checked={selected}
            disabled={busy || !canTargetFile}
            onChange={(event) => onSelect(event.target.checked)}
            aria-label={t('af.select_one', { name: file.name })}
            className={styles['record-checkbox']}
          />
        )}
        <div className={styles['record-icon']} title={displayProvider}>
          <ProviderBrandIcon iconId={iconId} logo={pluginLogo} size={18} />
        </div>
        <div className={styles['record-copy']}>
          <div className={styles['record-title-row']}>
            <Text strong className={styles['record-primary']} title={identity.primary}>
              {identity.primary}
            </Text>
            {hasWarning && file.status_message && (
              <Tooltip title={file.status_message}>
                <span className={styles['record-warning']}>
                  <WarningOutlined /> {file.status_message}
                </span>
              </Tooltip>
            )}
          </div>
          <div className={styles['record-secondary-row']}>
            {identity.secondary && identity.secondary !== identity.primary && (
              <span className={styles['record-secondary']} title={identity.secondary}>
                {identity.secondary}
              </span>
            )}
            <span
              className={styles['record-auth-index']}
              title={`${t('af.detail_auth_index')}: ${file.auth_index || '—'}`}
            >
              {file.auth_index || '—'}
            </span>
            {file.runtime_only && <Tag className={styles['virtual-tag']}>{t('af.status_virtual_badge')}</Tag>}
            {file.priority !== undefined && (
              <Tag className={styles['routing-tag']}>{t('omc.priority_value', { n: file.priority })}</Tag>
            )}
            {file.weight !== undefined && (
              <Tag className={styles['routing-tag']}>{t('omc.weight_value', { n: file.weight })}</Tag>
            )}
            {file.note && (
              <Tooltip title={file.note}>
                <span className={styles['record-note']}>{file.note}</span>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* 2. Status Column */}
      <div className={styles['record-status']}>
        <Switch
          size="small"
          checked={!disabled}
          disabled={busy || file.runtime_only || !canTargetFile}
          onChange={onToggle}
          aria-label={t('af.status_toggle_label', { name: file.name })}
        />
        <Tag className={`${styles['status-tag']} ${styles[`status-tag-${status.color || 'neutral'}`]}`}>
          {status.label}
        </Tag>
      </div>

      {/* 3. Traffic Metrics */}
      <div className={styles['record-management']}>
        <div className={styles['traffic-cell']}>
          <div className={styles['traffic-primary']}>
            <span className={styles['metric-success']} aria-label={t('dash.success_n', { n: file.success })}>
              {t('dash.success_n', { n: file.success })}
            </span>
          </div>
          <div className={styles['traffic-secondary']}>
            <span
              className={file.failed > 0 ? styles['metric-failed'] : styles['metric-muted']}
              aria-label={t('dash.failure_n', { n: file.failed })}
            >
              {t('dash.failure_n', { n: file.failed })}
            </span>
          </div>
        </div>
        {identityDiagnostic}
        {reauthAction && <div className={styles['record-reauth']}>{reauthAction}</div>}
      </div>

      {/* 3. Quota & Usage Windows */}
      <div className={styles['record-quota']}>
        {quotaContent}
      </div>

      {/* 5. Controls & Actions */}
      <div className={styles['record-actions']}>
        <Tooltip title={t('common.details')}>
          <Button
            size="small"
            icon={<ProfileOutlined />}
            disabled={busy}
            onClick={onShowDetails}
            aria-label={`${t('common.details')}: ${file.name}`}
            className={styles['btn-details']}
          >
            <span className={styles['btn-details-text']}>{t('common.details')}</span>
          </Button>
        </Tooltip>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              {
                key: 'models',
                icon: <AppstoreOutlined />,
                label: t('af.models_btn'),
                disabled: busy || file.runtime_only,
              },
              {
                key: 'edit',
                icon: <EditOutlined />,
                label: t('common.edit'),
                disabled: busy || !canTargetFile,
              },
              {
                key: 'refresh-quota',
                icon: <SyncOutlined spin={isRefreshingQuota} />,
                label: t('quota.btn_refresh_quota'),
                disabled: busy || isRefreshingQuota || isDemo || !canRefreshQuota,
              },
              {
                key: 'clear-cooldown',
                icon: <StopOutlined />,
                label: t('quota.clear_cooldown'),
                disabled: busy || isDemo || !canClearCooldown,
              },
              { type: 'divider' as const },
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
              if (key === 'models') {
                onShowModels();
                return;
              }
              if (key === 'edit') {
                onEdit();
                return;
              }
              if (key === 'refresh-quota') {
                onRefreshQuota?.();
                return;
              }
              if (key === 'clear-cooldown') {
                onClearCooldown?.();
                return;
              }
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
          <Tooltip title={t('keys.actions_more')}>
            <Button
              type="text"
              size="small"
              icon={<MoreOutlined />}
              aria-label={`${t('keys.actions_more')}: ${file.name}`}
              className={styles['record-action-more']}
            />
          </Tooltip>
        </Dropdown>
      </div>
    </article>
  );
};
