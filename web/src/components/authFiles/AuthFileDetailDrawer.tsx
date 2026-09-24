import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Alert,
  Drawer,
  Descriptions,
  Tag,
  Tabs,
  Button,
  Typography,
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
  CopyOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import type {
  ManagementAuthFile,
  ManagementAuthFileModel,
  ManagementAuthFileSafeFields,
} from '../../types/managementAuthFile';
import {
  deriveAuthFileIdentity,
  hasAuthFileStatusWarning,
  isAuthFileDisabled,
  isAuthFileProblem,
} from './authFileLogic';
import styles from './AuthFileDetailDrawer.module.css';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { copyText } from '../../utils/clipboard';

const { Text } = Typography;

interface AuthFileDetailDrawerProps {
  file: ManagementAuthFile | null;
  open: boolean;
  onClose: () => void;
  onSaved: (file?: ManagementAuthFile) => void;
  onDownload: (file: ManagementAuthFile) => void;
  quotaContent?: React.ReactNode;
  initialSection?: 'overview' | 'configuration' | 'models';
  /**
   * Whether the safe fields may be written. The write is keyed by file name, so a
   * credential whose name does not identify one entry cannot be edited safely: the
   * request would land on whichever entry CPA resolves the name to.
   */
  canEdit?: boolean;
}

interface FormValues {
  priority?: number;
  weight?: number;
  note?: string;
  prefix?: string;
  proxy_url?: string;
  expired?: string;
  disable_cooling?: boolean;
  websockets?: boolean;
  using_api?: boolean;
  excluded_models?: string;
}

