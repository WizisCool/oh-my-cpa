import { CredentialRenewalBadge } from '../../components/authFiles/CredentialRenewalBadge';
import { renewalLabel } from '../../components/authFiles/credentialRecovery';
import { formatGatewayTimestamp } from '../../utils/time';
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
  NoteOutlined,
  ProfileOutlined,
  RenameOutlined,
  CheckOutlined,
  PlusOutlined,
  RollbackOutlined,
  StopOutlined,
  SyncOutlined,
  TimerResetOutlined,
  WarningOutlined,
} from '../../components/icons';
import { getCredentialProviderMetadata } from '../../types/providerMetadata';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { CredentialMark } from '../../components/LobeIcon';
import { PriorityBadge } from '../../components/common/PriorityBadge';
import { StatusLabel } from '../../components/common/StatusLabel';
import { Tag } from '../../components/common/Tag';
import { Meter } from '../../components/common/Meter';
import { useT, type TFunc } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import {
  deriveAuthFileIdentity,
  hasAuthFileStatusWarning,
  isAuthFileDisabled,
  isAuthFileProblem,
  summarizeAuthFileStatusMessage,
} from '../../components/authFiles/authFileLogic';
import { SIWC_BADGE_LABEL_KEYS, type SIWCBadgeState } from '../../components/authFiles/siwcBadge';
import { formatObservedAgo, quotaRemainingPercent, quotaRemainingText, quotaResetCountdown, quotaResetText } from '../quota/quotaFormat';
import { quotaRemainingStroke } from '../quota/quotaThresholds';
import { quotaWindowKindOf } from '../quota/quotaWindowSelection';
import { compactQuotaCapacity, describeCompactQuotaCapacity } from '../quota/quotaCapacity';
import { outlivedResetLine, refreshFailureLine } from '../quota/quotaAttempt';
import { describeQuotaCooldown } from '../quota/quotaCooldown';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import type { OAuthWorkspaceRecord } from './oauthWorkspaceLogic';
import {
  credentialStatusOf,
  packQuotaLines,
  quotaLinesOf,
  type CredentialSection as Section,
  type QuotaColumnSort,
  type QuotaLine,
  type QuotaLineCell,
  type QuotaPeriod,
} from './credentialSections';
import { maskAccount } from '../../utils/maskAccount';
import styles from './CredentialSection.module.css';
import { Tooltip } from '../../components/common/Tooltip';
import { InlineNameEditor, inlineNameEditableClass, RenameButton } from '../../components/common/InlineName';
import { ReorderHandle, RowReorder, useReorderList, useReorderRow } from '../../components/common/RowReorder';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import type { DropSide } from '../../types/displayOrder';


/**
 * Each SIWC state's glyph on the status column's SIWC line. The line always spells its state out
 * ("SIWC off", "SIWC not bound"), so its presence never reads as "on"; the glyph and the tone back
 * the words up rather than replace them.
 */
const SIWC_STATE_GLYPHS: Record<SIWCBadgeState, React.ReactNode> = {
  active: <CheckOutlined aria-hidden />,
  rebind: <WarningOutlined aria-hidden />,
  pending: <SyncOutlined spin aria-hidden />,
  off: <StopOutlined aria-hidden />,
  bind: <PlusOutlined aria-hidden />,
};

export interface CredentialRowActions {
  isBusy: (record: OAuthWorkspaceRecord) => boolean;
  isRefreshingQuota: (record: OAuthWorkspaceRecord) => boolean;
  siwcBadge: (record: OAuthWorkspaceRecord) => SIWCBadgeState | undefined;
  onSelect: (records: OAuthWorkspaceRecord[], isSelected: boolean) => void;
  onToggle: (record: OAuthWorkspaceRecord) => void;
  onDownload: (record: OAuthWorkspaceRecord) => void;
  onDelete: (record: OAuthWorkspaceRecord) => void;
  onOpen: (record: OAuthWorkspaceRecord, section: 'overview' | 'renewal' | 'configuration' | 'models') => void;
  /** Saves the credential's own name; resolves false when it was not saved. */
  onRename: (record: OAuthWorkspaceRecord, displayName: string) => Promise<boolean>;
  onRefreshQuota: (record: OAuthWorkspaceRecord) => void;
  onClearCooldown: (record: OAuthWorkspaceRecord) => void;
  onReauthenticate: (record: OAuthWorkspaceRecord) => void;
  onOpenSIWC: (record: OAuthWorkspaceRecord) => void;
}

