import React, { useState, useMemo } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Space,
  Input,
  Radio,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SearchOutlined,
  EditOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { DiscoveredResource, ResourceOverridePayload } from '../types/resource';
import { PresetIcon } from '../components/icons/PresetIcon';
import { ResourceEditDrawer } from '../components/resources/ResourceEditDrawer';

const { Title, Text } = Typography;

export const AllResourcesPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'claimed' | 'unclaimed'>('all');
  const [editingResource, setEditingResource] = useState<DiscoveredResource | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['resources'],
    queryFn: () => api.getResources(),
  });

  const resources = data?.resources || [];

  const filteredResources = useMemo(() => {
    return resources.filter((item) => {
      if (statusFilter === 'claimed' && item.status !== 'claimed' && !item.custom_display_name) {
        return false;
      }
      if (statusFilter === 'unclaimed' && (item.status === 'claimed' && item.custom_display_name)) {
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
      message.success('已成功更新配置！');
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
    onError: (err: Error) => {
      message.error(`保存失败: ${err.message}`);
    },
  });

  const columns: ColumnsType<DiscoveredResource> = [
    {
      title: '资源标识与名称',
      key: 'name',
      render: (_, record) => {
        const color = record.color || '#1677FF';
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                backgroundColor: `${color}15`,
                color: color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <PresetIcon name={record.icon} size={20} />
            </div>
            <div>
              <div style={{ fontWeight: 600, color: '#0f172a' }}>{record.display_name}</div>
              {record.suggested_source && (
                <Text type="secondary" style={{ fontSize: '11px' }}>
                  来源: {record.suggested_source}
                </Text>
              )}
            </div>
          </div>
        );
      },
    },
    {
      title: '协议规范 · CPA 驱动',
      key: 'driver',
      render: (_, record) => (
        <Space direction="vertical" size={2}>
          <Tag color="purple" style={{ margin: 0, borderRadius: '4px' }}>
            {record.protocol_display || record.protocol_driver}
          </Tag>
          <Text type="secondary" style={{ fontSize: '11px', fontFamily: 'monospace' }}>
            CPA: {record.cpa_driver}
          </Text>
        </Space>
      ),
    },
    {
      title: '接入端点 (Base URL) / 凭据',
      key: 'endpoint',
      render: (_, record) => (
        <div>
          {record.base_url ? (
            <Text style={{ fontSize: '12px', fontFamily: 'monospace', color: '#334155' }}>
              {record.base_url}
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: '12px', fontFamily: 'monospace' }}>
              {record.cpa_resource_name || '-'}
            </Text>
          )}
          {record.cpa_auth_index && (
            <div style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>
              auth_index: {record.cpa_auth_index}
            </div>
          )}
        </div>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_, record) => {
        const isCustom = Boolean(record.custom_display_name);
        return isCustom ? (
          <Tag color="success">已自定义</Tag>
        ) : (
          <Tag color="warning">待整理</Tag>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_, record) => (
        <Button
          type="link"
          icon={<EditOutlined />}
          onClick={() => setEditingResource(record)}
        >
          编辑
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <Title level={3} style={{ margin: 0, color: '#0f172a' }}>所有 AI 接入资源</Title>
          <Text type="secondary">查看、管理与修改全部已发现的 CPA 接入端点及自定义元数据</Text>
        </div>
        <Button
          icon={<SyncOutlined spin={isFetching} />}
          onClick={() => refetch()}
          loading={isFetching}
        >
          刷新
        </Button>
      </div>

      <Card
        style={{ borderRadius: '12px', border: '1px solid #e2e8f0' }}
        bodyStyle={{ padding: '16px 20px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
          <Input
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            placeholder="按名称、Base URL 或 Auth Index 过滤..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 280, borderRadius: '8px' }}
            allowClear
          />

          <Radio.Group
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            buttonStyle="solid"
          >
            <Radio.Button value="all">全部 ({resources.length})</Radio.Button>
            <Radio.Button value="unclaimed">待整理</Radio.Button>
            <Radio.Button value="claimed">已认领</Radio.Button>
          </Radio.Group>
        </div>

        <Table
          columns={columns}
          dataSource={filteredResources}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 10, showSizeChanger: true }}
        />
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
