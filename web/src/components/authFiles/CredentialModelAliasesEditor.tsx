import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

import { VertexModelOpenAPI } from './VertexModelOpenAPI';
import { useT } from '../../i18n';
import { DeleteOutlined, PlusOutlined } from '../icons';
import {
  emptyOAuthModelAliasDraft,
  type ManagementOAuthModelAliasDraft,
} from './oauthModelAliasLogic';
import { MAX_CREDENTIAL_MODEL_ALIASES } from './credentialPolicy';
import { ReorderHandle, RowReorder, useReorderRow } from '../common/RowReorder';
import { applyKeyOrder, moveKey, type DropSide } from '../../types/displayOrder';
import styles from './AuthFileDetailDrawer.module.css';

interface CredentialModelAliasesEditorProps {
 isVertex?: boolean;
  aliases: ManagementOAuthModelAliasDraft[];
  isDisabled?: boolean;
  onChange: (aliases: ManagementOAuthModelAliasDraft[]) => void;
}

const CredentialAliasRow: React.FC<{
  entry: ManagementOAuthModelAliasDraft;
  position: number;
  isVertex?: boolean;
  isDisabled?: boolean;
  onPatch: (rowKey: string, change: Partial<ManagementOAuthModelAliasDraft>) => void;
  onRemove: (rowKey: string) => void;
}> = ({ entry, position, isVertex, isDisabled = false, onPatch, onRemove }) => {
  const t = useT();
  const { row, handle } = useReorderRow(entry.rowKey);
  return (
    <li {...row} className={styles.alias} data-alias-row={entry.rowKey}>
      <ReorderHandle {...handle} name={entry.alias || entry.name || `${position + 1}`} variant="inline" />
      <div className={styles['alias-body']}>
        <div className={styles['alias-names']}>
          <Input
            value={entry.name}
            disabled={isDisabled}
            placeholder={t('af.alias_col_name')}
            aria-label={`${t('af.alias_col_name')} ${position + 1}`}
            onChange={(event) => onPatch(entry.rowKey, { name: event.target.value })}
          />
          <Input
            value={entry.alias}
            disabled={isDisabled}
            placeholder={t('af.alias_col_alias')}
            aria-label={`${t('af.alias_col_alias')} ${position + 1}`}
            onChange={(event) => onPatch(entry.rowKey, { alias: event.target.value })}
          />
          <Input
            value={entry.display_name ?? ''}
            disabled={isDisabled}
            placeholder={t('af.alias_col_display')}
            aria-label={`${t('af.alias_col_display')} ${position + 1}`}
            onChange={(event) => onPatch(entry.rowKey, { display_name: event.target.value })}
          />
        </div>
        {isVertex && <>
          <VertexModelOpenAPI value={entry.openapi} disabled={isDisabled} label={`${t('vertex.openapi_model')} ${position + 1}`}
            onChange={(openapi) => onPatch(entry.rowKey, { openapi })} />
          <div className={styles['policy-desc']}>{t('vertex.openapi_precedence')}</div>
        </>}
        <div className={styles['alias-flags']}>
          <Checkbox checked={Boolean(entry.fork)} disabled={isDisabled} onCheckedChange={(checked) => onPatch(entry.rowKey, { fork: checked })}>
            {t('af.alias_col_fork')}
          </Checkbox>
          <Checkbox checked={Boolean(entry.force_mapping)} disabled={isDisabled} onCheckedChange={(checked) => onPatch(entry.rowKey, { force_mapping: checked })}>
            {t('af.alias_col_force')}
          </Checkbox>
          <Button
            variant="ghost"
            size="sm"
            danger
            disabled={isDisabled}
            icon={<DeleteOutlined />}
            className={styles['alias-remove']}
            aria-label={`${t('af.alias_remove')} ${position + 1}`}
            onClick={() => onRemove(entry.rowKey)}
          />
        </div>
      </div>
    </li>
  );
};

/**
 * The aliases one credential answers to, edited as stacked entries.
 *
 * Entries rather than a table: the drawer is narrow, and each alias carries three names and two
 * switches that a table would have to scroll sideways to show.
 */
export const CredentialModelAliasesEditor: React.FC<CredentialModelAliasesEditorProps> = ({ aliases, onChange, isVertex, isDisabled = false }) => {
  const t = useT();
  // Row keys only have to be unique among this credential's rows for as long as the editor is
  // mounted; the stored rows are keyed by their position at load.
  const nextRowRef = React.useRef(0);

  const patchAlias = (rowKey: string, change: Partial<ManagementOAuthModelAliasDraft>) => {
    if (isDisabled) return;
    onChange(aliases.map((entry) => (entry.rowKey === rowKey ? { ...entry, ...change } : entry)));
  };

  const aliasKeys = React.useMemo(() => aliases.map((entry) => entry.rowKey), [aliases]);
  const moveAlias = (key: string, target: string, side: DropSide) => {
    if (isDisabled) return;
    const nextKeys = moveKey(aliasKeys, key, target, side);
    if (nextKeys !== aliasKeys) {
      onChange(applyKeyOrder(aliases, (entry) => entry.rowKey, nextKeys));
    }
  };
  const stepAlias = (key: string, direction: -1 | 1) => {
    if (isDisabled) return;
    const index = aliasKeys.indexOf(key);
    const neighbour = aliasKeys[index + direction];
    if (index >= 0 && neighbour !== undefined) {
      moveAlias(key, neighbour, direction < 0 ? 'before' : 'after');
    }
  };

  return (
    <>
      {aliases.length > 0 && (
        <RowReorder items={aliasKeys} isEnabled={!isDisabled && aliases.length > 1} onMove={moveAlias} onStep={stepAlias}>
          <ul className={styles['alias-list']} data-testid="credential-model-aliases-list">
            {aliases.map((entry, position) => (
              <CredentialAliasRow
                key={entry.rowKey}
                entry={entry}
                position={position}
                isVertex={isVertex}
                isDisabled={isDisabled}
                onPatch={patchAlias}
                onRemove={(rowKey) => {
                  if (!isDisabled) onChange(aliases.filter((item) => item.rowKey !== rowKey));
                }}
              />
            ))}
          </ul>
        </RowReorder>
      )}
      <Button
        size="sm"
        icon={<PlusOutlined />}
        disabled={isDisabled || aliases.length >= MAX_CREDENTIAL_MODEL_ALIASES}
        onClick={() => {
          if (isDisabled) return;
          nextRowRef.current += 1;
          onChange([...aliases, emptyOAuthModelAliasDraft(`credential-alias-new-${nextRowRef.current}`)]);
        }}
      >
        {t('af.alias_add_mapping')}
      </Button>
    </>
  );
};
