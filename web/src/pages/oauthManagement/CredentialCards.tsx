import React from 'react';
import clsx from 'clsx';
import { CredentialMark } from '../../components/LobeIcon';
import { useT } from '../../i18n';
import { FilterTransition, useFilterItemMotion } from '../../motion/filter';
import { m } from '../../motion';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
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
import { GroupHead, isRecordBodyClick, type CredentialViewProps } from './CredentialList';
import { rowClickIntent } from '../../types/rowSelection';
import { activityOf } from './fleetPresentation';
import { maskedCredentialLabel, type OAuthWorkspaceRecord } from './oauthWorkspaceLogic';
import { ActivitySpark, QuotaLines, QuotaMetrics } from './QuotaGauges';
import styles from './CredentialCards.module.css';

/**
 * The card view: the workspace for reading the fleet at a glance.
 *
 * Each credential is a card: who it is, then every limit it reports in the list's two tracks - the
 * five-hour and weekly limits side by side, further limits under them - and its state and recent
 * traffic at the foot. A card
 * opens the credential's details; its switch, refresh and menu are on the card itself.
 */
export function CredentialCards({ groups, hasGroupHeads, pluginLogos, selectedKeys, nowMS, actions }: CredentialViewProps & {
  /** Whether each group names its provider: the scope is every provider, not one. */
  hasGroupHeads: boolean;
}) {
  return (
    <div className={styles.cards}>
      <FilterTransition itemKeys={groups.map((group) => group.provider)}>
        {groups.map((group) => (
          <CardGroup key={group.provider} group={group} hasHead={hasGroupHeads} pluginLogos={pluginLogos} selectedKeys={selectedKeys} nowMS={nowMS} actions={actions} />
        ))}
      </FilterTransition>
    </div>
  );
}

function CardGroup({ group, hasHead, pluginLogos, selectedKeys, nowMS, actions }: Omit<CredentialViewProps, 'groups'> & {
  group: CredentialViewProps['groups'][number];
  hasHead: boolean;
}) {
  const filterMotion = useFilterItemMotion();
  const keys = React.useMemo(() => group.records.map((record) => record.key), [group.records]);
  return (
    <m.section {...filterMotion} className={styles.group} data-testid="oauth-credential-section" data-provider={group.provider}>
      {hasHead && <GroupHead group={group} pluginLogos={pluginLogos} selectedKeys={selectedKeys} actions={actions} className={styles['group-head']} />}
      <div className={styles.grid}>
        <FilterTransition itemKeys={keys}>
          {group.records.map((record) => (
            <CredentialCard
              key={record.key}
              record={record}
              isSelected={selectedKeys.has(record.key)}
              hasSelection={selectedKeys.size > 0}
              nowMS={nowMS}
              actions={actions}
              pluginLogos={pluginLogos}
            />
          ))}
        </FilterTransition>
      </div>
    </m.section>
  );
}

/** Whether a click on a card's body opens it, rather than landing on a control inside it. */
function CredentialCard({ record, isSelected, hasSelection, nowMS, actions, pluginLogos }: {
  record: OAuthWorkspaceRecord;
  isSelected: boolean;
  /** Whether any credential is chosen, which makes a click on a card pick it. */
  hasSelection: boolean;
  nowMS: number;
  actions: CredentialActions;
  pluginLogos?: PluginOAuthLogos;
}) {
  const t = useT();
  const filterMotion = useFilterItemMotion();
  const facts = credentialFacts(record, actions, nowMS, t);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const { file } = record;
  const activity = activityOf(record);
  const metrics = record.quota?.plan?.metrics ?? [];
  const hasLines = facts.quotaLines.length > 0;
  const owner = file.auth_index
    ? { authIndex: file.auth_index, credentialName: maskedCredentialLabel(record), mark: <CredentialMark credential={{ provider: record.displayProvider, hint: file.name }} pluginLogos={pluginLogos} size={22} /> }
    : undefined;
  return (
    <m.article
      {...filterMotion}
      className={clsx(styles.card, isSelected && styles['card-selected'], facts.isDisabled && styles['card-disabled'])}
      onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }}
      onClick={(event) => {
        if (isRenaming || !isRecordBodyClick(event)) return;
        const intent = rowClickIntent(event, hasSelection);
        if (intent === 'open') actions.onOpen(record, 'overview');
        else if (record.canSelectForFileBatch && !facts.isBusy) actions.onPick(record, intent === 'range');
      }}
      data-rename-host
      data-testid="oauth-credential-record"
      data-identity={record.key}
      data-file-name={file.name}
      data-auth-index={file.auth_index ?? ''}
      data-quota-focus-anchor={record.quota ? record.authIndex : undefined}
    >
      <header className={styles.head}>
        <span className={styles.mark}>
          <CredentialMark credential={{ provider: record.displayProvider, hint: file.name }} pluginLogos={pluginLogos} size={22} />
        </span>
        <div className={styles.identity}>
          <CredentialName record={record} facts={facts} isRenaming={isRenaming} onRename={() => setIsRenaming(true)} onRenamed={() => setIsRenaming(false)} actions={actions} size="large" />
        </div>
        <div className={styles['head-tools']}>
          <SelectBox record={record} isSelected={isSelected} isBusy={facts.isBusy} actions={actions} />
          <CredentialSwitch record={record} facts={facts} actions={actions} />
          <CredentialMenu record={record} facts={facts} actions={actions} onRename={() => setIsRenaming(true)} />
        </div>
      </header>
      <CredentialTraits record={record} facts={facts} actions={actions} />

      <div className={styles.readings} data-quota-missing={!hasLines && metrics.length === 0 ? 'true' : undefined}>
        {/* The list's two tracks: the five-hour and weekly limits side by side, further limits under them. */}
        {hasLines && <QuotaLines lines={facts.quotaLines} provider={record.displayProvider} isMuted={facts.isQuotaMuted} nowMS={nowMS} owner={owner} />}
        {metrics.length > 0 && <QuotaMetrics metrics={metrics} isMuted={facts.isQuotaMuted} isStandalone={!hasLines} />}
        {!hasLines && metrics.length === 0 && (
          <span className={styles.quiet}>{facts.explanation ?? t('omc.quota_unobserved')}</span>
        )}
      </div>

      <footer className={styles.foot}>
        <div className={styles['foot-state']}>
          <CredentialState record={record} facts={facts} actions={actions} nowMS={nowMS} />
        </div>
        {activity.buckets.length > 0 && (
          <span className={styles.activity} data-tip={t('omc.fleet_traffic_12h')}>
            <ActivitySpark buckets={activity.buckets} failures={activity.failures} label={t('omc.fleet_traffic_12h')} />
          </span>
        )}
        <div className={styles['foot-tools']}>
          <EditCredentialButton record={record} facts={facts} actions={actions} />
          <RefreshQuotaButton record={record} facts={facts} actions={actions} />
        </div>
      </footer>
    </m.article>
  );
}
