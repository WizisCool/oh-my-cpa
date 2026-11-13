import React from 'react';
import clsx from 'clsx';
import { Checkbox } from '@/components/ui/checkbox';
import { CredentialMark } from '../../components/LobeIcon';
import { ReorderHandle, RowReorder, useReorderList, useReorderRow } from '../../components/common/RowReorder';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useT } from '../../i18n';
import { FilterTransition, useFilterItemMotion } from '../../motion/filter';
import { m } from '../../motion';
import type { DropSide } from '../../types/displayOrder';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { QuotaCapacityOwner } from '../quota/QuotaCapacityButton';
import {
  CredentialMenu,
  CredentialName,
  EditCredentialButton,
  CredentialState,
  CredentialSwitch,
  CredentialTraits,
  RefreshQuotaButton,
  SelectBox,
  credentialFacts,
  type CredentialActions,
} from './CredentialParts';
import { rowClickIntent } from '../../types/rowSelection';
import { maskedCredentialLabel, type OAuthWorkspaceRecord } from './oauthWorkspaceLogic';
import { QuotaLines, QuotaMetrics } from './QuotaGauges';
import styles from './CredentialList.module.css';

/** One provider's credentials on the page, and every one of its credentials the filters let through. */
export interface CredentialGroup {
  provider: string;
  title: string;
  records: OAuthWorkspaceRecord[];
  visibleRecords: OAuthWorkspaceRecord[];
}

export interface CredentialViewProps {
  groups: CredentialGroup[];
  pluginLogos?: PluginOAuthLogos;
  selectedKeys: ReadonlySet<string>;
  nowMS: number;
  actions: CredentialActions;
  /** Puts a dragged credential beside another; absent while the order is not the operator's own. */
  onReorder?: (record: OAuthWorkspaceRecord, target: OAuthWorkspaceRecord, side: DropSide) => unknown;
  /** The selection of every credential on the page, drawn in the header's checkbox column. */
  pageSelection?: React.ReactNode;
}

const recordKey = (record: OAuthWorkspaceRecord) => record.key;

/**
 * The list view: the credentials of each provider as rows, built for reading and acting on many.
 *
 * A row reads left to right in the order an operator asks: which account, how much it has left,
 * and what can be done with it. The account's name leads, with its address and plan in quiet text;
 * its state - with SIWC under it - stands in a column of its own, so every row's state is found in
 * one place. Its limits follow in two tracks of
 * one zone that starts and ends at the same place on every row of every provider: the five-hour
 * limit in the first and the weekly one in the second, so those two are found without a header,
 * and further limits two to a line under them, or alone as one long bar across both. The
 * switch, refresh and menu close the row. A row opens the credential's details, and rows of one
 * provider can be dragged into the operator's own order.
 *
 * Each provider is a surface of its own under the shared column names, so where one provider ends
 * and the next begins reads at a glance, while every surface keeps the one grid and the columns
 * still run straight down the page.
 */
export function CredentialList({ groups, pluginLogos, selectedKeys, nowMS, actions, onReorder, pageSelection }: CredentialViewProps) {
  const t = useT();
  return (
    <div className={styles.list}>
      {/* One header for every provider: the columns are named once, above the first surface, and
          the page's selection sits in the checkbox column it selects. */}
      <div className={clsx(styles.line, styles['table-head'])}>
        <span className={styles.lead}>{pageSelection}</span>
        <span className={styles['head-who']}>{t('omc.fleet_col_account')}</span>
        <span className={styles['head-state']}>{t('omc.fleet_col_state')}</span>
        <span className={styles['head-quota']}>{t('omc.fleet_col_quota')}</span>
        <span className={styles['head-toggle']}>{t('omc.fleet_col_switch')}</span>
        <span className={styles['head-controls']}><span className="sr-only">{t('omc.fleet_col_actions')}</span></span>
      </div>
      <FilterTransition itemKeys={groups.map((group) => group.provider)}>
        {groups.map((group) => (
          <ListGroup
            key={group.provider}
            group={group}
            pluginLogos={pluginLogos}
            selectedKeys={selectedKeys}
            nowMS={nowMS}
            actions={actions}
            onReorder={onReorder}
          />
        ))}
      </FilterTransition>
    </div>
  );
}

