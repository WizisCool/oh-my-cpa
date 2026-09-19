import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import type { ManagementOAuthModelAlias } from '../../types/managementOAuthModelAlias';
import {
  createOAuthModelAliasDrafts,
  emptyOAuthModelAliasDraft,
  isValidOAuthModelAliasProvider,
  normalizeOAuthModelAliasProvider,
  oauthModelAliasDraftsEqual,
  validateOAuthModelAliasDrafts,
  type ManagementOAuthModelAliasDraft,
  type OAuthModelAliasValidationError,
} from './oauthModelAliasLogic';
import styles from './OAuthModelAliasDrawer.module.css';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';

const { Text } = Typography;

interface OAuthModelAliasDrawerProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  providerOptions: string[];
}

const QUERY_KEY = ['management-oauth-model-aliases'] as const;

function validationMessage(error: OAuthModelAliasValidationError, t: TFunc, alias?: string): string {
  switch (error) {
    case 'provider':
      return t('af.alias_error_provider');
    case 'too_many':
      return t('af.alias_error_too_many');
    case 'name_alias_required':
      return t('af.alias_error_name_alias_required');
    case 'field_too_long':
      return t('af.alias_error_field_too_long');
    case 'alias_same':
      return t('af.alias_error_alias_same');
    case 'alias_duplicate':
      return t('af.alias_error_alias_duplicate', { alias: alias ?? '' });
  }
}

function safeError(error: unknown, t: TFunc): string {
  if (error instanceof ApiError && error.status === 501) return t('af.alias_unsupported');
  return error instanceof Error ? error.message : t('af.request_failed');
}

