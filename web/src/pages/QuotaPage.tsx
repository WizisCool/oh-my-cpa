import React, { useState } from 'react';
import { Alert, App as AntdApp, Button, Empty, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { QuotaItem } from '../types/quota';
import { QuotaCard } from './quota/QuotaCard';
import styles from './quota/QuotaPage.module.css';

export const QuotaPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  // Tracking refreshing auth indexes
  const [refreshingIndexes, setRefreshingIndexes] = useState<Set<string>>(new Set());

  // Fetch quota overview (snapshots + live windows after refresh)
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

  const quotas: QuotaItem[] = quotaData?.quotas ?? [];

  const invalidateQuota = () => {
    void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
  };

  const markRefreshing = (authIndexes: string[]) => {
    setRefreshingIndexes((prev) => {
      const next = new Set(prev);
      authIndexes.forEach((idx) => next.add(idx));
      return next;
    });
  };

  const unmarkRefreshing = (authIndexes: string[]) => {
    setRefreshingIndexes((prev) => {
      const next = new Set(prev);
      authIndexes.forEach((idx) => next.delete(idx));
      return next;
    });
  };

  // Single credential live refresh
  const refreshMutation = useMutation({
    mutationFn: (authIndex: string) => {
      markRefreshing([authIndex]);
      return api.refreshCredentialQuota(authIndex);
    },
    onSuccess: () => {
      message.success(t('quota.refresh_success'));
      invalidateQuota();
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.refresh_failed', { msg }));
    },
    onSettled: (_, __, authIndex) => {
      unmarkRefreshing([authIndex]);
    },
  });

  // Global refresh: live-refresh every credential in chunks of 10
  // (backend caps one batch call at 10).
  const batchRefreshMutation = useMutation({
    mutationFn: async (authIndexes: string[]) => {
      markRefreshing(authIndexes);
      const all: QuotaItem[] = [];
      for (let i = 0; i < authIndexes.length; i += 10) {
        const chunk = authIndexes.slice(i, i + 10);
        const res = await api.batchRefreshCredentialQuotas(chunk);
        all.push(...res.quotas);
      }
      return { status: 'ok', quotas: all };
    },
    onSuccess: () => {
      message.success(t('quota.batch_refresh_success'));
      invalidateQuota();
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.refresh_failed', { msg }));
    },
    onSettled: (_, __, authIndexes) => {
      unmarkRefreshing(authIndexes);
    },
  });

  const clearCooldownMutation = useMutation({
    mutationFn: (authIndex: string) => api.clearCredentialCooldown(authIndex),
    onSuccess: () => {
      message.success(t('quota.clear_cooldown_success'));
      invalidateQuota();
      void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.clear_cooldown_failed', { msg }));
    },
  });

  const redeemCreditMutation = useMutation({
    mutationFn: (authIndex: string) => api.redeemCodexResetCredit(authIndex),
    onSuccess: () => {
      message.success(t('quota.redeem_credit_success'));
      invalidateQuota();
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.redeem_credit_failed', { msg }));
    },
  });

  const handleRefreshAll = () => {
    if (quotas.length === 0) {
      void refetch();
      return;
    }
    batchRefreshMutation.mutate(quotas.map((item) => item.auth_index));
  };

  if (isLoading) {
    return (
      <div className="terminal-page quota-page">
        <div className="terminal-page-head">
          <div>
            <h1 className="terminal-title">{t('quota.title')}</h1>
            <p className="terminal-subtitle">{t('quota.subtitle')}</p>
          </div>
        </div>
        <div className="dashboard-loading">
          <Spin>
            <div style={{ minHeight: 80, minWidth: 200 }} />
          </Spin>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className={`terminal-page quota-page ${styles.quotaPage}`}>
        <div className="terminal-page-head">
          <div>
            <h1 className="terminal-title">{t('quota.title')}</h1>
            <p className="terminal-subtitle">{t('quota.subtitle')}</p>
          </div>
          <div>
            <Button icon={<ReloadOutlined />} onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        </div>
        <Alert
          type="error"
          showIcon
          description={error instanceof ApiError ? error.message : String(error)}
        />
      </div>
    );
  }

  const isRefreshingAll = isFetching || batchRefreshMutation.isPending;

  return (
    <div className={`terminal-page quota-page ${styles.quotaPage}`}>
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('quota.title')}</h1>
          <p className="terminal-subtitle">{t('quota.subtitle')}</p>
        </div>
        <div>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefreshAll}
            loading={isRefreshingAll}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {quotas.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={t('quota.empty')}
          style={{ padding: '40px 0', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
        />
      ) : (
        <div className={styles.cardsGrid}>
          {quotas.map((item) => (
            <QuotaCard
              key={item.auth_index}
              item={item}
              isRefreshing={refreshingIndexes.has(item.auth_index)}
              onRefresh={(idx) => refreshMutation.mutate(idx)}
              onClearCooldown={(idx) => clearCooldownMutation.mutate(idx)}
              onRedeemCredit={(idx) => redeemCreditMutation.mutate(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
