import React, { useState } from 'react';
import { App as AntdApp, Modal, Table, Input, Typography, Button } from 'antd';
import { CopyOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import type { ManagementAuthFile, ManagementAuthFileModel } from '../../types/managementAuthFile';

const { Text } = Typography;

interface ModelsModalProps {
  file: ManagementAuthFile | null;
  open: boolean;
  onClose: () => void;
}

export const ModelsModal: React.FC<ModelsModalProps> = ({ file, open, onClose }) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [filter, setFilter] = useState('');

  const {
    data: modelsData,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['auth-file-models', file?.name],
    queryFn: () => api.getManagementAuthFileModels(file!.name),
    enabled: Boolean(file?.name && open && !file?.runtime_only),
    staleTime: 60000,
  });

  const rawModels: ManagementAuthFileModel[] = modelsData?.models || file?.models || [];
  const filteredModels = rawModels.filter((m) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || (m.display_name && m.display_name.toLowerCase().includes(q));
  });

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => message.success(t('common.copied')),
      () => message.error('Failed to copy')
    );
  };

  const renderContent = () => {
    if (file?.runtime_only) {
      return <Text type="secondary">{t('af.runtime_only_badge')}</Text>;
    }
    if (isLoading) {
      return <div style={{ padding: 24, textAlign: 'center' }}>{t('common.loading')}</div>;
    }
    if (isError) {
      const is501 = error instanceof ApiError && error.status === 501;
      return (
        <div style={{ padding: 16 }}>
          <Text type="secondary">
            {is501 ? t('af.unsupported') : (error instanceof Error ? error.message : t('af.request_failed'))}
          </Text>
        </div>
      );
    }
    if (rawModels.length === 0) {
      return <div style={{ padding: 24, textAlign: 'center' }}><Text type="secondary">{t('af.models_empty')}</Text></div>;
    }

    return (
      <div>
        <div style={{ marginBottom: 12 }}>
          <Input
            prefix={<SearchOutlined />}
            placeholder={t('common.search')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            allowClear
          />
        </div>
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          <Table<ManagementAuthFileModel>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={filteredModels}
            columns={[
              {
                title: 'Model ID',
                dataIndex: 'id',
                key: 'id',
                render: (id: string) => <span className="mono-num">{id}</span>,
              },
              {
                title: 'Display Name',
                dataIndex: 'display_name',
                key: 'display_name',
                render: (name: string) => name || '-',
              },
              {
                title: '',
                key: 'action',
                width: 60,
                render: (_, record) => (
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => handleCopy(record.id)}
                  />
                ),
              },
            ]}
          />
        </div>
      </div>
    );
  };

  return (
    <Modal
      title={`${t('af.models_title')} — ${file?.name ?? ''}`}
      open={open}
      onOk={onClose}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          {t('common.close')}
        </Button>,
      ]}
    >
      {renderContent()}
    </Modal>
  );
};
