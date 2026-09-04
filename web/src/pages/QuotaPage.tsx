import React, { useState, useMemo, useCallback } from 'react';
import { Alert, App as AntdApp, Empty } from 'antd';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { QuotaItem, QuotaOverviewSummary } from '../types/quota';
import { QuotaSummaryMetrics } from './quota/QuotaSummaryMetrics';
import { QuotaToolbar, type ViewMode, type SortMode, type StatusFilter } from './quota/QuotaToolbar';
import { QuotaCard } from './quota/QuotaCard';
import { QuotaMatrix } from './quota/QuotaMatrix';
import { QuotaTable } from './quota/QuotaTable';
import { QuotaTimeline } from './quota/QuotaTimeline';
import { QuotaDetailDrawer } from './quota/QuotaDetailDrawer';
import { filterQuotaItems, sortQuotaItems, computeFleetSummary } from './quota/quotaModel';
import styles from './quota/QuotaPage.module.css';

const PROVIDER_KEYS = ['all', 'codex', 'claude', 'antigravity', 'kimi', 'xai'] as const;

export const QuotaPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  // Preferences & Filters
  const [activeProvider, setActiveProvider] = useState('all');
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('default');
  const [viewMode, setViewMode] = useState<ViewMode>('cards');

  // Detail Drawer state
  const [selectedItem, setSelectedItem] = useState<QuotaItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Tracking refreshing auth indexes
  const [refreshingIndexes, setRefreshingIndexes] = useState<Set<string>>(new Set());

  // 1. Fetch quota overview
  const {
    data: quotaData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['management-quota'],
    queryFn: api.getQuotaOverview,
    staleTime: 15000,
  });

  const allQuotas: QuotaItem[] = quotaData?.quotas || [];

  // 2. Compute fleet summary
  const summary: QuotaOverviewSummary = useMemo(() => {
    if (quotaData?.summary) {
      return quotaData.summary;
    }
    return computeFleetSummary(allQuotas);
  }, [quotaData, allQuotas]);

  // 3. Provider counts for tabs
  const providerTabs = useMemo(() => {
    const counts: Record<string, number> = { all: allQuotas.length };
    PROVIDER_KEYS.forEach((k) => {
      if (k !== 'all') counts[k] = 0;
    });

    allQuotas.forEach((q) => {
      const p = q.provider?.toLowerCase() || 'other';
      if (counts[p] !== undefined) {
        counts[p]++;
      }
    });

    return PROVIDER_KEYS.map((key) => {
      const label = key === 'all' ? t('quota.filter_all') : key.toUpperCase();
      return {
        key,
        label,
        count: counts[key] ?? 0,
      };
    });
  }, [allQuotas, t]);

  // 4. Filtering and searching
  const filteredItems = useMemo(() => {
    return filterQuotaItems(allQuotas, activeProvider, statusFilter, searchText);
  }, [allQuotas, activeProvider, statusFilter, searchText]);

  // 5. Sorting
  const sortedItems = useMemo(() => {
    return sortQuotaItems(filteredItems, sortMode);
  }, [filteredItems, sortMode]);

  // 6. Action Mutations
  const refreshMutation = useMutation({
    mutationFn: (authIndex: string) => {
      setRefreshingIndexes((prev) => new Set(prev).add(authIndex));
      return api.refreshCredentialQuota(authIndex);
    },
    onSuccess: (res) => {
      message.success(t('quota.refresh_success'));
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['quota-detail'] });
      if (selectedItem?.auth_index === res.quota.auth_index) {
        setSelectedItem(res.quota);
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.refresh_failed', { msg }));
    },
    onSettled: (_, __, authIndex) => {
      setRefreshingIndexes((prev) => {
        const next = new Set(prev);
        next.delete(authIndex);
        return next;
      });
    },
  });

  const batchRefreshMutation = useMutation({
    mutationFn: (authIndexes: string[]) => {
      setRefreshingIndexes((prev) => {
        const next = new Set(prev);
        authIndexes.forEach((idx) => next.add(idx));
        return next;
      });
      return api.batchRefreshCredentialQuotas(authIndexes);
    },
    onSuccess: () => {
      message.success(t('quota.batch_refresh_success'));
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['quota-detail'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.refresh_failed', { msg }));
    },
    onSettled: (_, __, authIndexes) => {
      setRefreshingIndexes((prev) => {
        const next = new Set(prev);
        authIndexes.forEach((idx) => next.delete(idx));
        return next;
      });
    },
  });

  const clearCooldownMutation = useMutation({
    mutationFn: (authIndex: string) => api.clearCredentialCooldown(authIndex),
    onSuccess: () => {
      message.success(t('quota.clear_cooldown_success'));
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
      void queryClient.invalidateQueries({ queryKey: ['quota-detail'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.clear_cooldown_failed', { msg }));
    },
  });

  const redeemCreditMutation = useMutation({
    mutationFn: (authIndex: string) => api.redeemCodexResetCredit(authIndex),
    onSuccess: (res) => {
      message.success(t('quota.redeem_credit_success'));
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['quota-detail'] });
      if (selectedItem?.auth_index === res.quota.auth_index) {
        setSelectedItem(res.quota);
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.redeem_credit_failed', { msg }));
    },
  });

  // Handlers
  const handleOpenDetail = useCallback((item: QuotaItem) => {
    setSelectedItem(item);
    setDrawerOpen(true);
  }, []);

  const handleRefreshAllVisible = useCallback(() => {
    const visibleIndexes = sortedItems.slice(0, 10).map((item) => item.auth_index);
    if (visibleIndexes.length > 0) {
      batchRefreshMutation.mutate(visibleIndexes);
    } else {
      void refetch();
    }
  }, [sortedItems, batchRefreshMutation, refetch]);

  const handleClearAllCooldowns = useCallback(() => {
    const cooldownItems = allQuotas.filter((q) => q.active_cooldown?.is_active);
    cooldownItems.forEach((q) => clearCooldownMutation.mutate(q.auth_index));
  }, [allQuotas, clearCooldownMutation]);

  return (
    <div className={`terminal-page quota-page ${styles.quotaPage}`}>
      {/* Header */}
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('quota.title')}</h1>
          <p className="terminal-subtitle">{t('quota.subtitle')}</p>
        </div>
      </div>

      {/* KPI Overview */}
      <QuotaSummaryMetrics
        summary={summary}
        isRefreshing={isFetching || batchRefreshMutation.isPending}
        onRefreshAll={handleRefreshAllVisible}
        onClearAllCooldowns={summary.cooldown_count > 0 ? handleClearAllCooldowns : undefined}
      />

      {/* Toolbar */}
      <QuotaToolbar
        providers={providerTabs}
        activeProvider={activeProvider}
        onProviderChange={setActiveProvider}
        searchText={searchText}
        onSearchChange={setSearchText}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        sortMode={sortMode}
        onSortModeChange={setSortMode}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          description={error instanceof ApiError ? error.message : String(error)}
        />
      )}

      {/* Main View Area */}
      {sortedItems.length === 0 && !isLoading ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('quota.empty')}
          style={{ padding: '40px 0', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
        />
      ) : viewMode === 'cards' ? (
        <div className={styles.cardsGrid}>
          {sortedItems.map((item) => (
            <QuotaCard
              key={item.auth_index}
              item={item}
              isRefreshing={refreshingIndexes.has(item.auth_index)}
              onRefresh={(idx) => refreshMutation.mutate(idx)}
              onClearCooldown={(idx) => clearCooldownMutation.mutate(idx)}
              onRedeemCredit={(idx) => redeemCreditMutation.mutate(idx)}
              onOpenDetail={handleOpenDetail}
            />
          ))}
        </div>
      ) : viewMode === 'matrix' ? (
        <QuotaMatrix
          items={sortedItems}
          refreshingIndexes={refreshingIndexes}
          onRefresh={(idx) => refreshMutation.mutate(idx)}
          onClearCooldown={(idx) => clearCooldownMutation.mutate(idx)}
          onOpenDetail={handleOpenDetail}
        />
      ) : (
        <QuotaTable
          items={sortedItems}
          loading={isLoading}
          refreshingIndexes={refreshingIndexes}
          onRefresh={(idx) => refreshMutation.mutate(idx)}
          onBatchRefresh={(idxs) => batchRefreshMutation.mutate(idxs)}
          onClearCooldown={(idx) => clearCooldownMutation.mutate(idx)}
          onRedeemCredit={(idx) => redeemCreditMutation.mutate(idx)}
          onOpenDetail={handleOpenDetail}
        />
      )}

      {/* Quota Timeline Comparison */}
      <QuotaTimeline items={sortedItems} />

      {/* Deep Inspection Drawer */}
      <QuotaDetailDrawer
        item={selectedItem}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onRefresh={(idx) => refreshMutation.mutate(idx)}
        onClearCooldown={(idx) => clearCooldownMutation.mutate(idx)}
        onRedeemCredit={(idx) => redeemCreditMutation.mutate(idx)}
        isRefreshing={selectedItem ? refreshingIndexes.has(selectedItem.auth_index) : false}
      />
    </div>
  );
};
