import React, { useEffect, useState, useCallback } from 'react';
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
  Switch,
  App as AntdApp,
} from 'antd';
import {
  SaveOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import type { ManagementAuthFile, ManagementAuthFileModel } from '../../types/managementAuthFile';
import {
  deriveAuthFileIdentity,
  hasAuthFileStatusWarning,
  isAuthFileDisabled,
  isAuthFileProblem,
} from './authFileLogic';

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
  prefix?: string;
  proxy_url?: string;
  disable_cooling?: boolean;
  excluded_models?: string;
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
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [baseline, setBaseline] = useState<FormValues>({});
  const [isDirty, setIsDirty] = useState(false);

  // Initialize form baseline whenever a new file is opened
  useEffect(() => {
    if (file && open) {
      const initial: FormValues = {
        priority: file.priority ?? 0,
        weight: file.weight ?? 1,
        prefix: '',
        proxy_url: '',
        disable_cooling: false,
        excluded_models: '',
        note: file.note ?? '',
      };
      setBaseline(initial);
      form.setFieldsValue(initial);
      setIsDirty(false);
    } else {
      form.resetFields();
      setBaseline({});
      setIsDirty(false);
    }
  }, [file?.name, open, form]);

  const handleValuesChange = () => {
    const current = form.getFieldsValue();
    const changed =
      current.priority !== baseline.priority ||
      current.weight !== baseline.weight ||
      (current.prefix || '') !== (baseline.prefix || '') ||
      (current.proxy_url || '') !== (baseline.proxy_url || '') ||
      Boolean(current.disable_cooling) !== Boolean(baseline.disable_cooling) ||
      (current.excluded_models || '').trim() !== (baseline.excluded_models || '').trim() ||
      (current.note || '') !== (baseline.note || '');
    setIsDirty(changed);
  };

  const handleAttemptClose = useCallback(() => {
    if (isDirty) {
      modal.confirm({
        title: t('af.unsaved_confirm_title'),
        icon: <ExclamationCircleOutlined />,
        content: t('af.unsaved_confirm_desc'),
        okText: t('common.confirm'),
        cancelText: t('common.cancel'),
        okButtonProps: { danger: true },
        onOk: () => {
          setIsDirty(false);
          onClose();
        },
      });
    } else {
      onClose();
    }
  }, [isDirty, modal, onClose, t]);

  const {
    data: modelsData,
    isLoading: modelsLoading,
    isError: modelsIsError,
    error: modelsError,
  } = useQuery({
    queryKey: ['auth-file-models', file?.name],
    queryFn: () => api.getManagementAuthFileModels(file!.name),
    enabled: Boolean(file?.name && open && !file?.runtime_only),
    staleTime: 60000,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ fileName, values }: { fileName: string; values: FormValues }) => {
      const patch: Record<string, unknown> = {};

      if (values.priority !== baseline.priority && values.priority !== undefined) {
        patch.priority = values.priority;
      }
      if (values.weight !== baseline.weight && values.weight !== undefined) {
        patch.weight = values.weight;
      }
      if ((values.note || '') !== (baseline.note || '')) {
        patch.note = values.note || '';
      }
      if ((values.prefix || '') !== (baseline.prefix || '')) {
        patch.prefix = values.prefix || '';
      }
      if ((values.proxy_url || '') !== (baseline.proxy_url || '')) {
        patch.proxy_url = values.proxy_url || '';
      }
      if (Boolean(values.disable_cooling) !== Boolean(baseline.disable_cooling)) {
        patch.disable_cooling = Boolean(values.disable_cooling);
      }
      if ((values.excluded_models || '').trim() !== (baseline.excluded_models || '').trim()) {
        const modelsList = (values.excluded_models || '')
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        patch.excluded_models = modelsList;
      }

      if (Object.keys(patch).length === 0) {
        return { status: 'noop' };
      }

      return api.patchManagementAuthFileFields(fileName, patch);
    },
    onSuccess: (_, variables) => {
      // Guard against stale save callback if file changed
      if (file && variables.fileName === file.name) {
        message.success(t('af.save_fields_success'));
        setIsDirty(false);
        onSaved();
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleFinish = (values: FormValues) => {
    if (!file) return;
    saveMutation.mutate({ fileName: file.name, values });
  };

  const models: ManagementAuthFileModel[] = modelsData?.models || file?.models || [];
  const quotaSignals = file?.quota?.signals ? Object.entries(file.quota.signals) : [];
  const identity = file ? deriveAuthFileIdentity(file) : null;
  const isProblem = file ? isAuthFileProblem(file) : false;
  const isDisabled = file ? isAuthFileDisabled(file) : false;
  const hasWarning = file ? hasAuthFileStatusWarning(file) : false;

  const renderModelsContent = () => {
    if (file?.runtime_only) {
      return <Text type="secondary">{t('af.runtime_only_badge')}</Text>;
    }
    if (modelsLoading) {
      return <Text type="secondary">{t('common.loading')}</Text>;
    }
    if (modelsIsError) {
      const is501 = modelsError instanceof ApiError && modelsError.status === 501;
      return (
        <Text type="secondary">
          {is501 ? t('af.unsupported') : (modelsError instanceof Error ? modelsError.message : t('af.request_failed'))}
        </Text>
      );
    }
    if (models.length === 0) {
      return <Text type="secondary">{t('af.models_empty')}</Text>;
    }
    return (
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
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
    );
  };

  return (
    <Drawer
      title={t('af.drawer_title')}
      size="large"
      open={open}
      onClose={handleAttemptClose}
    >
      {file ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Identity & Status Card */}
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
                {file.runtime_only ? (
                  <Tag color="default">{t('af.runtime_only_badge')}</Tag>
                ) : isDisabled ? (
                  <Tag color="error">{t('af.disabled')}</Tag>
                ) : isProblem ? (
                  <Tag color="warning">{t('af.status_problem')}</Tag>
                ) : (
                  <Tag color="success">{t('af.enabled')}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Identity">
                {identity?.primary || t('af.identity_missing')}
              </Descriptions.Item>
              <Descriptions.Item label="Total Requests">
                <span className="mono-num">
                  {t('dash.success_n', { n: file.success })} · {t('dash.failure_n', { n: file.failed })}
                </span>
              </Descriptions.Item>
            </Descriptions>
            {hasWarning && file.status_message && (
              <div
                style={{
                  marginTop: 10,
                  padding: '6px 10px',
                  background: 'rgba(255, 159, 10, 0.12)',
                  border: '1px solid rgba(255, 159, 10, 0.4)',
                  borderRadius: 4,
                  color: 'var(--warn)',
                  fontSize: 12,
                }}
              >
                <b>{t('af.warning_status')}:</b> {file.status_message}
              </div>
            )}
          </Card>

          {/* Safe Field Configuration Form */}
          <Card size="small" title={t('af.fields_title')} className="terminal-panel">
            <Form
              form={form}
              layout="vertical"
              onValuesChange={handleValuesChange}
              onFinish={handleFinish}
              disabled={saveMutation.isPending || file.runtime_only}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <Form.Item name="priority" label={t('af.field_priority')}>
                  <InputNumber style={{ width: '100%' }} min={0} max={100} />
                </Form.Item>
                <Form.Item name="weight" label={t('af.field_weight')}>
                  <InputNumber style={{ width: '100%' }} min={0} max={1000} />
                </Form.Item>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <Form.Item name="prefix" label={t('af.field_prefix')}>
                  <Input placeholder="/custom-prefix" allowClear />
                </Form.Item>
                <Form.Item name="proxy_url" label={t('af.field_proxy_url')}>
                  <Input placeholder="http://127.0.0.1:7890" allowClear />
                </Form.Item>
              </div>

              <Form.Item
                name="disable_cooling"
                label={t('af.field_disable_cooling')}
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>

              <Form.Item
                name="excluded_models"
                label={t('af.field_excluded_models')}
                extra={t('af.field_excluded_models_hint')}
              >
                <Input.TextArea rows={2} placeholder="model-a, model-b" />
              </Form.Item>

              <Form.Item name="note" label={t('af.field_note')}>
                <Input.TextArea rows={2} maxLength={500} showCount />
              </Form.Item>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<SaveOutlined />}
                  loading={saveMutation.isPending}
                  disabled={!isDirty || file.runtime_only}
                >
                  {t('af.save_fields')}
                </Button>
              </div>
            </Form>
          </Card>

          {/* Supported Models */}
          <Card size="small" title={t('af.models_title')} className="terminal-panel">
            {renderModelsContent()}
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
              disabled={file.runtime_only}
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
