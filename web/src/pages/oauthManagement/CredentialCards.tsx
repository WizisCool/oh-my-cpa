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
import { isRecordBodyClick, type CredentialViewProps } from './CredentialList';
import { rowClickIntent } from '../../types/rowSelection';
import { activityOf } from './fleetPresentation';
import { maskedCredentialLabel, type OAuthWorkspaceRecord } from './oauthWorkspaceLogic';
import { ActivitySpark, QuotaLines, QuotaMetrics } from './QuotaGauges';
import styles from './CredentialCards.module.css';

/**
 * The card view: the workspace for reading the fleet at a glance.
 *
 * The cards flow in one grid in the list's order - its providers in turn - and each card's mark
 * names its provider. A grid cut into a section per provider left a row with one card in it and the
 * rest of the width empty whenever a provider had few credentials, which is most of them.
 *
 * Every card has the same four bands, in the same places, whatever its credential reports: a head
 * with the selection, the provider mark, the name and the switch; a line of traits; the limits in
 * the list's two tracks; and a foot with the state on the left and the tools on the right. A card
 * opens the credential's details.
 */
export function CredentialCards({ groups, pluginLogos, selectedKeys, nowMS, actions, pageSelection }: CredentialViewProps) {
  const t = useT();
  // Each card carries its provider's name: with the sections gone, the mark is the only sign of it.
  const entries = React.useMemo(
    () => groups.flatMap((group) => group.records.map((record) => ({ record, providerName: group.title }))),
    [groups],
  );
  const keys = React.useMemo(() => entries.map(({ record }) => record.key), [entries]);
  return (
    <div className={styles.cards}>
      {pageSelection && (
        <div className={styles['page-select']}>
          {pageSelection}
          <span aria-hidden="true">{t('omc.fleet_select_page')}</span>
        </div>
      )}
      <div className={styles.grid} data-testid="oauth-credential-section" data-provider="all">
      <FilterTransition itemKeys={keys}>
        {entries.map(({ record, providerName }) => (
          <CredentialCard
            key={record.key}
            record={record}
            providerName={providerName}
            isSelected={selectedKeys.has(record.key)}
            hasSelection={selectedKeys.size > 0}
            nowMS={nowMS}
            actions={actions}
            pluginLogos={pluginLogos}
          />
        ))}
      </FilterTransition>
      </div>
    </div>
  );
}

function CredentialCard({ record, providerName, isSelected, hasSelection, nowMS, actions, pluginLogos }: {
  record: OAuthWorkspaceRecord;
  providerName: string;
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
        <span className={styles.select}>
          <SelectBox record={record} isSelected={isSelected} isBusy={facts.isBusy} actions={actions} />
        </span>
        <span className={styles.mark} role="img" aria-label={providerName} data-tip={providerName}>
          <CredentialMark credential={{ provider: record.displayProvider, hint: file.name }} pluginLogos={pluginLogos} size={18} />
        </span>
        <div className={styles.identity}>
          <CredentialName record={record} facts={facts} isRenaming={isRenaming} onRename={() => setIsRenaming(true)} onRenamed={() => setIsRenaming(false)} actions={actions} />
        </div>
        <CredentialSwitch record={record} facts={facts} actions={actions} className={styles.switch} />
      </header>

      <div className={styles.traits}>
        {/* Named as well as drawn: a mark that falls back to a neutral glyph says nothing of whose it is. */}
        <span className={styles.provider}>{providerName}</span>
        <CredentialTraits record={record} facts={facts} actions={actions} />
      </div>

      <div className={styles.readings} data-quota-missing={!hasLines && metrics.length === 0 ? 'true' : undefined}>
        {/* The list's two tracks: the five-hour and weekly limits side by side, further limits under them. */}
        {hasLines && <QuotaLines lines={facts.quotaLines} provider={record.displayProvider} observedAtMS={record.quota?.observed_at_ms} isMuted={facts.isQuotaMuted} isRefreshing={facts.isRefreshing} nowMS={nowMS} owner={owner} />}
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
          <CredentialMenu record={record} facts={facts} actions={actions} onRename={() => setIsRenaming(true)} />
        </div>
      </footer>
    </m.article>
  );
}
