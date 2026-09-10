import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Alert,
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

  const sessionCounterRef = useRef(0);
  const currentSessionRef = useRef<number>(0);
  const isPendingRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      currentSessionRef.current = 0;
      isPendingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (file && open) {
      sessionCounterRef.current += 1;
      const sid = sessionCounterRef.current;
      currentSessionRef.current = sid;

      const initial: FormValues = {
        priority: file.priority ?? 0,
        weight: file.weight ?? 1,
        note: file.note ?? '',
      };
      setBaseline(initial);
      form.setFieldsValue(initial);
      setIsDirty(false);
    } else {
      currentSessionRef.current = 0;
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
      (current.note || '') !== (baseline.note || '');
    setIsDirty(changed);
  };

  const saveMutation = useMutation({
    mutationFn: async ({
      fileName,
      patch,
    }: {
      fileName: string;
      patch: Record<string, unknown>;
      sessionId: number;
    }) => {
      return api.patchManagementAuthFileFields(fileName, patch);
    },
    onSuccess: (_, variables) => {
      isPendingRef.current = false;
      onSaved();
      if (variables.sessionId === currentSessionRef.current) {
        message.success(t('af.save_fields_success'));
        setIsDirty(false);
        onClose();
      }
    },
    onError: (err: unknown) => {
      isPendingRef.current = false;
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleAttemptClose = useCallback(() => {
    if (saveMutation.isPending || isPendingRef.current) return;
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
  }, [isDirty, modal, onClose, saveMutation.isPending, t]);

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

  const handleFinish = (values: FormValues) => {
    if (!file || file.runtime_only || isPendingRef.current || saveMutation.isPending) return;
    isPendingRef.current = true;

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

    if (Object.keys(patch).length === 0) {
      isPendingRef.current = false;
      onClose();
      return;
    }

    saveMutation.mutate({
      fileName: file.name,
      patch,
      sessionId: currentSessionRef.current,
    });
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
          {is501
            ? t('af.unsupported')
            : modelsError instanceof Error
              ? modelsError.message
              : t('af.request_failed')}
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
              title: t('af.model_id'),
              dataIndex: 'id',
              key: 'id',
              render: (id: string) => <span className="mono-num">{id}</span>,
            },
            {
              title: t('af.model_name'),
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
              <Descriptions.Item label={t('af.detail_file_name')}>
                <span className="mono-num">{file.name}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('af.detail_provider')}>
                <Tag color="purple">{file.type || file.provider || 'unknown'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('af.detail_auth_index')}>
                <span className="mono-num">{file.auth_index || '—'}</span>
              </Descriptions.Item>
              <Descriptions.Item label={t('af.detail_status')}>
                {file.runtime_only ? (
                  <Tag>{t('af.runtime_only_badge')}</Tag>
                ) : isDisabled ? (
                  <Tag color="error">{t('af.disabled')}</Tag>
                ) : isProblem ? (
                  <Tag color="warning">{t('af.status_problem')}</Tag>
                ) : (
                  <Tag color="success">{t('af.enabled')}</Tag>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={t('af.detail_identity')}>
                {identity?.primary || t('af.identity_missing')}
              </Descriptions.Item>
              <Descriptions.Item label={t('af.detail_total_requests')}>
                <span className="mono-num">
                  {t('dash.success_n', { n: file.success })} · {t('dash.failure_n', { n: file.failed })}
                </span>
              </Descriptions.Item>
            </Descriptions>
            {hasWarning && file.status_message && (
              <Alert
                type="warning"
                showIcon
                description={
                  <span>
                    <b>{t('af.warning_status')}:</b> {file.status_message}
                  </span>
                }
                style={{ marginTop: 12 }}
              />
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
                <Form.Item
                  name="priority"
                  label={t('af.field_priority')}
                  rules={[
                    {
                      type: 'integer',
                      min: 0,
                      max: 100,
                      message: t('af.val_priority_int'),
                    },
                  ]}
                >
                  <InputNumber style={{ width: '100%' }} min={0} max={100} precision={0} />
                </Form.Item>
                <Form.Item
                  name="weight"
                  label={t('af.field_weight')}
                  rules={[
                    {
                      type: 'integer',
                      min: 0,
                      max: 1000,
                      message: t('af.val_weight_int'),
                    },
                  ]}
                >
                  <InputNumber style={{ width: '100%' }} min={0} max={1000} precision={0} />
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