interface CredentialSectionProps {
  section: Section;
  /** The provider's display name, for plugin providers whose name the console does not know. */
  title?: string;
  pluginLogos?: PluginOAuthLogos;
  selectedKeys: Set<string>;
  nowMS: number;
  actions: CredentialRowActions;
  columnSort?: QuotaColumnSort;
  onSort: (key: string) => void;
  /**
   * Puts a dragged credential beside another in this section's display order; absent where rows
   * cannot be rearranged (a phone, or before the stored order has been read).
   */
  onReorder?: (record: OAuthWorkspaceRecord, target: OAuthWorkspaceRecord, side: DropSide) => unknown;
}

const PERIOD_KEYS: Record<QuotaPeriod, MessageKey> = {
  five_hour: 'quota.slot_five_hour', daily: 'quota.slot_daily', weekly: 'quota.slot_weekly', monthly: 'quota.slot_monthly',
};

function lineTitle(line: QuotaLine, t: TFunc): string {
  if (line.label) return line.label;
  return t(line.scope === 'code_review' ? 'omc.quota_family_code_review' : 'omc.quota_family_plan');
}

function cellPeriodTitle(cell: QuotaLineCell, t: TFunc): string | undefined {
  const kind = quotaWindowKindOf(cell.window);
  return kind === 'five_hour' || kind === 'daily' || kind === 'weekly' || kind === 'monthly' ? t(PERIOD_KEYS[kind]) : undefined;
}

/** The plan's limits are named by their period; any other by its period and name, or its name alone. */
function readingName(line: QuotaLine, cell: QuotaLineCell, t: TFunc): string {
  const period = cellPeriodTitle(cell, t);
  if (line.scope === 'standard' && !line.label) return period ?? cell.window.label;
  return period ? t('omc.quota_reading_name', { family: lineTitle(line, t), period }) : lineTitle(line, t);
}

/**
 * One provider's credentials as one table.
 *
 * The section header names the provider once, so rows carry no provider mark; the quota header names
 * each model group once, so a quota cell is only the share left, its bar, and when it resets. A
 * column's header sorts the section by that reading, which is how an operator with many accounts
 * finds the one with the most Claude quota left without opening anything.
 */
