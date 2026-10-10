import React, { useMemo, useRef } from 'react';
import { AutoComplete, Button, Empty, Input, Switch, Table } from 'antd';
import { DeleteOutlined, PlusOutlined } from '../icons';
import { useT } from '../../i18n';
import type {
  ManagementOAuthModelAlias,
  ManagementOAuthProviderModel,
} from '../../types/managementOAuthModelAlias';
import { OAUTH_MODEL_ALIAS_ENTRY_LIMIT, emptyOAuthModelAliasDraft, type ManagementOAuthModelAliasDraft } from './oauthModelAliasLogic';
import { matchesExcludedModelRule } from './oauthExcludedModelLogic';
import type { OAuthModelCatalogState } from './OAuthExcludedModelsPanel';
import styles from './OAuthModelRulesDrawer.module.css';

interface OAuthModelAliasPanelProps {
  drafts: ManagementOAuthModelAliasDraft[];
  onChange: (update: (current: ManagementOAuthModelAliasDraft[]) => ManagementOAuthModelAliasDraft[]) => void;
  catalog: ManagementOAuthProviderModel[];
  catalogState: OAuthModelCatalogState;
  /** The provider's saved exclusion rules: an alias of a hidden model serves nothing. */
  excludedRules: string[];
  isDisabled: boolean;
}

export const OAuthModelAliasPanel: React.FC<OAuthModelAliasPanelProps> = ({
  drafts,
  onChange,
  catalog,
  catalogState,
  excludedRules,
  isDisabled,
}) => {
  const t = useT();
  const rowCounterRef = useRef(0);

  const modelOptions = useMemo(() => catalog.map((model) => ({
    value: model.id,
    label: model.display_name && model.display_name !== model.id
      ? `${model.id} · ${model.display_name}`
      : model.id,
  })), [catalog]);

  const updateDraft = (rowKey: string, field: keyof ManagementOAuthModelAlias, value: string | boolean) => {
    onChange((current) => current.map((draft) => (
      draft.rowKey === rowKey ? { ...draft, [field]: value } : draft
    )));
  };

  const addDraft = () => {
    onChange((current) => [...current, emptyOAuthModelAliasDraft(`oauth-alias-new-${rowCounterRef.current++}`)]);
  };

  const excludingRuleOf = (modelName: string): string | undefined => {
    const name = modelName.trim();
    return name ? excludedRules.find((rule) => matchesExcludedModelRule(rule, name)) : undefined;
  };

  // The fixed widths leave the upstream model the remainder, so the whole row
  // fits the drawer's content width without scrolling sideways.
  const columns = [
    {
      title: t('af.alias_col_name'),
      dataIndex: 'name',
      key: 'name',
      render: (value: string, row: ManagementOAuthModelAliasDraft) => {
        const excludingRule = excludingRuleOf(value);
        return (
          <div className={styles['alias-source']}>
            <AutoComplete
              className={styles['alias-source-input']}
              value={value}
              options={modelOptions}
              disabled={isDisabled}
              showSearch={{ filterOption: (input, option) => String(option?.label ?? '').toLowerCase().includes(input.trim().toLowerCase()) }}
              onChange={(next) => updateDraft(row.rowKey, 'name', next)}
            >
              <Input data-alias-field="name" aria-label={t('af.alias_col_name')} />
            </AutoComplete>
            {excludingRule && (
              <span className={styles['field-warning']} data-testid="oauth-model-alias-excluded-source">
                {t('af.alias_source_excluded', { rule: excludingRule })}
              </span>
            )}
          </div>
        );
      },
    },
    {
      title: t('af.alias_col_alias'),
      dataIndex: 'alias',
      key: 'alias',
      width: 160,
      render: (value: string, row: ManagementOAuthModelAliasDraft) => (
        <Input
          data-alias-field="alias"
          value={value}
          disabled={isDisabled}
          aria-label={t('af.alias_col_alias')}
          onChange={(event) => updateDraft(row.rowKey, 'alias', event.target.value)}
        />
      ),
    },
    {
      title: t('af.alias_col_display'),
      dataIndex: 'display_name',
      key: 'display_name',
      width: 132,
      render: (value: string | undefined, row: ManagementOAuthModelAliasDraft) => (
        <Input
          data-alias-field="display_name"
          value={value ?? ''}
          disabled={isDisabled}
          aria-label={t('af.alias_col_display')}
          onChange={(event) => updateDraft(row.rowKey, 'display_name', event.target.value)}
        />
      ),
    },
    {
      title: t('af.alias_col_fork'),
      dataIndex: 'fork',
      key: 'fork',
      width: 96,
      render: (value: boolean | undefined, row: ManagementOAuthModelAliasDraft) => (
        <Switch
          checked={Boolean(value)}
          disabled={isDisabled}
          aria-label={`${t('af.alias_col_fork')} ${row.alias || row.name}`}
          onChange={(checked) => updateDraft(row.rowKey, 'fork', checked)}
        />
      ),
    },
    {
      title: t('af.alias_col_force'),
      dataIndex: 'force_mapping',
      key: 'force_mapping',
      width: 104,
      render: (value: boolean | undefined, row: ManagementOAuthModelAliasDraft) => (
        <Switch
          checked={Boolean(value)}
          disabled={isDisabled}
          aria-label={`${t('af.alias_col_force')} ${row.alias || row.name}`}
          onChange={(checked) => updateDraft(row.rowKey, 'force_mapping', checked)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 48,
      // Pinned: a phone still scrolls the fields sideways, and the row's only
      // removal control must not scroll out of sight with them.
      fixed: 'end' as const,
      render: (_: unknown, row: ManagementOAuthModelAliasDraft) => (
        <Button
          type="text"
          danger
          disabled={isDisabled}
          aria-label={`${t('af.alias_remove')} ${row.alias || row.name}`}
          icon={<DeleteOutlined />}
          onClick={() => onChange((current) => current.filter((draft) => draft.rowKey !== row.rowKey))}
        />
      ),
    },
  ];

  return (
    <div className={styles['pane']} data-testid="oauth-model-alias-panel">
      <p className={styles['hint']} data-testid="oauth-model-alias-catalog-hint">
        {catalogState === 'loading' && t('af.rules_catalog_loading')}
        {catalogState === 'ready' && t('af.alias_catalog_ready', { n: catalog.length })}
        {(catalogState === 'unavailable' || catalogState === 'error') && t('af.alias_catalog_unavailable')}
      </p>
      {drafts.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('af.alias_empty')}>
          <Button icon={<PlusOutlined />} disabled={isDisabled || drafts.length >= OAUTH_MODEL_ALIAS_ENTRY_LIMIT} onClick={addDraft}>
            {t('af.alias_add_mapping')}
          </Button>
        </Empty>
      ) : (
        <>
          <Table<ManagementOAuthModelAliasDraft>
            className={styles['alias-table']}
            rowKey="rowKey"
            size="small"
            pagination={false}
            dataSource={drafts}
            columns={columns}
            scroll={{ x: 680 }}
          />
          <div>
            <Button icon={<PlusOutlined />} disabled={isDisabled || drafts.length >= OAUTH_MODEL_ALIAS_ENTRY_LIMIT} onClick={addDraft}>
              {t('af.alias_add_mapping')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
