import React, { useState, useEffect } from 'react';
import { Button, Tag, Popconfirm } from 'antd';
import {
  SyncOutlined,
  StopOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { LobeIcon, getProviderDefaultIcon } from '../../components/LobeIcon';
import { getCredentialProviderMetadata } from '../../components/common/providerMetadata';
import { useT } from '../../i18n';
import type { QuotaItem } from '../../types/quota';
import { QuotaProgressBar } from './QuotaProgressBar';
import {
  formatGmtOffsetLabel,
  formatObservedAgo,
  formatTimeWithCountdown,
} from './quotaFormat';
import styles from './QuotaPage.module.css';

interface QuotaCardProps {
  item: QuotaItem;
  isRefreshing?: boolean;
  onRefresh: (authIndex: string) => void;
  onClearCooldown: (authIndex: string) => void;
  onRedeemCredit: (authIndex: string) => void;
}

export const QuotaCard: React.FC<QuotaCardProps> = ({
  item,
  isRefreshing,
  onRefresh,
  onClearCooldown,
  onRedeemCredit,
}) => {
  const t = useT();
  const [nowMS, setNowMS] = useState(Date.now());

  // Ticker for plan-expiry and credit-expiry countdowns on this card
  useEffect(() => {
    const interval = setInterval(() => setNowMS(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  const meta = getCredentialProviderMetadata(item.provider);
  const iconId = meta.iconId || getProviderDefaultIcon(item.provider, item.name);

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

  // Standard windows first (5h, weekly), then upstream order; never truncated —
  // antigravity alone carries six group windows (Claude/ChatGPT/Gemini × 5h/weekly)
  const displayWindows = [...item.windows].sort(
    (a, b) => windowRank(a.kind) - windowRank(b.kind)
  );

  const availableCredits = item.reset_credits?.available_count ?? 0;
  const creditSupported = item.capabilities.reset_credit_supported;
  const canRedeem = creditSupported && availableCredits > 0 && !item.disabled;

  // Upcoming credit expiries for the "manual reset expiry" block
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
        rows.push(<div key={`divider-${win.id}`} className={styles.windowDivider} aria-hidden="true" />);
      }
      rows.push(
        <QuotaProgressBar
          key={win.id}
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
    <article className={`terminal-panel ${styles.quotaCard}`}>
      {/* Header: provider icon + credential name + status */}
      <div className={styles.cardHead}>
        <div className={styles.cardTitleWrap}>
          <div className={styles.cardIcon}>
            <LobeIcon iconId={iconId} size={20} />
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
        <div className={styles.cardTags}>{renderStatus()}</div>
      </div>

      {/* Plan summary strip: 套餐 | 续期时间 | 重置次数 — omit empty slots
          instead of showing "—" dummies (CPAMC behavior) */}
      {(item.plan?.plan_label || item.plan?.expires_at_ms || item.reset_credits) && (
        <div className={styles.metaRow}>
          {item.plan?.plan_label && (
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('quota.col_plan')}</span>
              <span className={styles.metaValue}>{item.plan.plan_label}</span>
            </span>
          )}
          {item.plan?.expires_at_ms && (
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('quota.col_renewal')}</span>
              <span className={styles.metaValue}>
                {formatTimeWithCountdown(item.plan.expires_at_ms, nowMS, t)}
              </span>
            </span>
          )}
          {item.reset_credits && (
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('quota.col_reset_count')}</span>
              <span className={styles.metaValue}>{availableCredits}</span>
            </span>
          )}
        </div>
      )}

      {/* Active Cooldown Banner */}
      {item.active_cooldown?.is_active && (
        <div className={`${styles.recBanner} ${styles.recBannerDanger}`}>
          <div className={styles.recText}>
            <div>{item.active_cooldown.reason || t('quota.cooldown_active_desc')}</div>
            {item.active_cooldown.recover_at_ms && (
              <div className={styles.recSubDanger}>
                {t('quota.recover_at', { time: formatTimeWithCountdown(item.active_cooldown.recover_at_ms, nowMS, t) })}
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

      {/* Manual reset credit expiries */}
      {item.reset_credits && creditRows.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            {t('quota.reset_expiry_title')}（{formatGmtOffsetLabel(new Date(nowMS))}）
          </div>
          <div className={styles.resetList}>
            {creditRows.map((credit, idx) => (
              <div className={styles.resetRow} key={credit.id || idx}>
                <span className={styles.metaLabel}>{t('quota.reset_occurrence', { n: idx + 1 })}</span>
                <span className={styles.metaValue}>
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
        <div className={styles.sectionTitle}>{t('quota.windows_title')}</div>
        <div className={styles.windowsList}>
          {displayWindows.length > 0 ? (
            renderWindowRows(displayWindows)
          ) : (
            <div className={styles.noWindow}>
              {item.disabled ? t('quota.credential_disabled') : t('quota.no_window_data')}
            </div>
          )}
        </div>
      </div>

      {/* Footer: observed time + primary actions */}
      <div className={styles.cardFooter}>
        <div className={styles.cardMetaTime}>
          {formatObservedAgo(item.observed_at_ms, nowMS, t)}
        </div>
        <div className={styles.cardActions}>
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
