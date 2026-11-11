import React from 'react';
import clsx from 'clsx';
import { App as AntdApp, Dropdown } from 'antd';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { MenuProps } from 'antd';
import { CredentialRenewalBadge } from '../../components/authFiles/CredentialRenewalBadge';
import { renewalLabel } from '../../components/authFiles/credentialRecovery';
import {
  deriveAuthFileIdentity,
  hasAuthFileStatusWarning,
  isAuthFileDisabled,
  isAuthFileProblem,
  summarizeAuthFileStatusMessage,
} from '../../components/authFiles/authFileLogic';
import { SIWC_BADGE_LABEL_KEYS, type SIWCBadgeState } from '../../components/authFiles/siwcBadge';
import { InlineNameEditor, RenameButton, inlineNameEditableClass } from '../../components/common/InlineName';
import { PriorityBadge } from '../../components/common/PriorityBadge';
import { StatusLabel } from '../../components/common/StatusLabel';
import { Tooltip } from '../../components/common/Tooltip';
import {
  AppstoreOutlined,
  CheckOutlined,
  CheckSquareOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  LinkOutlined,
  LoginOutlined,
  MoreOutlined,
  NoteOutlined,
  PlusOutlined,
  ProfileOutlined,
  RenameOutlined,
  RollbackOutlined,
  StopOutlined,
  SyncOutlined,
  TimerResetOutlined,
  WarningOutlined,
} from '../../components/icons';
import { useT, type TFunc } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { maskAccount } from '../../utils/maskAccount';
import { formatGatewayTimestamp } from '../../utils/time';
import { formatObservedAgo } from '../quota/quotaFormat';
import { Switch } from '../../components/common/Switch';
import { Tag } from '../../components/common/Tag';
import { outlivedResetLine, refreshFailureLine } from '../quota/quotaAttempt';
import { describeQuotaCooldown } from '../quota/quotaCooldown';
import { isRangeCheckboxClick } from '../../types/rowSelection';
import { credentialStatusOf, quotaLinesOf, type CredentialStatus, type QuotaLine } from './credentialSections';
import type { OAuthWorkspaceRecord } from './oauthWorkspaceLogic';
import styles from './CredentialParts.module.css';

export type DetailSection = 'overview' | 'renewal' | 'configuration' | 'models';

/** Everything the workspace can do to one credential, wired once by the page for both views. */
export interface CredentialActions {
  isBusy: (record: OAuthWorkspaceRecord) => boolean;
  isRefreshingQuota: (record: OAuthWorkspaceRecord) => boolean;
  siwcBadge: (record: OAuthWorkspaceRecord) => SIWCBadgeState | undefined;
  onSelect: (records: OAuthWorkspaceRecord[], isSelected: boolean) => void;
  /** Picks one credential, or with `isRange` the run from the last one picked to it. */
  onPick: (record: OAuthWorkspaceRecord, isRange: boolean) => void;
  onToggle: (record: OAuthWorkspaceRecord) => void;
  onDownload: (record: OAuthWorkspaceRecord) => void;
  onDelete: (record: OAuthWorkspaceRecord) => void;
  onOpen: (record: OAuthWorkspaceRecord, section: DetailSection) => void;
  /** Saves the credential's own name; resolves false when it was not saved. */
  onRename: (record: OAuthWorkspaceRecord, displayName: string) => Promise<boolean>;
  onRefreshQuota: (record: OAuthWorkspaceRecord) => void;
  onClearCooldown: (record: OAuthWorkspaceRecord) => void;
  onRedeemCredit: (record: OAuthWorkspaceRecord) => void;
  onReauthenticate: (record: OAuthWorkspaceRecord) => void;
  onOpenSIWC: (record: OAuthWorkspaceRecord) => void;
}

/**
 * What both views say about a credential, derived once: its name and account, its one state and
 * why, its limits, and which actions it can take now.
 */
export interface CredentialFacts {
  displayName: string;
  account: string;
  /** The headline before the account is revealed: the operator's name, the masked account, or the file. */
  headline: string;
  isDisabled: boolean;
  status: CredentialStatus;
  /** Why the state is what it is, when the state alone does not say. */
  explanation: string | null;
  failure: string | null;
  warning?: string;
  /** The credential's limits, a family to a line, as the quota tracks draw them. */
  quotaLines: QuotaLine[];
  siwc?: SIWCBadgeState;
  credits: number;
  canRename: boolean;
  isBusy: boolean;
  isRefreshing: boolean;
  /** The reading is out of date or failed, and a refresh is the operator's fix. */
  needsRefresh: boolean;
  /** Stale and disabled readings are drawn faded: the numbers are not being acted on. */
  isQuotaMuted: boolean;
}

