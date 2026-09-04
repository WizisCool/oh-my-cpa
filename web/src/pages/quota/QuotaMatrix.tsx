import React from 'react';
import { Button, Tag } from 'antd';
import {
  SyncOutlined,
  StopOutlined,
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

interface QuotaMatrixProps {
  items: QuotaItem[];
  refreshingIndexes: Set<string>;
  onRefresh: (authIndex: string) => void;
  onClearCooldown: (authIndex: string) => void;
  onOpenDetail: (item: QuotaItem) => void;
}

export const QuotaMatrix: React.FC<QuotaMatrixProps> = ({
  items,
  refreshingIndexes,
  onRefresh,
  onClearCooldown,
  onOpenDetail,
}) => {
  const t = useT();

  const getWindowByType = (item: QuotaItem, type: '5h' | 'weekly' | 'other') => {
    if (type === '5h') {
      return item.windows.find((w) => w.id.includes('5') || w.period_hours === 5 || w.label.includes('5小时'));
    }
    if (type === 'weekly') {
      return item.windows.find(
        (w) => w.id.includes('weekly') || w.period_hours === 168 || w.label.includes('每周') || w.label.includes('Daily')
      );
    }
    return item.windows.find(
      (w) => !w.id.includes('5') && !w.id.includes('weekly') && w.period_hours !== 5 && w.period_hours !== 168
    );
  };

  const renderStatus = (item: QuotaItem) => {
    if (item.active_cooldown?.is_active) {
      return (
        <Tag color="error" icon={<StopOutlined />}>
          {t('quota.status_cooldown')}
        </Tag>
      );
    }
    switch (item.status) {
      case 'healthy':
        return (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            {t('quota.status_normal')}
          </Tag>
        );
      case 'warning':
        return (
          <Tag color="warning" icon={<WarningOutlined />}>
            {t('quota.status_warning')}
          </Tag>
        );
      case 'exhausted':
        return (
          <Tag color="error" icon={<CloseCircleOutlined />}>
            {t('quota.status_exceeded')}
          </Tag>
        );
      case 'stale':
        return <Tag color="default">{t('quota.status_stale')}</Tag>;
      default:
        return <Tag color="default">{t('quota.status_idle')}</Tag>;
    }
  };

  return (
    <div className={styles.matrixTableWrap}>
      <table className={styles.matrixTable}>
        <thead>
          <tr>
            <th style={{ width: 220 }}>{t('quota.col_credential')}</th>
            <th style={{ width: 130 }}>{t('quota.col_plan')}</th>
            <th style={{ width: 170 }}>{t('quota.window_five_hour')}</th>
            <th style={{ width: 170 }}>{t('quota.window_weekly')}</th>
            <th style={{ width: 140 }}>{t('quota.col_other_windows')}</th>
            <th style={{ width: 140 }}>{t('quota.col_status')}</th>
            <th style={{ width: 130, textAlign: 'right' }}>{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const iconId = getProviderDefaultIcon(item.provider, item.name);
            const win5h = getWindowByType(item, '5h');
            const winWeekly = getWindowByType(item, 'weekly');
            const otherWins = item.windows.filter((w) => w !== win5h && w !== winWeekly);
            const isRefreshing = refreshingIndexes.has(item.auth_index);

            return (
              <tr key={item.auth_index}>
                {/* Credential */}
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className={styles.cardIcon} style={{ width: 24, height: 24 }}>
                      <LobeIcon iconId={iconId} size={15} />
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 13 }}>
                        {item.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--meta)', fontFamily: 'var(--font-mono)' }}>
                        {item.auth_index}
                      </div>
                    </div>
                  </div>
                </td>

                {/* Plan & Tier */}
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <Tag color="blue" style={{ width: 'fit-content', margin: 0, fontSize: 11 }}>
                      {item.provider}
                    </Tag>
                    {item.plan?.plan_label && (
                      <span style={{ fontSize: 11, color: 'var(--fg-2)', fontWeight: 600 }}>
                        {item.plan.plan_label}
                      </span>
                    )}
                  </div>
                </td>

                {/* 5-Hour Window */}
                <td className={styles.matrixCellProgress}>
                  {win5h ? (
                    <QuotaProgressBar
                      remainingPercent={win5h.remaining_percent}
                      resetLabel={win5h.reset_label}
                    />
                  ) : (
                    <span style={{ color: 'var(--meta)', fontSize: 11 }}>-</span>
                  )}
                </td>

                {/* Weekly / Daily Window */}
                <td className={styles.matrixCellProgress}>
                  {winWeekly ? (
                    <QuotaProgressBar
                      remainingPercent={winWeekly.remaining_percent}
                      resetLabel={winWeekly.reset_label}
                    />
                  ) : (
                    <span style={{ color: 'var(--meta)', fontSize: 11 }}>-</span>
                  )}
                </td>

                {/* Other Windows / Model limits */}
                <td>
                  {otherWins.length > 0 ? (
                    <Tag color="cyan" style={{ fontSize: 11 }}>
                      {t('quota.models_count', { count: otherWins.length })}
                    </Tag>
                  ) : item.reset_credits ? (
                    <Tag color="orange" style={{ fontSize: 11 }}>
                      {t('quota.credits_count', { count: item.reset_credits.available_count })}
                    </Tag>
                  ) : (
                    <span style={{ color: 'var(--meta)', fontSize: 11 }}>-</span>
                  )}
                </td>

                {/* Status & Cooldown */}
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {renderStatus(item)}
                    {item.active_cooldown?.is_active && (
                      <Button
                        size="small"
                        type="link"
                        danger
                        style={{ padding: 0, height: 'auto', fontSize: 11, textAlign: 'left' }}
                        onClick={() => onClearCooldown(item.auth_index)}
                      >
                        {t('quota.clear_cooldown')}
                      </Button>
                    )}
                  </div>
                </td>

                {/* Actions */}
                <td style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                    <Button
                      size="small"
                      icon={<SyncOutlined spin={isRefreshing} />}
                      aria-label={t('common.refresh')}
                      disabled={item.disabled || isRefreshing}
                      onClick={() => onRefresh(item.auth_index)}
                    />
                    <Button
                      size="small"
                      icon={<RightOutlined />}
                      aria-label={t('common.details')}
                      onClick={() => onOpenDetail(item)}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