export const OAuthModelAliasDrawer: React.FC<OAuthModelAliasDrawerProps> = ({
  open,
  onClose,
  onSaved,
  providerOptions,
}) => {
  const t = useT();
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const rowCounterRef = useRef(0);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [newProvider, setNewProvider] = useState('');
  const [drafts, setDrafts] = useState<ManagementOAuthModelAliasDraft[]>([]);
  const [baseline, setBaseline] = useState<ManagementOAuthModelAliasDraft[]>([]);

  const aliasesQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.getManagementOAuthModelAliases(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });

  const existingProviders = useMemo(() => {
    const values = new Set<string>();
    Object.keys(aliasesQuery.data?.aliases ?? {}).forEach((provider) => {
      const normalized = normalizeOAuthModelAliasProvider(provider);
      if (normalized) values.add(normalized);
    });
    providerOptions.forEach((provider) => {
      const normalized = normalizeOAuthModelAliasProvider(provider);
      if (normalized && isValidOAuthModelAliasProvider(normalized)) values.add(normalized);
    });
    return Array.from(values).sort();
  }, [aliasesQuery.data?.aliases, providerOptions]);

  const provider = normalizeOAuthModelAliasProvider(selectedProvider);
  const isDirty = !oauthModelAliasDraftsEqual(drafts, baseline);
  const hasSavedProvider = Boolean(provider && aliasesQuery.data?.aliases?.[provider]?.length);

  const loadProvider = useCallback((providerValue: string) => {
    const normalized = normalizeOAuthModelAliasProvider(providerValue);
    const next = createOAuthModelAliasDrafts(aliasesQuery.data?.aliases?.[normalized] ?? []);
    setSelectedProvider(normalized);
    setNewProvider('');
    setDrafts(next);
    setBaseline(next);
  }, [aliasesQuery.data?.aliases]);

  useEffect(() => {
    if (!open || !aliasesQuery.data || selectedProvider) return;
    const first = existingProviders.find((value) => aliasesQuery.data.aliases[value]?.length) ?? existingProviders[0] ?? '';
    if (first) loadProvider(first);
  }, [aliasesQuery.data, existingProviders, loadProvider, open, selectedProvider]);

  useEffect(() => {
    if (!open) {
      setSelectedProvider('');
      setNewProvider('');
      setDrafts([]);
      setBaseline([]);
    }
  }, [open]);

  const updateDraft = (rowKey: string, field: keyof ManagementOAuthModelAlias, value: string | boolean) => {
    setDrafts((current) => current.map((draft) => (
      draft.rowKey === rowKey ? { ...draft, [field]: value } : draft
    )));
  };

  const saveMutation = useMutation({
    mutationFn: ({ provider: targetProvider, aliases }: { provider: string; aliases: ManagementOAuthModelAlias[] }) =>
      api.patchManagementOAuthModelAliases(targetProvider, aliases),
    onSuccess: (response, variables) => {
      queryClient.setQueryData(QUERY_KEY, (current: { aliases?: Record<string, ManagementOAuthModelAlias[]> } | undefined) => {
        const aliases = { ...(current?.aliases ?? {}) };
        if (response.aliases.length > 0) {
          aliases[variables.provider] = response.aliases;
        } else {
          delete aliases[variables.provider];
        }
        return { aliases };
      });
      const next = createOAuthModelAliasDrafts(response.aliases);
      setSelectedProvider(normalizeOAuthModelAliasProvider(response.provider));
      setDrafts(next);
      setBaseline(next);
      onSaved();
    },
  });

  const handleSave = async () => {
    const validation = validateOAuthModelAliasDrafts(selectedProvider, drafts);
    if (!validation.ok) {
      message.error(validationMessage(validation.error, t, validation.alias));
      return;
    }
    try {
      await saveMutation.mutateAsync({ provider: validation.provider, aliases: validation.aliases });
      message.success(t('af.alias_saved'));
    } catch (error) {
      message.error(safeError(error, t));
    }
  };

  const handleDeleteProvider = () => {
    if (!provider || !hasSavedProvider || isDirty) return;
    modal.confirm({
      title: t('af.alias_delete_confirm_title'),
      content: t('af.alias_delete_confirm_desc', { provider }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await saveMutation.mutateAsync({ provider, aliases: [] });
          message.success(t('af.alias_delete_success', { provider }));
        } catch (error) {
          message.error(safeError(error, t));
          throw error;
        }
      },
    });
  };

  const handleSelectProvider = (value: string) => {
    if (isDirty) {
      message.info(t('af.alias_provider_locked'));
      return;
    }
    loadProvider(value);
  };

  const handleUseNewProvider = () => {
    if (isDirty) {
      message.info(t('af.alias_provider_locked'));
      return;
    }
    const normalized = normalizeOAuthModelAliasProvider(newProvider);
    if (!normalized || !isValidOAuthModelAliasProvider(normalized)) {
      message.error(t('af.alias_error_provider'));
      return;
    }
    // The endpoint replaces a provider's whole list, and this field offers the
    // providers that already have aliases, so an existing key has to be seeded
    // from its saved rows. Starting from an empty table would make the next save
    // delete every mapping the operator never saw.
    loadProvider(normalized);
  };

  const handleAttemptClose = () => {
    if (saveMutation.isPending) return;
    if (!isDirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: t('af.alias_unsaved_title'),
      content: t('af.alias_unsaved_desc'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: onClose,
    });
  };

  /**
   * Back goes through the same guard the drawer's own Cancel does.
   *
   * `onClose` is the raw callback, and wiring it here would make a physical key discard an unsaved
   * alias edit without the confirmation the button beside it shows - two ways of leaving one panel
   * behaving differently, which is the defect this drawer's guard exists to prevent. The hook also
   * re-arms the sentinel when the guard *refuses* the close, so declining the confirmation does not
   * leave the next Back press to navigate the page out from under an open editor.
   */
  useOverlayHistory({ isOpen: open, onClose: handleAttemptClose });

  const columns = [
    {
      title: t('af.alias_col_name'),
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (value: string, row: ManagementOAuthModelAliasDraft) => (
        <Input
          data-alias-field="name"
          value={value}
          aria-label={t('af.alias_col_name')}
          onChange={(event) => updateDraft(row.rowKey, 'name', event.target.value)}
        />
      ),
    },
    {
      title: t('af.alias_col_alias'),
      dataIndex: 'alias',
      key: 'alias',
      width: 180,
      render: (value: string, row: ManagementOAuthModelAliasDraft) => (
        <Input
          data-alias-field="alias"
          value={value}
          aria-label={t('af.alias_col_alias')}
          onChange={(event) => updateDraft(row.rowKey, 'alias', event.target.value)}
        />
      ),
    },
    {
      title: t('af.alias_col_display'),
      dataIndex: 'display_name',
      key: 'display_name',
      width: 170,
      render: (value: string | undefined, row: ManagementOAuthModelAliasDraft) => (
        <Input
          data-alias-field="display_name"
          value={value ?? ''}
          aria-label={t('af.alias_col_display')}
          onChange={(event) => updateDraft(row.rowKey, 'display_name', event.target.value)}
        />
      ),
    },
    {
      title: t('af.alias_col_fork'),
      dataIndex: 'fork',
      key: 'fork',
      width: 100,
      render: (value: boolean | undefined, row: ManagementOAuthModelAliasDraft) => (
        <Switch
          checked={Boolean(value)}
          aria-label={`${t('af.alias_col_fork')} ${row.alias || row.name}`}
          onChange={(checked) => updateDraft(row.rowKey, 'fork', checked)}
        />
      ),
    },
    {
      title: t('af.alias_col_force'),
      dataIndex: 'force_mapping',
      key: 'force_mapping',
      width: 110,
      render: (value: boolean | undefined, row: ManagementOAuthModelAliasDraft) => (
        <Switch
          checked={Boolean(value)}
          aria-label={`${t('af.alias_col_force')} ${row.alias || row.name}`}
          onChange={(checked) => updateDraft(row.rowKey, 'force_mapping', checked)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 52,
      render: (_: unknown, row: ManagementOAuthModelAliasDraft) => (
        <Button
          type="text"
          danger
          aria-label={`${t('af.alias_remove')} ${row.alias || row.name}`}
          icon={<DeleteOutlined />}
          onClick={() => setDrafts((current) => current.filter((draft) => draft.rowKey !== row.rowKey))}
        />
      ),
    },
  ];

  const renderBody = () => {
    if (aliasesQuery.isLoading) {
      return <Empty description={t('common.loading')} />;
    }
    if (aliasesQuery.isError) {
      const unsupported = aliasesQuery.error instanceof ApiError && aliasesQuery.error.status === 501;
      return (
        <Alert
          type={unsupported ? 'info' : 'error'}
          showIcon
          description={unsupported ? t('af.alias_unsupported') : safeError(aliasesQuery.error, t)}
          action={!unsupported && <Button size="small" onClick={() => void aliasesQuery.refetch()}>{t('common.retry')}</Button>}
        />
      );
    }
    return (
      <>
        <div className={styles['provider-toolbar']}>
          <Select
            className={styles['provider-select']}
            value={provider || undefined}
            placeholder={t('af.alias_provider_placeholder')}
            options={existingProviders.map((value) => ({ value, label: value }))}
            onChange={handleSelectProvider}
            disabled={isDirty || saveMutation.isPending}
          />
          <AutoComplete
            className={styles['provider-new']}
            value={newProvider}
            options={existingProviders.map((value) => ({ value }))}
            placeholder={t('af.alias_new_provider_placeholder')}
            onChange={setNewProvider}
            disabled={isDirty || saveMutation.isPending}
          />
          <Button onClick={handleUseNewProvider} disabled={isDirty || saveMutation.isPending || !newProvider.trim()}>
            {t('af.alias_load_provider')}
          </Button>
        </div>
        {provider && <Tag data-testid="oauth-model-alias-provider" className={styles['provider-tag']}>{provider}</Tag>}
        {isDirty && <Alert type="info" showIcon description={t('af.alias_dirty_hint')} />}
        {drafts.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('af.alias_empty')}>
            <Button
              icon={<PlusOutlined />}
              onClick={() => setDrafts([emptyOAuthModelAliasDraft(`oauth-alias-new-${rowCounterRef.current++}`)])}
            >
              {t('af.alias_add_mapping')}
            </Button>
          </Empty>
        ) : (
          <Table<ManagementOAuthModelAliasDraft>
            rowKey="rowKey"
            size="small"
            pagination={false}
            dataSource={drafts}
            columns={columns}
            scroll={{ x: 800 }}
            className={styles['alias-table']}
          />
        )}
        <Space wrap>
          <Button
            icon={<PlusOutlined />}
            onClick={() => setDrafts((current) => [...current, emptyOAuthModelAliasDraft(`oauth-alias-new-${rowCounterRef.current++}`)])}
          >
            {t('af.alias_add_mapping')}
          </Button>
          <Button
            data-testid="oauth-model-alias-save"
            type="primary"
            icon={<SaveOutlined />}
            loading={saveMutation.isPending}
            disabled={!provider || !isDirty}
            onClick={() => void handleSave()}
          >
            {t('af.alias_save')}
          </Button>
          <Button data-testid="oauth-model-alias-delete-provider" danger icon={<DeleteOutlined />} disabled={!hasSavedProvider || isDirty} onClick={handleDeleteProvider}>
            {t('af.alias_delete_provider')}
          </Button>
        </Space>
        <Text type="secondary" className={styles['drawer-note']}>{t('af.alias_provider_lock_note')}</Text>
      </>
    );
  };

  return (
    <Drawer
      data-testid="oauth-model-alias-drawer"
      title={t('af.alias_title')}
      size="min(760px, 100vw)"
      open={open}
      onClose={handleAttemptClose}
    >
      <div className={styles['drawer-content']}>{renderBody()}</div>
    </Drawer>
  );
};
