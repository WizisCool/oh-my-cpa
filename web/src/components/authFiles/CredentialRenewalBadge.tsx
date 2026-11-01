import { Tooltip } from '../common/Tooltip';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import { formatGatewayTimestamp } from '../../utils/time';
import {
  ExclamationCircleOutlined,
  WarningOutlined,
} from '../icons';
import {
  renewalDetail,
  renewalKind,
  renewalLabel,
  type RenewalKind,
} from './credentialRecovery';
import styles from './CredentialRenewalBadge.module.css';

export interface CredentialRenewalBadgeProps {
  file: ManagementAuthFile;
  /** Optional callback to open the credential drawer on the renewal tab. */
  onOpen?: () => void;
  className?: string;
}

function RenewalIcon({ kind }: { kind: RenewalKind }) {
  switch (kind) {
    case 'reauth':
      return <ExclamationCircleOutlined />;
    case 'retry':
    default:
      return <WarningOutlined />;
  }
}

function resolveBadgeTone(kind: RenewalKind): 'warn' | 'danger' {
  return kind === 'reauth' ? 'danger' : 'warn';
}

export function CredentialRenewalBadge({ file, onOpen, className }: CredentialRenewalBadgeProps) {
  const t = useT();
  const kind = renewalKind(file);

  // Management by exception (例外管理模式):
  // When renewal is healthy (verified, awaiting), remain completely silent.
  // When sign-in is required, the primary StatusLabel itself already states "Sign-in required"
  // with an action button "Reauthenticate" beneath it; adding an icon beside it is redundant and crowds the cell.
  // The alert badge is specifically for background retry attention (retry_scheduled) where the primary status
  // is healthy/normal but CPA needs operator awareness of the scheduled retry.
  if (kind !== 'retry') {
    return null;
  }

  const tone = resolveBadgeTone(kind);
  const label = t(renewalLabel(file));
  const detail = t(renewalDetail(file));
  const credentialName = file.display_name?.trim() || file.name;
  const ariaLabel = onOpen
    ? `${t('recovery.view_details')}: ${credentialName} (${t('recovery.renewal')}: ${label})`
    : `${t('recovery.renewal')}: ${credentialName} — ${label}`;
  const renewalStateValue = file.renewal_state ?? (file.requires_sign_in ? 'sign_in_required' : 'unknown');

  const tooltipContent = (
    <div className={styles.tooltip}>
      <div className={styles['tooltip-head']}>
        <span className={clsx(styles['tooltip-pip'], styles[`is-${tone}`])} aria-hidden="true" />
        <span>{t('recovery.renewal')}: {label}</span>
      </div>
      <div className={styles['tooltip-detail']}>{detail}</div>
      {(file.access_token_expires_at || file.next_refresh_after || file.refresh_error || file.recovery_stage === 'quota_blocked') && (
        <div className={styles['tooltip-meta']}>
          {file.access_token_expires_at && (
            <div className={styles['tooltip-meta-row']}>
              <span className={styles['tooltip-meta-label']}>{t('recovery.access_expires')}</span>
              <span className={styles['tooltip-meta-value']}>{formatGatewayTimestamp(file.access_token_expires_at)}</span>
            </div>
          )}
          {file.next_refresh_after && (
            <div className={styles['tooltip-meta-row']}>
              <span className={styles['tooltip-meta-label']}>{t('recovery.next_refresh')}</span>
              <span className={styles['tooltip-meta-value']}>{formatGatewayTimestamp(file.next_refresh_after)}</span>
            </div>
          )}
          {file.refresh_error && (
            <div className={clsx(styles['tooltip-meta-row'], styles['tooltip-error'])}>
              <span className={styles['tooltip-meta-label']}>{t('recovery.refresh_error')}</span>
              <span className={styles['tooltip-meta-value']}>
                {[file.refresh_error.code, file.refresh_error.http_status].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
          {file.recovery_stage === 'quota_blocked' && (
            <div className={styles['tooltip-blocked']}>
              {t('recovery.quota_blocked_hint')}
            </div>
          )}
        </div>
      )}
      {onOpen && (
        <div className={styles['tooltip-action']}>
          {t('recovery.view_details')}
        </div>
      )}
    </div>
  );

  const badgeProps = {
    className: clsx(
      styles.badge,
      styles[`is-${tone}`],
      styles[`kind-${kind}`],
      !onOpen && styles['badge-static'],
      className,
    ),
    'aria-label': ariaLabel,
    'data-testid': 'oauth-credential-renewal-badge',
    'data-renewal-state': renewalStateValue,
    'data-renewal-kind': kind,
    'data-renewal-tone': tone,
  };

  const badgeElement = onOpen ? (
    <button
      type="button"
      {...badgeProps}
      onClick={onOpen}
    >
      <RenewalIcon kind={kind} />
    </button>
  ) : (
    <span
      role="img"
      tabIndex={0}
      {...badgeProps}
    >
      <RenewalIcon kind={kind} />
    </span>
  );

  return (
    <Tooltip title={tooltipContent}>
      {badgeElement}
    </Tooltip>
  );
}
