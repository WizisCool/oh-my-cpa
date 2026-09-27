import React, { useMemo, useState } from 'react';
import {
  Card,
  Button,
  Switch,
  Alert,
  Modal,
  Popconfirm,
  Tooltip,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SettingOutlined,
  DeleteOutlined,
  ShopOutlined,
} from '../components/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import type { PluginItem } from '../types/plugin';
import { PluginConfigEditor } from '../components/plugins/PluginConfigEditor';
import { parsePluginConfig, pluginConfigsEqual } from '../components/plugins/pluginConfig';
import { PluginIdentity, PluginPermissions, PluginVersion, pluginDisplayName } from '../components/plugins/PluginCells';
import { useOverlayHistory } from '../hooks/useOverlayHistory';
import { PageHeader } from '../components/common/PageHeader';
import { RefreshButton } from '../components/common/RefreshButton';
import { ResponsiveList } from '../components/common/ResponsiveList';
import { StatusLabel } from '../components/common/StatusLabel';

/** One page of the list, shared by both renderings so a page means the same thing at either width. */
const PAGE_SIZE = 20;

export const PluginsPage: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [configModalPlugin, setConfigModalPlugin] = useState<PluginItem | null>(null);
  const [configText, setConfigText] = useState<string>('');
  const parsedConfig = useMemo(() => parsePluginConfig(configText), [configText]);

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

  const statusMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setPluginStatus(id, enabled),
    onSuccess: () => {
      message.success(t('plg.status_updated'));
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    },
    onError: (err: unknown) => {
      message.error(describeError(err));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deletePlugin(id),
    onSuccess: () => {
      message.success(t('plg.deleted'));
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
    },
    onError: (err: unknown) => {
      message.error(describeError(err));
    },
  });

  const configMutation = useMutation({
    mutationFn: ({ id, config }: { id: string; config: Record<string, unknown> }) =>
      api.setPluginConfig(id, config),
    onSuccess: () => {
      message.success(t('plg.config_saved'));
      setConfigModalPlugin(null);
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    },
    onError: (err: unknown) => {
      message.error(describeError(err));
    },
  });

  const handleOpenConfig = (plugin: PluginItem) => {
    const text = JSON.stringify(plugin.config || {}, null, 2);
    setConfigModalPlugin(plugin);
    setConfigText(text);
  };

  const handleSaveConfig = () => {
    if (!configModalPlugin) return;
    if (!parsedConfig.value) {
      message.error(parsedConfig.error === 'duplicate-key'
        ? t('plg.config_duplicate_key_desc')
        : t('plg.config_invalid_json'));
      return;
    }
    configMutation.mutate({ id: configModalPlugin.id, config: parsedConfig.value });
  };

  // The config dialog refuses to close while an edit is in progress, which the hook handles:
  // a refused close re-arms its sentinel rather than letting the next Back leave the page.
  const handleCloseConfig = () => {
    if (!configModalPlugin || pluginConfigsEqual(parsedConfig.value, configModalPlugin.config ?? {})) {
      setConfigModalPlugin(null);
      return;
    }
    modal.confirm({
      title: t('plg.config_unsaved_title'),
      content: t('plg.config_unsaved_desc'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => setConfigModalPlugin(null),
    });
  };

  // The dialog refuses to close while an edit is in progress, which the hook handles: a refused
  // close re-arms its sentinel instead of letting the next Back press leave the page under an
  // open editor.
  useOverlayHistory({ isOpen: configModalPlugin !== null, onClose: handleCloseConfig });

  // Plugins execute inside the gateway, so enabling, configuring or removing one is not something
  // the demonstration can honour: the server refuses it, and the controls say so up front.
  const isDemo = isDemoMode();

  const columns: ColumnsType<PluginItem> = [
    {
      title: t('plg.col_plugin'),
      key: 'name',
      render: (_, r) => <PluginIdentity name={pluginDisplayName(r)} id={r.id} description={r.description} />,
    },
    {
      title: t('plg.col_version'),
      key: 'version',
      width: 160,
      render: (_, r) => <PluginVersion version={r.version || r.metadata?.version} author={r.author || r.metadata?.author} />,
    },
    {
      title: t('plg.col_permissions'),
      key: 'permissions',
      render: (_, r) => <PluginPermissions permissions={r.permissions} />,
    },
    {
      title: t('plg.col_status'),
      key: 'status',
      width: 150,
      render: (_, r) => (
        <div className="switch-status-cell">
          <Switch
            size="small"
            checked={r.enabled}
            loading={statusMutation.isPending && statusMutation.variables?.id === r.id}
            disabled={isDemo}
            onChange={(checked) => statusMutation.mutate({ id: r.id, enabled: checked })}
            aria-label={`${t('plg.col_status')}: ${pluginDisplayName(r)}`}
          />
          <StatusLabel tone={r.enabled ? 'success' : 'neutral'}>
            {r.enabled ? t('plg.status_enabled') : t('plg.status_disabled')}
          </StatusLabel>
        </div>
      ),
    },
    {
      title: t('plg.col_actions'),
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, r) => (
        <div className="row-actions">
          <Tooltip title={isDemo ? t('demo.blocked') : t('plg.config_title', { name: pluginDisplayName(r) })}>
            <Button
              size="small"
              className="row-action-btn"
              icon={<SettingOutlined />}
              disabled={isDemo}
              onClick={() => handleOpenConfig(r)}
              aria-label={t('plg.config_title', { name: pluginDisplayName(r) })}
            />
          </Tooltip>
          <Popconfirm
            title={t('plg.delete_confirm')}
            onConfirm={() => deleteMutation.mutate(r.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            disabled={isDemo}
          >
            <Tooltip title={isDemo ? t('demo.blocked') : t('common.delete')}>
              <Button
                size="small"
                danger
                className="row-action-btn"
                icon={<DeleteOutlined />}
                disabled={isDemo}
                loading={deleteMutation.isPending && deleteMutation.variables === r.id}
                aria-label={`${t('common.delete')}: ${pluginDisplayName(r)}`}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="terminal-page terminal-page-stack plugins-page">
      <PageHeader
        title={t('plg.title')}
        actions={(
          <>
            <RefreshButton onRefresh={() => void refetch()} isRefreshing={isFetching} />
            <Button icon={<ShopOutlined />} onClick={() => navigate('/plugin-store')}>
              {t('plg.go_store')}
            </Button>
          </>
        )}
      />

      {isError && <Alert type="error" showIcon description={describeError(error)} />}

      <Card>
        <ResponsiveList
          columns={columns}
          dataSource={plugins}
          rowKey="id"
          isLoading={isLoading}
          isBlocked={isError && !pluginsData}
          emptyText={t('plg.empty')}
          pageSize={PAGE_SIZE}
          /* The status column draws the switch *and* its label, so the whole cell is the control
             strip: the row cannot show a state the switch disagrees with. */
          phone={{ identity: 'name', actions: ['status', 'actions'] }}
        />
      </Card>

      {/* Config Edit Modal */}
      <Modal
        title={t('plg.config_title', { name: configModalPlugin ? pluginDisplayName(configModalPlugin) : '' })}
        open={!!configModalPlugin}
        onOk={handleSaveConfig}
        onCancel={handleCloseConfig}
        confirmLoading={configMutation.isPending}
        okButtonProps={{ disabled: !parsedConfig.value }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <PluginConfigEditor value={configText} onChange={setConfigText} pluginName={configModalPlugin ? pluginDisplayName(configModalPlugin) : ''} />
      </Modal>
    </div>
  );
};
