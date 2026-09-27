import React from 'react';
import { Alert, Input } from 'antd';
import { clsx } from 'clsx';
import { SearchOutlined } from '../../components/icons';
import { CopyButton } from '../../components/workspace/CopyButton';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { groupCapabilities } from './state';
import type { Capability } from './state';
import styles from './AgentPage.module.css';

/** The pip each permission group carries: reading is not a verdict, changing is a caution, destroying is the alarm. */
const PERMISSION_TONE: Record<string, string> = { read: 'default', write: 'warning', destructive: 'error' };

export interface CapabilityDirectoryProps {
  capabilities: Capability[];
  isPending: boolean;
  isError: boolean;
}

/**
 * What the agent can do, before it does it.
 *
 * The registry is the agent's entire authority, and this is the same list the model is offered -
 * not a curated subset - so an operator can read the destructive entries before approving
 * anything, and can tell a missing capability from a badly worded request. The groups are in a
 * fixed order rather than alphabetical, so the destructive set is always in the same place.
 *
 * It is an open list, one hairline row per capability: a card per entry would turn a registry of
 * dozens into a column of boxes whose borders are louder than the names in them.
 */
export const CapabilityDirectory = React.memo(function CapabilityDirectory({ capabilities, isPending, isError }: CapabilityDirectoryProps) {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState('');
  const groups = React.useMemo(() => groupCapabilities(capabilities, query), [capabilities, query]);

  return (
    <div className={workspace['panel']} data-testid="agent-directory">
      <div className={styles['directory-head']}>
        <div className={workspace['section-head']}>
          <h2 className={workspace['section-title']}>{t('agent.directory')}</h2>
          <span className={styles['count']}>{t('agent.directory.count', { count: String(capabilities.length) })}</span>
        </div>
        <p className={workspace['field-hint']}>{t('agent.directory.hint')}</p>
        <Input
          aria-label={t('agent.directory.search')}
          placeholder={t('agent.directory.search')}
          allowClear
          value={query}
          prefix={<SearchOutlined aria-hidden="true" className={styles['search-icon']} />}
          onChange={event => setQuery(event.target.value)}
        />
      </div>
      {isError && <div className={styles['directory-note']}><Alert type="error" title={t('agent.error.gateway')} /></div>}
      {isPending && <p className={styles['directory-note']}>{t('common.loading')}</p>}
      {!isPending && !isError && groups.length === 0 && <p className={styles['directory-note']}>{t('agent.directory.empty')}</p>}
      {groups.map(group => (
        <section key={group.permission} className={styles['group']} aria-label={t(`agent.permission.${group.permission}`)}>
          <h3 className={styles['group-head']}>
            <span className={workspace['pip']} data-tone={PERMISSION_TONE[group.permission]} aria-hidden="true" />
            <span>{t(`agent.permission.${group.permission}`)}</span>
            <span className={styles['count']}>{group.items.length}</span>
          </h3>
          <ul className={styles['capabilities']}>
            {group.items.map(capability => {
              const isExpanded = expanded === capability.name;
              return (
                <li key={capability.name} className={styles['capability']}>
                  <button
                    type="button"
                    className={styles['capability-body']}
                    aria-expanded={isExpanded}
                    onClick={() => setExpanded(isExpanded ? '' : capability.name)}
                  >
                    <code className={styles['capability-name']}>{capability.name}</code>
                    <span className={clsx(styles['capability-description'], isExpanded && styles['is-expanded'])}>
                      {capability.description}
                    </span>
                  </button>
                  <CopyButton text={capability.name} label={`${t('agent.directory.copy_name')}: ${capability.name}`} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
});
