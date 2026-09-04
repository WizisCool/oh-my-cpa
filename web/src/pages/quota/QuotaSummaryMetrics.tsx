import React from 'react';
import { Button } from 'antd';
import {
  SyncOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  StopOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import type { QuotaOverviewSummary } from '../../types/quota';
import styles from './QuotaPage.module.css';

interface QuotaSummaryMetricsProps {
  summary: QuotaOverviewSummary;
  isRefreshing: boolean;
  onRefreshAll: () => void;
  onClearAllCooldowns?: () => void;
}

export const QuotaSummaryMetrics: React.FC<QuotaSummaryMetricsProps> = ({
  summary,
  isRefreshing,
  onRefreshAll,
  onClearAllCooldowns,
}) => {
  const t = useT();

  const formatSoonestRecovery = (ms?: number) => {
    if (!ms) return t('quota.metric_all_available');
    const diff = ms - Date.now();
    if (diff <= 0) return t('quota.metric_all_available');
    const mins = Math.ceil(diff / 60000);
    if (mins < 60) return `${mins} ${t('quota.mins_later')}`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return `${hours}h ${remMins}m ${t('quota.later')}`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h ${t('quota.later')}`;
  };

  return (
    <div>
      <div className={styles.kpiStrip}>
        {/* Total Credentials */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>
            <ThunderboltOutlined />
            <span>{t('quota.metric_total')}</span>
          </div>
          <div className={styles.kpiValueRow}>
            <span className={styles.kpiNumber}>{summary.total_credentials}</span>
            <span className={`${styles.kpiPip} ${styles.pipMeta}`} />
          </div>
        </div>

        {/* Healthy Credentials */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>
            <CheckCircleOutlined />
            <span>{t('quota.metric_healthy')}</span>
          </div>
          <div className={styles.kpiValueRow}>
            <span className={styles.kpiNumber} style={{ color: 'var(--success)' }}>
              {summary.healthy_count}
            </span>
            <span className={`${styles.kpiPip} ${styles.pipSuccess}`} />
          </div>
        </div>

        {/* Attention / Warning */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>
            <WarningOutlined />
            <span>{t('quota.metric_attention')}</span>
          </div>
          <div className={styles.kpiValueRow}>
            <span className={styles.kpiNumber} style={{ color: summary.attention_count > 0 ? 'var(--warn)' : 'var(--fg)' }}>
              {summary.attention_count}
            </span>
            <span className={`${styles.kpiPip} ${summary.attention_count > 0 ? styles.pipWarn : styles.pipMeta}`} />
          </div>
        </div>

        {/* Cooldown Active */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>
            <StopOutlined />
            <span>{t('quota.metric_cooldown')}</span>
          </div>
          <div className={styles.kpiValueRow}>
            <span className={styles.kpiNumber} style={{ color: summary.cooldown_count > 0 ? 'var(--danger)' : 'var(--fg)' }}>
              {summary.cooldown_count}
            </span>
            <span className={`${styles.kpiPip} ${summary.cooldown_count > 0 ? styles.pipDanger : styles.pipMeta}`} />
          </div>
        </div>

        {/* Soonest Recovery */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>
            <ClockCircleOutlined />
            <span>{t('quota.metric_soonest_recovery')}</span>
          </div>
          <div className={styles.kpiValueRow}>
            <span className={styles.kpiNumber} style={{ fontSize: 16 }}>
              {formatSoonestRecovery(summary.soonest_recovery_ms)}
            </span>
            <span className={`${styles.kpiPip} ${styles.pipAccent}`} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 16 }}>
        {summary.cooldown_count > 0 && onClearAllCooldowns && (
          <Button
            size="small"
            danger
            icon={<StopOutlined />}
            onClick={onClearAllCooldowns}
          >
            {t('quota.clear_all_cooldowns')}
          </Button>
        )}
        <Button
          size="small"
          icon={<SyncOutlined spin={isRefreshing} />}
          onClick={onRefreshAll}
        >
          {t('quota.refresh_visible')}
        </Button>
      </div>
    </div>
  );
};