const MAX_CREDENTIAL_WEIGHT = 1_000_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function normalizeExcludedModelsText(value: string | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of (value ?? '').split(/[\n,]/)) {
    const model = part.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

function excludedModelsText(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

function formValues(
  file: ManagementAuthFile,
  safeFields?: ManagementAuthFileSafeFields,
): FormValues {
  return {
    priority: safeFields && Number.isSafeInteger(safeFields.priority) ? safeFields.priority : file.priority ?? 0,
    weight: safeFields && Number.isSafeInteger(safeFields.weight) ? safeFields.weight : file.weight ?? 1,
    note: safeFields?.note ?? file.note ?? '',
    prefix: safeFields?.prefix ?? '',
    proxy_url: safeFields?.proxy_url ?? '',
    expired: safeFields?.expired ?? '',
    disable_cooling: safeFields?.disable_cooling ?? false,
    websockets: safeFields?.websockets ?? false,
    using_api: safeFields?.using_api ?? false,
    excluded_models: excludedModelsText(safeFields?.excluded_models),
  };
}

function sameFormValues(left: FormValues, right: FormValues): boolean {
  return left.priority === right.priority
    && left.weight === right.weight
    && (left.note ?? '') === (right.note ?? '')
    && (left.prefix ?? '') === (right.prefix ?? '')
    && (left.proxy_url ?? '') === (right.proxy_url ?? '')
    && (left.expired ?? '') === (right.expired ?? '')
    && Boolean(left.disable_cooling) === Boolean(right.disable_cooling)
    && Boolean(left.websockets) === Boolean(right.websockets)
    && Boolean(left.using_api) === Boolean(right.using_api)
    && (left.excluded_models ?? '') === (right.excluded_models ?? '');
}

export const AuthFileDetailDrawer: React.FC<AuthFileDetailDrawerProps> = ({
  file,
  open,
  onClose,
  onSaved,
  onDownload,
  quotaContent,
  initialSection = 'overview',
  canEdit = false,
}) => {
  const t = useT();
  const isDemo = isDemoMode();
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [baseline, setBaseline] = useState<FormValues>({});
  const [isDirty, setIsDirty] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [activeSection, setActiveSection] = useState<'overview' | 'configuration' | 'models'>(initialSection);

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
    if (!open) {
      setModelFilter('');
      return;
    }
    setActiveSection(initialSection);
  }, [file?.name, file?.auth_index, initialSection, open]);

  useEffect(() => {
    if (file && open) {
      sessionCounterRef.current += 1;
      const sid = sessionCounterRef.current;
      currentSessionRef.current = sid;

      const initial = formValues(file);
      setBaseline(initial);
      form.setFieldsValue(initial);
      setIsDirty(false);
    } else {
      currentSessionRef.current = 0;
      form.resetFields();
      setBaseline({});
      setIsDirty(false);
    }
  }, [file?.name, file?.auth_index, open, form]);

  const handleValuesChange = () => {
    setIsDirty(!sameFormValues(form.getFieldsValue(), baseline));
  };

  const saveMutation = useMutation({
    mutationFn: async ({
      fileName,
      authIndex,
      patch,
    }: {
      fileName: string;
      authIndex?: string;
      patch: Record<string, unknown>;
      sessionId: number;
    }) => {
      return api.patchManagementAuthFileFields(fileName, patch, authIndex);
    },
    onSuccess: (response, variables) => {
      isPendingRef.current = false;
      onSaved(response.file);
      if (variables.sessionId === currentSessionRef.current) {
        if (response.file) {
          const next = formValues(response.file, response.fields);
          setBaseline(next);
          form.setFieldsValue(next);
        }
        if (response.fields) {
          queryClient.setQueryData(
            ['auth-file-safe-fields', variables.fileName, variables.authIndex],
            response.fields,
          );
        }
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

  // Back goes through the same guard the drawer's own X does, so an edit in progress is never
  // discarded by a physical key that the reader may have pressed by accident.
  useOverlayHistory({ isOpen: open, onClose: handleAttemptClose });

  const safeFieldsQuery = useQuery({
    queryKey: ['auth-file-safe-fields', file?.name, file?.auth_index],
    queryFn: () => api.getManagementAuthFileSafeFields(file!.name, file!.auth_index),
    enabled: Boolean(file?.name && open && activeSection === 'configuration' && !file?.runtime_only),
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!file || !open || !safeFieldsQuery.data || isDirty) return;
    const next = formValues(file, safeFieldsQuery.data);
    setBaseline(next);
    form.setFieldsValue(next);
  }, [file, form, isDirty, open, safeFieldsQuery.data]);

  const {
    data: modelsData,
    isLoading: modelsLoading,
    isError: modelsIsError,
    error: modelsError,
  } = useQuery({
    queryKey: ['auth-file-models', file?.name, file?.auth_index],
    queryFn: () => api.getManagementAuthFileModels(file!.name),
    enabled: Boolean(file?.name && open && activeSection === 'models' && !file?.runtime_only),
    staleTime: 60000,
  });

  const handleFinish = (values: FormValues) => {
    if (!file || file.runtime_only || !canEdit || isPendingRef.current || saveMutation.isPending) return;
    isPendingRef.current = true;

    const patch: Record<string, unknown> = {};
    const nextPriority = values.priority ?? 0;
    const nextWeight = values.weight ?? 1;
    if (nextPriority !== (baseline.priority ?? 0)) {
      patch.priority = nextPriority;
    }
    if (nextWeight !== (baseline.weight ?? 1)) {
      patch.weight = nextWeight;
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
    if ((values.expired || '') !== (baseline.expired || '')) {
      patch.expired = values.expired || '';
    }
    if (Boolean(values.disable_cooling) !== Boolean(baseline.disable_cooling)) {
      patch.disable_cooling = Boolean(values.disable_cooling);
    }
    if (Boolean(values.websockets) !== Boolean(baseline.websockets)) {
      patch.websockets = Boolean(values.websockets);
    }
    if (Boolean(values.using_api) !== Boolean(baseline.using_api)) {
      patch.using_api = Boolean(values.using_api);
    }
    const excludedModels = normalizeExcludedModelsText(values.excluded_models);
    if (excludedModels.join('\n') !== normalizeExcludedModelsText(baseline.excluded_models).join('\n')) {
      patch.excluded_models = excludedModels;
    }

    if (Object.keys(patch).length === 0) {
      isPendingRef.current = false;
      onClose();
      return;
    }

    saveMutation.mutate({
      fileName: file.name,
      authIndex: file.auth_index,
      patch,
      sessionId: currentSessionRef.current,
    });
  };

  const models: ManagementAuthFileModel[] = modelsData?.models || file?.models || [];
  const normalizedModelFilter = modelFilter.trim().toLowerCase();
  const filteredModels = normalizedModelFilter
    ? models.filter((model) => model.id.toLowerCase().includes(normalizedModelFilter)
      || (model.display_name ?? '').toLowerCase().includes(normalizedModelFilter))
    : models;
  const safeFieldsReady = safeFieldsQuery.isSuccess;
  const safeFieldsFailed = safeFieldsQuery.isError;
  const quotaSignals = file?.quota?.signals ? Object.entries(file.quota.signals) : [];
  const identity = file ? deriveAuthFileIdentity(file) : null;
  const isProblem = file ? isAuthFileProblem(file) : false;
  const isDisabled = file ? isAuthFileDisabled(file) : false;
  const hasWarning = file ? hasAuthFileStatusWarning(file) : false;
  const statusBadge = file?.runtime_only ? (
    <Tag>{t('af.runtime_only_badge')}</Tag>
  ) : isDisabled ? (
    <Tag color="error">{t('af.disabled')}</Tag>
  ) : isProblem ? (
    <Tag color="warning">{t('af.status_problem')}</Tag>
  ) : (
    <Tag color="success">{t('af.enabled')}</Tag>
  );

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
      <div className={styles['models-scroll']}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={modelFilter}
          aria-label={t('omc.models_search_placeholder')}
          onChange={(event) => setModelFilter(event.target.value)}
          placeholder={t('omc.models_search_placeholder')}
          style={{ marginBottom: 12 }}
        />
        <Table<ManagementAuthFileModel>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={filteredModels}
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
            {
              title: '',
              key: 'copy',
              width: 52,
              render: (_, model) => (
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  aria-label={`${t('common.copy')}: ${model.id}`}
                  onClick={() => {
                    void copyText(model.id).then((copied) => {
                      if (copied) message.success(t('common.copied'));
                      else message.error(t('common.copy_failed'));
                    });
                  }}
                />
              ),
            },
          ]}
        />
      </div>
    );
  };

  return (
    <Drawer
      title={identity?.primary || t('af.drawer_title')}
      size="large"
      open={open}
      onClose={handleAttemptClose}
    >
      {file ? (
        <div className={styles['drawer-content']}>
          <Tabs
            activeKey={activeSection}
            onChange={(key) => setActiveSection(key as typeof activeSection)}
            items={[
              {
                key: 'overview',
                label: t('omc.tab_quota'),
                disabled: saveMutation.isPending,
                children: (
                  <div>
                    {quotaContent}
                    <details className={styles['credential-metadata']}>
                      <summary>{t('common.details')}</summary>
                      {/* Overview and identity */}
                      <div className={styles['drawer-section']}>
                        <div className={styles['section-header']}>
                          <h3 className={styles['section-title']}>{t('common.details')}</h3>
                          {statusBadge}
                        </div>
                        <div className={styles['section-body']}>
                          <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered className={styles['overview-table']}>
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
                              {statusBadge}
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
                              className={styles['identity-alert']}
                            />
                          )}
                        </div>
                      </div>

                      {/* Quota Observations */}
                      <div className={styles['drawer-section']}>
                        <div className={styles['section-header']}>
                          <h3 className={styles['section-title']}>{t('af.quota_title')}</h3>
                        </div>
                        <div className={styles['section-body']}>
                          {quotaSignals.length > 0 ? (
                            <Descriptions column={1} size="small" bordered className={styles['overview-table']}>
                              {quotaSignals.map(([k, v]) => (
                                <Descriptions.Item key={k} label={k}>
                                  <span className="mono-num">{v}</span>
                                </Descriptions.Item>
                              ))}
                            </Descriptions>
                          ) : (
                            <Text type="secondary">{t('af.quota_empty')}</Text>
                          )}
                        </div>
                      </div>

                    </details>
                  </div>
                ),
              },
              {
                key: 'configuration',
                forceRender: true,
                label: <span>{t('omc.tab_configuration')}{isDirty && <Tag color="warning">{t('cfg.dirty_bar_unsaved')}</Tag>}</span>,
                children: (
                  <div className={styles['drawer-section']}>
                    <div className={styles['section-header']}>
                      <h3 className={styles['section-title']}>{t('af.fields_title')}</h3>
                      {isDirty && <Tag color="warning">{t('cfg.dirty_bar_unsaved')}</Tag>}
                    </div>
                    <div className={styles['section-body']}>
                      {safeFieldsFailed && (
                        <Alert
                          type="warning"
                          showIcon
                          description={t('af.safe_fields_error')}
                          action={<Button size="small" onClick={() => void safeFieldsQuery.refetch()}>{t('common.retry')}</Button>}
                          style={{ marginBottom: 12 }}
                        />
                      )}
                      <Form
                        form={form}
                        layout="vertical"
                        onValuesChange={handleValuesChange}
                        onFinish={handleFinish}
                        disabled={saveMutation.isPending || file.runtime_only || !canEdit}
                      >
                        <div className={styles['field-grid']}>
                          <Form.Item
                            name="priority"
                            label={t('af.field_priority')}
                            extra={t('af.field_priority_hint')}
                            rules={[
                              {
                                type: 'integer',
                                min: -MAX_SAFE_INTEGER,
                                max: MAX_SAFE_INTEGER,
                                message: t('af.val_priority_safe_int'),
                              },
                            ]}
                          >
                            <InputNumber
                              style={{ width: '100%' }}
                              min={-MAX_SAFE_INTEGER}
                              max={MAX_SAFE_INTEGER}
                              precision={0}
                            />
                          </Form.Item>
                          <Form.Item
                            name="weight"
                            label={t('af.field_weight')}
                            extra={t('af.field_weight_hint')}
                            rules={[
                              {
                                type: 'integer',
                                max: MAX_CREDENTIAL_WEIGHT,
                                message: t('af.val_weight_range'),
                              },
                            ]}
                          >
                            <InputNumber style={{ width: '100%' }} max={MAX_CREDENTIAL_WEIGHT} precision={0} />
                          </Form.Item>

                          <Form.Item name="prefix" label={t('af.field_prefix')}>
                            <Input allowClear maxLength={4096} disabled={!safeFieldsReady} />
                          </Form.Item>
                          <Form.Item name="proxy_url" label={t('af.field_proxy_url')}>
                            <Input allowClear maxLength={4096} disabled={!safeFieldsReady} />
                          </Form.Item>

                          <Form.Item
                            name="expired"
                            label={t('af.field_expired')}
                            extra={t('af.field_expired_hint')}
                          >
                            <Input allowClear maxLength={4096} disabled={!safeFieldsReady} placeholder="2027-01-02T03:04:05Z" />
                          </Form.Item>
                        </div>

                        <div className={styles['switch-grid']}>
                          <div className={styles['switch-item']}>
                            <div className={styles['switch-info']}>
                              <span className={styles['switch-title']}>{t('af.field_disable_cooling')}</span>
                            </div>
                            <Form.Item name="disable_cooling" valuePropName="checked" noStyle>
                              <Switch disabled={!safeFieldsReady} />
                            </Form.Item>
                          </div>
                          <div className={styles['switch-item']}>
                            <div className={styles['switch-info']}>
                              <span className={styles['switch-title']}>{t('af.field_websockets')}</span>
                            </div>
                            <Form.Item name="websockets" valuePropName="checked" noStyle>
                              <Switch disabled={!safeFieldsReady} />
                            </Form.Item>
                          </div>
                          <div className={styles['switch-item']}>
                            <div className={styles['switch-info']}>
                              <span className={styles['switch-title']}>{t('af.field_using_api')}</span>
                            </div>
                            <Form.Item name="using_api" valuePropName="checked" noStyle>
                              <Switch disabled={!safeFieldsReady} />
                            </Form.Item>
                          </div>
                        </div>

                        <Form.Item
                          className={styles['field-grid-wide']}
                          name="excluded_models"
                          label={t('af.field_excluded_models')}
                          extra={t('af.field_excluded_models_hint')}
                        >
                          <Input.TextArea
                            rows={4}
                            maxLength={8192}
                            disabled={!safeFieldsReady}
                            placeholder="model-a&#10;model-b"
                          />
                        </Form.Item>

                        <Form.Item name="note" label={t('af.field_note')}>
                          <Input.TextArea rows={3} maxLength={500} showCount />
                        </Form.Item>

                        <div className={styles['form-actions']}>
                          <Button
                            type="primary"
                            htmlType="submit"
                            icon={<SaveOutlined />}
                            loading={saveMutation.isPending}
                            disabled={!isDirty || file.runtime_only || !canEdit}
                          >
                            {t('af.save_fields')}
                          </Button>
                        </div>
                      </Form>
                    </div>
                  </div>


                ),
              },
              {
                key: 'models',
                label: t('af.models_btn'),
                disabled: saveMutation.isPending,
                children: (
                  <div className={styles['drawer-section']}>
                    <div className={styles['section-header']}>
                      <h3 className={styles['section-title']}>{t('af.models_title')}</h3>
                      {models.length > 0 && <Tag>{filteredModels.length}</Tag>}
                    </div>
                    <div className={styles['section-body']}>
                      {renderModelsContent()}
                    </div>
                  </div>


                ),
              },
            ]}
          />
          {/* Footer Actions */}
          <div className={styles['drawer-footer']}>
            <Button
              icon={<DownloadOutlined />}
              // Downloading credential material is refused by the demonstration, here as
              // well as on the card behind this drawer.
              disabled={file.runtime_only || isDemo}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={() => onDownload(file)}
            >
              {t('af.download_credential')}
            </Button>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
};