export function CredentialSection({ section, title, pluginLogos, selectedKeys, nowMS, actions, columnSort, onSort, onReorder }: CredentialSectionProps) {
  const t = useT();
  const metadata = getCredentialProviderMetadata(section.provider);
  const records = section.records;
  const selectable = section.records.filter((record) => record.canSelectForFileBatch);
  const selectedCount = selectable.filter((record) => selectedKeys.has(record.key)).length;
  const { hasQuota } = section;

  const isSorted = columnSort?.key === 'quota';
  // A quota sort is an order the operator did not arrange, so the handles step aside while it holds.
  const canReorder = Boolean(onReorder);
  const byKey = React.useMemo(() => new Map(section.visibleRecords.map((record) => [record.key, record])), [section.visibleRecords]);
  const write = (key: string, targetKey: string, side: DropSide) => {
    const record = byKey.get(key);
    const target = byKey.get(targetKey);
    return record && target ? onReorder?.(record, target, side) : undefined;
  };
  const reorder = useReorderList(records, recordKey, write);
  const rowKeys = React.useMemo(() => reorder.ordered.map(recordKey), [reorder.ordered]);
  // A keyboard step moves past the neighbour the operator can see, not one a filter hides; past the
  // page's edge it lands on the next page, so there is nothing on this one to hold.
  const step = (key: string, direction: -1 | 1) => {
    const index = section.visibleRecords.findIndex((record) => record.key === key);
    const neighbour = section.visibleRecords[index + direction];
    if (index < 0 || !neighbour) return;
    const side = direction < 0 ? 'before' : 'after';
    if (rowKeys.includes(neighbour.key)) reorder.move(key, neighbour.key, side);
    else void write(key, neighbour.key, side);
  };
  return (
    <section className={styles.section} data-testid="oauth-credential-section" data-provider={section.provider}>
      <header className={styles.head}>
        <div className={styles['head-info']}>
          <span className={styles['head-icon']}>
            <CredentialMark credential={{ provider: section.provider }} pluginLogos={pluginLogos} size={18} />
          </span>
          <h2 className={styles['head-title']}>{title ?? metadata.label}</h2>
          <Tag size="small">{t('omc.section_count', { n: section.records.length })}</Tag>
        </div>
        {selectable.length > 0 && (
          <div className={styles['head-mobile-select']}>
            <Checkbox
              checked={selectable.length > 0 && selectedCount === selectable.length}
              indeterminate={selectedCount > 0 && selectedCount < selectable.length}
              onChange={(event) => actions.onSelect(selectable, event.target.checked)}
              aria-label={t('omc.section_select', { provider: title ?? metadata.label })}
            >
              <span className={styles['head-mobile-select-label']}>
                {selectedCount > 0 ? `${selectedCount}/${selectable.length}` : t('pro.select_all')}
              </span>
            </Checkbox>
          </div>
        )}
      </header>
      {/* Outside the table: the drag context draws its own accessible text, which a table may not hold. */}
      <RowReorder items={rowKeys} isEnabled={canReorder && !isSorted} onMove={reorder.move} onStep={step}>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <colgroup>
              <col className={styles['col-identity']} />
              <col className={styles['col-status']} />
              <col className={styles['col-switch']} />
              {hasQuota && <><col /><col /></>}
              {!hasQuota && <col />}
              <col className={styles['col-actions']} />
            </colgroup>
            <thead>
              <tr>
                <th className={styles['th-identity']}>
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
                <th>{t('af.detail_status')}</th>
                <th>{t('pro.col_switch')}</th>
                {hasQuota && (
                  // Every reading names itself, so the two columns share one header; it sorts by the
                  // share left in each credential's tightest limit.
                  <th colSpan={2} className={styles['th-period']} aria-sort={isSorted ? (columnSort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <button type="button" className={styles['sort-button']} onClick={() => onSort('quota')}>
                      <span className={styles['sort-label']}>{t('omc.section_quota')}</span>
                      {isSorted && (columnSort.direction === 'asc' ? <ArrowUpOutlined /> : <ArrowDownOutlined />)}
                    </button>
                  </th>
                )}
                {!hasQuota && <th aria-hidden="true" />}
                <th className={styles['th-actions']}><span className="sr-only">{t('keys.col_actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {reorder.ordered.map((record) => (
                <CredentialRow
                  key={record.key}
                  record={record}
                  provider={section.provider}
                  hasQuota={hasQuota}
                  hasHandle={canReorder}
                  isSelected={selectedKeys.has(record.key)}
                  nowMS={nowMS}
                  actions={actions}
                />
              ))}
            </tbody>
          </table>
        </div>
      </RowReorder>
    </section>
  );
}

/**
 * What the row's headline says before the operator reveals the account: the operator's own name, or
 * the masked account, or the file's identity. The drag chip and the handle's label repeat it, so
 * neither publishes an address the row keeps masked.
 */
function maskedCredentialLabel(record: OAuthWorkspaceRecord): string {
  const displayName = record.file.display_name?.trim();
  if (displayName) return displayName;
  const identity = deriveAuthFileIdentity(record.file);
  return identity.isAccountPrimary ? maskAccount(identity.primary) : identity.primary;
}

const recordKey = (record: OAuthWorkspaceRecord) => record.key;

interface CredentialRowProps {
  record: OAuthWorkspaceRecord;
  provider: string;
  /** Whether the section has quota columns at all. */
  hasQuota: boolean;
  /** Whether the row draws a drag handle; it may still be hidden while a quota sort holds. */
  hasHandle: boolean;
  isSelected: boolean;
  nowMS: number;
  actions: CredentialRowActions;
}

function CredentialRow({ record, provider, hasQuota, hasHandle, isSelected, nowMS, actions }: CredentialRowProps) {
  const t = useT();
  const { modal } = AntdApp.useApp();
  const isDemo = isDemoMode();
  const { file, quota } = record;
  const identity = deriveAuthFileIdentity(file);
  // Who an account belongs to is masked until the operator asks, so a screen share or a screenshot of
  // the list does not publish every address; the reveal is per row and lasts until clicked again.
  const [isRevealed, setIsRevealed] = React.useState(false);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const account = identity.isAccountPrimary ? identity.primary : '';
  const shownAccount = account && !isRevealed ? maskAccount(account) : account;
  // The operator's own name leads the row; the account it stands for drops to the line under it,
  // where it keeps its mask and its reveal.
  const displayName = file.display_name?.trim() ?? '';
  const canRename = !file.runtime_only && record.hasUniqueFileName;
  const accountToggle = account ? (
    <button
      type="button"
      className={displayName ? clsx(styles['meta-account'], styles['primary-toggle']) : clsx(styles.primary, styles['primary-toggle'])}
      onClick={() => setIsRevealed((value) => !value)}
      aria-pressed={isRevealed}
      title={t(isRevealed ? 'omc.account_hide' : 'omc.account_reveal')}
      data-account-masked={isRevealed ? undefined : 'true'}
    >
      {shownAccount}
    </button>
  ) : null;
  const isDisabled = isAuthFileDisabled(file);
  const status = credentialStatusOf(record, isDisabled, isAuthFileProblem(file));
  const isBusy = actions.isBusy(record);
  const isRefreshing = actions.isRefreshingQuota(record);
  const lines = quotaLinesOf(record, provider);
  const siwc = actions.siwcBadge(record);
  const isStale = record.quotaCondition === 'stale' || record.quotaCondition === 'error';
  const warning = hasAuthFileStatusWarning(file) && file.status_message ? file.status_message : undefined;
  // A failed refresh leaves the last good reading standing, possibly under a status that still says
  // Normal; the row has to say so, or whoever opens the page later trusts numbers nobody has.
  const failure = quota ? refreshFailureLine(quota, nowMS, t) : null;
  const explanation = failure
    ?? (quota ? outlivedResetLine(quota, t) : null)
    ?? (record.quotaCondition === 'cooldown' ? describeQuotaCooldown(quota?.active_cooldown?.reason, t('quota.cooldown_active_desc')) : null);
  const needsRefresh = (status.canRefreshFix || Boolean(failure)) && record.canRefreshQuota;
  const credits = quota?.reset_credits?.available_count ?? 0;

  const reorder = useReorderRow(record.key);
  // The grip leads the row on a wide screen; a card keeps its name over its state line, so there the
  // grip closes the glyph strip at the card's edge, where a phone list keeps its reorder control.
  const isPhone = useIsPhoneViewport();
  const handle = <ReorderHandle {...reorder.handle} name={maskedCredentialLabel(record)} variant={isPhone ? 'inline' : 'edge'} />;

  return (
    <tr
      {...reorder.row}
      className={clsx(styles.row, isSelected && styles['row-selected'], isDisabled && styles['row-disabled'])}
      data-testid="oauth-credential-record"
      data-identity={record.key}
      data-file-name={file.name}
      data-auth-index={file.auth_index ?? ''}
      data-quota-focus-anchor={quota ? record.authIndex : undefined}
    >
      <td className={styles['td-identity']}>
        {hasHandle && !isPhone && handle}
        <div className={styles.identity}>
          {!file.runtime_only ? (
            <Checkbox
              checked={isSelected}
              disabled={isBusy || !record.canSelectForFileBatch}
              onChange={(event) => actions.onSelect([record], event.target.checked)}
              aria-label={t('af.select_one', { name: file.name })}
            />
          ) : <span className={styles['checkbox-space']} />}
          <div className={clsx(styles['identity-copy'], canRename && inlineNameEditableClass)}>
              {canRename && !isRenaming && (
                <RenameButton label={file.name} disabled={isBusy} onClick={() => setIsRenaming(true)} data-testid="oauth-credential-rename" />
              )}
            <div className={styles['identity-line']}>
              <div className={clsx(styles['name-group'], !isRenaming && !displayName && styles['name-group-fluid'])}>
                {isRenaming ? (
                  <InlineNameEditor
                    initial={displayName}
                    label={`${t('af.field_display_name')}: ${file.name}`}
                    placeholder={t('af.display_name_placeholder')}
                    data-testid="oauth-credential-name-input"
                    onCommit={async (next) => {
                      const isSaved = await actions.onRename(record, next);
                      if (isSaved) setIsRenaming(false);
                      return isSaved;
                    }}
                    onCancel={() => setIsRenaming(false)}
                  />
                ) : displayName ? (
                  <span className={clsx(styles.primary, styles['primary-name'])} title={displayName} data-credential-display-name="true">{displayName}</span>
                ) : accountToggle ?? <span className={styles.primary} title={identity.primary}>{identity.primary}</span>}
              </div>
              {file.note && (
                <Tooltip title={<span className={styles['note-tip']}>{file.note}</span>}>
                  <span className={styles.note} tabIndex={0} role="img" aria-label={`${t('af.field_note')}: ${file.note}`} data-credential-note="true">
                    <NoteOutlined />
                  </span>
                </Tooltip>
              )}
              {quota?.plan?.plan_label && <span className={styles.plan}>{quota.plan.plan_label}</span>}
              <PriorityBadge priority={file.priority} weight={file.weight} />
              {quota?.plan?.subscription_active === false && (
                <span className={clsx(styles.plan, styles['plan-inactive'])} data-subscription-inactive="true">{t('quota.subscription_inactive')}</span>
              )}
              {(warning || !record.hasUniqueFileName) && (
                <Tooltip title={warning ? summarizeAuthFileStatusMessage(warning) : t('omc.duplicate_file_identity', { name: record.fileName })}>
                  <WarningOutlined className={styles.warning} data-testid="oauth-credential-warning" aria-label={warning ?? t('omc.duplicate_file_identity', { name: record.fileName })} />
                </Tooltip>
              )}
            </div>
            {displayName && accountToggle && <div className={styles['account-line']}>{accountToggle}</div>}
            {/* Banked resets are a tag under the name rather than a column, so a Codex section's quota
                tracks start and end where every other provider's do. */}
            {credits > 0 && (
              <div className={styles['identity-tags']}>
                <Tooltip title={t('omc.quota_credit_available_hint')}>
                  <button
                    type="button"
                    className={styles.tag}
                    data-quota-credits={credits}
                    onClick={() => actions.onOpen(record, 'overview')}
                    aria-label={`${t('omc.reset_credits_count', { n: credits })}: ${file.name}`}
                  >
                    <RollbackOutlined aria-hidden="true" />
                    {t('omc.reset_credits_count', { n: credits })}
                  </button>
                </Tooltip>
              </div>
            )}
          </div>
        </div>
      </td>
      <td className={styles['td-status']} data-testid="oauth-credential-status" data-credential-renewal>
        <div className={styles['status-cell']}>
          <div className={styles['status-main']}>
            <Tooltip title={<>
              {status.needsReauth && <div>{t('omc.reauthenticate')}</div>}
              {explanation && <div>{explanation}</div>}
              <div>{t('recovery.renewal')}: {t(renewalLabel(file))}</div>
              {file.access_token_expires_at && <div>{t('recovery.expires_at', { time: formatGatewayTimestamp(file.access_token_expires_at) })}</div>}
              {file.next_refresh_after && <div>{t('recovery.next_refresh')}: {formatGatewayTimestamp(file.next_refresh_after)}</div>}
              {file.refresh_error && (
                <div>
                  {t('recovery.refresh_error')}: {[file.refresh_error.code, file.refresh_error.http_status].filter(Boolean).join(' · ')}
                </div>
              )}
              {quota?.observed_at_ms ? <div>{formatObservedAgo(quota.observed_at_ms, nowMS, t)}</div> : null}
            </>}>
              {/* A state that asks for a sign-in is itself the link to it, so the action costs the
                  cell no line of its own. */}
              {status.needsReauth ? (
                <button
                  type="button"
                  className={styles['status-reauth']}
                  onClick={() => actions.onReauthenticate(record)}
                  aria-label={`${t('omc.reauthenticate')}: ${t(status.labelKey)}`}
                  data-status-explained={explanation ? 'true' : undefined}
                >
                  <StatusLabel tone={status.tone}>{t(status.labelKey)}</StatusLabel>
                </button>
              ) : (
                <StatusLabel tone={status.tone} tabIndex={0} data-status-explained={explanation ? 'true' : undefined}>{t(status.labelKey)}</StatusLabel>
              )}
            </Tooltip>
            <CredentialRenewalBadge
              file={file}
              onOpen={() => actions.onOpen(record, 'renewal')}
            />
            {/* On the state's line, so the cell never runs past the state and the SIWC line. */}
            {failure && !status.needsReauth && (
              <span className={styles['status-failed']} title={failure} data-quota-failure-line="failed">{t('omc.status_refresh_failed')}</span>
            )}
          </div>
          {/* SIWC is a state of the account, so it reads with the status: a quiet line under it that
              names its state in words and opens the SIWC settings. */}
          {siwc && (
            <button
              type="button"
              className={clsx(styles['status-siwc'], styles[`status-siwc-${siwc}`])}
              data-siwc-badge={siwc}
              onClick={() => actions.onOpenSIWC(record)}
              aria-label={t('siwc.badge_aria', { name: file.name })}
            >
              {SIWC_STATE_GLYPHS[siwc]}
              <span className={styles['status-siwc-label']}>{t('siwc.status_line', { state: t(SIWC_BADGE_LABEL_KEYS[siwc]) })}</span>
            </button>
          )}
        </div>
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
      {hasQuota && (
        <td colSpan={2} className={styles['td-quota']}>
          <QuotaLines lines={lines} provider={record.displayProvider} isStale={isStale || isDisabled} nowMS={nowMS} />
        </td>
      )}
      {!hasQuota && <td className={styles['td-filler']} aria-hidden="true" />}
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
        <Tooltip title={t('common.edit')}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            disabled={isBusy || !record.canSelectForFileBatch}
            onClick={() => actions.onOpen(record, 'configuration')}
            aria-label={`${t('common.edit')}: ${file.name}`}
            data-testid="oauth-credential-edit"
          />
        </Tooltip>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'models', icon: <AppstoreOutlined />, label: t('af.models_btn'), disabled: isBusy || file.runtime_only },
              { key: 'rename', icon: <RenameOutlined />, label: t('af.rename'), disabled: isBusy || !canRename },
              { key: 'edit', icon: <EditOutlined />, label: t('common.edit'), disabled: isBusy || !record.canSelectForFileBatch },
              { key: 'clear-cooldown', icon: <TimerResetOutlined />, label: t('quota.clear_cooldown'), disabled: isBusy || isDemo || !record.canClearCooldown },
              ...(siwc ? [{ key: 'siwc', icon: <LinkOutlined />, label: t('siwc.menu'), disabled: isBusy }] : []),
              { type: 'divider' as const },
              { key: 'download', icon: <DownloadOutlined />, label: t('af.download_credential'), disabled: isBusy || file.runtime_only || isDemo || !record.canSelectForFileBatch },
              { key: 'delete', icon: <DeleteOutlined />, label: t('af.delete_credential'), danger: true, disabled: isBusy || file.runtime_only || isDemo || !record.canSelectForFileBatch },
            ],
            onClick: ({ key }) => {
              if (key === 'models') actions.onOpen(record, 'models');
              else if (key === 'rename') setIsRenaming(true);
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
        {hasHandle && isPhone && handle}
      </td>
    </tr>
  );
}

