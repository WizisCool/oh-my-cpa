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
    let healthy = 0;
    let warning = 0;
    let exhausted = 0;
    let cooldown = 0;
    let attention = 0;
    let soonest: number | undefined;
    const nowMS = Date.now();

    allQuotas.forEach((q) => {
      if (q.active_cooldown?.is_active) {
        cooldown++;
        attention++;
        if (q.active_cooldown.recover_at_ms && q.active_cooldown.recover_at_ms > nowMS) {
          if (!soonest || q.active_cooldown.recover_at_ms < soonest) {
            soonest = q.active_cooldown.recover_at_ms;
          }
        }
      } else if (q.status === 'healthy') {
        healthy++;
      } else if (q.status === 'warning') {
        warning++;
        attention++;
      } else if (q.status === 'exhausted') {
        exhausted++;
        attention++;
      } else if (q.status === 'error') {
        attention++;
      }

      q.windows?.forEach((w) => {
        if (w.reset_at_ms && w.reset_at_ms > nowMS) {
          if (!soonest || w.reset_at_ms < soonest) {
            soonest = w.reset_at_ms;
          }
        }
      });
    });

    return {
      total_credentials: allQuotas.length,
      healthy_count: healthy,
      warning_count: warning,
      exhausted_count: exhausted,
      cooldown_count: cooldown,
      attention_count: attention,
      soonest_recovery_ms: soonest,
    };
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
    return allQuotas.filter((item) => {
      // Provider filter
      if (activeProvider !== 'all') {
        if (item.provider?.toLowerCase() !== activeProvider.toLowerCase()) {
          return false;
        }
      }

      // Status filter
      if (statusFilter === 'healthy' && item.status !== 'healthy') return false;
      if (statusFilter === 'warning' && item.status !== 'warning') return false;
      if (statusFilter === 'exhausted' && item.status !== 'exhausted') return false;
      if (statusFilter === 'cooldown' && !item.active_cooldown?.is_active) return false;

      // Text search
      if (searchText.trim()) {
        const query = searchText.trim().toLowerCase();
        const matchesName = item.name.toLowerCase().includes(query);
        const matchesAuthIndex = item.auth_index.toLowerCase().includes(query);
        const matchesModel = item.windows?.some((w) => w.model?.toLowerCase().includes(query));
        if (!matchesName && !matchesAuthIndex && !matchesModel) {
          return false;
        }
      }

      return true;
    });
  }, [allQuotas, activeProvider, statusFilter, searchText]);

  // 5. Sorting
  const sortedItems = useMemo(() => {
    const list = [...filteredItems];
    const nowMS = Date.now();

    const getMinRemaining = (q: QuotaItem) => {
      if (!q.windows || q.windows.length === 0) return 100;
      return Math.min(...q.windows.map((w) => w.remaining_percent ?? 100));
    };

    const getSoonestReset = (q: QuotaItem) => {
      if (q.active_cooldown?.is_active && q.active_cooldown.recover_at_ms) {
        return q.active_cooldown.recover_at_ms;
      }
      let minReset = Number.MAX_SAFE_INTEGER;
      q.windows?.forEach((w) => {
        if (w.reset_at_ms && w.reset_at_ms > nowMS && w.reset_at_ms < minReset) {
          minReset = w.reset_at_ms;
        }
      });
      return minReset;
    };

    switch (sortMode) {
      case 'recovery':
        list.sort((a, b) => getSoonestReset(a) - getSoonestReset(b));
        break;
      case 'least_remaining':
        list.sort((a, b) => getMinRemaining(a) - getMinRemaining(b));
        break;
      case 'most_remaining':
        list.sort((a, b) => getMinRemaining(b) - getMinRemaining(a));
        break;
      case 'name':
        list.sort((a, b) => a.name.localeCompare(b.name));
        break;
      default:
        // Default: attention/cooldown/exhausted first, then alphabetical
        list.sort((a, b) => {
          const priorityRank = (q: QuotaItem) => {
            if (q.active_cooldown?.is_active) return 5;
            if (q.status === 'exhausted') return 4;
            if (q.status === 'warning') return 3;
            if (q.status === 'error') return 2;
            if (q.status === 'healthy') return 1;
            return 0;
          };
          const diff = priorityRank(b) - priorityRank(a);
          if (diff !== 0) return diff;
          return a.name.localeCompare(b.name);
        });
    }

    return list;
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
    <div className={`terminal-page ${styles.quotaPage}`}>
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
