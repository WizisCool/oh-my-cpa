import React, { useState } from 'react';
import { Table, Button, Tag, Space, Popconfirm } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  StopOutlined,
  ThunderboltOutlined,
  RightOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { LobeIcon, getProviderDefaultIcon } from '../../components/LobeIcon';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { QuotaProgressBar } from './QuotaProgressBar';
import styles from './QuotaPage.module.css';

interface QuotaTableProps {
  items: QuotaItem[];
  loading: boolean;
  refreshingIndexes: Set<string>;
  onRefresh: (authIndex: string) => void;
  onBatchRefresh: (authIndexes: string[]) => void;
  onClearCooldown: (authIndex: string) => void;
  onRedeemCredit: (authIndex: string) => void;
  onOpenDetail: (item: QuotaItem) => void;
}

export const QuotaTable: React.FC<QuotaTableProps> = ({
  items,
  loading,
  refreshingIndexes,
  onRefresh,
  onBatchRefresh,
  onClearCooldown,
  onRedeemCredit,
  onOpenDetail,
}) => {
  const t = useT();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

  const onSelectChange = (newSelectedRowKeys: React.Key[]) => {
    setSelectedRowKeys(newSelectedRowKeys);
  };

  const rowSelection = {
    selectedRowKeys,
    onChange: onSelectChange,
  };

  const hasSelected = selectedRowKeys.length > 0;

  const columns: ColumnsType<QuotaItem> = [
    {
      title: t('quota.col_credential'),
      key: 'name',
      width: 220,
      render: (_, r) => {
        const iconId = getProviderDefaultIcon(r.provider, r.name);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className={styles.cardIcon} style={{ width: 26, height: 26 }}>
              <LobeIcon iconId={iconId} size={16} />
            </div>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 13 }}>{r.name}</div>
              <div style={{ fontSize: 11, color: 'var(--meta)', fontFamily: 'var(--font-mono)' }}>
                {r.auth_index}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      title: t('quota.col_provider'),
      key: 'provider',
      width: 130,
      render: (_, r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Tag color="blue" style={{ width: 'fit-content' }}>
            {r.provider}
          </Tag>
          {r.type && <span style={{ fontSize: 11, color: 'var(--meta)' }}>{r.type}</span>}
        </div>
      ),
    },
    {
      title: t('quota.col_plan'),
      key: 'plan',
      width: 140,
      render: (_, r) => (
        <div>
          {r.plan ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg)' }}>
                {r.plan.plan_label}
              </span>
              {r.plan.expires_label && (
                <span style={{ fontSize: 11, color: 'var(--meta)' }}>{r.plan.expires_label}</span>
              )}
            </div>
          ) : (
            <span style={{ color: 'var(--meta)' }}>-</span>
          )}
        </div>
      ),
    },
    {
      title: t('quota.col_status'),
      key: 'status',
      width: 180,
      render: (_, r) => (
        <div>
          {r.active_cooldown?.is_active ? (
            <div>
              <Tag color="error" icon={<StopOutlined />}>
                {t('quota.status_cooldown')}
              </Tag>
              {r.active_cooldown.reason && (
                <div style={{ fontSize: 11, color: 'var(--ant-color-error)', marginTop: 4 }}>
                  {r.active_cooldown.reason}
                </div>
              )}
              {r.active_cooldown.recover_at_ms && (
                <div style={{ fontSize: 10, color: 'var(--meta)', marginTop: 2 }}>
                  {t('quota.recover_at', {
                    time: new Date(r.active_cooldown.recover_at_ms).toLocaleTimeString(),
                  })}
                </div>
              )}
            </div>
          ) : r.status === 'healthy' ? (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              {t('quota.status_normal')}
            </Tag>
          ) : r.status === 'warning' ? (
            <Tag color="warning" icon={<WarningOutlined />}>
              {t('quota.status_warning')}
            </Tag>
          ) : r.status === 'exhausted' ? (
            <Tag color="error" icon={<CloseCircleOutlined />}>
              {t('quota.status_exceeded')}
            </Tag>
          ) : (
            <Tag color="default">{t('quota.status_idle')}</Tag>
          )}
        </div>
      ),
    },
    {
      title: t('quota.col_windows'),
      key: 'windows',
      width: 250,
      render: (_, r) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {r.windows.slice(0, 2).map((w) => (
            <QuotaProgressBar
              key={w.id}
              label={w.label}
              remainingPercent={w.remaining_percent}
              resetLabel={w.reset_label}
            />
          ))}
          {r.windows.length === 0 && <span style={{ color: 'var(--meta)', fontSize: 11 }}>-</span>}
        </div>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 180,
      align: 'right',
      render: (_, r) => {
        const isRefreshing = refreshingIndexes.has(r.auth_index);
        return (
          <Space direction="horizontal" size="small">
            {r.active_cooldown?.is_active && (
              <Button
                size="small"
                danger
                onClick={() => onClearCooldown(r.auth_index)}
              >
                {t('quota.clear_cooldown')}
              </Button>
            )}

            {r.reset_credits && r.reset_credits.available_count > 0 && (
              <Popconfirm
                title={t('quota.redeem_credit_confirm_title')}
                description={t('quota.redeem_credit_confirm_desc')}
                onConfirm={() => onRedeemCredit(r.auth_index)}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
              >
                <Button
                  size="small"
                  icon={<ThunderboltOutlined />}
                  style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}
                >
                  {t('quota.redeem_credit')}
                </Button>
              </Popconfirm>
            )}

            <Button
              size="small"
              icon={<SyncOutlined spin={isRefreshing} />}
              disabled={r.disabled || isRefreshing}
              onClick={() => onRefresh(r.auth_index)}
            />

            <Button
              size="small"
              icon={<RightOutlined />}
              onClick={() => onOpenDetail(r)}
            />
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      {/* Batch toolbar */}
      {hasSelected && (
        <div
          style={{
            background: 'var(--hover-inset)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 14px',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
            {t('quota.selected_count', { count: selectedRowKeys.length })}
          </span>
          <Space>
            <Button
              size="small"
              icon={<SyncOutlined />}
              onClick={() => onBatchRefresh(selectedRowKeys as string[])}
            >
              {t('quota.batch_refresh')}
            </Button>
            <Button size="small" onClick={() => setSelectedRowKeys([])}>
              {t('common.cancel')}
            </Button>
          </Space>
        </div>
      )}

      <Table
        rowSelection={rowSelection}
        columns={columns}
        dataSource={items}
        rowKey="auth_index"
        loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{ emptyText: t('quota.empty') }}
      />
    </div>
  );
};
