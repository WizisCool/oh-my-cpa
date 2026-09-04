import React from 'react';
import { Drawer, Button, Tag, Space, Popconfirm, Spin, Descriptions } from 'antd';
import {
  SyncOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { LobeIcon, getProviderDefaultIcon } from '../../components/LobeIcon';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { QuotaProgressBar } from './QuotaProgressBar';
import styles from './QuotaPage.module.css';

interface QuotaDetailDrawerProps {
  item: QuotaItem | null;
  open: boolean;
  onClose: () => void;
  onRefresh: (authIndex: string) => void;
  onClearCooldown: (authIndex: string) => void;
  onRedeemCredit: (authIndex: string) => void;
  isRefreshing?: boolean;
}

export const QuotaDetailDrawer: React.FC<QuotaDetailDrawerProps> = ({
  item,
  open,
  onClose,
  onRefresh,
  onClearCooldown,
  onRedeemCredit,
  isRefreshing,
}) => {
  const t = useT();

  const authIndex = item?.auth_index || '';

  // Query detail and history
  const { data: detailData, isLoading } = useQuery({
    queryKey: ['quota-detail', authIndex],
    queryFn: () => api.getCredentialQuotaDetail(authIndex),
    enabled: open && Boolean(authIndex),
    staleTime: 10000,
  });

  if (!item) return null;

  const currentQuota = detailData?.quota || item;
  const history = detailData?.history || [];
  const iconId = getProviderDefaultIcon(currentQuota.provider, currentQuota.name);

  const standardWindows = currentQuota.windows.filter((w) => w.scope === 'standard' || !w.scope);
  const modelWindows = currentQuota.windows.filter((w) => w.scope === 'model' || w.scope === 'group');

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className={styles.cardIcon} style={{ width: 28, height: 28 }}>
            <LobeIcon iconId={iconId} size={18} />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{currentQuota.name}</div>
            <div style={{ fontSize: 11, color: 'var(--meta)', fontFamily: 'var(--font-mono)' }}>
              {currentQuota.auth_index}
            </div>
          </div>
        </div>
      }
      extra={
        <Space>
          {currentQuota.active_cooldown?.is_active && (
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              onClick={() => onClearCooldown(currentQuota.auth_index)}
            >
              {t('quota.clear_cooldown')}
            </Button>
          )}

          {currentQuota.reset_credits && currentQuota.reset_credits.available_count > 0 && (
            <Popconfirm
              title={t('quota.redeem_credit_confirm_title')}
              description={t('quota.redeem_credit_confirm_desc')}
              onConfirm={() => onRedeemCredit(currentQuota.auth_index)}
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
            disabled={currentQuota.disabled || isRefreshing}
            onClick={() => onRefresh(currentQuota.auth_index)}
          >
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      <Spin spinning={isLoading}>
        {/* Recommendation / Warning Banner */}
        {currentQuota.recommendation && currentQuota.recommendation.status !== 'healthy' && (
          <div
            className={`${styles.recBanner} ${
              currentQuota.recommendation.priority === 'critical' || currentQuota.recommendation.status === 'cooldown'
                ? styles.recBannerDanger
                : styles.recBannerWarn
            }`}
            style={{ marginBottom: 20 }}
          >
            <div className={styles.recText}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('quota.recommendation_title')}</div>
              <div>{currentQuota.recommendation.reason}</div>
            </div>
          </div>
        )}

        {/* Basic Metadata */}
        <div className={styles.drawerSection}>
          <div className={styles.drawerSectionTitle}>{t('quota.drawer_basic_info')}</div>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label={t('quota.col_provider')}>{currentQuota.provider}</Descriptions.Item>
            <Descriptions.Item label={t('quota.col_type')}>{currentQuota.type || '-'}</Descriptions.Item>
            <Descriptions.Item label={t('quota.col_plan')}>
              {currentQuota.plan ? (
                <span>
                  <Tag color="blue">{currentQuota.plan.plan_label}</Tag>
                  {currentQuota.plan.expires_label && (
                    <span style={{ fontSize: 11, color: 'var(--meta)' }}>({currentQuota.plan.expires_label})</span>
                  )}
                </span>
              ) : (
                '-'
              )}
            </Descriptions.Item>
            <Descriptions.Item label={t('quota.col_status')}>
              {currentQuota.active_cooldown?.is_active ? (
                <Tag color="error">{t('quota.status_cooldown')}</Tag>
              ) : currentQuota.status === 'healthy' ? (
                <Tag color="success">{t('quota.status_normal')}</Tag>
              ) : currentQuota.status === 'warning' ? (
                <Tag color="warning">{t('quota.status_warning')}</Tag>
              ) : (
                <Tag color="error">{t('quota.status_exceeded')}</Tag>
              )}
            </Descriptions.Item>
          </Descriptions>
        </div>

        {/* Standard Quota Windows */}
        <div className={styles.drawerSection}>
          <div className={styles.drawerSectionTitle}>{t('quota.drawer_standard_windows')}</div>
          {standardWindows.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {standardWindows.map((win) => (
                <div key={win.id} style={{ background: 'var(--hover-inset)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
                  <QuotaProgressBar
                    label={win.label}
                    usedPercent={win.used_percent}
                    remainingPercent={win.remaining_percent}
                    resetLabel={win.reset_label}
                    height={8}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--meta)', marginTop: 6 }}>
                    <span>{win.period_hours ? t('quota.window_duration', { hours: win.period_hours }) : ''}</span>
                    <span>{win.reset_accuracy ? t(`quota.accuracy_${win.reset_accuracy}`) : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--meta)' }}>{t('quota.no_window_data')}</div>
          )}
        </div>

        {/* Model Scoped Windows */}
        {modelWindows.length > 0 && (
          <div className={styles.drawerSection}>
            <div className={styles.drawerSectionTitle}>{t('quota.drawer_model_windows')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {modelWindows.map((win) => (
                <div key={win.id} style={{ background: 'var(--hover-inset)', padding: 10, borderRadius: 'var(--radius-sm)' }}>
                  <QuotaProgressBar
                    label={win.label}
                    subLabel={win.model}
                    usedPercent={win.used_percent}
                    remainingPercent={win.remaining_percent}
                    resetLabel={win.reset_label}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Codex Reset Credits */}
        {currentQuota.reset_credits && (
          <div className={styles.drawerSection}>
            <div className={styles.drawerSectionTitle}>{t('quota.drawer_reset_credits')}</div>
            <div style={{ background: 'var(--hover-inset)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12 }}>
                <span>{t('quota.available_credits_label')}:</span>
                <span style={{ fontWeight: 700, color: 'var(--fg)' }}>{currentQuota.reset_credits.available_count}</span>
              </div>
              {currentQuota.reset_credits.credits && currentQuota.reset_credits.credits.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                  {currentQuota.reset_credits.credits.map((c) => (
                    <div
                      key={c.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 11,
                        padding: '4px 8px',
                        background: 'var(--surface)',
                        borderRadius: 2,
                      }}
                    >
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{c.id.slice(0, 16)}…</span>
                      <span style={{ color: 'var(--meta)' }}>
                        {c.expires_at_ms ? new Date(c.expires_at_ms).toLocaleDateString() : '-'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Snapshot History */}
        {history.length > 0 && (
          <div className={styles.drawerSection}>
            <div className={styles.drawerSectionTitle}>{t('quota.drawer_history')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.slice(0, 8).map((h) => (
                <div
                  key={h.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 11,
                    padding: '6px 10px',
                    background: 'var(--hover-inset)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <span style={{ color: 'var(--meta)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(h.observed_at_ms).toLocaleString()}
                  </span>
                  <Tag color={h.status === 'healthy' ? 'success' : h.status === 'warning' ? 'warning' : 'default'} style={{ margin: 0 }}>
                    {h.status}
                  </Tag>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Raw Passive Signals */}
        {currentQuota.raw_signals && Object.keys(currentQuota.raw_signals).length > 0 && (
          <div className={styles.drawerSection}>
            <div className={styles.drawerSectionTitle}>{t('quota.drawer_signals')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(currentQuota.raw_signals).map(([k, v]) => (
                <Tag key={k} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {k}: {v}
                </Tag>
              ))}
            </div>
          </div>
        )}
      </Spin>
    </Drawer>
  );
};
