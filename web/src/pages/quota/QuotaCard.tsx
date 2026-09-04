import React from 'react';
import { Button, Tag, Popconfirm } from 'antd';
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

interface QuotaCardProps {
  item: QuotaItem;
  isRefreshing?: boolean;
  onRefresh: (authIndex: string) => void;
  onClearCooldown: (authIndex: string) => void;
  onRedeemCredit: (authIndex: string) => void;
  onOpenDetail: (item: QuotaItem) => void;
}

export const QuotaCard: React.FC<QuotaCardProps> = ({
  item,
  isRefreshing,
  onRefresh,
  onClearCooldown,
  onRedeemCredit,
  onOpenDetail,
}) => {
  const t = useT();

  const iconId = getProviderDefaultIcon(item.provider, item.name);

  // Status badge config
  const renderStatus = () => {
    if (item.active_cooldown?.is_active) {
      return (
        <Tag color="error" icon={<StopOutlined />} style={{ margin: 0 }}>
          {t('quota.status_cooldown')}
        </Tag>
      );
    }
    switch (item.status) {
      case 'healthy':
        return (
          <Tag color="success" icon={<CheckCircleOutlined />} style={{ margin: 0 }}>
            {t('quota.status_normal')}
          </Tag>
        );
      case 'warning':
        return (
          <Tag color="warning" icon={<WarningOutlined />} style={{ margin: 0 }}>
            {t('quota.status_warning')}
          </Tag>
        );
      case 'exhausted':
        return (
          <Tag color="error" icon={<CloseCircleOutlined />} style={{ margin: 0 }}>
            {t('quota.status_exceeded')}
          </Tag>
        );
      case 'error':
        return (
          <Tag color="error" style={{ margin: 0 }}>
            {t('quota.status_error')}
          </Tag>
        );
      case 'stale':
        return (
          <Tag color="default" style={{ margin: 0 }}>
            {t('quota.status_stale')}
          </Tag>
        );
      default:
        return (
          <Tag color="default" style={{ margin: 0 }}>
            {t('quota.status_idle')}
          </Tag>
        );
    }
  };

  // Plan tier class
  const getPlanClass = () => {
    if (!item.plan) return styles.planStandard;
    switch (item.plan.tier) {
      case 'elite':
        return styles.planElite;
      case 'premium':
        return styles.planPremium;
      default:
        return styles.planStandard;
    }
  };

  // Select primary windows to show (e.g. 5h and weekly, or up to 2)
  const displayWindows = item.windows.slice(0, 2);

  // Relative time for observed_at
  const formatObservedTime = (ms?: number) => {
    if (!ms) return '-';
    const diffSec = Math.floor((Date.now() - ms) / 1000);
    if (diffSec < 60) return t('quota.just_now');
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} ${t('quota.mins_ago')}`;
    const diffHours = Math.floor(diffMin / 60);
    return `${diffHours} ${t('quota.hours_ago')}`;
  };

  return (
    <article className={styles.quotaCard}>
      {/* Header */}
      <div className={styles.cardHead}>
        <div className={styles.cardTitleWrap}>
          <div className={styles.cardIcon}>
            <LobeIcon iconId={iconId} size={18} />
          </div>
          <div className={styles.cardNameBlock}>
            <div className={styles.cardName} title={item.name}>
              {item.name}
            </div>
            <div className={styles.cardAuthIndex} title={item.auth_index}>
              {item.auth_index}
            </div>
          </div>
        </div>

        <div className={styles.cardTags}>
          {item.plan?.plan_label && (
            <span className={`${styles.planTag} ${getPlanClass()}`}>
              {item.plan.plan_label}
            </span>
          )}
          {renderStatus()}
        </div>
      </div>

      {/* Active Cooldown Banner */}
      {item.active_cooldown?.is_active && (
        <div className={`${styles.recBanner} ${styles.recBannerDanger}`}>
          <div className={styles.recText}>
            <div>{item.active_cooldown.reason || t('quota.cooldown_active_desc')}</div>
            {item.active_cooldown.recover_at_ms && (
              <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>
                {t('quota.recover_at', { time: new Date(item.active_cooldown.recover_at_ms).toLocaleTimeString() })}
              </div>
            )}
          </div>
          <Button
            size="small"
            danger
            onClick={() => onClearCooldown(item.auth_index)}
          >
            {t('quota.clear_cooldown')}
          </Button>
        </div>
      )}

      {/* Codex Reset Credits Available Banner */}
      {!item.active_cooldown?.is_active && item.reset_credits && item.reset_credits.available_count > 0 && (
        <div className={`${styles.recBanner} ${styles.recBannerWarn}`}>
          <div className={styles.recText}>
            <span style={{ fontWeight: 600 }}>{t('quota.credits_available_title', { count: item.reset_credits.available_count })}</span>
          </div>
          <Popconfirm
            title={t('quota.redeem_credit_confirm_title')}
            description={t('quota.redeem_credit_confirm_desc')}
            onConfirm={() => onRedeemCredit(item.auth_index)}
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
        </div>
      )}

      {/* Windows list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        {displayWindows.length > 0 ? (
          displayWindows.map((win) => (
            <QuotaProgressBar
              key={win.id}
              label={win.label}
              usedPercent={win.used_percent}
              remainingPercent={win.remaining_percent}
              resetLabel={win.reset_label}
            />
          ))
        ) : (
          <div style={{ fontSize: 11, color: 'var(--meta)', padding: '12px 0', textAlign: 'center' }}>
            {item.disabled ? t('quota.credential_disabled') : t('quota.no_window_data')}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className={styles.cardFooter}>
        <div className={styles.cardMetaTime}>
          {formatObservedTime(item.observed_at_ms)}
        </div>

        <div className={styles.cardActions}>
          <Button
            size="small"
            icon={<SyncOutlined spin={isRefreshing} />}
            disabled={item.disabled || isRefreshing}
            onClick={() => onRefresh(item.auth_index)}
          >
            {t('common.refresh')}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<RightOutlined />}
            onClick={() => onOpenDetail(item)}
          >
            {t('common.details')}
          </Button>
        </div>
      </div>
    </article>
  );
};
