import type { MessageKey } from '../../i18n/catalog';
import React from 'react';
import clsx from 'clsx';
import { App as AntdApp, Button, Checkbox, Dropdown } from 'antd';
import { Switch } from '../../components/common/Switch';
import {
  AppstoreOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  LinkOutlined,
  MoreOutlined,
  ProfileOutlined,
  StopOutlined,
  SyncOutlined,
  WarningOutlined,
} from '../../components/icons';
import { credentialProviderIconId, getCredentialProviderMetadata } from '../../components/common/providerMetadata';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { StatusLabel } from '../../components/common/StatusLabel';
import { Meter } from '../../components/common/Meter';
import { useT, type TFunc } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import type { QuotaWindow } from '../../types/quota';
import {
  deriveAuthFileIdentity,
  hasAuthFileStatusWarning,
  isAuthFileDisabled,
  isAuthFileProblem,
  summarizeAuthFileStatusMessage,
} from '../../components/authFiles/authFileLogic';
import { SIWC_BADGE_LABEL_KEYS, SIWC_BADGE_TONES, type SIWCBadgeState } from '../../components/authFiles/siwcBadge';
import { formatObservedAgo, quotaRemainingPercent, quotaRemainingText, quotaResetCountdown, quotaResetText } from '../quota/quotaFormat';
import { quotaRemainingStroke } from '../quota/quotaThresholds';
import { describeCompactQuotaCapacity } from '../quota/quotaCapacity';
import { outlivedResetLine, refreshFailureLine } from '../quota/quotaAttempt';
import { resolveQuotaCooldownTooltip } from '../quota/quotaCooldown';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import type { OAuthWorkspaceRecord } from './oauthWorkspaceLogic';
import {
  credentialStatusOf,
  quotaCellsOf,
  type CredentialSection as Section,
  type QuotaColumn,
  type QuotaColumnSort,
  type QuotaFamilyHeader,
} from './credentialSections';
import { maskAccount, maskAccountIn } from '../../utils/maskAccount';
import styles from './CredentialSection.module.css';
import { Tooltip } from '../../components/common/Tooltip';

export interface CredentialRowActions {
  isBusy: (record: OAuthWorkspaceRecord) => boolean;
  isRefreshingQuota: (record: OAuthWorkspaceRecord) => boolean;
  siwcBadge: (record: OAuthWorkspaceRecord) => SIWCBadgeState | undefined;
  onSelect: (records: OAuthWorkspaceRecord[], isSelected: boolean) => void;
  onToggle: (record: OAuthWorkspaceRecord) => void;
  onDownload: (record: OAuthWorkspaceRecord) => void;
  onDelete: (record: OAuthWorkspaceRecord) => void;
  onOpen: (record: OAuthWorkspaceRecord, section: 'overview' | 'configuration' | 'models') => void;
  onRefreshQuota: (record: OAuthWorkspaceRecord) => void;
  onClearCooldown: (record: OAuthWorkspaceRecord) => void;
  onReauthenticate: (record: OAuthWorkspaceRecord) => void;
  onOpenSIWC: (record: OAuthWorkspaceRecord) => void;
}

interface CredentialSectionProps {
  section: Section;
  /** The provider's display name, for plugin providers whose name the console does not know. */
  title?: string;
  pluginLogo?: string;
  selectedKeys: Set<string>;
  nowMS: number;
  actions: CredentialRowActions;
  columnSort?: QuotaColumnSort;
  onSort: (key: string) => void;
}

const PERIOD_KEYS: Record<NonNullable<QuotaColumn['period']>, MessageKey> = {
  five_hour: 'quota.slot_five_hour', daily: 'quota.slot_daily', weekly: 'quota.slot_weekly', monthly: 'quota.slot_monthly',
};

function familyTitle(family: QuotaFamilyHeader, t: TFunc): string {
  if (family.label) return family.label;
  return t(family.scope === 'code_review' ? 'omc.quota_family_code_review' : 'omc.quota_family_plan');
}

function periodTitle(column: QuotaColumn, t: TFunc): string {
  return column.period ? t(PERIOD_KEYS[column.period]) : column.label ?? '';
}