export function credentialFacts(record: OAuthWorkspaceRecord, actions: CredentialActions, nowMS: number, t: TFunc): CredentialFacts {
  const { file, quota } = record;
  const identity = deriveAuthFileIdentity(file);
  const account = identity.isAccountPrimary ? identity.primary : '';
  const displayName = file.display_name?.trim() ?? '';
  const isDisabled = isAuthFileDisabled(file);
  const status = credentialStatusOf(record, isDisabled, isAuthFileProblem(file));
  // A failed refresh leaves the last good reading standing, possibly under a status that still says
  // Normal; the credential has to say so, or whoever opens the page later trusts numbers nobody has.
  const failure = quota ? refreshFailureLine(quota, nowMS, t) : null;
  const explanation = failure
    ?? (quota ? outlivedResetLine(quota, t) : null)
    ?? (record.quotaCondition === 'cooldown' ? describeQuotaCooldown(quota?.active_cooldown?.reason, t('quota.cooldown_active_desc')) : null);
  return {
    displayName,
    account,
    headline: displayName || (account ? maskAccount(account) : identity.primary),
    isDisabled,
    status,
    explanation,
    failure,
    warning: hasAuthFileStatusWarning(file) && file.status_message ? file.status_message : undefined,
    quotaLines: quotaLinesOf(record),
    siwc: actions.siwcBadge(record),
    credits: quota?.reset_credits?.available_count ?? 0,
    canRename: !file.runtime_only && record.hasUniqueFileName,
    isBusy: actions.isBusy(record),
    isRefreshing: actions.isRefreshingQuota(record),
    needsRefresh: (status.canRefreshFix || Boolean(failure)) && record.canRefreshQuota,
    isQuotaMuted: isDisabled || record.quotaCondition === 'stale' || record.quotaCondition === 'error',
  };
}

export function SelectBox({ record, isSelected, isBusy, actions }: {
  record: OAuthWorkspaceRecord;
  isSelected: boolean;
  isBusy: boolean;
  actions: CredentialActions;
}) {
  const t = useT();
  if (record.file.runtime_only) return <span className={styles['select-space']} />;
  return (
    <Checkbox
      checked={isSelected}
      disabled={isBusy || !record.canSelectForFileBatch}
      onCheckedChange={(_checked, details) => actions.onPick(record, isRangeCheckboxClick(details.event as MouseEvent))}
      onClick={(event) => event.stopPropagation()}
      aria-label={t('af.select_one', { name: record.file.name })}
    />
  );
}

/**
 * The credential's name: the operator's own when there is one, with the account it stands for on the
 * line under it, masked until asked for. A rename edits the name where it stands.
 */
export function CredentialName({ record, facts, isRenaming, onRename, onRenamed, actions, size = 'default' }: {
  record: OAuthWorkspaceRecord;
  facts: CredentialFacts;
  isRenaming: boolean;
  onRename: () => void;
  onRenamed: () => void;
  actions: CredentialActions;
  size?: 'default' | 'large';
}) {
  const t = useT();
  const { file } = record;
  // The account stays masked in the list; a click on it opens the credential, whose details show it whole.
  const accountToggle = facts.account ? (
    <span className={facts.displayName ? styles.account : styles.primary}>{maskAccount(facts.account)}</span>
  ) : null;
  return (
    <div className={clsx(styles.name, size === 'large' && styles['name-large'], facts.canRename && inlineNameEditableClass)}>
      {facts.canRename && !isRenaming && (
        <RenameButton label={file.name} disabled={facts.isBusy} onClick={onRename} data-testid="oauth-credential-rename" />
      )}
      <div className={styles['name-line']}>
        {isRenaming ? (
          <InlineNameEditor
            initial={facts.displayName}
            label={`${t('af.field_display_name')}: ${file.name}`}
            placeholder={t('af.display_name_placeholder')}
            data-testid="oauth-credential-name-input"
            onCommit={async (next) => {
              const isSaved = await actions.onRename(record, next);
              if (isSaved) onRenamed();
              return isSaved;
            }}
            onCancel={onRenamed}
          />
        ) : facts.displayName ? (
          <span className={styles.primary} title={facts.displayName} data-credential-display-name="true">{facts.displayName}</span>
        ) : accountToggle ?? <span className={styles.primary} title={file.name}>{facts.headline}</span>}
        {file.note && !isRenaming && (
          <Tooltip title={<span className={styles['note-tip']}>{file.note}</span>}>
            <span className={styles.note} tabIndex={0} role="img" aria-label={`${t('af.field_note')}: ${file.note}`} data-credential-note="true">
              <NoteOutlined />
            </span>
          </Tooltip>
        )}
        {(facts.warning || !record.hasUniqueFileName) && (
          <Tooltip title={facts.warning ? summarizeAuthFileStatusMessage(facts.warning) : t('omc.duplicate_file_identity', { name: record.fileName })}>
            <span className={styles.warning} tabIndex={0} role="img" data-testid="oauth-credential-warning" aria-label={facts.warning ?? t('omc.duplicate_file_identity', { name: record.fileName })}>
              <WarningOutlined aria-hidden />
            </span>
          </Tooltip>
        )}
      </div>
      {facts.displayName && accountToggle && <div className={styles['account-line']}>{accountToggle}</div>}
    </div>
  );
}

