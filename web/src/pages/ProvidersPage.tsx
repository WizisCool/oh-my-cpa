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
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  PlusOutlined,
  DeleteOutlined,
  CopyOutlined,
  KeyOutlined,
  ThunderboltOutlined,
  CloudServerOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { ClientAPIKeyItem, ProviderItem } from '../types/providers';

const { Text } = Typography;

export const ProvidersPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<'providers' | 'keys'>('providers');

  // ── 1. Providers ──────────────────────────────────────────────────────────
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

  // ── 2. Client API Keys ────────────────────────────────────────────────────
  const {
    data: keysData,
    isLoading: keysLoading,
    isFetching: keysFetching,
    isError: keysError,
    error: keysErr,
    refetch: refetchKeys,
  } = useQuery({
    queryKey: ['client-api-keys'],
    queryFn: api.getClientAPIKeys,
    staleTime: 30000,
  });

  const clientKeys = keysData?.keys || [];

  const [addKeyModalOpen, setAddKeyModalOpen] = useState(false);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [createdKeyToDisplay, setCreatedKeyToDisplay] = useState<string | null>(null);

  const createKeyMutation = useMutation({
    mutationFn: (key: string) => api.createClientAPIKey(key),
    onSuccess: (_, newKey) => {
      message.success(t('pro.key_created'));
      setAddKeyModalOpen(false);
      setNewKeyInput('');
      setCreatedKeyToDisplay(newKey);
      void queryClient.invalidateQueries({ queryKey: ['client-api-keys'] });
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
      void queryClient.invalidateQueries({ queryKey: ['client-api-keys'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleGenerateKey = () => {
    const randomSuffix = Array.from(crypto.getRandomValues(new Uint8Array(18)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    setNewKeyInput(`omc-sk-${randomSuffix}`);
  };

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
    message.success(t('res.copied'));
  };

  // Provider Columns
  const providerColumns: ColumnsType<ProviderItem> = [
    {
      title: t('pro.col_provider'),
      key: 'name',
      render: (_, record) => (
        <div>
          <Text strong>{record.name}</Text>
          <div>
            <Tag color="purple" style={{ fontSize: 10, margin: '2px 0 0 0' }}>
              {record.family}
            </Tag>
          </div>
        </div>
      ),
    },
    {
      title: t('pro.col_protocol'),
      key: 'protocol',
      dataIndex: 'protocol',
      render: (protocol: string) => <Tag color="blue">{protocol}</Tag>,
    },
    {
      title: t('pro.col_endpoint'),
      key: 'endpoint',
      render: (_, record) =>
        record.base_url ? (
          <div>
            <span className="mono-num" style={{ fontSize: 12 }}>{record.base_url}</span>
            {record.auth_index && (
              <div style={{ fontSize: 10, color: 'var(--meta)' }} className="mono-num">
                auth: {record.auth_index}
              </div>
            )}
          </div>
        ) : (
          <span style={{ color: 'var(--meta)' }}>-</span>
        ),
    },
    {
      title: t('pro.col_models'),
      key: 'models',
      render: (_, record) =>
        record.models && record.models.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 300 }}>
            {record.models.slice(0, 4).map((m) => (
              <Tag key={m} style={{ fontSize: 11, margin: 0 }}>
                {m}
              </Tag>
            ))}
            {record.models.length > 4 && (
              <Tag style={{ fontSize: 11, margin: 0 }}>+{record.models.length - 4}</Tag>
            )}
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
                {providersError && (
                  <Alert
                    type="error"
                    showIcon
                    description={`${t('common.save_failed', { msg: providersErr instanceof Error ? providersErr.message : String(providersErr) })}`}
                    action={
                      <Button size="small" type="primary" onClick={() => void refetchProviders()}>
                        {t('common.retry')}
                      </Button>
                    }
                    style={{ marginBottom: 16 }}
                  />
                )}

                <Card size="small" className="terminal-panel" styles={{ body: { padding: 0 } }}>
                  <div className="table-responsive-wrapper" style={{ width: '100%', overflowX: 'auto' }}>
                    <Table<ProviderItem>
                      columns={providerColumns}
                      dataSource={providers}
                      rowKey="id"
                      loading={providersLoading}
                      pagination={false}
                      scroll={{ x: 'max-content' }}
                      size="small"
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
                {t('pro.tab_keys')} ({clientKeys.length})
              </span>
            ),
            children: (
              <div>
                {keysError && (
                  <Alert
                    type="error"
                    showIcon
                    description={`${t('common.save_failed', { msg: keysErr instanceof Error ? keysErr.message : String(keysErr) })}`}
                    action={
                      <Button size="small" type="primary" onClick={() => void refetchKeys()}>
                        {t('common.retry')}
                      </Button>
                    }
                    style={{ marginBottom: 16 }}
                  />
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => setAddKeyModalOpen(true)}
                  >
                    {t('pro.add_key')}
                  </Button>
                </div>

                <Card size="small" className="terminal-panel" styles={{ body: { padding: 0 } }}>
                  <div className="table-responsive-wrapper" style={{ width: '100%', overflowX: 'auto' }}>
                    <Table<ClientAPIKeyItem>
                      columns={keyColumns}
                      dataSource={clientKeys}
                      rowKey="index"
                      loading={keysLoading}
                      pagination={false}
                      scroll={{ x: 'max-content' }}
                      size="small"
                      locale={{ emptyText: t('pro.keys_empty') }}
                    />
                  </div>
                </Card>
              </div>
            ),
          },
        ]}
      />

      {/* Add Client Key Modal */}
      <Modal
        open={addKeyModalOpen}
        title={t('pro.add_key_title')}
        onOk={() => {
          if (!newKeyInput.trim()) {
            message.warning(t('pro.key_placeholder'));
            return;
          }
          createKeyMutation.mutate(newKeyInput.trim());
        }}
        onCancel={() => {
          setAddKeyModalOpen(false);
          setNewKeyInput('');
        }}
        confirmLoading={createKeyMutation.isPending}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <Input
            placeholder={t('pro.key_placeholder')}
            value={newKeyInput}
            onChange={(e) => setNewKeyInput(e.target.value)}
            autoFocus
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={handleGenerateKey}
            >
              {t('pro.generate_key')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* One-time Key Created Display Modal */}
      <Modal
        open={createdKeyToDisplay != null}
        title={t('pro.key_created_title')}
        footer={[
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={() => {
              if (createdKeyToDisplay) {
                handleCopy(createdKeyToDisplay);
                setCreatedKeyToDisplay(null);
              }
            }}
          >
            {t('res.copy_url')}
          </Button>,
          <Button key="close" onClick={() => setCreatedKeyToDisplay(null)}>
            {t('common.confirm')}
          </Button>,
        ]}
        onCancel={() => setCreatedKeyToDisplay(null)}
      >
        <Alert
          type="warning"
          showIcon
          description={t('pro.key_created_desc')}
          style={{ marginBottom: 16 }}
        />
        <Input
          readOnly
          value={createdKeyToDisplay || ''}
          className="mono-num"
          style={{ fontWeight: 600, color: 'var(--accent)' }}
        />
      </Modal>
    </div>
  );
};