/**
 * One provider's credentials as one table.
 *
 * The section header names the provider once, so rows carry no provider mark; the quota header names
 * each model group once, so a quota cell is only the share left, its bar, and when it resets. A
 * column's header sorts the section by that reading, which is how an operator with many accounts
 * finds the one with the most Claude quota left without opening anything.
 */
export function CredentialSection({ section, title, pluginLogo, selectedKeys, nowMS, actions, columnSort, onSort }: CredentialSectionProps) {
  const t = useT();
  const metadata = getCredentialProviderMetadata(section.provider);
  const columns = section.families.flatMap((family) => family.columns);
  const records = section.records;
  const hasSIWC = section.visibleRecords.some((record) => actions.siwcBadge(record));
  const hasCredits = section.visibleRecords.some((record) => record.quota?.reset_credits !== undefined);
  const selectable = section.records.filter((record) => record.canSelectForFileBatch);
  const selectedCount = selectable.filter((record) => selectedKeys.has(record.key)).length;
  const statuses = section.records.map((record) => credentialStatusOf(record, isAuthFileDisabled(record.file), isAuthFileProblem(record.file)));
  const exceptions = new Map<MessageKey, { tone: string; count: number }>();
  for (const status of statuses) {
    if (status.tone === 'success') continue;
    const entry = exceptions.get(status.labelKey) ?? { tone: status.tone, count: 0 };
    entry.count += 1;
    exceptions.set(status.labelKey, entry);
  }
  const quotaNote = columns.length > 0
    ? undefined
    : t(section.records.every((record) => record.isQuotaUnsupported) ? 'omc.section_quota_unsupported' : 'omc.section_quota_unobserved');
  // A section whose only family is the plan names its periods directly: "Plan" above every column
  // would say nothing the section header has not.
  const hasGroupedHeader = section.families.length > 1 || section.families.some((family) => family.scope !== 'standard');
  const headerRows = hasGroupedHeader ? 2 : 1;
  // A phone hides the header, so each reading carries the name its column header would have given
  // it: the period alone under a single plan family, the family and the period otherwise.
  const phoneColumns = section.families.map((family) => family.columns.map((column) => ({
    column,
    phoneLabel: hasGroupedHeader ? `${familyTitle(family, t)} · ${periodTitle(column, t)}` : periodTitle(column, t),
  })));

  const periodHeader = (column: QuotaColumn, isFirstOfFamily: boolean) => {
    const isSorted = columnSort?.key === column.key;
    const label = periodTitle(column, t);
    return (
      <th
        key={column.key}
        className={clsx(styles['th-period'], isFirstOfFamily && styles['th-divided'])}
        aria-sort={isSorted ? (columnSort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <button type="button" className={styles['sort-button']} onClick={() => onSort(column.key)} title={label}>
          <span className={styles['sort-label']}>{label}</span>
          {isSorted && (columnSort.direction === 'asc' ? <ArrowUpOutlined /> : <ArrowDownOutlined />)}
        </button>
      </th>
    );
  };

  return (
    <section className={styles.section} data-testid="oauth-credential-section" data-provider={section.provider}>
      <header className={styles.head}>
        <span className={styles['head-icon']}>
          <ProviderBrandIcon iconId={credentialProviderIconId(section.provider)} logo={pluginLogo} size={18} />
        </span>
        <h2 className={styles['head-title']}>{title ?? metadata.label}</h2>
        <span className={styles['head-count']}>{t('omc.section_count', { n: section.records.length })}</span>
        {[...exceptions.entries()].map(([labelKey, { tone, count }]) => (
          <span key={labelKey} className={clsx(styles['head-exception'], styles[`tone-${tone}`])}>{count} {t(labelKey)}</span>
        ))}
        {quotaNote && <span className={styles['head-note']}>{quotaNote}</span>}
      </header>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <colgroup>
            <col className={styles['col-identity']} />
            <col className={styles['col-status']} />
            <col className={styles['col-switch']} />
            {columns.map((column) => <col key={column.key} />)}
            {hasSIWC && <col className={styles['col-extra']} />}
            {hasCredits && <col className={styles['col-extra']} />}
            {columns.length === 0 && <col />}
            <col className={styles['col-actions']} />
          </colgroup>
          <thead>
            <tr>
              <th rowSpan={headerRows} className={styles['th-identity']}>
                <span className={styles['identity-head']}>
                  <Checkbox
                    checked={selectable.length > 0 && selectedCount === selectable.length}
                    indeterminate={selectedCount > 0 && selectedCount < selectable.length}
                    disabled={selectable.length === 0}
                    onChange={(event) => actions.onSelect(selectable, event.target.checked)}
                    aria-label={t('omc.section_select', { provider: title ?? metadata.label })}
                  />
                  {t('omc.col_credential')}
                </span>
              </th>
              <th rowSpan={headerRows}>{t('af.detail_status')}</th>
              <th rowSpan={headerRows}>{t('pro.col_switch')}</th>
              {hasGroupedHeader
                ? section.families.map((family) => (
                  <th key={family.key} colSpan={family.columns.length} className={styles['th-family']} scope="colgroup" title={familyTitle(family, t)}>
                    {familyTitle(family, t)}
                  </th>
                ))
                : columns.map((column, index) => periodHeader(column, index === 0))}
              {hasSIWC && <th rowSpan={headerRows} className={styles['th-divided']}>SIWC</th>}
              {hasCredits && <th rowSpan={headerRows} className={clsx(styles.num, !hasSIWC && styles['th-divided'])}>{t('omc.col_reset_credits')}</th>}
              {columns.length === 0 && <th rowSpan={headerRows} aria-hidden="true" />}
              <th rowSpan={headerRows} className={styles['th-actions']}><span className={styles['visually-hidden']}>{t('keys.col_actions')}</span></th>
            </tr>
            {hasGroupedHeader && (
              <tr>
                {section.families.map((family) => family.columns.map((column, index) => periodHeader(column, index === 0)))}
              </tr>
            )}
          </thead>
          <tbody>
            {records.map((record) => (
              <CredentialRow
                key={record.key}
                record={record}
                columns={phoneColumns}
                hasQuotaColumns={columns.length > 0}
                hasSIWC={hasSIWC}
                hasCredits={hasCredits}
                isSelected={selectedKeys.has(record.key)}
                nowMS={nowMS}
                actions={actions}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface CredentialRowProps {
  record: OAuthWorkspaceRecord;
  columns: { column: QuotaColumn; phoneLabel: string }[][];
  hasQuotaColumns: boolean;
  hasSIWC: boolean;
  hasCredits: boolean;
  isSelected: boolean;
  nowMS: number;
  actions: CredentialRowActions;
}

function CredentialRow({ record, columns, hasQuotaColumns, hasSIWC, hasCredits, isSelected, nowMS, actions }: CredentialRowProps) {
  const t = useT();
  const { modal } = AntdApp.useApp();
  const isDemo = isDemoMode();
  const { file, quota } = record;
  const identity = deriveAuthFileIdentity(file);
  // Who an account belongs to is masked until the operator asks, so a screen share or a screenshot of
  // the list does not publish every address; the reveal is per row and lasts until clicked again.
  const [isRevealed, setIsRevealed] = React.useState(false);
  const account = identity.isAccountPrimary ? identity.primary : '';
  const shownPrimary = account && !isRevealed ? maskAccount(account) : identity.primary;
  const shownSecondary = identity.secondary && account && !isRevealed ? maskAccountIn(identity.secondary, account) : identity.secondary;
  const isDisabled = isAuthFileDisabled(file);
  const status = credentialStatusOf(record, isDisabled, isAuthFileProblem(file));
  const isBusy = actions.isBusy(record);
  const isRefreshing = actions.isRefreshingQuota(record);
  const cells = quotaCellsOf(quota?.windows);
  const siwc = actions.siwcBadge(record);
  const isStale = record.quotaCondition === 'stale' || record.quotaCondition === 'error';
  const warning = hasAuthFileStatusWarning(file) && file.status_message ? file.status_message : undefined;
  // A failed refresh leaves the last good reading standing, possibly under a status that still says
  // Normal; the row has to say so, or whoever opens the page later trusts numbers nobody has.
  const failure = quota ? refreshFailureLine(quota, nowMS, t) : null;
  const explanation = failure
    ?? (quota ? outlivedResetLine(quota, t) : null)
    ?? (record.quotaCondition === 'cooldown' ? resolveQuotaCooldownTooltip(quota?.active_cooldown?.reason, t('quota.cooldown_active_desc')) : null);
  const needsRefresh = (status.canRefreshFix || Boolean(failure)) && record.canRefreshQuota;
  // A phone card has no columns to keep aligned, so it shows only the readings this credential
  // reports, two to a line; when that leaves one alone on the last line, it takes the whole line.
  const reportedKeys = columns.flat().map(({ column }) => column.key).filter((key) => cells.has(key));
  const hasRowCredits = quota?.reset_credits !== undefined;
  const hasOddPhoneItems = (reportedKeys.length + (hasRowCredits ? 1 : 0)) % 2 === 1;
  const phoneWideKey = hasOddPhoneItems && !hasRowCredits ? reportedKeys[reportedKeys.length - 1] : undefined;

  return (
    <tr
      className={clsx(styles.row, isSelected && styles['row-selected'], isDisabled && styles['row-disabled'])}
      data-testid="oauth-credential-record"
      data-identity={record.key}
      data-file-name={file.name}
      data-auth-index={file.auth_index ?? ''}
      data-quota-focus-anchor={quota ? record.authIndex : undefined}
    >
      <td className={styles['td-identity']}>
        <div className={styles.identity}>
          {!file.runtime_only ? (
            <Checkbox
              checked={isSelected}
              disabled={isBusy || !record.canSelectForFileBatch}
              onChange={(event) => actions.onSelect([record], event.target.checked)}
              aria-label={t('af.select_one', { name: file.name })}
            />
          ) : <span className={styles['checkbox-space']} />}
          <div className={styles['identity-copy']}>
            <div className={styles['identity-line']}>
              {account ? (
                <button
                  type="button"
                  className={clsx(styles.primary, styles['primary-toggle'])}
                  onClick={() => setIsRevealed((value) => !value)}
                  aria-pressed={isRevealed}
                  title={t(isRevealed ? 'omc.account_hide' : 'omc.account_reveal')}
                  data-account-masked={isRevealed ? undefined : 'true'}
                >
                  {shownPrimary}
                </button>
              ) : <span className={styles.primary} title={identity.primary}>{identity.primary}</span>}
              {quota?.plan?.plan_label && <span className={styles.plan}>{quota.plan.plan_label}</span>}
              {quota?.plan?.subscription_active === false && (
                <span className={clsx(styles.plan, styles['plan-inactive'])} data-subscription-inactive="true">{t('quota.subscription_inactive')}</span>
              )}
              {(warning || !record.hasUniqueFileName) && (
                <Tooltip title={warning ? summarizeAuthFileStatusMessage(warning) : t('omc.duplicate_file_identity', { name: record.fileName })}>
                  <WarningOutlined className={styles.warning} data-testid="oauth-credential-warning" aria-label={warning ?? t('omc.duplicate_file_identity', { name: record.fileName })} />
                </Tooltip>
              )}
            </div>
            <div className={styles.meta}>
              {shownSecondary && identity.secondary !== identity.primary && <span className={styles['meta-file']} title={shownSecondary}>{shownSecondary}</span>}
              {file.priority !== undefined && <span>{t('omc.priority_value', { n: file.priority })}</span>}
              {file.weight !== undefined && <span>{t('omc.weight_value', { n: file.weight })}</span>}
              {file.note && <Tooltip title={file.note}><span className={styles['meta-note']}>{file.note}</span></Tooltip>}
            </div>
          </div>
        </div>
      </td>
      <td className={styles['td-status']} data-testid="oauth-credential-status">
        <Tooltip title={explanation ?? undefined}>
          <StatusLabel tone={status.tone} data-status-explained={explanation ? 'true' : undefined}>{t(status.labelKey)}</StatusLabel>
        </Tooltip>
        {status.needsReauth ? (
          <button type="button" className={styles['status-action']} onClick={() => actions.onReauthenticate(record)}>{t('omc.reauthenticate')}</button>
        ) : failure ? (
          <span className={clsx(styles['status-sub'], styles['status-failed'])} title={failure} data-quota-failure-line="failed">{t('omc.status_refresh_failed')}</span>
        ) : quota?.observed_at_ms ? (
          <span className={styles['status-sub']}>{formatObservedAgo(quota.observed_at_ms, nowMS, t)}</span>
        ) : null}
      </td>
      <td className={styles['td-switch']}>
        <Switch
          size="small"
          checked={!isDisabled}
          disabled={isBusy || file.runtime_only || !record.canSelectForFileBatch}
          onChange={() => actions.onToggle(record)}
          aria-label={t('af.status_toggle_label', { name: file.name })}
        />
      </td>
      {columns.map((family) => family.map(({ column, phoneLabel }, index) => (
        <QuotaCell
          key={column.key}
          columnKey={column.key}
          phoneLabel={phoneLabel}
          window={cells.get(column.key)}
          isPhoneWide={column.key === phoneWideKey}
          isFirstOfFamily={index === 0}
          isStale={isStale || isDisabled}
          nowMS={nowMS}
        />
      )))}
      {hasSIWC && (
        <td className={clsx(styles['td-divided'], styles['td-siwc'])}>
          {siwc && (
            <button
              type="button"
              className={clsx(styles.siwc, styles[`siwc-${SIWC_BADGE_TONES[siwc]}`], siwc === 'bind' && styles['siwc-unbound'])}
              data-siwc-badge={siwc}
              onClick={() => actions.onOpenSIWC(record)}
              aria-label={t('siwc.badge_aria', { name: file.name })}
            >
              {t(SIWC_BADGE_LABEL_KEYS[siwc])}
            </button>
          )}
        </td>
      )}
      {hasCredits && (
        <td className={clsx(styles.num, styles['td-credits'], !hasSIWC && styles['td-divided'], !hasRowCredits && styles['td-credits-missing'], hasRowCredits && hasOddPhoneItems && styles['phone-wide'])}
          data-quota-credits={quota?.reset_credits?.available_count}
          data-quota-credits-missing={hasRowCredits ? undefined : 'true'}
        >
          <span className={styles['phone-label']}>{t('omc.col_reset_credits')}</span>
          {quota?.reset_credits ? (
            <span className={quota.reset_credits.available_count > 0 ? styles['credits-available'] : styles['credits-zero']} title={t('omc.quota_credit_available_hint')}>
              {quota.reset_credits.available_count}
            </span>
          ) : <span className={styles.missing}>—</span>}
        </td>
      )}
      {!hasQuotaColumns && <td className={styles['td-filler']} aria-hidden="true" />}
      <td className={styles['td-actions']}>
        {/* Refreshing is what an operator does most to a row, so it stands beside Details rather
            than in the menu. A row the console cannot refresh keeps the glyph's width empty, so
            the Details and menu glyphs stay in one column down the section. */}
        {record.canRefreshQuota ? (
          <Tooltip title={needsRefresh ? `${t('quota.btn_refresh_quota')} · ${t('omc.refresh_needed')}` : t('quota.btn_refresh_quota')}>
            <Button
              type="text"
              size="small"
              className={clsx(needsRefresh && styles['refresh-needed'])}
              icon={<SyncOutlined spin={isRefreshing} />}
              disabled={isBusy || isRefreshing || isDemo}
              onClick={() => actions.onRefreshQuota(record)}
              aria-label={needsRefresh
                ? `${t('quota.btn_refresh_quota')}: ${file.name} (${t('omc.refresh_needed')})`
                : `${t('quota.btn_refresh_quota')}: ${file.name}`}
              data-testid="oauth-credential-refresh"
              data-needs-refresh={needsRefresh ? 'true' : undefined}
            />
          </Tooltip>
        ) : <span className={styles['action-space']} aria-hidden="true" />}
        <Tooltip title={t('common.details')}>
          <Button
            type="text"
            size="small"
            icon={<ProfileOutlined />}
            disabled={isBusy}
            onClick={() => actions.onOpen(record, 'overview')}
            aria-label={`${t('common.details')}: ${file.name}`}
          />
        </Tooltip>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'models', icon: <AppstoreOutlined />, label: t('af.models_btn'), disabled: isBusy || file.runtime_only },
              { key: 'edit', icon: <EditOutlined />, label: t('common.edit'), disabled: isBusy || !record.canSelectForFileBatch },
              { key: 'clear-cooldown', icon: <StopOutlined />, label: t('quota.clear_cooldown'), disabled: isBusy || isDemo || !record.canClearCooldown },
              ...(siwc ? [{ key: 'siwc', icon: <LinkOutlined />, label: t('siwc.menu'), disabled: isBusy }] : []),
              { type: 'divider' as const },
              { key: 'download', icon: <DownloadOutlined />, label: t('af.download_credential'), disabled: isBusy || file.runtime_only || isDemo || !record.canSelectForFileBatch },
              { key: 'delete', icon: <DeleteOutlined />, label: t('af.delete_credential'), danger: true, disabled: isBusy || file.runtime_only || isDemo || !record.canSelectForFileBatch },
            ],
            onClick: ({ key }) => {
              if (key === 'models') actions.onOpen(record, 'models');
              else if (key === 'edit') actions.onOpen(record, 'configuration');
              else if (key === 'clear-cooldown') actions.onClearCooldown(record);
              else if (key === 'siwc') actions.onOpenSIWC(record);
              else if (key === 'download') actions.onDownload(record);
              else if (key === 'delete') {
                modal.confirm({
                  title: t('af.delete_one_title'),
                  content: file.name,
                  okText: t('common.delete'),
                  cancelText: t('common.cancel'),
                  okButtonProps: { danger: true },
                  onOk: () => actions.onDelete(record),
                });
              }
            },
          }}
        >
          <Tooltip title={t('keys.actions_more')}>
            <Button type="text" size="small" icon={<MoreOutlined />} aria-label={`${t('keys.actions_more')}: ${file.name}`} />
          </Tooltip>
        </Dropdown>
      </td>
    </tr>
  );
}

/**
 * One reading: the share left, its bar, and - only while the window is not full - when it resets.
 * A full window has nothing to wait for. The window's own label, exact reset instant and capacity
 * estimate are its tooltip.
 */
interface QuotaCellProps {
  columnKey: string;
  /** The column's name, printed over the reading only on a phone, where the header is not shown. */
  phoneLabel: string;
  window?: QuotaWindow;
  /** The reading left alone on a phone card's last line, which takes the line's full width. */
  isPhoneWide: boolean;
  isFirstOfFamily: boolean;
  isStale: boolean;
  nowMS: number;
}

function QuotaCell({ columnKey, phoneLabel, window, isPhoneWide, isFirstOfFamily, isStale, nowMS }: QuotaCellProps) {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  if (!window) {
    return (
      <td className={clsx(styles['td-quota'], styles['td-quota-missing'], isFirstOfFamily && styles['td-divided'])} data-quota-column={columnKey} data-quota-missing="true">
        <span className={styles.missing}>—</span>
      </td>
    );
  }
  const remaining = quotaRemainingPercent(window);
  const reset = remaining != null && remaining < 100 ? quotaResetCountdown(window, nowMS, t) : '';
  const capacity = describeCompactQuotaCapacity(window, tokenStyle, t);
  const detail = [window.label, quotaResetText(window, nowMS, t), capacity].filter(Boolean).join('\n');
  return (
    <td
      className={clsx(styles['td-quota'], isFirstOfFamily && styles['td-divided'], isStale && styles['quota-stale'], isPhoneWide && styles['phone-wide'])}
      data-quota-column={columnKey}
      data-quota-window-label={window.label}
      title={detail}
    >
      <div className={styles['quota-reading']}>
        <span className={styles['phone-label']}>{phoneLabel}</span>
        <span className={styles['quota-value']} style={remaining != null && remaining < 70 ? { color: quotaRemainingStroke(remaining) } : undefined}>
          {quotaRemainingText(window)}
        </span>
        {reset && <span className={styles['quota-reset']}>{reset}</span>}
        <Meter className={styles['quota-meter']} value={remaining ?? 0} color={quotaRemainingStroke(remaining)} label={remaining == null ? undefined : window.label} />
      </div>
    </td>
  );
}
