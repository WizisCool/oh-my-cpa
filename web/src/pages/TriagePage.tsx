import React, { useState, useMemo } from 'react';
import {
  Row,
  Col,
  Spin,
  Alert,
  Empty,
  Button,
  message,
  Typography,
} from 'antd';
import {
  SyncOutlined,
  CheckCircleOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api/client';
import { DiscoveredResource, ResourceOverridePayload } from '../types/resource';
import { ResourceCard } from '../components/resources/ResourceCard';
import { ResourceEditDrawer } from '../components/resources/ResourceEditDrawer';
import { ResourceStatsHero } from '../components/resources/ResourceStatsHero';

const { Text } = Typography;

interface OutletContextType {
  triggerDiscovery: () => void;
  isDiscovering: boolean;
}

export const TriagePage: React.FC = () => {
  const queryClient = useQueryClient();
  const { triggerDiscovery, isDiscovering } = useOutletContext<OutletContextType>();

  const [searchQuery, setSearchQuery] = useState('');
  const [driverFilter, setDriverFilter] = useState('all');
  const [editingResource, setEditingResource] = useState<DiscoveredResource | null>(null);

  // Primary query: Fetch unclaimed resources directly from the dedicated endpoint
  const {
    data: unclaimedData,
    isLoading: isUnclaimedLoading,
    isError: isUnclaimedError,
    error: unclaimedError,
    refetch: refetchUnclaimed,
    isFetching: isUnclaimedFetching,
  } = useQuery({
    queryKey: ['resources', { status: 'unclaimed' }],
    queryFn: () => api.getResources({ status: 'unclaimed' }),
    staleTime: 10000,
  });

  // Secondary query: Fetch all resources to compute total & claimed metrics
  const {
    data: allData,
    refetch: refetchAll,
    isFetching: isAllFetching,
  } = useQuery({
    queryKey: ['resources', 'all'],
    queryFn: () => api.getResources(),
    staleTime: 10000,
  });

  const unclaimedList = unclaimedData?.resources || [];
  const allResources = allData?.resources || [];

  const claimedCount = useMemo(() => {
    return allResources.filter((r) => r.status === 'claimed' && r.custom_display_name).length;
  }, [allResources]);

  const totalCount = allResources.length > 0 ? allResources.length : unclaimedList.length;

  const isLoading = isUnclaimedLoading;
  const isError = isUnclaimedError;
  const error = unclaimedError;
  const isFetching = isUnclaimedFetching || isAllFetching;

  const handleRefetch = () => {
    refetchUnclaimed();
    refetchAll();
  };

  // Filtered triage cards based on user search & driver filter
  const filteredList = useMemo(() => {
    return unclaimedList.filter((item) => {
      // Driver filter
      if (driverFilter !== 'all') {
        const matchesDriver =
          item.cpa_driver === driverFilter ||
          item.cpa_resource_type === driverFilter ||
          item.protocol_driver === driverFilter;
        if (!matchesDriver) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = (item.display_name || '').toLowerCase().includes(q);
        const urlMatch = (item.base_url || '').toLowerCase().includes(q);
        const authMatch = (item.cpa_auth_index || '').toLowerCase().includes(q);
        const sourceMatch = (item.suggested_source || '').toLowerCase().includes(q);
        const driverMatch = (item.cpa_driver || '').toLowerCase().includes(q);
        return nameMatch || urlMatch || authMatch || sourceMatch || driverMatch;
      }

      return true;
    });
  }, [unclaimedList, driverFilter, searchQuery]);

  // Override mutation
  const overrideMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ResourceOverridePayload }) =>
      api.updateResourceOverride(id, payload),
    onSuccess: (_, variables) => {
      message.success(`已成功保存「${variables.payload.display_name || '自定义资源'}」！`);
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
    onError: (err: Error) => {
      message.error(`保存失败: ${err.message}`);
    },
  });

  const handleSaveOverride = async (resourceId: string, payload: ResourceOverridePayload) => {
    await overrideMutation.mutateAsync({ id: resourceId, payload });
  };

  const handleQuickClaim = async (resource: DiscoveredResource) => {
    await overrideMutation.mutateAsync({
      id: resource.id,
      payload: {
        display_name: resource.display_name,
        icon: resource.icon || 'custom',
        color: resource.color || '#1677FF',
        status: 'claimed',
      },
    });
  };

  const handleIgnore = async (resource: DiscoveredResource) => {
    await overrideMutation.mutateAsync({
      id: resource.id,
      payload: {
        status: 'ignored',
      },
    });
  };

  return (
    <div>
      {/* Top Hero and Filter Component */}
      <ResourceStatsHero
        unclaimedCount={unclaimedList.length}
        claimedCount={claimedCount}
        totalCount={totalCount}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        driverFilter={driverFilter}
        onDriverFilterChange={setDriverFilter}
        onSync={() => {
          handleRefetch();
          triggerDiscovery();
        }}
        isSyncing={isDiscovering || isFetching}
      />

      {/* Error Alert */}
      {isError && (
        <Alert
          message="无法从 Oh My CPA 服务获取资源列表"
          description={
            <div>
              <p style={{ margin: '4px 0 8px 0' }}>{error instanceof Error ? error.message : String(error)}</p>
              <Button size="small" type="primary" onClick={handleRefetch}>
                重试连接
              </Button>
            </div>
          }
          type="error"
          showIcon
          style={{ marginBottom: '24px', borderRadius: '8px' }}
        />
      )}

      {/* Loading State */}
      {isLoading && (
        <div style={{ textAlign: 'center', padding: '64px 0' }}>
          <Spin size="large" tip="正在扫描并加载 CPA 资源列表..." />
        </div>
      )}

      {/* Empty State when no resources found */}
      {!isLoading && !isError && totalCount === 0 && (
        <div
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '16px',
            padding: '64px 24px',
            textAlign: 'center',
            border: '1px solid #e2e8f0',
          }}
        >
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ maxWidth: '420px', margin: '0 auto' }}>
                <Text strong style={{ fontSize: '16px', color: '#0f172a', display: 'block', marginBottom: '6px' }}>
                  尚未发现任何 CPA 接入点
                </Text>
                <Text type="secondary" style={{ fontSize: '13px' }}>
                  请确保 CPA 实例已正常启动，并配置了正确的 <code>OMCPA_CPA_BASE_URL</code> 与 <code>MANAGEMENT_KEY</code>。
                </Text>
              </div>
            }
          >
            <Button
              type="primary"
              icon={<SyncOutlined />}
              onClick={triggerDiscovery}
              loading={isDiscovering}
              size="large"
              style={{ marginTop: '16px', borderRadius: '8px' }}
            >
              立即扫描 CPA 实例
            </Button>
          </Empty>
        </div>
      )}

      {/* All Clear / Triage Complete State */}
      {!isLoading && !isError && totalCount > 0 && unclaimedList.length === 0 && (
        <div
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '16px',
            padding: '64px 24px',
            textAlign: 'center',
            border: '1px solid #e2e8f0',
          }}
        >
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              backgroundColor: '#f0fdf4',
              color: '#16a34a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '32px',
              margin: '0 auto 16px auto',
            }}
          >
            <CheckCircleOutlined />
          </div>

          <Text strong style={{ fontSize: '18px', color: '#0f172a', display: 'block', marginBottom: '8px' }}>
            太棒了！所有接入点已全部整理完毕
          </Text>

          <Text type="secondary" style={{ fontSize: '14px', maxWidth: '480px', display: 'block', margin: '0 auto 20px auto' }}>
            你已为全部 {totalCount} 个端点配置了专属名称与品牌图标。新增 CPA 凭据后，点击下方按钮即可重新扫描。
          </Text>

          <Button
            type="default"
            icon={<SyncOutlined />}
            onClick={triggerDiscovery}
            loading={isDiscovering}
            style={{ borderRadius: '8px' }}
          >
            重新扫描新端点
          </Button>
        </div>
      )}

      {/* Filter result is empty */}
      {!isLoading && !isError && unclaimedList.length > 0 && filteredList.length === 0 && (
        <div
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '16px',
            padding: '48px 24px',
            textAlign: 'center',
            border: '1px solid #e2e8f0',
          }}
        >
          <Empty
            image={<InboxOutlined style={{ fontSize: '48px', color: '#94a3b8' }} />}
            description={
              <span>
                没有匹配过滤条件 <strong>"{searchQuery || driverFilter}"</strong> 的待整理端点
              </span>
            }
          >
            <Button
              onClick={() => {
                setSearchQuery('');
                setDriverFilter('all');
              }}
            >
              清空搜索与筛选
            </Button>
          </Empty>
        </div>
      )}

      {/* Grid of Unclaimed Resource Cards */}
      {!isLoading && !isError && filteredList.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <Text strong style={{ fontSize: '15px', color: '#1e293b' }}>
              待整理端点列表 ({filteredList.length})
            </Text>
            <Text type="secondary" style={{ fontSize: '13px' }}>
              点击卡片「立即整理」为端点赋予业务名称与品牌标识
            </Text>
          </div>

          <Row gutter={[16, 16]}>
            {filteredList.map((resource) => (
              <Col xs={24} sm={12} lg={8} key={resource.id}>
                <ResourceCard
                  resource={resource}
                  onEdit={setEditingResource}
                  onQuickClaim={handleQuickClaim}
                  onIgnore={handleIgnore}
                />
              </Col>
            ))}
          </Row>
        </div>
      )}

      {/* Edit Override Drawer */}
      <ResourceEditDrawer
        visible={Boolean(editingResource)}
        resource={editingResource}
        onClose={() => setEditingResource(null)}
        onSave={handleSaveOverride}
        loading={overrideMutation.isPending}
      />
    </div>
  );
};