/**
 * A credential's limits across the section's two columns: the first line's short limit under
 * "5 hours" and its long one under "Weekly", further limits two to a line, and a limit left alone
 * across both. The readings share one grid whose tracks are the two columns the cell spans, so
 * every reading stands under its header and under the reading above it.
 */
function QuotaLines({ lines, provider, isStale, nowMS }: {
  lines: QuotaLine[];
  provider: string;
  isStale: boolean;
  nowMS: number;
}) {
  const t = useT();
  if (lines.length === 0) {
    return <div className={styles['quota-lines']} data-quota-missing="true"><span className={styles.missing}>—</span></div>;
  }
  return (
    <div className={styles['quota-lines']}>
      {packQuotaLines(lines).map(({ line, cell }) => (
        <QuotaReading
          key={cell.key}
          cell={cell}
          // Every reading names itself, so "5 hours Gemini" and "Weekly Gemini 4 Argon" cannot be
          // mistaken for each other without a header to read them by.
          name={readingName(line, cell, t)}
          provider={provider}
          isStale={isStale}
          nowMS={nowMS}
        />
      ))}
    </div>
  );
}

/**
 * One reading: its name and the share left, the bar, then the window's estimated size and when it
 * resets. Explicitly unused, full Codex five-hour readings show the window duration; rounded or
 * unknown usage keeps a countdown. The window's label, reset instant, accuracy and the estimate's
 * basis remain in its tooltip.
 */
