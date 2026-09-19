import React from 'react';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { Button, Tag, Popconfirm } from 'antd';
import {
  SyncOutlined,
  StopOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { credentialProviderIconId } from '../../components/common/providerMetadata';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { isDemoMode } from '../../types/demoMode';
import { QuotaProgressBar } from './QuotaProgressBar';
import {
  formatGmtOffsetLabel,
  formatObservedAgo,
  formatTimeWithCountdown,
} from './quotaFormat';
import styles from './QuotaPage.module.css';

interface QuotaCardProps {
  item: QuotaItem;
  /** Logo published by the plugin that registers this provider, when it has one. */
  pluginLogo?: string;
  isRefreshing?: boolean;
  onRefresh: (authIndex: string) => void;
  onClearCooldown: (authIndex: string) => void;
  onRedeemCredit: (authIndex: string) => void;
}

export const QuotaCard: React.FC<QuotaCardProps> = ({
  item,
  pluginLogo,
  isRefreshing,
  onRefresh,
  onClearCooldown,
  onRedeemCredit,
}) => {
  const t = useT();
  // Redeeming a reset credit spends a real entitlement and clearing a cooldown changes a
  // credential's state; the demonstration refuses both, so neither is offered.
  const isDemo = isDemoMode();
  const nowMS = useVisibleNow();

  const iconId = credentialProviderIconId(item.provider, item.name);

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

  // Standard windows first (5h, weekly), then upstream order; never truncated —
  // antigravity alone carries six group windows (Claude/ChatGPT/Gemini × 5h/weekly)
  const displayWindows = [...item.windows].sort(
    (a, b) => windowRank(a.kind) - windowRank(b.kind)
  );

  const availableCredits = item.reset_credits?.available_count ?? 0;
  const creditSupported = item.capabilities.reset_credit_supported;
  const canRedeem = creditSupported && availableCredits > 0 && !item.disabled;

  const creditRows = (item.reset_credits?.credits ?? [])
    .filter((c) => c.expires_at_ms)
    .sort((a, b) => (a.expires_at_ms ?? 0) - (b.expires_at_ms ?? 0));

  // Group-scoped windows (antigravity) render under their model group; a
  // hairline divider separates consecutive groups, e.g. Gemini vs Claude and GPT.
  const renderWindowRows = (windows: QuotaItem['windows']) => {
    const rows: React.ReactNode[] = [];
    let lastGroup: string | null = null;
    windows.forEach((win) => {
      const group = win.scope === 'group' ? win.label.split(' · ')[0] : null;
      if (group && lastGroup && group !== lastGroup) {
        rows.push(<div key={`divider-${win.id}`} className={styles['window-divider']} aria-hidden="true" />);
      }
      rows.push(
        <QuotaProgressBar
          key={win.id}
          nowMS={nowMS}
          kind={win.kind}
          label={win.label}
          usedPercent={win.used_percent}
          remainingPercent={win.remaining_percent}
          resetAtMS={win.reset_at_ms}
          resetLabel={win.reset_label}
        />
      );
      if (group) {
        lastGroup = group;
      }
    });
    return rows;
  };

  return (
    <article className={`terminal-panel ${styles['quota-card']}`}>
      {/* Header: provider icon + credential name + status */}
      <div className={styles['card-head']}>
        <div className={styles['card-title-wrap']}>
          <div className={styles['card-icon']}>
            <ProviderBrandIcon iconId={iconId} logo={pluginLogo} size={20} />
          </div>
          <div className={styles['card-name-block']}>
            <div className={styles['card-name']} title={item.name}>
              {item.name}
            </div>
            <div className={styles['card-auth-index']} title={item.auth_index}>
              {item.auth_index}
            </div>
          </div>
        </div>
        <div className={styles['card-tags']}>{renderStatus()}</div>
      </div>

      {/* Plan summary strip: plan | renewal date | reset count — omit empty
          slots instead of showing "—" dummies (CPAMC behaviour) */}
      {(item.plan?.plan_label || item.plan?.expires_at_ms || item.reset_credits) && (
        <div className={styles['meta-row']}>
          {item.plan?.plan_label && (
            <span className={styles['meta-item']}>
              <span className={styles['meta-label']}>{t('quota.col_plan')}</span>
              <span className={styles['meta-value']}>{item.plan.plan_label}</span>
            </span>
          )}
          {item.plan?.expires_at_ms && (
            <span className={styles['meta-item']}>
              <span className={styles['meta-label']}>{t('quota.col_renewal')}</span>
              <span className={styles['meta-value']}>
                {formatTimeWithCountdown(item.plan.expires_at_ms, nowMS, t)}
              </span>
            </span>
          )}
          {item.reset_credits && (
            <span className={styles['meta-item']}>
              <span className={styles['meta-label']}>{t('quota.col_reset_count')}</span>
              <span className={styles['meta-value']}>{availableCredits}</span>
            </span>
          )}
        </div>
      )}

      {/* Active Cooldown Banner */}
      {item.active_cooldown?.is_active && (
        <div className={`${styles['rec-banner']} ${styles['rec-banner-danger']}`}>
          <span className={styles['banner-dot']} style={{ background: 'var(--danger)' }} />
          <div className={styles['rec-text']}>
            <div>{item.active_cooldown.reason || t('quota.cooldown_active_desc')}</div>
            {item.active_cooldown.recover_at_ms && (
              <div className={styles['rec-sub-danger']}>
                {t('quota.recover_at', { time: formatTimeWithCountdown(item.active_cooldown.recover_at_ms, nowMS, t) })}
              </div>
            )}
          </div>
          <Button
            size="small"
            danger
            disabled={isDemo}
            title={isDemo ? t('demo.blocked') : undefined}
            onClick={() => onClearCooldown(item.auth_index)}
          >
            {t('quota.clear_cooldown')}
          </Button>
        </div>
      )}

      {/* Manual reset credit expiries */}
      {item.reset_credits && creditRows.length > 0 && (
        <div className={styles.section}>
          <div className={styles['section-title']}>
            {t('quota.reset_expiry_title')}（{formatGmtOffsetLabel(new Date(nowMS))}）
          </div>
          <div className={styles['reset-list']}>
            {creditRows.map((credit, idx) => (
              <div className={styles['reset-row']} key={credit.id || idx}>
                <span className={styles['meta-label']}>{t('quota.reset_occurrence', { n: idx + 1 })}</span>
                <span className={styles['meta-value']}>
                  {credit.expires_at_ms
                    ? formatTimeWithCountdown(credit.expires_at_ms, nowMS, t)
                    : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Usage limits */}
      <div className={styles.section}>
        <div className={styles['section-title']}>{t('quota.windows_title')}</div>
        <div className={styles['windows-list']}>
          {displayWindows.length > 0 ? (
            renderWindowRows(displayWindows)
          ) : (
            <div className={styles['no-window']}>
              {item.disabled ? t('quota.credential_disabled') : t('quota.no_window_data')}
            </div>
          )}
        </div>
      </div>

      {/* Footer: observed time + primary actions */}
      <div className={styles['card-footer']}>
        <div className={styles['card-meta-time']}>
          {formatObservedAgo(item.observed_at_ms, nowMS, t)}
        </div>
        <div className={styles['card-actions']}>
          {canRedeem && (
            <Popconfirm
              title={t('quota.redeem_credit_confirm_title')}
              description={t('quota.redeem_credit_confirm_desc')}
              onConfirm={() => onRedeemCredit(item.auth_index)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                icon={<ThunderboltOutlined />}
                disabled={isDemo}
                title={isDemo ? t('demo.blocked') : undefined}
              >
                {t('quota.btn_reset_quota')}
              </Button>
            </Popconfirm>
          )}
          <Button
            size="small"
            icon={<SyncOutlined spin={isRefreshing} />}
            aria-label={t('quota.btn_refresh_quota')}
            disabled={item.disabled || isRefreshing}
            onClick={() => onRefresh(item.auth_index)}
          >
            {t('quota.btn_refresh_quota')}
          </Button>
        </div>
      </div>
    </article>
  );
};

// five_hour before weekly before everything else
function windowRank(kind?: string): number {
  if (kind === 'five_hour') return 0;
  if (kind === 'weekly') return 1;
  if (kind === 'daily') return 2;
  if (kind === 'monthly') return 3;
  return 4;
}
