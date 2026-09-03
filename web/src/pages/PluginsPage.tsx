import React, { useState } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Switch,
  Alert,
  Modal,
  Input,
  Popconfirm,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  SettingOutlined,
  DeleteOutlined,
  ShopOutlined,
  SafetyCertificateOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { PluginItem } from '../types/plugin';

export const PluginsPage: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [configModalPlugin, setConfigModalPlugin] = useState<PluginItem | null>(null);
  const [configText, setConfigText] = useState<string>('');

  const {
    data: pluginsData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 15000,
  });

  const plugins: PluginItem[] = pluginsData?.plugins || [];

  // 1. Status Mutation
  const statusMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setPluginStatus(id, enabled),
    onSuccess: () => {
      message.success(t('plg.status_updated'));
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  // 2. Delete Mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePlugin(id),
    onSuccess: () => {
      message.success(t('plg.deleted'));
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  // 3. Config Mutation
  const configMutation = useMutation({
    mutationFn: ({ id, config }: { id: string; config: Record<string, unknown> }) =>
      api.setPluginConfig(id, config),
    onSuccess: () => {
      message.success(t('plg.config_saved'));
      setConfigModalPlugin(null);
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleOpenConfig = (plugin: PluginItem) => {
    setConfigModalPlugin(plugin);
    setConfigText(JSON.stringify(plugin.config || {}, null, 2));
  };

  const handleSaveConfig = () => {
    if (!configModalPlugin) return;
    try {
      const parsed = JSON.parse(configText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        message.error(t('plg.config_invalid_json'));
        return;
      }
      configMutation.mutate({ id: configModalPlugin.id, config: parsed as Record<string, unknown> });
    } catch {
      message.error(t('plg.config_invalid_json'));
    }
  };

  const columns: ColumnsType<PluginItem> = [
    {
      title: t('plg.col_plugin'),
      key: 'name',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <ApiOutlined />
            <span>{r.name}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--meta)', fontFamily: 'monospace' }}>
            {r.id}
          </div>
          {r.description && (
            <div style={{ fontSize: 12, color: 'var(--meta)', marginTop: 4 }}>
              {r.description}
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('plg.col_version'),
      key: 'version',
      width: 160,
      render: (_, r) => (
        <div>
          <div><Tag color="blue">{r.version || 'v1.0.0'}</Tag></div>
          {r.author && <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 2 }}>{r.author}</div>}
        </div>
      ),
    },
    {
      title: t('plg.col_permissions'),
      key: 'permissions',
      render: (_, r) => {
        if (!r.permissions || r.permissions.length === 0) {
          return <span style={{ color: 'var(--meta)' }}>-</span>;
        }
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {r.permissions.map((p) => (
              <Tag key={p} style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {p}
              </Tag>
            ))}
          </div>
        );
      },
    },
    {
      title: t('plg.col_status'),
      key: 'status',
      width: 140,
      render: (_, r) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch
            size="small"
            checked={r.enabled}
            loading={statusMutation.isPending && statusMutation.variables?.id === r.id}
            onChange={(checked) => statusMutation.mutate({ id: r.id, enabled: checked })}
          />
          <Tag color={r.enabled ? 'success' : 'default'} style={{ margin: 0 }}>
            {r.enabled ? t('plg.status_enabled') : t('plg.status_disabled')}
          </Tag>
        </div>
      ),
    },
    {
      title: t('plg.col_actions'),
      key: 'actions',
      width: 150,
      align: 'right',
      render: (_, r) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            onClick={() => handleOpenConfig(r)}
          />
          <Popconfirm
            title={t('plg.delete_confirm')}
            onConfirm={() => deleteMutation.mutate(r.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              loading={deleteMutation.isPending && deleteMutation.variables === r.id}
            />
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="terminal-page plugins-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('plg.title')}</h1>
          <p className="terminal-subtitle">{t('plg.subtitle')}</p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="small"
            icon={<ShopOutlined />}
            onClick={() => navigate('/plugin-store')}
          >
            {t('plg.go_store')}
          </Button>
          <Button
            size="small"
            icon={<SyncOutlined spin={isFetching} />}
            onClick={() => void refetch()}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        style={{ marginBottom: 16 }}
        description={t('plg.security_notice')}
      />

      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          description={error instanceof ApiError ? error.message : String(error)}
        />
      )}

      <Card>
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <Table
            columns={columns}
            dataSource={plugins}
            rowKey="id"
            loading={isLoading}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            locale={{ emptyText: t('plg.empty') }}
          />
        </div>
      </Card>

      {/* Config Edit Modal */}
      <Modal
        title={t('plg.config_title', { name: configModalPlugin?.name || '' })}
        open={!!configModalPlugin}
        onOk={handleSaveConfig}
        onCancel={() => setConfigModalPlugin(null)}
        confirmLoading={configMutation.isPending}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <p style={{ fontSize: 13, color: 'var(--meta)' }}>
          {t('plg.config_json_desc')}
        </p>
        <Input.TextArea
          rows={10}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Modal>
    </div>
  );
};
