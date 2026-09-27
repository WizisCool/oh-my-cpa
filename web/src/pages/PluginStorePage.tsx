import React from 'react';
import { Card, Button, Alert, Popconfirm, App as AntdApp } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DownloadOutlined, ArrowLeftOutlined } from '../components/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, describeError } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import type { StorePluginItem } from '../types/plugin';
import { PluginIdentity, PluginPermissions, PluginVersion, pluginDisplayName } from '../components/plugins/PluginCells';
import { PageHeader } from '../components/common/PageHeader';
import { RefreshButton } from '../components/common/RefreshButton';
import { ResponsiveList } from '../components/common/ResponsiveList';
import { StatusLabel } from '../components/common/StatusLabel';

/** One page of the list, shared by both renderings so a page means the same thing at either width. */
const PAGE_SIZE = 20;

export const PluginStorePage: React.FC = () => {
  const t = useT();
  // Installing a plugin runs third-party code inside the gateway, so the demonstration
  // refuses it; the button says so instead of failing on click.
  const isDemo = isDemoMode();
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const {
    data: storeData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['management-plugin-store'],
    queryFn: api.getPluginStore,
    staleTime: 30000,
  });

  const storePlugins: StorePluginItem[] = storeData?.plugins || [];

  const installMutation = useMutation({
    mutationFn: (id: string) => api.installPlugin(id),
    onSuccess: () => {
      message.success(t('store.install_success'));
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
    },
    onError: (err: unknown) => {
      message.error(t('store.install_failed', { msg: describeError(err) }));
    },
  });

  const columns: ColumnsType<StorePluginItem> = [
    {
      title: t('store.col_plugin'),
      key: 'name',
      render: (_, r) => <PluginIdentity name={pluginDisplayName(r)} id={r.id} description={r.description} />,
    },
    {
      title: t('store.col_version'),
      key: 'version',
      width: 160,
      render: (_, r) => <PluginVersion version={r.version} author={r.author} />,
    },
    {
      title: t('store.col_permissions'),
      key: 'permissions',
      render: (_, r) => <PluginPermissions permissions={r.permissions} isRequest />,
    },
    {
      title: t('store.col_actions'),
      key: 'actions',
      width: 140,
      align: 'right',
      render: (_, r) => {
        if (r.installed) {
          return <StatusLabel tone="success">{t('store.installed')}</StatusLabel>;
        }
        return (
          <Popconfirm
            title={t('store.install_confirm_title', { name: pluginDisplayName(r) })}
            description={t('store.install_confirm_desc', {
              perms: r.permissions && r.permissions.length > 0 ? r.permissions.join(', ') : t('store.no_permissions'),
            })}
            onConfirm={() => installMutation.mutate(r.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            disabled={isDemo}
          >
            <Button
              size="small"
              disabled={isDemo}
              title={isDemo ? t('demo.blocked') : undefined}
              type="primary"
              icon={<DownloadOutlined />}
              loading={installMutation.isPending && installMutation.variables === r.id}
            >
              {t('store.install')}
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <div className="terminal-page terminal-page-stack plugin-store-page">
      <PageHeader
        title={t('store.title')}
        actions={(
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/plugins')}>
              {t('plg.title')}
            </Button>
            <RefreshButton onRefresh={() => void refetch()} isRefreshing={isFetching} />
          </>
        )}
      />

      {isError && <Alert type="error" showIcon description={describeError(error)} />}

      <Card>
        <ResponsiveList
          columns={columns}
          dataSource={storePlugins}
          rowKey="id"
          isLoading={isLoading}
          isBlocked={isError && !storeData}
          emptyText={t('store.empty')}
          pageSize={PAGE_SIZE}
          phone={{ identity: 'name', actions: ['actions'] }}
        />
      </Card>
    </div>
  );
};
