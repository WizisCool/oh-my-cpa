import React, { useState } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Input,
  Switch,
  Typography,
  Alert,
  Modal,
  Tabs,
  Popconfirm,
  Form,
  Select,
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
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { ClientAPIKeyItem, ProviderItem, SaveProviderPayload } from '../types/providers';

const { Text } = Typography;

export const ProvidersPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<'providers' | 'keys'>('providers');

  // Provider Modal state
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(null);
  const [formFamily, setFormFamily] = useState<string>('openai-compatibility');
  const [formName, setFormName] = useState<string>('');
  const [formBaseURL, setFormBaseURL] = useState<string>('');
  const [formKey, setFormKey] = useState<string>('');
  const [formModels, setFormModels] = useState<string[]>([]);
  const [formDisabled, setFormDisabled] = useState<boolean>(false);

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
      setProviderModalOpen(false);
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
      setProviderModalOpen(false);
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
    setFormKey('');
    setFormModels([]);
    setFormDisabled(false);
    setProviderModalOpen(true);
  };

  const handleOpenEdit = (provider: ProviderItem) => {
    setEditingProvider(provider);
    setFormFamily(provider.family);
    setFormName(provider.name);
    setFormBaseURL(provider.base_url || '');
    setFormKey('');
    setFormModels(provider.models || []);
    setFormDisabled(provider.disabled);
    setProviderModalOpen(true);
  };

  const handleSaveProvider = () => {
    const payload: SaveProviderPayload = {
      family: formFamily,
      name: formName.trim() || 'Custom Provider',
      base_url: formBaseURL.trim(),
      api_key: formKey.trim(),
      models: formModels,
      disabled: formDisabled,
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

  // Columns for Providers
  const providerColumns: ColumnsType<ProviderItem> = [
    {
      title: t('pro.col_provider'),
      key: 'name',
      render: (_, record) => (
        <div>
          <div style={{ fontWeight: 600 }}>{record.name}</div>
          <Tag color="purple" style={{ fontFamily: 'monospace', fontSize: 10, marginTop: 4 }}>
            {record.family}
          </Tag>
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
      width: 120,
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

      {/* Provider Create/Edit Modal */}
      <Modal
        title={editingProvider ? t('pro.edit_provider_title') : t('pro.add_provider_title')}
        open={providerModalOpen}
        onCancel={() => setProviderModalOpen(false)}
        onOk={handleSaveProvider}
        confirmLoading={createProviderMutation.isPending || updateProviderMutation.isPending}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('pro.field_family')} required>
            <Select
              value={formFamily}
              onChange={setFormFamily}
              disabled={!!editingProvider}
              options={[
                { label: 'OpenAI Compatible (openai-compatibility)', value: 'openai-compatibility' },
                { label: 'Codex / Responses (codex)', value: 'codex' },
                { label: 'Anthropic Claude (claude)', value: 'claude' },
                { label: 'Google Gemini (gemini)', value: 'gemini' },
              ]}
            />
          </Form.Item>
          <Form.Item label={t('pro.field_name')} required>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t('pro.field_name_ph')}
            />
          </Form.Item>
          <Form.Item label={t('pro.field_base_url')}>
            <Input
              value={formBaseURL}
              onChange={(e) => setFormBaseURL(e.target.value)}
              placeholder={t('pro.field_base_url_ph')}
            />
          </Form.Item>
          <Form.Item label={t('pro.field_key')}>
            <Input.Password
              value={formKey}
              onChange={(e) => setFormKey(e.target.value)}
              placeholder={editingProvider ? t('pro.field_key_ph_edit') : t('pro.field_key_ph_create')}
            />
          </Form.Item>
          <Form.Item label={t('pro.field_models')}>
            <Select
              mode="tags"
              value={formModels}
              onChange={setFormModels}
              tokenSeparators={[',', ' ']}
              placeholder={t('pro.field_models_ph')}
            />
          </Form.Item>
          <Form.Item label={t('pro.col_status')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Switch checked={!formDisabled} onChange={(checked) => setFormDisabled(!checked)} />
              <Text type="secondary">{formDisabled ? t('af.disabled') : t('af.enabled')}</Text>
            </div>
          </Form.Item>
        </Form>
      </Modal>

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
