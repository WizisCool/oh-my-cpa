import React from 'react';
import { Button, Checkbox, Input } from 'antd';

import { useT } from '../../i18n';
import { DeleteOutlined, PlusOutlined } from '../icons';
import {
  emptyOAuthModelAliasDraft,
  type ManagementOAuthModelAliasDraft,
} from './oauthModelAliasLogic';
import { MAX_CREDENTIAL_MODEL_ALIASES } from './credentialPolicy';
import styles from './AuthFileDetailDrawer.module.css';

interface CredentialModelAliasesEditorProps {
  aliases: ManagementOAuthModelAliasDraft[];
  onChange: (aliases: ManagementOAuthModelAliasDraft[]) => void;
}

/**
 * The aliases one credential answers to, edited as stacked entries.
 *
 * Entries rather than a table: the drawer is narrow, and each alias carries three names and two
 * switches that a table would have to scroll sideways to show.
 */
export const CredentialModelAliasesEditor: React.FC<CredentialModelAliasesEditorProps> = ({ aliases, onChange }) => {
  const t = useT();
  // Row keys only have to be unique among this credential's rows for as long as the editor is
  // mounted; the stored rows are keyed by their position at load.
  const nextRowRef = React.useRef(0);

  const patchAlias = (rowKey: string, change: Partial<ManagementOAuthModelAliasDraft>) => {
    onChange(aliases.map((entry) => (entry.rowKey === rowKey ? { ...entry, ...change } : entry)));
  };

  return (
    <>
      {aliases.length > 0 && (
        <ul className={styles['alias-list']}>
          {aliases.map((entry, position) => (
            <li key={entry.rowKey} className={styles.alias}>
              <div className={styles['alias-names']}>
                <Input
                  value={entry.name}
                  placeholder={t('af.alias_col_name')}
                  aria-label={`${t('af.alias_col_name')} ${position + 1}`}
                  onChange={(event) => patchAlias(entry.rowKey, { name: event.target.value })}
                />
                <Input
                  value={entry.alias}
                  placeholder={t('af.alias_col_alias')}
                  aria-label={`${t('af.alias_col_alias')} ${position + 1}`}
                  onChange={(event) => patchAlias(entry.rowKey, { alias: event.target.value })}
                />
                <Input
                  value={entry.display_name ?? ''}
                  placeholder={t('af.alias_col_display')}
                  aria-label={`${t('af.alias_col_display')} ${position + 1}`}
                  onChange={(event) => patchAlias(entry.rowKey, { display_name: event.target.value })}
                />
              </div>
              <div className={styles['alias-flags']}>
                <Checkbox checked={Boolean(entry.fork)} onChange={(event) => patchAlias(entry.rowKey, { fork: event.target.checked })}>
                  {t('af.alias_col_fork')}
                </Checkbox>
                <Checkbox checked={Boolean(entry.force_mapping)} onChange={(event) => patchAlias(entry.rowKey, { force_mapping: event.target.checked })}>
                  {t('af.alias_col_force')}
                </Checkbox>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  className={styles['alias-remove']}
                  aria-label={`${t('af.alias_remove')} ${position + 1}`}
                  onClick={() => onChange(aliases.filter((item) => item.rowKey !== entry.rowKey))}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Button
        size="small"
        icon={<PlusOutlined />}
        disabled={aliases.length >= MAX_CREDENTIAL_MODEL_ALIASES}
        onClick={() => {
          nextRowRef.current += 1;
          onChange([...aliases, emptyOAuthModelAliasDraft(`credential-alias-new-${nextRowRef.current}`)]);
        }}
      >
        {t('af.alias_add_mapping')}
      </Button>
    </>
  );
};
