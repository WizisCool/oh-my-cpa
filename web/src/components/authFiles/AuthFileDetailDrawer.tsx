import React, { useEffect } from 'react';
import {
  Drawer,
  Descriptions,
  Tag,
  Button,
  Typography,
  Card,
  Input,
  InputNumber,
  Form,
  Table,
  App as AntdApp,
} from 'antd';
import {
  SaveOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import type { ManagementAuthFile, ManagementAuthFileModel } from '../../types/managementAuthFile';

const { Text } = Typography;

interface AuthFileDetailDrawerProps {
  file: ManagementAuthFile | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDownload: (file: ManagementAuthFile) => void;
}

interface FormValues {
  priority?: number;
  weight?: number;
  note?: string;
}

export const AuthFileDetailDrawer: React.FC<AuthFileDetailDrawerProps> = ({
  file,
  open,
  onClose,
  onSaved,
  onDownload,
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();

  useEffect(() => {
    if (file) {
      form.setFieldsValue({
        priority: file.priority ?? 0,
        weight: file.weight ?? 1,
        note: file.note ?? '',
      });
    } else {
      form.resetFields();
    }
  }, [file, form]);

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ['auth-file-models', file?.name],
    queryFn: () => api.getManagementAuthFileModels(file!.name),
    enabled: Boolean(file?.name && open),
    staleTime: 60000,
  });

  const saveMutation = useMutation({
    mutationFn: (values: FormValues) => {
      if (!file) throw new Error('No file selected');
      return api.patchManagementAuthFileFields(file.name, {
        priority: values.priority,
        weight: values.weight,
        note: values.note,
      });
    },
    onSuccess: () => {
      message.success(t('af.save_fields_success'));
      onSaved();
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleFinish = (values: FormValues) => {
    saveMutation.mutate(values);
  };

  const models: ManagementAuthFileModel[] = modelsData?.models || file?.models || [];
  const quotaSignals = file?.quota?.signals ? Object.entries(file.quota.signals) : [];

  return (
    <Drawer
      title={t('af.drawer_title')}
      size="large"
      open={open}
      onClose={onClose}
    >
      {file ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Identity & Status */}
          <Card size="small" className="terminal-panel">
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered>
              <Descriptions.Item label="File Name">
                <span className="mono-num">{file.name}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Provider">
                <Tag color="purple">{file.type || file.provider || 'unknown'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Auth Index">
                <span className="mono-num">{file.auth_index || '—'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Status">
                {file.disabled ? (
                  <Tag color="error">{t('af.disabled')}</Tag>
                ) : file.unavailable ? (
                  <Tag color="warning">{t('af.unavailable')}</Tag>
                ) : (
                  <Tag color="success">{t('af.enabled')}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Identity">
                {file.email || file.project_id || t('af.identity_missing')}
              </Descriptions.Item>
              <Descriptions.Item label="Total Requests">
                {t('dash.success_n', { n: file.success })} · {t('dash.failure_n', { n: file.failed })}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {/* Safe Field Configuration Form */}
          <Card size="small" title={t('af.fields_title')} className="terminal-panel">
            <Form
              form={form}
              layout="vertical"
              onFinish={handleFinish}
              disabled={saveMutation.isPending}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <Form.Item name="priority" label={t('af.field_priority')}>
                  <InputNumber style={{ width: '100%' }} min={0} max={100} />
                </Form.Item>
                <Form.Item name="weight" label={t('af.field_weight')}>
                  <InputNumber style={{ width: '100%' }} min={0} max={1000} />
                </Form.Item>
              </div>
              <Form.Item name="note" label={t('af.field_note')}>
                <Input.TextArea rows={3} maxLength={500} showCount />
              </Form.Item>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<SaveOutlined />}
                  loading={saveMutation.isPending}
                >
                  {t('af.save_fields')}
                </Button>
              </div>
            </Form>
          </Card>

          {/* Supported Models */}
          <Card size="small" title={t('af.models_title')} className="terminal-panel">
            {models.length > 0 ? (
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                <Table<ManagementAuthFileModel>
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={models}
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
                  ]}
                />
              </div>
            ) : (
              <Text type="secondary">{modelsLoading ? t('common.loading') : t('af.models_empty')}</Text>
            )}
          </Card>

          {/* Quota Observations */}
          <Card size="small" title={t('af.quota_title')} className="terminal-panel">
            {quotaSignals.length > 0 ? (
              <Descriptions column={1} size="small" bordered>
                {quotaSignals.map(([k, v]) => (
                  <Descriptions.Item key={k} label={k}>
                    <span className="mono-num">{v}</span>
                  </Descriptions.Item>
                ))}
              </Descriptions>
            ) : (
              <Text type="secondary">{t('af.quota_empty')}</Text>
            )}
          </Card>

          {/* Footer Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, paddingTop: 8 }}>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => onDownload(file)}
            >
              {t('af.download_one', { name: file.name })}
            </Button>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
};
