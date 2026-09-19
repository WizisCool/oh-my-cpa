import React from 'react';
import {
  Card,
  Pagination,
  Spin,
  Table,
  Tag,
  Button,
  Alert,
  Popconfirm,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  DownloadOutlined,
  CheckOutlined,
  WarningOutlined,
  ApiOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { StorePluginItem } from '../types/plugin';
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport';
import { PhoneRow } from '../components/common/PhoneRow';
import { phoneRowFields, renderedCell } from '../components/common/phoneRowFields';

/** One page of the list, shared by both renderings so a page means the same thing at either width. */
const PAGE_SIZE = 20;

export const PluginStorePage: React.FC = () => {
  const t = useT();
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
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('store.install_failed', { msg }));
    },
  });

  const isPhone = useIsPhoneViewport();
  const [phonePage, setPhonePage] = React.useState(1);
  // Clamped rather than trusted: the store list is fetched, and a page past the end would render
  // an empty list with no way back.
  const lastPhonePage = Math.max(1, Math.ceil(storePlugins.length / PAGE_SIZE));
  const safePhonePage = Math.min(phonePage, lastPhonePage);
  const pagedPlugins = storePlugins.slice((safePhonePage - 1) * PAGE_SIZE, safePhonePage * PAGE_SIZE);

  const columns: ColumnsType<StorePluginItem> = [
    {
      title: t('store.col_plugin'),
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
      title: t('store.col_version'),
      key: 'version',
      width: 160,
      render: (_, r) => (
        <div>
          <div><Tag color="cyan">{r.version || 'v1.0.0'}</Tag></div>
          {r.author && <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 2 }}>{r.author}</div>}
        </div>
      ),
    },
    {
      title: t('store.col_permissions'),
      key: 'permissions',
      render: (_, r) => {
        if (!r.permissions || r.permissions.length === 0) {
          return <span style={{ color: 'var(--meta)' }}>-</span>;
        }
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {r.permissions.map((p) => (
              <Tag key={p} color="warning" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                {p}
              </Tag>
            ))}
          </div>
        );
      },
    },
    {
      title: t('store.col_actions'),
      key: 'actions',
      width: 140,
      align: 'right',
      render: (_, r) => {
        if (r.installed) {
          return (
            <Tag color="success" icon={<CheckOutlined />}>
              {t('store.installed')}
            </Tag>
          );
        }
        return (
          <Popconfirm
            title={t('store.install_confirm_title', { name: r.name })}
            description={t('store.install_confirm_desc', {
              perms: r.permissions && r.permissions.length > 0 ? r.permissions.join(', ') : 'none',
            })}
            onConfirm={() => installMutation.mutate(r.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button
              size="small"
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
    <div className="terminal-page plugin-store-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('store.title')}</h1>
          <p className="terminal-subtitle">{t('store.subtitle')}</p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/plugins')}
          >
            {t('plg.title')}
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
        type="warning"
        showIcon
        icon={<WarningOutlined />}
        style={{ marginBottom: 16 }}
        description={t('store.security_alert')}
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
        {isPhone ? (
          /* Loading before emptiness: the empty copy is a claim about the store, and it is not true
             while the first read is still in flight. */
          isLoading && storePlugins.length === 0 ? (
            <div className="phone-list-loading">
              <Spin />
            </div>
          ) : storePlugins.length === 0 ? (
            /* A blocked read is not an empty store. With no cached rows the error alert above is the
               only true thing on the page, and claiming "no plugins" beside it asserts something the
               console does not know - the distinction docs/design.md's checklist requires. */
            isError && !storeData ? null : <p className="empty-copy">{t('store.empty')}</p>
          ) : (
            <>
              {pagedPlugins.map((plugin, index) => (
                <PhoneRow
                  key={plugin.id}
                  identity={renderedCell(columns, 'name', plugin, index)}
                  fields={phoneRowFields(columns, plugin, { skip: ['name', 'actions'], index })}
                  actions={renderedCell(columns, 'actions', plugin, index)}
                />
              ))}
              <Pagination
                size="small"
                simple
                current={safePhonePage}
                pageSize={PAGE_SIZE}
                total={storePlugins.length}
                onChange={setPhonePage}
              />
            </>
          )
        ) : (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <Table
              columns={columns}
              dataSource={storePlugins}
              rowKey="id"
              loading={isLoading}
              pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false }}
              locale={{ emptyText: t('store.empty') }}
            />
          </div>
        )}
      </Card>
    </div>
  );
};