function ListGroup({ group, pluginLogos, selectedKeys, nowMS, actions, onReorder }: Omit<CredentialViewProps, 'groups'> & { group: CredentialGroup }) {
  const filterMotion = useFilterItemMotion();
  const byKey = React.useMemo(() => new Map(group.visibleRecords.map((record) => [record.key, record])), [group.visibleRecords]);
  const write = (key: string, targetKey: string, side: DropSide) => {
    const record = byKey.get(key);
    const target = byKey.get(targetKey);
    return record && target ? onReorder?.(record, target, side) : undefined;
  };
  const reorder = useReorderList(group.records, recordKey, write);
  const rowKeys = React.useMemo(() => reorder.ordered.map(recordKey), [reorder.ordered]);
  // A keyboard step moves past the neighbour the operator can see; past the page's edge it lands on
  // the next page, so there is nothing on this one to hold.
  const step = (key: string, direction: -1 | 1) => {
    const index = group.visibleRecords.findIndex((record) => record.key === key);
    const neighbour = group.visibleRecords[index + direction];
    if (index < 0 || !neighbour) return;
    const side = direction < 0 ? 'before' : 'after';
    if (rowKeys.includes(neighbour.key)) reorder.move(key, neighbour.key, side);
    else void write(key, neighbour.key, side);
  };
  return (
    <m.section {...filterMotion} className={styles.group} data-testid="oauth-credential-section" data-provider={group.provider}>
      <RowReorder items={rowKeys} isEnabled={Boolean(onReorder)} onMove={reorder.move} onStep={step}>
        <div className={styles.rows}>
          <GroupHead group={group} pluginLogos={pluginLogos} selectedKeys={selectedKeys} actions={actions} isBand />
          <FilterTransition itemKeys={rowKeys}>
            {reorder.ordered.map((record) => (
              <CredentialRow
                key={record.key}
                record={record}
                isSelected={selectedKeys.has(record.key)}
                hasSelection={selectedKeys.size > 0}
                hasHandle={Boolean(onReorder)}
                nowMS={nowMS}
                actions={actions}
                pluginLogos={pluginLogos}
              />
            ))}
          </FilterTransition>
        </div>
      </RowReorder>
    </m.section>
  );
}

/**
 * A provider's title over its credentials: the selection of all of them, its mark on a tile, name and
 * count. It heads the provider's own surface, so the mark is drawn once per provider, not per row.
 */
export function GroupHead({ group, pluginLogos, selectedKeys, actions, isBand = false, className }: {
  group: CredentialGroup;
  pluginLogos?: PluginOAuthLogos;
  selectedKeys: ReadonlySet<string>;
  actions: CredentialActions;
  /** Whether the head is a band inside the list's table, on the rows' checkbox column. */
  isBand?: boolean;
  className?: string;
}) {
  const t = useT();
  const selectable = group.records.filter((record) => record.canSelectForFileBatch);
  const selectedCount = selectable.filter((record) => selectedKeys.has(record.key)).length;
  return (
    <header className={clsx(styles['group-head'], isBand && styles.band, className)}>
      <span className={styles.lead}>
        <Checkbox
          checked={selectable.length > 0 && selectedCount === selectable.length}
          indeterminate={selectedCount > 0 && selectedCount < selectable.length}
          disabled={selectable.length === 0}
          onCheckedChange={(checked) => actions.onSelect(selectable, checked)}
          aria-label={t('omc.section_select', { provider: group.title })}
        />
      </span>
      <span className={styles['group-identity']}>
        <span className={styles['group-mark']} aria-hidden="true">
          <CredentialMark credential={{ provider: group.provider }} pluginLogos={pluginLogos} size={16} />
        </span>
        <h2 className={styles['group-title']}>{group.title}</h2>
        <span className={styles['group-count']}>{group.visibleRecords.length}</span>
      </span>
    </header>
  );
}

/**
 * Whether a click on a row or card opens it, rather than landing on a control inside it. A reading
 * that only takes focus for its tooltip - a quota bar, the state - is not a control.
 */
export function isRecordBodyClick(event: React.MouseEvent<HTMLElement>): boolean {
  const target = event.target instanceof Element ? event.target : undefined;
  // A dialog opened from inside - a capacity estimate, a confirmation - is portalled elsewhere in the
  // page but still bubbles here; a click on it, or on its mask to close it, is not a click on the row.
  if (target && !event.currentTarget.contains(target)) return false;
  if (!target) return false;
  if (window.getSelection()?.toString()) return false;
  // A control's own hit box - the switch's - belongs to the control, not to the row around it.
  return !target.closest('button, a, input, label, [role="button"], [role="checkbox"], [role="switch"], [data-control-hit], [data-slot="dropdown-menu-content"], [data-slot="popover-content"]');
}

