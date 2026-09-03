import React, { useState, useMemo } from 'react';
import {
  Alert,
  App as AntdApp,
  Card,
  Table,
  Tag,
  Button,
  Input,
  Radio,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SearchOutlined,
  EditOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useT } from '../i18n';
import { DiscoveredResource, ResourceOverridePayload } from '../types/resource';
import { PresetIcon } from '../components/icons/PresetIcon';
import { ResourceEditDrawer } from '../components/resources/ResourceEditDrawer';

const { Text } = Typography;

export const AllResourcesPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'claimed' | 'unclaimed' | 'ignored' | 'missing'>('all');
  const [editingResource, setEditingResource] = useState<DiscoveredResource | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['resources'],
    queryFn: () => api.getResources(),
  });

  const resources = data?.resources || [];

  const filteredResources = useMemo(() => {
    return resources.filter((item) => {
      if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        const nameMatch = (item.display_name || '').toLowerCase().includes(q);
        const urlMatch = (item.base_url || '').toLowerCase().includes(q);
        const authMatch = (item.cpa_auth_index || '').toLowerCase().includes(q);
        const driverMatch = (item.cpa_driver || '').toLowerCase().includes(q);
        return nameMatch || urlMatch || authMatch || driverMatch;
      }
      return true;
    });
  }, [resources, statusFilter, search]);

  const overrideMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ResourceOverridePayload }) =>
      api.updateResourceOverride(id, payload),
    onSuccess: () => {
      message.success(t('allres.updated'));
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
    onError: (err: Error) => {
      message.error(t('common.save_failed', { msg: err.message }));
    },
  });

  const columns: ColumnsType<DiscoveredResource> = [
    {
      title: t('allres.col_name'),
      key: 'name',
      render: (_, record) => {
        const color = record.color || '#007aff';
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '4px',
                backgroundColor: `${color}15`,
                color: color,
                border: `1px solid ${color}30`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <PresetIcon name={record.icon} size={20} />
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{record.display_name}</div>
              {record.suggested_source && (
                <Text type="secondary" style={{ fontSize: '11px' }}>
                  {t('allres.source', { source: record.suggested_source })}
                </Text>
              )}
            </div>
          </div>
        );
      },
    },
    {
      title: t('allres.col_driver'),
      key: 'driver',
      render: (_, record) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Tag color="purple" style={{ margin: 0, borderRadius: '4px' }}>
            {record.protocol_display || record.protocol_driver}
          </Tag>
          <Text type="secondary" style={{ fontSize: '11px', fontFamily: 'monospace' }}>
            CPA: {record.cpa_driver}
          </Text>
        </div>
      ),
    },
    {
      title: t('allres.col_endpoint'),
      key: 'endpoint',
      render: (_, record) => (
        <div>
          {record.base_url ? (
            <Text style={{ fontSize: '12px', fontFamily: 'monospace' }}>
              {record.base_url}
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: '12px', fontFamily: 'monospace' }}>
              {record.cpa_resource_name || '-'}
            </Text>
          )}
          {record.cpa_auth_index && (
            <div style={{ fontSize: '11px', color: 'var(--meta)', fontFamily: 'monospace' }}>
              auth_index: {record.cpa_auth_index}
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('allres.col_status'),
      key: 'status',
      width: 120,
      render: (_, record) => {
        const statusTag = (() => {
          switch (record.status) {
            case 'claimed':
              return <Tag color="success">{t('res.status_claimed')}</Tag>;
            case 'unclaimed':
              return <Tag color="warning">{t('res.status_unclaimed')}</Tag>;
            case 'ignored':
              return <Tag color="default">{t('res.status_ignored')}</Tag>;
            case 'missing':
              return <Tag color="error">{t('res.status_missing')}</Tag>;
            default:
              return <Tag>{record.status}</Tag>;
          }
        })();
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
            {statusTag}
            {record.custom_display_name && (
              <Tag color="cyan" style={{ margin: 0, fontSize: '10px' }}>
                {t('res.customized')}
              </Tag>
            )}
          </div>
        );
      },
    },
    {
      title: t('allres.col_actions'),
      key: 'action',
      width: 100,
      render: (_, record) => (
        <Button
          type="link"
          icon={<EditOutlined />}
          onClick={() => setEditingResource(record)}
        >
          {t('common.edit')}
        </Button>
      ),
    },
  ];

  return (
    <div className="terminal-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('allres.title')}</h1>
        </div>
        <Button
          icon={<SyncOutlined spin={isFetching} />}
          onClick={() => refetch()}
          loading={isFetching}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {isError && (
        <Alert
          type="error"
          showIcon
          description={`${t('allres.load_error')} — ${error instanceof Error ? error.message : String(error)}`}
          action={
            <Button size="small" type="primary" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <Card className="terminal-panel" styles={{ body: { padding: '16px 20px' } }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
          <Input
            prefix={<SearchOutlined style={{ color: 'var(--muted)' }} />}
            placeholder={t('allres.search_ph')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 280 }}
            allowClear
          />

          <Radio.Group
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            buttonStyle="solid"
          >
            <Radio.Button value="all">{t('allres.filter_all', { n: resources.length })}</Radio.Button>
            <Radio.Button value="unclaimed">{t('allres.filter_unclaimed')}</Radio.Button>
            <Radio.Button value="claimed">{t('allres.filter_claimed')}</Radio.Button>
            <Radio.Button value="ignored">{t('allres.filter_ignored')}</Radio.Button>
            <Radio.Button value="missing">{t('allres.filter_missing')}</Radio.Button>
          </Radio.Group>
        </div>

        <div className="table-responsive-wrapper" style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <Table
            columns={columns}
            dataSource={filteredResources}
            rowKey="id"
            loading={isLoading}
            scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 10, showSizeChanger: true }}
          />
        </div>
      </Card>

      <ResourceEditDrawer
        visible={Boolean(editingResource)}
        resource={editingResource}
        onClose={() => setEditingResource(null)}
        onSave={async (id, payload) => {
          await overrideMutation.mutateAsync({ id, payload });
        }}
        loading={overrideMutation.isPending}
      />
    </div>
  );
};
