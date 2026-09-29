import React from 'react';

import { App as AntdApp, Button, Modal, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';

import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { saveBlob } from '../../utils/download';
import { formatBytes } from '../../utils/format';
import type { ConfigBackup } from '../../types/configManagement';
import { DownloadOutlined, HistoryOutlined } from '../icons';

const { Text } = Typography;

/**
 * The copies of pre-v8 configuration files kept before the save that converted
 * them. CPA rewrites the whole file on that save, dropping comments and keys it
 * does not know, so the copy is how an operator gets the original back.
 *
 * The button only appears once a copy exists: a gateway whose file was never
 * converted by this console has nothing to show.
 */
export const ConfigBackupsButton: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [isOpen, setIsOpen] = React.useState(false);
  const [downloadingID, setDownloadingID] = React.useState<number | null>(null);
  useOverlayHistory({ isOpen, onClose: () => setIsOpen(false) });

  const backupsQuery = useQuery({
    queryKey: ['management-config-backups'],
    queryFn: () => api.listConfigBackups(),
    staleTime: 60000,
  });
  const backups = backupsQuery.data?.backups ?? [];
  if (backups.length === 0) return null;

  const downloadBackup = async (backup: ConfigBackup) => {
    setDownloadingID(backup.id);
    try {
      const { yaml } = await api.getConfigBackup(backup.id);
      saveBlob(
        new Blob([yaml], { type: 'application/yaml' }),
        `cpa-config-before-v8-${dayjs(backup.created_at_ms).format('YYYYMMDD-HHmmss')}.yaml`,
      );
    } catch (err) {
      message.error(t('cfg.backups_download_failed', { msg: describeError(err) }));
    } finally {
      setDownloadingID(null);
    }
  };

  return (
    <>
      <Button size="small" icon={<HistoryOutlined />} onClick={() => setIsOpen(true)}>
        {t('cfg.backups')}
      </Button>
      <Modal open={isOpen} title={t('cfg.backups_title')} footer={null} onCancel={() => setIsOpen(false)}>
        <Text type="secondary" className="config-backups-desc">{t('cfg.backups_desc')}</Text>
        <Table<ConfigBackup>
          className="config-backups-table"
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={backups}
          columns={[
            {
              key: 'created',
              title: t('cfg.backups_created'),
              render: (_, backup) => dayjs(backup.created_at_ms).format('YYYY-MM-DD HH:mm:ss'),
            },
            { key: 'size', title: t('cfg.backups_size'), render: (_, backup) => formatBytes(backup.size_bytes) },
            {
              key: 'download',
              align: 'right',
              render: (_, backup) => (
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={downloadingID === backup.id}
                  onClick={() => void downloadBackup(backup)}
                >
                  {t('cfg.backups_download')}
                </Button>
              ),
            },
          ]}
        />
      </Modal>
    </>
  );
};