function CredentialRow({ record, isSelected, hasSelection, hasHandle, nowMS, actions, pluginLogos }: {
  record: OAuthWorkspaceRecord;
  isSelected: boolean;
  /** Whether any credential is chosen, which makes a plain click on a row pick it. */
  hasSelection: boolean;
  hasHandle: boolean;
  nowMS: number;
  actions: CredentialActions;
  pluginLogos?: PluginOAuthLogos;
}) {
  const t = useT();
  const facts = credentialFacts(record, actions, nowMS, t);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const reorder = useReorderRow(record.key);
  const filterMotion = useFilterItemMotion({ isHeld: reorder.isHeld });
  const isPhone = useIsPhoneViewport();
  const { file } = record;
  const metrics = record.quota?.plan?.metrics ?? [];
  const owner: QuotaCapacityOwner | undefined = file.auth_index
    ? {
      authIndex: file.auth_index,
      credentialName: maskedCredentialLabel(record),
      mark: <CredentialMark credential={{ provider: record.displayProvider, hint: file.name }} pluginLogos={pluginLogos} size={22} />,
    }
    : undefined;
  const hasLines = facts.quotaLines.length > 0;
  // Provider summary figures sit below the limit readings, or stand alone for a provider without any.
  const quota = hasLines || metrics.length > 0 ? (
    <>
      {hasLines && <QuotaLines lines={facts.quotaLines} provider={record.displayProvider} isMuted={facts.isQuotaMuted} isRefreshing={facts.isRefreshing} nowMS={nowMS} owner={owner} />}
      {metrics.length > 0 && <QuotaMetrics metrics={metrics} isMuted={facts.isQuotaMuted} isStandalone={!hasLines} />}
    </>
  ) : <span className={styles.missing}>{facts.explanation ?? t('omc.fleet_no_reading')}</span>;
  return (
    <m.div
      {...filterMotion}
      {...reorder.row}
      className={clsx(styles.row, isSelected && styles['row-selected'], facts.isDisabled && styles['row-disabled'])}
      data-testid="oauth-credential-record"
      data-identity={record.key}
      data-file-name={file.name}
      data-auth-index={file.auth_index ?? ''}
      data-quota-focus-anchor={record.quota ? record.authIndex : undefined}
    >
      {hasHandle && !isPhone && <ReorderHandle {...reorder.handle} name={maskedCredentialLabel(record)} variant="edge" className={styles.handle} />}
      <div
        className={styles.line}
        data-rename-host
        // Shift extends a selection, so it must not also start a text selection across the rows.
        onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
        onClick={(event) => {
          if (isRenaming || !isRecordBodyClick(event)) return;
          const intent = rowClickIntent(event, hasSelection);
          if (intent === 'open') actions.onOpen(record, 'overview');
          else if (record.canSelectForFileBatch && !facts.isBusy) actions.onPick(record, intent === 'range');
        }}
      >
        <div className={styles.lead}>
          <SelectBox record={record} isSelected={isSelected} isBusy={facts.isBusy} actions={actions} />
        </div>
        <div className={styles.who}>
          <CredentialName record={record} facts={facts} isRenaming={isRenaming} onRename={() => setIsRenaming(true)} onRenamed={() => setIsRenaming(false)} actions={actions} />
          <CredentialTraits record={record} facts={facts} actions={actions} />
        </div>
        <div className={styles.state}>
          <CredentialState record={record} facts={facts} actions={actions} nowMS={nowMS} />
        </div>
        <div className={styles.quota} data-quota-missing={!hasLines && metrics.length === 0 ? 'true' : undefined}>
          {quota}
        </div>
        <div className={styles.toggle}>
          <CredentialSwitch record={record} facts={facts} actions={actions} className={styles['toggle-hit']} />
        </div>
        <div className={styles.controls}>
          {hasHandle && isPhone && <ReorderHandle {...reorder.handle} name={maskedCredentialLabel(record)} variant="inline" />}
          <EditCredentialButton record={record} facts={facts} actions={actions} />
          <RefreshQuotaButton record={record} facts={facts} actions={actions} />
          <CredentialMenu record={record} facts={facts} actions={actions} onRename={() => setIsRenaming(true)} />
        </div>
      </div>
    </m.div>
  );
}
