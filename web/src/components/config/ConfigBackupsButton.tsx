import React from 'react';

import { Button, InputNumber, Modal, Popconfirm, Table, Tag, Tooltip, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';

import { api, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { isDemoMode } from '../../types/demoMode';
import { saveBlob } from '../../utils/download';
import { formatBytes } from '../../utils/format';
import type { ConfigBackup } from '../../types/configManagement';
import { DeleteOutlined, DownloadOutlined, HistoryOutlined, PlusOutlined, RollbackOutlined } from '../icons';
import { useToast } from '../feedback';
import { describeConfigSaveError } from './configSaveErrors';
import styles from './ConfigBackupsButton.module.css';

const { Text } = Typography;

const BACKUPS_QUERY_KEY = ['management-config-backups'];

/** Reasons the console names; anything newer than this build reads as a generic write. */
const KNOWN_REASONS = new Set([
  'config_changes',
  'config_source',
  'provider_keys',
  'client_keys',
  'oauth_aliases',
  'plugin_settings',
  'plugin_install',
  'plugin_delete',
  'credential_status',
  'restore',
  'manual',
  'legacy_conversion',
]);

interface ConfigBackupsButtonProps {
  /**
   * A restore replaces the whole document the editor is based on, so it is
   * withheld while the operator has unsaved edits instead of discarding them.
   */
  isDirty: boolean;
  /** Reloads the editor onto the document CPA stores after a restore. */
  onRestored: () => Promise<void> | void;
}

/**
 * The configuration file as it was before each write. Oh My CPA keeps one
 * encrypted copy before every operation that rewrites CPA's file, so any of them
 * can be undone: a restore writes the chosen copy back on the server, after
 * keeping the file it replaces like any other write.
 */
export const ConfigBackupsButton: React.FC<ConfigBackupsButtonProps> = ({ isDirty, onRestored }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const [isOpen, setIsOpen] = React.useState(false);
  const [downloadingID, setDownloadingID] = React.useState<number | null>(null);
  const [retentionDraft, setRetentionDraft] = React.useState<number | null>(null);
  useOverlayHistory({ isOpen, onClose: () => setIsOpen(false) });

  const backupsQuery = useQuery({
    queryKey: BACKUPS_QUERY_KEY,
    queryFn: () => api.listConfigBackups(),
    staleTime: 60000,
  });
  const backups = backupsQuery.data?.backups ?? [];
  const settings = backupsQuery.data?.settings;
  const refreshBackups = () => queryClient.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: () => api.createConfigBackup(),
    onSuccess: ({ created }) => {
      toast.success(created ? t('cfg.backups_created_now') : t('cfg.backups_unchanged'));
      void refreshBackups();
    },
    onError: (err) => toast.error(t('cfg.backups_create_failed', { msg: describeError(err) })),
  });

  const settingsMutation = useMutation({
    mutationFn: (retention: number) => api.updateConfigBackupSettings(retention),
    onSuccess: ({ settings: saved }) => {
      setRetentionDraft(null);
      toast.success(t('cfg.backups_retention_saved', { n: saved.retention }));
      void refreshBackups();
    },
    onError: (err) => toast.error(t('cfg.backups_retention_failed', { msg: describeError(err) })),
  });

  const restoreMutation = useMutation({
    mutationFn: (backup: ConfigBackup) => api.restoreConfigBackup(backup.id),
    onSuccess: async () => {
      toast.success(t('cfg.backups_restored'));
      void refreshBackups();
      await onRestored();
    },
    onError: (err) => {
      const reason = apiErrorCode(err) === 'config_backup_legacy' ? t('cfg.backups_restore_legacy') : describeConfigSaveError(err, t);
      toast.error(t('cfg.backups_restore_failed', { msg: reason }));
      void refreshBackups();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (backup: ConfigBackup) => api.deleteConfigBackup(backup.id),
    onSuccess: () => void refreshBackups(),
    onError: (err) => toast.error(t('cfg.backups_delete_failed', { msg: describeError(err) })),
  });

  const downloadBackup = async (backup: ConfigBackup) => {
    setDownloadingID(backup.id);
    try {
      const { yaml } = await api.getConfigBackup(backup.id);
      saveBlob(
        new Blob([yaml], { type: 'application/yaml' }),
        `cpa-config-${dayjs(backup.created_at_ms).format('YYYYMMDD-HHmmss')}.yaml`,
      );
    } catch (err) {
      toast.error(t('cfg.backups_download_failed', { msg: describeError(err) }));
    } finally {
      setDownloadingID(null);
    }
  };

  const describeReason = (reason: string) => t(KNOWN_REASONS.has(reason) ? `cfg.backups_reason_${reason}` : 'cfg.backups_reason_other');

  const restoreBlockedReason = (backup: ConfigBackup): string | undefined => {
    if (isDemo) return t('demo.blocked');
    if (backup.layout !== 'v8') return t('cfg.backups_restore_legacy');
    if (isDirty) return t('cfg.backups_restore_dirty');
    return undefined;
  };

  const retentionValue = retentionDraft ?? settings?.retention ?? null;
  const isRetentionChanged = retentionDraft !== null && retentionDraft !== settings?.retention;

  return (
    <>
      <Button size="small" icon={<HistoryOutlined />} onClick={() => setIsOpen(true)}>
        {t('cfg.backups')}
      </Button>
      <Modal
        open={isOpen}
        title={t('cfg.backups_title')}
        footer={null}
        width={760}
        onCancel={() => setIsOpen(false)}
      >
        <Text type="secondary" className={styles['backups-desc']}>
          {t('cfg.backups_desc', { legacy: settings?.legacy_retention ?? 10 })}
        </Text>
        <div className={styles['backups-toolbar']}>
          <div className={styles['backups-retention']}>
            <Text>{t('cfg.backups_retention')}</Text>
            <InputNumber
              size="small"
              min={settings?.retention_min ?? 5}
              max={settings?.retention_max ?? 100}
              precision={0}
              value={retentionValue}
              disabled={!settings || isDemo}
              aria-label={t('cfg.backups_retention')}
              onChange={(value) => setRetentionDraft(typeof value === 'number' ? value : null)}
            />
            <Text type="secondary">{t('cfg.backups_retention_unit')}</Text>
            {isRetentionChanged && (
              <Button
                size="small"
                type="primary"
                loading={settingsMutation.isPending}
                onClick={() => retentionDraft !== null && settingsMutation.mutate(retentionDraft)}
              >
                {t('common.save')}
              </Button>
            )}
          </div>
          <Button
            size="small"
            icon={<PlusOutlined />}
            loading={createMutation.isPending}
            disabled={isDemo}
            title={isDemo ? t('demo.blocked') : undefined}
            onClick={() => createMutation.mutate()}
          >
            {t('cfg.backups_create')}
          </Button>
        </div>
        <Table<ConfigBackup>
          className={styles['backups-table']}
          size="small"
          rowKey="id"
          pagination={false}
          loading={backupsQuery.isPending}
          dataSource={backups}
          scroll={{ x: 'max-content', y: 420 }}
          locale={{ emptyText: backupsQuery.isError ? describeError(backupsQuery.error) : t('cfg.backups_empty') }}
          columns={[
            {
              key: 'created',
              title: t('cfg.backups_created'),
              render: (_, backup) => (
                <Tooltip title={dayjs(backup.created_at_ms).format('YYYY-MM-DD HH:mm:ss')}>
                  <span className={styles['backups-time']}>{dayjs(backup.created_at_ms).format('MM-DD HH:mm:ss')}</span>
                </Tooltip>
              ),
            },
            {
              key: 'reason',
              title: t('cfg.backups_reason'),
              render: (_, backup) => (
                <span className={styles['backups-reason']}>
                  {describeReason(backup.reason)}
                  {backup.layout !== 'v8' && <Tag className={styles['backups-layout']}>{t('cfg.backups_layout_legacy')}</Tag>}
                </span>
              ),
            },
            { key: 'size', title: t('cfg.backups_size'), render: (_, backup) => formatBytes(backup.size_bytes) },
            {
              key: 'actions',
              align: 'right',
              render: (_, backup) => {
                const blockedReason = restoreBlockedReason(backup);
                return (
                  <span className={styles['backups-actions']}>
                    <Popconfirm
                      title={t('cfg.backups_restore_confirm')}
                      description={t('cfg.backups_restore_confirm_desc', { time: dayjs(backup.created_at_ms).format('YYYY-MM-DD HH:mm:ss') })}
                      okText={t('cfg.backups_restore')}
                      cancelText={t('common.cancel')}
                      disabled={Boolean(blockedReason)}
                      onConfirm={() => restoreMutation.mutateAsync(backup).catch(() => undefined)}
                    >
                      <Tooltip title={blockedReason}>
                        <Button
                          size="small"
                          icon={<RollbackOutlined />}
                          disabled={Boolean(blockedReason) || (restoreMutation.isPending && restoreMutation.variables?.id !== backup.id)}
                          loading={restoreMutation.isPending && restoreMutation.variables?.id === backup.id}
                        >
                          {t('cfg.backups_restore')}
                        </Button>
                      </Tooltip>
                    </Popconfirm>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      loading={downloadingID === backup.id}
                      aria-label={t('cfg.backups_download')}
                      title={t('cfg.backups_download')}
                      onClick={() => void downloadBackup(backup)}
                    />
                    <Popconfirm
                      title={t('cfg.backups_delete_confirm')}
                      okText={t('common.delete')}
                      okButtonProps={{ danger: true }}
                      cancelText={t('common.cancel')}
                      disabled={isDemo}
                      onConfirm={() => deleteMutation.mutateAsync(backup).catch(() => undefined)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={isDemo}
                        loading={deleteMutation.isPending && deleteMutation.variables?.id === backup.id}
                        aria-label={t('common.delete')}
                        title={isDemo ? t('demo.blocked') : t('common.delete')}
                      />
                    </Popconfirm>
                  </span>
                );
              },
            },
          ]}
        />
      </Modal>
    </>
  );
};
