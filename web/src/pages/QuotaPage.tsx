import React, { useState, useMemo } from 'react';
import {
  Card,
  Table,
  Tag,
  Button,
  Alert,
  Popconfirm,
  Row,
  Col,
  Statistic,
  Segmented,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  ReloadOutlined,
  FieldTimeOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import type { QuotaItem } from '../types/quota';

export const QuotaPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<'all' | 'normal' | 'exceeded'>('all');

  // 1. Quota overview
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

  // 2. Filtered list
  const filteredQuotas = useMemo(() => {
    if (filter === 'normal') return allQuotas.filter((q) => !q.quota_exceeded);
    if (filter === 'exceeded') return allQuotas.filter((q) => q.quota_exceeded);
    return allQuotas;
  }, [allQuotas, filter]);

  // Statistics
  const totalCount = allQuotas.length;
  const exceededCount = allQuotas.filter((q) => q.quota_exceeded).length;
  const healthyCount = totalCount - exceededCount;

  // 3. Reset mutation
  const resetMutation = useMutation({
    mutationFn: (authIndex: string) => api.resetCredentialQuota(authIndex),
    onSuccess: () => {
      message.success(t('quota.reset_success'));
      void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
      void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(t('quota.reset_failed', { msg }));
    },
  });

  const columns: ColumnsType<QuotaItem> = [
    {
      title: t('quota.col_credential'),
      key: 'name',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.name}</div>
          <div style={{ fontSize: 11, color: 'var(--meta)', fontFamily: 'monospace' }}>
            {r.auth_index}
          </div>
        </div>
      ),
    },
    {
      title: t('quota.col_provider'),
      key: 'provider',
      width: 140,
      render: (_, r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Tag color="blue">{r.provider || 'unknown'}</Tag>
          {r.type && <span style={{ fontSize: 11, color: 'var(--meta)' }}>{r.type}</span>}
        </div>
      ),
    },
    {
      title: t('quota.col_status'),
      key: 'status',
      width: 220,
      render: (_, r) => (
        <div>
          {r.quota_exceeded ? (
            <div>
              <Tag color="error" icon={<WarningOutlined />}>
                {t('quota.status_exceeded')}
              </Tag>
              {r.quota_reason && (
                <div style={{ fontSize: 11, color: 'var(--ant-color-error)', marginTop: 4 }}>
                  {r.quota_reason}
                </div>
              )}
              {r.next_recover_at_ms && (
                <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 2 }}>
                  {t('quota.recover_at', { time: new Date(r.next_recover_at_ms).toLocaleTimeString() })}
                </div>
              )}
              {r.next_retry_after_ms && (
                <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 2 }}>
                  {t('quota.retry_after', { seconds: Math.ceil(r.next_retry_after_ms / 1000) })}
                </div>
              )}
            </div>
          ) : (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              {t('quota.status_normal')}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: t('quota.col_signals'),
      key: 'signals',
      render: (_, r) => {
        const signals = r.quota?.signals;
        if (!signals || Object.keys(signals).length === 0) {
          return <span style={{ color: 'var(--meta)' }}>-</span>;
        }
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(signals).map(([k, v]) => (
              <Tag key={k} style={{ fontFamily: 'monospace', fontSize: 11 }}>
                {k}: {v}
              </Tag>
            ))}
          </div>
        );
      },
    },
    {
      title: t('quota.col_model_quotas'),
      key: 'model_quotas',
      render: (_, r) => {
        const modelQuotas = r.model_quotas;
        if (!modelQuotas || Object.keys(modelQuotas).length === 0) {
          return <span style={{ color: 'var(--meta)' }}>-</span>;
        }
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(modelQuotas).map(([model, mq]) => {
              const sigs = mq.signals ? Object.entries(mq.signals).map(([k, v]) => `${k}=${v}`).join(', ') : '';
              return (
                <Tag key={model} color="cyan" style={{ fontSize: 11 }}>
                  {model}{sigs ? ` (${sigs})` : ''}
                </Tag>
              );
            })}
          </div>
        );
      },
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 130,
      align: 'right',
      render: (_, r) => (
        <Popconfirm
          title={t('quota.reset_confirm_title')}
          description={t('quota.reset_confirm_desc')}
          onConfirm={() => resetMutation.mutate(r.auth_index)}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
        >
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={resetMutation.isPending && resetMutation.variables === r.auth_index}
          >
            {t('quota.reset')}
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div className="terminal-page quota-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('quota.title')}</h1>
          <p className="terminal-subtitle">{t('quota.subtitle')}</p>
        </div>

        <Button
          size="small"
          icon={<SyncOutlined spin={isFetching} />}
          onClick={() => void refetch()}
        >
          {t('common.refresh')}
        </Button>
      </div>

      {/* Metrics overview */}
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic
              title={t('quota.metric_total')}
              value={totalCount}
              prefix={<FieldTimeOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic
              title={t('quota.metric_healthy')}
              value={healthyCount}
              
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card size="small">
            <Statistic
              title={t('quota.metric_exceeded')}
              value={exceededCount}
              
              prefix={<ExclamationCircleOutlined />}
            />
          </Card>
        </Col>
      </Row>

      {/* Filter toolbar */}
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Segmented
          value={filter}
          onChange={(val) => setFilter(val as 'all' | 'normal' | 'exceeded')}
          options={[
            { label: `${t('quota.filter_all')} (${totalCount})`, value: 'all' },
            { label: `${t('quota.filter_normal')} (${healthyCount})`, value: 'normal' },
            { label: `${t('quota.filter_exceeded')} (${exceededCount})`, value: 'exceeded' },
          ]}
        />
      </div>

      {isError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          description={error instanceof ApiError ? error.message : String(error)}
        />
      )}

      <Card >
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <Table
            columns={columns}
            dataSource={filteredQuotas}
            rowKey="auth_index"
            loading={isLoading}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            locale={{ emptyText: t('quota.empty') }}
          />
        </div>
      </Card>
    </div>
  );
};
