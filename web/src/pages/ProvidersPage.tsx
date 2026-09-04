import React, { useState } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Input,
  InputNumber,
  Checkbox,
  Switch,
  Typography,
  Alert,
  Drawer,
  Modal,
  Tabs,
  Popconfirm,
  Form,
  Select,
  Row,
  Col,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  CopyOutlined,
  KeyOutlined,
  ThunderboltOutlined,
  CloudServerOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type {
  ClientAPIKeyItem,
  ProviderItem,
  SaveProviderPayload,
  SaveProviderKeyItem,
  SaveProviderModelItem,
} from '../types/providers';

const { Text } = Typography;

interface FormKeyItem {
  id: string;
  masked?: string;
  apiKey?: string;
  proxyUrl?: string;
  isChanging?: boolean;
}

interface FormHeaderItem {
  id: string;
  key: string;
  value: string;
}

interface FormModelItem {
  id: string;
  name: string;
  alias: string;
}

export const ProvidersPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<'providers' | 'keys'>('providers');

  // Provider Drawer state
  const [providerDrawerOpen, setProviderDrawerOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(null);
  const [formFamily, setFormFamily] = useState<string>('openai-compatibility');
  const [formName, setFormName] = useState<string>('');
  const [formBaseURL, setFormBaseURL] = useState<string>('');
  const [formPrefix, setFormPrefix] = useState<string>('');
  const [formPriority, setFormPriority] = useState<number | null>(null);
  const [formDisabled, setFormDisabled] = useState<boolean>(false);
  const [formDisableCooling, setFormDisableCooling] = useState<boolean>(false);
  const [formKeys, setFormKeys] = useState<FormKeyItem[]>([]);
  const [formHeaders, setFormHeaders] = useState<FormHeaderItem[]>([]);
  const [formModels, setFormModels] = useState<FormModelItem[]>([]);

  // ── 1. Providers Query & Mutations ────────────────────────────────────────
  const {
    data: providersData,
    isLoading: providersLoading,
    isFetching: providersFetching,
    isError: providersError,
    error: providersErr,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['management-providers'],
    queryFn: api.getManagementProviders,
    staleTime: 30000,
  });

  const providers = providersData?.providers || [];

  const statusMutation = useMutation({
    mutationFn: ({ family, index, disabled }: { family: string; index: number; disabled: boolean }) =>
      api.patchManagementProviderStatus(family, index, disabled),
    onSuccess: () => {
      message.success(t('pro.status_updated'));
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const createProviderMutation = useMutation({
    mutationFn: (payload: SaveProviderPayload) => api.createManagementProvider(payload),
    onSuccess: () => {
      message.success(t('pro.provider_created'));
      setProviderDrawerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const updateProviderMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SaveProviderPayload }) =>
      api.updateManagementProvider(id, payload),
    onSuccess: () => {
      message.success(t('pro.provider_updated'));
      setProviderDrawerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const deleteProviderMutation = useMutation({
    mutationFn: (id: string) => api.deleteManagementProvider(id),
    onSuccess: () => {
      message.success(t('pro.provider_deleted'));
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleOpenCreate = () => {
    setEditingProvider(null);
    setFormFamily('openai-compatibility');
    setFormName('');
    setFormBaseURL('');
    setFormPrefix('');
    setFormPriority(null);
    setFormDisabled(false);
    setFormDisableCooling(false);
    setFormKeys([{ id: 'key-init-1', apiKey: '', proxyUrl: '' }]);
    setFormHeaders([]);
    setFormModels([]);
    setProviderDrawerOpen(true);
  };

  const handleOpenEdit = (provider: ProviderItem) => {
    setEditingProvider(provider);
    setFormFamily(provider.family);
    setFormName(provider.name);
    setFormBaseURL(provider.base_url || '');
    setFormPrefix(provider.prefix || '');
    setFormPriority(provider.priority != null ? provider.priority : null);
    setFormDisabled(provider.disabled);
    setFormDisableCooling(Boolean(provider.disable_cooling));

    // Populate keys
    if (provider.key_entries && provider.key_entries.length > 0) {
      setFormKeys(
        provider.key_entries.map((k, i) => ({
          id: `key-edit-${i}`,
          masked: k.masked,
          proxyUrl: k.proxy_url,
          isChanging: false,
        }))
      );
    } else if (provider.key_masked) {
      setFormKeys([
        {
          id: 'key-edit-0',
          masked: provider.key_masked,
          isChanging: false,
        },
      ]);
    } else {
      setFormKeys([{ id: 'key-new-0', apiKey: '', proxyUrl: '' }]);
    }

    // Populate headers
    if (provider.headers && Object.keys(provider.headers).length > 0) {
      setFormHeaders(
        Object.entries(provider.headers).map(([k, v], i) => ({
          id: `hdr-edit-${i}`,
          key: k,
          value: v,
        }))
      );
    } else {
      setFormHeaders([]);
    }

    // Populate models
    if (provider.model_entries && provider.model_entries.length > 0) {
      setFormModels(
        provider.model_entries.map((m, i) => ({
          id: `model-edit-${i}`,
          name: m.name,
          alias: m.alias || m.name,
        }))
      );
    } else if (provider.models && provider.models.length > 0) {
      setFormModels(
        provider.models.map((m, i) => ({
          id: `model-edit-${i}`,
          name: m,
          alias: m,
        }))
      );
    } else {
      setFormModels([]);
    }

    setProviderDrawerOpen(true);
  };

  const handleSaveProvider = () => {
    const keysPayload: SaveProviderKeyItem[] = formKeys.map((k) => ({
      api_key: k.apiKey || '',
      proxy_url: k.proxyUrl || '',
    }));

    const modelsPayload: SaveProviderModelItem[] = formModels
      .filter((m) => m.name.trim() !== '')
      .map((m) => ({
        name: m.name.trim(),
        alias: m.alias.trim() || m.name.trim(),
      }));

    const headersPayload: Record<string, string> = {};
    for (const h of formHeaders) {
      if (h.key.trim() !== '') {
        headersPayload[h.key.trim()] = h.value.trim();
      }
    }

    const payload: SaveProviderPayload = {
      family: formFamily,
      name: formName.trim() || 'Custom Provider',
      base_url: formBaseURL.trim(),
      prefix: formPrefix.trim(),
      priority: formPriority != null ? formPriority : undefined,
      disable_cooling: formDisableCooling,
      disabled: formDisabled,
      keys: keysPayload,
      model_entries: modelsPayload,
      headers: headersPayload,
    };

    if (editingProvider) {
      updateProviderMutation.mutate({ id: editingProvider.id, payload });
    } else {
      createProviderMutation.mutate(payload);
    }
  };

  // ── 2. Client API Keys ────────────────────────────────────────────────────
  const {
    data: keysData,
    isLoading: keysLoading,
    isFetching: keysFetching,
    isError: keysError,
    error: keysErr,
    refetch: refetchKeys,
  } = useQuery({
    queryKey: ['management-client-api-keys'],
    queryFn: api.getClientAPIKeys,
    staleTime: 30000,
  });

  const keys = keysData?.keys || [];

  const [addKeyModalOpen, setAddKeyModalOpen] = useState(false);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [createdKeyPlaintext, setCreatedKeyPlaintext] = useState<string | null>(null);

  const createKeyMutation = useMutation({
    mutationFn: (key: string) => api.createClientAPIKey(key),
    onSuccess: () => {
      message.success(t('pro.key_created'));
      setCreatedKeyPlaintext(newKeyInput);
      setNewKeyInput('');
      setAddKeyModalOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['management-client-api-keys'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (index: number) => api.deleteClientAPIKey(index),
    onSuccess: () => {
      message.success(t('pro.key_deleted'));
      void queryClient.invalidateQueries({ queryKey: ['management-client-api-keys'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleGenerateRandomKey = () => {
    const array = new Uint8Array(24);
    crypto.getRandomValues(array);
    const randomHex = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
    setNewKeyInput(`omc-sk-${randomHex}`);
  };

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      message.success(t('res.copied'));
    });
  };

  const familyDisplayNames: Record<string, string> = {
    'openai-compatibility': 'OpenAI 兼容',
    'codex': 'Codex / Responses',
    'claude': 'Anthropic Claude',
    'gemini': 'Google Gemini',
  };

  // Columns for Providers
  const providerColumns: ColumnsType<ProviderItem> = [
    {
      title: t('pro.col_provider'),
      key: 'name',
      render: (_, record) => (
        <div>
          <div style={{ fontWeight: 600 }}>{record.name}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <Tag color="purple" style={{ fontFamily: 'monospace', fontSize: 10 }}>
              {record.family}
            </Tag>
            {record.prefix && (
              <Tag color="geekblue" style={{ fontSize: 10 }}>
                prefix: {record.prefix}
              </Tag>
            )}
            {record.priority != null && (
              <Tag style={{ fontSize: 10 }}>
                pri: {record.priority}
              </Tag>
            )}
          </div>
        </div>
      ),
    },
    {
      title: t('pro.col_protocol'),
      key: 'protocol',
      render: (_, record) => <Tag color="blue">{record.protocol}</Tag>,
    },
    {
      title: t('pro.col_endpoint'),
      key: 'base_url',
      render: (_, record) =>
        record.base_url ? (
          <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{record.base_url}</code>
        ) : (
          <span style={{ color: 'var(--meta)' }}>-</span>
        ),
    },
    {
      title: t('pro.col_models'),
      key: 'models',
      render: (_, record) =>
        record.models && record.models.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {record.models.map((m) => (
              <Tag key={m} style={{ fontSize: 11 }}>
                {m}
              </Tag>
            ))}
          </div>
        ) : (
          <span style={{ color: 'var(--meta)' }}>-</span>
        ),
    },
    {
      title: t('pro.col_key'),
      key: 'key',
      render: (_, record) =>
        record.key_configured ? (
          <Tag color="success" style={{ fontFamily: 'monospace' }}>
            {record.key_masked || 'Configured'}
          </Tag>
        ) : (
          <Tag color="default">Unset</Tag>
        ),
    },
    {
      title: t('pro.col_status'),
      key: 'status',
      width: 100,
      render: (_, record) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch
            size="small"
            checked={!record.disabled}
            disabled={record.family !== 'openai-compatibility' || statusMutation.isPending}
            onChange={(checked) => {
              const idx = parseInt(record.id.split('-').pop() || '0', 10);
              statusMutation.mutate({ family: record.family, index: idx, disabled: !checked });
            }}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {record.disabled ? t('af.disabled') : t('af.enabled')}
          </Text>
        </div>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, record) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleOpenEdit(record)}
          />
          <Popconfirm
            title={t('pro.delete_provider_confirm')}
            onConfirm={() => deleteProviderMutation.mutate(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              loading={deleteProviderMutation.isPending && deleteProviderMutation.variables === record.id}
            />
          </Popconfirm>
        </div>
      ),
    },
  ];

  // Client Key Columns
  const keyColumns: ColumnsType<ClientAPIKeyItem> = [
    {
      title: '#',
      key: 'index',
      width: 60,
      render: (_, r) => <span className="mono-num">#{r.index + 1}</span>,
    },
    {
      title: t('pro.col_key'),
      key: 'masked',
      render: (_, r) => <span className="mono-num" style={{ fontWeight: 600 }}>{r.masked}</span>,
    },
    {
      title: 'Fingerprint (HMAC)',
      key: 'fingerprint',
      render: (_, r) => (
        <span className="mono-num" style={{ fontSize: 11, color: 'var(--meta)' }}>
          {r.fingerprint}
        </span>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 120,
      align: 'right',
      render: (_, r) => (
        <Popconfirm
          title={t('pro.delete_key_confirm')}
          onConfirm={() => deleteKeyMutation.mutate(r.index)}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
        >
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            loading={deleteKeyMutation.isPending}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div className="terminal-page providers-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('pro.title')}</h1>
          <p className="terminal-subtitle">{t('pro.subtitle')}</p>
        </div>

        <Button
          size="small"
          icon={<SyncOutlined spin={activeTab === 'providers' ? providersFetching : keysFetching} />}
          onClick={() => {
            if (activeTab === 'providers') void refetchProviders();
            else void refetchKeys();
          }}
        >
          {t('common.refresh')}
        </Button>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'providers' | 'keys')}
        items={[
          {
            key: 'providers',
            label: (
              <span>
                <CloudServerOutlined style={{ marginRight: 6 }} />
                {t('pro.tab_providers')} ({providers.length})
              </span>
            ),
            children: (
              <div>
                <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-start' }}>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={handleOpenCreate}
                  >
                    {t('pro.add_provider')}
                  </Button>
                </div>

                {providersError && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 16 }}
                    description={`${t('common.save_failed', { msg: providersErr instanceof Error ? providersErr.message : String(providersErr) })}`}
                  />
                )}

                <Card>
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <Table
                      columns={providerColumns}
                      dataSource={providers}
                      rowKey="id"
                      loading={providersLoading}
                      pagination={false}
                      locale={{ emptyText: t('pro.providers_empty') }}
                    />
                  </div>
                </Card>
              </div>
            ),
          },
          {
            key: 'keys',
            label: (
              <span>
                <KeyOutlined style={{ marginRight: 6 }} />
                {t('pro.tab_keys')} ({keys.length})
              </span>
            ),
            children: (
              <div>
                {keysError && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 16 }}
                    description={`${t('common.save_failed', { msg: keysErr instanceof Error ? keysErr.message : String(keysErr) })}`}
                  />
                )}

                <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setNewKeyInput('');
                      setAddKeyModalOpen(true);
                    }}
                  >
                    {t('pro.add_key')}
                  </Button>
                </div>

                <Card>
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <Table
                      columns={keyColumns}
                      dataSource={keys}
                      rowKey="index"
                      loading={keysLoading}
                      pagination={false}
                      locale={{ emptyText: t('pro.keys_empty') }}
                    />
                  </div>
                </Card>
              </div>
            ),
          },
        ]}
      />

      {/* Provider Rich Drawer */}
      <Drawer
        title={
          <div>
            <div style={{ fontSize: 12, color: 'var(--meta)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {editingProvider ? t('common.edit') : t('pro.add_provider')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)', marginTop: 2 }}>
              {editingProvider
                ? `${t('common.edit')} · ${familyDisplayNames[formFamily] || formFamily}`
                : `${t('pro.add_provider')} · ${familyDisplayNames[formFamily] || formFamily}`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {t('pro.manage_resource_subtitle', { path: `/ai-providers/${formFamily}` })}
            </div>
          </div>
        }
        open={providerDrawerOpen}
        onClose={() => setProviderDrawerOpen(false)}
        size="large"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, padding: '4px 0' }}>
            <Button onClick={() => setProviderDrawerOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="primary"
              loading={createProviderMutation.isPending || updateProviderMutation.isPending}
              onClick={handleSaveProvider}
            >
              {t('common.save')}
            </Button>
          </div>
        }
      >
        <Form layout="vertical">
          {/* Driver & Name */}
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_family')} required>
                <Select
                  value={formFamily}
                  onChange={setFormFamily}
                  disabled={!!editingProvider}
                  options={[
                    { label: 'OpenAI 兼容 (openai-compatibility)', value: 'openai-compatibility' },
                    { label: 'Codex / Responses (codex)', value: 'codex' },
                    { label: 'Anthropic Claude (claude)', value: 'claude' },
                    { label: 'Google Gemini (gemini)', value: 'gemini' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_name')} required>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('pro.field_name_ph')}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Base URL */}
          <Form.Item
            label={
              <span>
                {t('pro.field_base_url')}{' '}
                <span style={{ fontSize: 12, color: 'var(--meta)', fontWeight: 400 }}>
                  · {t('pro.field_base_url_desc')}
                </span>
              </span>
            }
          >
            <Input
              value={formBaseURL}
              onChange={(e) => setFormBaseURL(e.target.value)}
              placeholder={t('pro.field_base_url_ph')}
            />
          </Form.Item>

          {/* Prefix & Priority */}
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_prefix')}>
                <Input
                  value={formPrefix}
                  onChange={(e) => setFormPrefix(e.target.value)}
                  placeholder="e.g. glm"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_priority')}>
                <InputNumber
                  value={formPriority}
                  onChange={(val) => setFormPriority(val)}
                  placeholder="e.g. 1"
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Flags: Disabled & Disable Cooling */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ marginBottom: 12 }}>
              <Checkbox
                checked={formDisabled}
                onChange={(e) => setFormDisabled(e.target.checked)}
              >
                <span style={{ fontWeight: 500 }}>{t('pro.field_disabled')}</span>
              </Checkbox>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginLeft: 24, marginTop: 2 }}>
                {t('pro.field_disabled_desc')}
              </div>
            </div>

            <div>
              <Checkbox
                checked={formDisableCooling}
                onChange={(e) => setFormDisableCooling(e.target.checked)}
              >
                <span style={{ fontWeight: 500 }}>{t('pro.field_disable_cooling')}</span>
              </Checkbox>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginLeft: 24, marginTop: 2 }}>
                {t('pro.field_disable_cooling_desc')}
              </div>
            </div>
          </div>

          {/* Section: API Keys */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              padding: 16,
              marginBottom: 20,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_keys')}{' '}
                <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 4 }}>{formKeys.length}</span>
              </div>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() =>
                  setFormKeys((prev) => [
                    ...prev,
                    { id: `key-${Date.now()}-${prev.length}`, apiKey: '', proxyUrl: '', isChanging: true },
                  ])
                }
              >
                {t('pro.add_key_entry')}
              </Button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {formKeys.map((k, idx) => (
                <div
                  key={k.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '8px 12px',
                  }}
                >
                  <span style={{ fontWeight: 500, fontSize: 13, minWidth: 60 }}>
                    {t('pro.key_label', { n: idx + 1 })}
                  </span>

                  {k.masked && !k.isChanging ? (
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--fg)', letterSpacing: '1px' }}>
                        {k.masked}
                      </span>
                      <Button
                        size="small"
                        type="link"
                        onClick={() =>
                          setFormKeys((prev) =>
                            prev.map((item) => (item.id === k.id ? { ...item, isChanging: true } : item))
                          )
                        }
                      >
                        {t('pro.change_key')}
                      </Button>
                    </div>
                  ) : (
                    <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                      <Input.Password
                        value={k.apiKey || ''}
                        onChange={(e) =>
                          setFormKeys((prev) =>
                            prev.map((item) => (item.id === k.id ? { ...item, apiKey: e.target.value } : item))
                          )
                        }
                        placeholder={t('pro.field_key_ph_create')}
                        style={{ flex: 1 }}
                      />
                      {k.masked && (
                        <Button
                          size="small"
                          onClick={() =>
                            setFormKeys((prev) =>
                              prev.map((item) =>
                                item.id === k.id ? { ...item, isChanging: false, apiKey: '' } : item
                              )
                            )
                          }
                        >
                          {t('pro.keep_key')}
                        </Button>
                      )}
                    </div>
                  )}

                  <Input
                    value={k.proxyUrl || ''}
                    onChange={(e) =>
                      setFormKeys((prev) =>
                        prev.map((item) => (item.id === k.id ? { ...item, proxyUrl: e.target.value } : item))
                      )
                    }
                    placeholder="proxy-url (可选)"
                    style={{ width: 160 }}
                  />

                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<CloseOutlined />}
                    disabled={formKeys.length <= 1}
                    onClick={() => setFormKeys((prev) => prev.filter((item) => item.id !== k.id))}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Section: Custom Headers */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              padding: 16,
              marginBottom: 20,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_headers')}{' '}
                <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 4 }}>{formHeaders.length}</span>
              </div>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() =>
                  setFormHeaders((prev) => [
                    ...prev,
                    { id: `hdr-${Date.now()}-${prev.length}`, key: '', value: '' },
                  ])
                }
              >
                {t('pro.add_header_entry')}
              </Button>
            </div>

            {formHeaders.length === 0 ? (
              <div style={{ color: 'var(--meta)', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>
                -
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {formHeaders.map((h) => (
                  <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Input
                      value={h.key}
                      onChange={(e) =>
                        setFormHeaders((prev) =>
                          prev.map((item) => (item.id === h.id ? { ...item, key: e.target.value } : item))
                        )
                      }
                      placeholder={t('pro.header_name')}
                      style={{ flex: 1, fontFamily: 'monospace' }}
                    />
                    <Input
                      value={h.value}
                      onChange={(e) =>
                        setFormHeaders((prev) =>
                          prev.map((item) => (item.id === h.id ? { ...item, value: e.target.value } : item))
                        )
                      }
                      placeholder={t('pro.header_value')}
                      style={{ flex: 1 }}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<CloseOutlined />}
                      onClick={() => setFormHeaders((prev) => prev.filter((item) => item.id !== h.id))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section: Custom Models */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              padding: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_models')}{' '}
                <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 4 }}>{formModels.length}</span>
              </div>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() =>
                  setFormModels((prev) => [
                    ...prev,
                    { id: `mdl-${Date.now()}-${prev.length}`, name: '', alias: '' },
                  ])
                }
              >
                {t('pro.add_model_entry')}
              </Button>
            </div>

            {formModels.length === 0 ? (
              <div style={{ color: 'var(--meta)', fontSize: 13, textAlign: 'center', padding: '12px 0' }}>
                -
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {formModels.map((m) => (
                  <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Input
                      value={m.name}
                      onChange={(e) =>
                        setFormModels((prev) =>
                          prev.map((item) => (item.id === m.id ? { ...item, name: e.target.value } : item))
                        )
                      }
                      placeholder={t('pro.model_name')}
                      style={{ flex: 1 }}
                    />
                    <Input
                      value={m.alias}
                      onChange={(e) =>
                        setFormModels((prev) =>
                          prev.map((item) => (item.id === m.id ? { ...item, alias: e.target.value } : item))
                        )
                      }
                      placeholder={t('pro.model_alias')}
                      style={{ flex: 1 }}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<CloseOutlined />}
                      onClick={() => setFormModels((prev) => prev.filter((item) => item.id !== m.id))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Form>
      </Drawer>

      {/* Add Client Key Modal */}
      <Modal
        title={t('pro.add_key_title')}
        open={addKeyModalOpen}
        onCancel={() => setAddKeyModalOpen(false)}
        onOk={() => createKeyMutation.mutate(newKeyInput)}
        confirmLoading={createKeyMutation.isPending}
        okButtonProps={{ disabled: !newKeyInput.trim() }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <Input
            value={newKeyInput}
            onChange={(e) => setNewKeyInput(e.target.value)}
            placeholder={t('pro.key_placeholder')}
          />
          <div>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={handleGenerateRandomKey}
            >
              {t('pro.generate_key')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Single-view Key Display Modal */}
      <Modal
        title={t('pro.key_created_title')}
        open={!!createdKeyPlaintext}
        onOk={() => setCreatedKeyPlaintext(null)}
        onCancel={() => setCreatedKeyPlaintext(null)}
        okText={t('common.confirm')}
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16, marginTop: 12 }}
          description={t('pro.key_created_desc')}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Input
            readOnly
            value={createdKeyPlaintext || ''}
            style={{ fontFamily: 'monospace', fontWeight: 600 }}
          />
          <Button
            icon={<CopyOutlined />}
            onClick={() => handleCopy(createdKeyPlaintext || '')}
          />
        </div>
      </Modal>
    </div>
  );
};