function QuotaReading({ cell, name, provider, isStale, nowMS }: {
  cell: QuotaLineCell;
  name: string;
  provider: string;
  isStale: boolean;
  nowMS: number;
}) {
  const t = useT();
  const { style: tokenStyle } = useTokenDisplayStyle();
  const { window } = cell;
  const remaining = quotaRemainingPercent(window);
  // Use the unrounded upstream reading: a displayed 100% alone does not prove zero usage.
  // Show the unused window's duration, independent of its moving reset estimate. The tooltip
  // preserves that estimate; zero usage does not prove whether the upstream window has started.
  const isUnusedFullCodexWindow = provider === 'codex'
    && window.scope === 'standard'
    && quotaWindowKindOf(window) === 'five_hour'
    && window.used_percent === 0
    && (window.remaining_percent ?? 100) === 100;
  const reset = isUnusedFullCodexWindow ? t('quota.duration_hours', { n: 5 }) : quotaResetCountdown(window, nowMS, t);
  // A plugin window has no estimate; its own words for what is left take the estimate's place.
  const estimate = compactQuotaCapacity(window, tokenStyle, t) ?? window.description;
  const capacity = describeCompactQuotaCapacity(window, tokenStyle, t);
  const detail = [window.label, window.description, quotaResetText(window, nowMS, t), capacity].filter(Boolean);
  return (
    <div
      className={clsx(
        styles['quota-cell'],
        cell.spans ? styles['slot-span'] : cell.slot === 'long' ? styles['slot-long'] : styles['slot-short'],
        isStale && styles['quota-stale'],
      )}
      data-quota-column={cell.key}
      data-quota-window-label={window.label}
      data-quota-spans={cell.spans ? 'true' : undefined}
    >
      {/* A reading is plain text, so the shared hint answers touch and keyboard focus without
          turning quota inspection into an action or relying on a hover-only native title. */}
      <Tooltip
        classNames={{ root: styles['quota-tip-popper'] }}
        title={<div className={styles['quota-tip']}>{detail.map((line) => <div key={line}>{line}</div>)}</div>}
      >
        <div className={styles['quota-reading']} role="group" aria-label={window.label} tabIndex={0}>
          <Tag size="small" className={styles['quota-name']} title={name}>{name}</Tag>
          <span className={styles['quota-value']}>
            <span className={styles['quota-value-prefix']}>{t('omc.quota_remaining_prefix')}</span>
            <b style={remaining != null && remaining < 70 ? { color: quotaRemainingStroke(remaining) } : undefined}>{quotaRemainingText(window)}</b>
          </span>
          <Meter className={styles['quota-meter']} value={remaining ?? 0} color={quotaRemainingStroke(remaining)} label={remaining == null ? undefined : window.label} />
          {estimate && <span className={styles['quota-estimate']}>{estimate}</span>}
          {reset && <span className={styles['quota-reset']}>{reset}</span>}
        </div>
      </Tooltip>
    </div>
  );
}
