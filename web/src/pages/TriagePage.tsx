import React, { useState, useMemo } from 'react';
import {
  App as AntdApp,
  Row,
  Col,
  Spin,
  Alert,
  Empty,
  Button,
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
import { useT } from '../i18n';
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
  const t = useT();
  const { message } = AntdApp.useApp();
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
      message.success(t('tri.saved', { name: variables.payload.display_name || t('common.unnamed') }));
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
    onError: (err: Error) => {
      message.error(t('common.save_failed', { msg: err.message }));
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
        color: resource.color || '#007aff',
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
          type="error"
          showIcon
          description={
            <div>
              <Text strong>{t('tri.error')}</Text>
              <p style={{ margin: '4px 0 8px 0' }}>{error instanceof Error ? error.message : String(error)}</p>
              <Button size="small" type="primary" onClick={handleRefetch}>
                {t('tri.retry_conn')}
              </Button>
            </div>
          }
          style={{ marginBottom: '24px' }}
        />
      )}

      {/* Loading State */}
      {isLoading && (
        <div style={{ textAlign: 'center', padding: '64px 0' }}>
          <Spin size="large" tip={t('tri.loading')}><div style={{ minHeight: 80, minWidth: 220 }} /></Spin>
        </div>
      )}

      {/* Empty State when no resources found */}
      {!isLoading && !isError && totalCount === 0 && (
        <div className="terminal-panel" style={{ padding: '64px 24px', textAlign: 'center' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ maxWidth: '420px', margin: '0 auto' }}>
                <Text strong style={{ fontSize: '16px', display: 'block', marginBottom: '6px' }}>
                  {t('tri.empty_title')}
                </Text>
                <Text type="secondary" style={{ fontSize: '13px' }}>
                  {t('tri.empty_desc')}
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
              style={{ marginTop: '16px' }}
            >
              {t('tri.scan_now')}
            </Button>
          </Empty>
        </div>
      )}

      {/* All Clear / Triage Complete State */}
      {!isLoading && !isError && totalCount > 0 && unclaimedList.length === 0 && (
        <div className="terminal-panel" style={{ padding: '64px 24px', textAlign: 'center' }}>
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              border: '1px solid var(--success)',
              color: 'var(--success)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '32px',
              margin: '0 auto 16px auto',
            }}
          >
            <CheckCircleOutlined />
          </div>

          <Text strong style={{ fontSize: '18px', display: 'block', marginBottom: '8px' }}>
            {t('tri.all_done')}
          </Text>

          <Text type="secondary" style={{ fontSize: '14px', maxWidth: '480px', display: 'block', margin: '0 auto 20px auto' }}>
            {t('tri.all_done_desc', { n: totalCount })}
          </Text>

          <Button
            type="default"
            icon={<SyncOutlined />}
            onClick={triggerDiscovery}
            loading={isDiscovering}
          >
            {t('tri.rescan')}
          </Button>
        </div>
      )}

      {/* Filter result is empty */}
      {!isLoading && !isError && unclaimedList.length > 0 && filteredList.length === 0 && (
        <div className="terminal-panel" style={{ padding: '48px 24px', textAlign: 'center' }}>
          <Empty
            image={<InboxOutlined style={{ fontSize: '48px', color: 'var(--muted)' }} />}
            description={t('tri.no_match', { q: searchQuery || driverFilter })}
          >
            <Button
              onClick={() => {
                setSearchQuery('');
                setDriverFilter('all');
              }}
            >
              {t('tri.clear_filters')}
            </Button>
          </Empty>
        </div>
      )}

      {/* Grid of Unclaimed Resource Cards */}
      {!isLoading && !isError && filteredList.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <Text strong style={{ fontSize: '15px' }}>
              {t('tri.list_title', { n: filteredList.length })}
            </Text>
            <Text type="secondary" style={{ fontSize: '13px' }}>
              {t('tri.list_hint')}
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