/** The plan, routing priority and banked resets: the facts that sit beside a name. */
export function CredentialTraits({ record, facts, actions }: { record: OAuthWorkspaceRecord; facts: CredentialFacts; actions: CredentialActions }) {
  const t = useT();
  const plan = record.quota?.plan;
  const hasTraits = Boolean(plan?.plan_label) || record.file.priority !== undefined || (record.file.weight ?? 1) !== 1
    || plan?.subscription_active === false || facts.credits > 0;
  if (!hasTraits) return null;
  return (
    <div className={styles.traits}>
      {/* The plan says what the account can do, so it leads what is said about it. */}
      {plan?.plan_label && <Tag size="small">{plan.plan_label}</Tag>}
      {plan?.subscription_active === false && (
        <Tag size="small" tone="warn" data-subscription-inactive="true">{t('quota.subscription_inactive')}</Tag>
      )}
      <PriorityBadge priority={record.file.priority} weight={record.file.weight} />
      {facts.credits > 0 && (
        <Tooltip title={t('omc.quota_credit_available_hint')}>
          <button
            type="button"
            className={styles.credits}
            data-quota-credits={facts.credits}
            onClick={(event) => {
              event.stopPropagation();
              actions.onOpen(record, 'overview');
            }}
            aria-label={`${t('omc.reset_credits_count', { n: facts.credits })}: ${record.file.name}`}
          >
            <RollbackOutlined aria-hidden="true" />
            {t('omc.reset_credits_count', { n: facts.credits })}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

const SIWC_STATE_GLYPHS: Record<SIWCBadgeState, React.ReactNode> = {
  active: <CheckOutlined aria-hidden />,
  rebind: <WarningOutlined aria-hidden />,
  pending: <SyncOutlined spin aria-hidden />,
  off: <StopOutlined aria-hidden />,
  bind: <PlusOutlined aria-hidden />,
};

/**
 * The credential's one state, with what explains it in its tooltip. A state that asks for a sign-in
 * is itself the way to it. Renewal retries and a failed refresh sit beside it; SIWC, when the
 * provider offers it, follows as a quiet line that opens its settings.
 */
export function CredentialState({ record, facts, actions, nowMS, hasSIWC = true }: {
  record: OAuthWorkspaceRecord;
  facts: CredentialFacts;
  actions: CredentialActions;
  nowMS: number;
  hasSIWC?: boolean;
}) {
  const t = useT();
  const { file, quota } = record;
  const { status, explanation, failure, siwc } = facts;
  return (
    <div className={styles.state} data-testid="oauth-credential-status" data-credential-renewal>
      <div className={styles['state-main']}>
        <Tooltip title={<>
          {status.needsReauth && <div>{t('omc.reauthenticate')}</div>}
          {explanation && <div>{explanation}</div>}
          <div>{t('recovery.renewal')}: {t(renewalLabel(file))}</div>
          {file.access_token_expires_at && <div>{t('recovery.expires_at', { time: formatGatewayTimestamp(file.access_token_expires_at) })}</div>}
          {file.next_refresh_after && <div>{t('recovery.next_refresh')}: {formatGatewayTimestamp(file.next_refresh_after)}</div>}
          {file.refresh_error && (
            <div>{t('recovery.refresh_error')}: {[file.refresh_error.code, file.refresh_error.http_status].filter(Boolean).join(' · ')}</div>
          )}
          {quota?.observed_at_ms ? <div>{formatObservedAgo(quota.observed_at_ms, nowMS, t)}</div> : null}
        </>}>
          {status.needsReauth ? (
            <button
              type="button"
              className={styles.reauth}
              onClick={(event) => {
                event.stopPropagation();
                actions.onReauthenticate(record);
              }}
              aria-label={`${t('omc.reauthenticate')}: ${t(status.labelKey)}`}
              data-status-explained={explanation ? 'true' : undefined}
            >
              <StatusLabel tone={status.tone}>{t(status.labelKey)}</StatusLabel>
            </button>
          ) : (
            <StatusLabel tone={status.tone} tabIndex={0} data-status-explained={explanation ? 'true' : undefined}>{t(status.labelKey)}</StatusLabel>
          )}
        </Tooltip>
        <CredentialRenewalBadge file={file} onOpen={() => actions.onOpen(record, 'renewal')} />
        {failure && !status.needsReauth && (
          <span className={styles.failed} title={failure} data-quota-failure-line="failed">{t('omc.status_refresh_failed')}</span>
        )}
      </div>
      {hasSIWC && siwc && (
        <button
          type="button"
          className={clsx(styles.siwc, styles[`siwc-${siwc}`])}
          data-siwc-badge={siwc}
          onClick={(event) => {
            event.stopPropagation();
            actions.onOpenSIWC(record);
          }}
          aria-label={t('siwc.badge_aria', { name: file.name })}
        >
          {SIWC_STATE_GLYPHS[siwc]}
          <span>{t('siwc.status_line', { state: t(SIWC_BADGE_LABEL_KEYS[siwc]) })}</span>
        </button>
      )}
    </div>
  );
}

/** Whether the gateway may use the credential: a column of its own in the list, the card's head corner. */
export function CredentialSwitch({ record, facts, actions }: { record: OAuthWorkspaceRecord; facts: CredentialFacts; actions: CredentialActions }) {
  const t = useT();
  const { file } = record;
  return (
    <Switch
      size="small"
      checked={!facts.isDisabled}
      disabled={facts.isBusy || file.runtime_only || !record.canSelectForFileBatch}
      onChange={() => actions.onToggle(record)}
      aria-label={t('af.status_toggle_label', { name: file.name })}
    />
  );
}

/** The configuration glyph: the credential's settings, one click from its row. */
export function EditCredentialButton({ record, facts, actions }: { record: OAuthWorkspaceRecord; facts: CredentialFacts; actions: CredentialActions }) {
  const t = useT();
  return (
    <Tooltip title={t('omc.fleet_action_configure')}>
      <Button
        variant="ghost"
        size="sm"
        className={styles['icon-action']}
        icon={<EditOutlined />}
        disabled={facts.isBusy || !record.canSelectForFileBatch}
        onClick={(event) => {
          event.stopPropagation();
          actions.onOpen(record, 'configuration');
        }}
        aria-label={`${t('omc.fleet_action_configure')}: ${record.file.name}`}
        data-testid="oauth-credential-configure"
      />
    </Tooltip>
  );
}

/** The refresh glyph: the action an operator takes most, marked when a refresh is the fix. */
export function RefreshQuotaButton({ record, facts, actions }: { record: OAuthWorkspaceRecord; facts: CredentialFacts; actions: CredentialActions }) {
  const t = useT();
  const isDemo = isDemoMode();
  if (!record.canRefreshQuota) return <span className={styles['action-space']} aria-hidden="true" />;
  const label = facts.needsRefresh
    ? `${t('quota.btn_refresh_quota')}: ${record.file.name} (${t('omc.refresh_needed')})`
    : `${t('quota.btn_refresh_quota')}: ${record.file.name}`;
  return (
    <Tooltip title={facts.needsRefresh ? `${t('quota.btn_refresh_quota')} · ${t('omc.refresh_needed')}` : t('quota.btn_refresh_quota')}>
      <Button
        variant="ghost"
        size="sm"
        className={clsx(styles['icon-action'], facts.needsRefresh && styles['refresh-needed'])}
        icon={<SyncOutlined spin={facts.isRefreshing} />}
        disabled={facts.isBusy || facts.isRefreshing || isDemo}
        onClick={(event) => {
          event.stopPropagation();
          actions.onRefreshQuota(record);
        }}
        aria-label={label}
        data-testid="oauth-credential-refresh"
        data-needs-refresh={facts.needsRefresh ? 'true' : undefined}
      />
    </Tooltip>
  );
}

type ActionKey =
  | 'details' | 'select' | 'edit' | 'models' | 'rename' | 'reauth' | 'clear-cooldown' | 'redeem' | 'siwc' | 'download' | 'delete';

/**
 * Every action one credential can take, in one order, behind a row's or card's ellipsis. What
 * cannot be done now is offered disabled rather than hidden, so the menu does not change shape
 * between credentials.
 */
function actionList(record: OAuthWorkspaceRecord, facts: CredentialFacts, t: TFunc) {
  const isDemo = isDemoMode();
  const { file } = record;
  const canFile = record.canSelectForFileBatch;
  return [
    { key: 'details' as const, icon: <ProfileOutlined />, label: t('common.details'), disabled: facts.isBusy },
    { key: 'select' as const, icon: <CheckSquareOutlined />, label: t('omc.fleet_action_select'), disabled: facts.isBusy || !canFile },
    { key: 'edit' as const, icon: <EditOutlined />, label: t('omc.fleet_action_configure'), disabled: facts.isBusy || !canFile },
    { key: 'models' as const, icon: <AppstoreOutlined />, label: t('af.models_btn'), disabled: facts.isBusy || file.runtime_only },
    { key: 'rename' as const, icon: <RenameOutlined />, label: t('af.rename'), disabled: facts.isBusy || !facts.canRename },
    { key: 'reauth' as const, icon: <LoginOutlined />, label: t('omc.reauthenticate'), disabled: facts.isBusy || !record.canEditFile, hidden: !record.authorizationProviderId },
    { key: 'clear-cooldown' as const, icon: <TimerResetOutlined />, label: t('quota.clear_cooldown'), disabled: facts.isBusy || isDemo || !record.canClearCooldown, hidden: !record.canClearCooldown },
    { key: 'redeem' as const, icon: <RollbackOutlined />, label: t('omc.fleet_action_redeem'), disabled: facts.isBusy || isDemo || !record.canRedeemCredit, hidden: !record.canRedeemCredit },
    { key: 'siwc' as const, icon: <LinkOutlined />, label: t('siwc.menu'), disabled: facts.isBusy, hidden: !facts.siwc },
    { key: 'download' as const, icon: <DownloadOutlined />, label: t('af.download_credential'), disabled: facts.isBusy || file.runtime_only || isDemo || !canFile },
    { key: 'delete' as const, icon: <DeleteOutlined />, label: t('af.delete_credential'), disabled: facts.isBusy || file.runtime_only || isDemo || !canFile, danger: true },
  ].filter((action) => !action.hidden);
}

function useRunAction(record: OAuthWorkspaceRecord, actions: CredentialActions, onRename: () => void) {
  const t = useT();
  const { modal } = AntdApp.useApp();
  return (key: ActionKey) => {
    switch (key) {
      case 'details': actions.onOpen(record, 'overview'); break;
      case 'select': actions.onSelect([record], true); break;
      case 'edit': actions.onOpen(record, 'configuration'); break;
      case 'models': actions.onOpen(record, 'models'); break;
      case 'rename': onRename(); break;
      case 'reauth': actions.onReauthenticate(record); break;
      case 'clear-cooldown': actions.onClearCooldown(record); break;
      case 'redeem': actions.onRedeemCredit(record); break;
      case 'siwc': actions.onOpenSIWC(record); break;
      case 'download': actions.onDownload(record); break;
      case 'delete':
        modal.confirm({
          title: t('af.delete_one_title'),
          content: record.file.name,
          okText: t('common.delete'),
          cancelText: t('common.cancel'),
          okButtonProps: { danger: true },
          onOk: () => actions.onDelete(record),
        });
        break;
    }
  };
}

export function CredentialMenu({ record, facts, actions, onRename }: {
  record: OAuthWorkspaceRecord;
  facts: CredentialFacts;
  actions: CredentialActions;
  onRename: () => void;
}) {
  const t = useT();
  const run = useRunAction(record, actions, onRename);
  const list = actionList(record, facts, t);
  const items: MenuProps['items'] = list.flatMap((action) => {
    const item = { key: action.key, icon: action.icon, label: action.label, disabled: action.disabled, danger: action.danger };
    return action.key === 'download' ? [{ type: 'divider' as const }, item] : [item];
  });
  return (
    <Dropdown trigger={['click']} menu={{ items, onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); run(key as ActionKey); } }}>
      <Tooltip title={t('keys.actions_more')}>
        <Button
          variant="ghost"
          size="sm"
          className={styles['icon-action']}
          icon={<MoreOutlined />}
          onClick={(event) => event.stopPropagation()}
          aria-label={`${t('keys.actions_more')}: ${record.file.name}`}
        />
      </Tooltip>
    </Dropdown>
  );
}
