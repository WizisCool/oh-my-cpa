import { ActionMenu } from '../components/common/ActionMenu';
import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Input,
  Modal,
} from 'antd';
import { PageLoading } from '../components/common/PageLoading';
import {
  CopyOutlined,
  KeyOutlined,
  PlusOutlined,
  SearchOutlined,
  SyncOutlined,
  TagOutlined,
  WarningOutlined,
} from '../components/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseDocument } from 'yaml';
import type { Document } from 'yaml';
import dayjs from '../utils/time';
import { api, ApiError, apiErrorCode, describeError } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import { useOverlayHistory } from '../hooks/useOverlayHistory';
import { copyText } from '../utils/clipboard';
import { ApiKeysList, type ApiKeyRecord } from '../components/keys/ApiKeysList';
import { updateFieldWithBaseline, getFieldSemanticValue } from '../components/config/configDirty';
import { computeConfigChanges } from '../components/config/configPatch';
import { describeConfigSaveError } from '../components/config/configSaveErrors';
import { ALL_CONFIG_FIELDS } from '../types/configSchema';
import type { ConfigChange, ConfigScalarsResponse } from '../types/configManagement';
import type { ClientKeyUsageItem } from '../types/providers';
import { PageHeader } from '../components/common/PageHeader';
import { RefreshButton } from '../components/common/RefreshButton';
import { SecretInput } from '../components/common/SecretInput';
import styles from './ApiKeysPage.module.css';
import { LoadFailure, Notice, useToast } from '../components/feedback';

/** The longest name the alias endpoint accepts. */
const MAX_ALIAS_LENGTH = 64;

/** A fresh gateway key: a recognisable prefix and 128 bits from the platform's CSPRNG. */
function generateGatewayKey(): string {
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sk-cpa-${randomHex}`;
}

interface EditorState {
  isOpen: boolean;
  /** The key's position when editing one; null while adding. */
  index: number | null;
  /** The value the dialog opened with, so a changed secret can be called out. */
  originalKey: string;
}

const CLOSED_EDITOR: EditorState = { isOpen: false, index: null, originalKey: '' };

/**
 * ApiKeysPage owns the gateway client API keys as their own surface.
 *
 * The keys are part of CPA's configuration document (`api-keys`, or `access.api-keys` in a v8
 * layout), not a separate store, so every change is written as one revision-guarded transaction
 * on that document - the same one the configuration workbench uses. It is the only editor of that
 * field: the workbench points here instead of carrying a second one (ADR 0010).
 *
 * A change applies when it is confirmed. Adding, editing and removing a key each end in their
 * own confirmation - the dialog's primary action, or the removal's popover - so there is no
 * second "save the list" step to find: a draft that looked applied but was not was the one way
 * this page could leave an operator believing a key worked when CPA had never heard of it.
 *
 * A key has no disabled state to edit — CPA authenticates by presence in the list, so removing
 * a key is the only way to stop it, and that is what the list offers.
 */
export const ApiKeysPage: React.FC = () => {
  const timeZone = useTimeZone();
  const t = useT();
  // Gateway keys live in CPA's own configuration document, so adding, editing and
  // removing a key are refused by the demonstration.
  const isDemo = isDemoMode();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const configQuery = useQuery<ConfigScalarsResponse>({
    queryKey: ['management-config'],
    queryFn: () => api.getConfigScalars(),
    staleTime: 60_000,
  });

  const keysQuery = useQuery({
    // Its own cache entry, not the dashboard's: that one reads the masked list, and a
    // shared entry would let whichever page fetched first decide what the other sees.
    // A mask here would not merely display wrong - the alias join below is by key text,
    // so every name and every usage column would quietly empty out.
    queryKey: ['management-client-keys', 'with-keys'],
    queryFn: () => api.getClientAPIKeys(true),
    staleTime: 30_000,
  });

  const usageQuery = useQuery({
    queryKey: ['management-client-key-usage'],
    queryFn: () => api.getClientKeyUsage('preset=24h'),
    staleTime: 60_000,
  });

  const [searchQuery, setSearchQuery] = React.useState('');
  const [editor, setEditor] = React.useState<EditorState>(CLOSED_EDITOR);
  const [keyInput, setKeyInput] = React.useState('');
  const [aliasInput, setAliasInput] = React.useState('');
  const [isKeyVisible, setIsKeyVisible] = React.useState(false);
  const [isSavingEditor, setIsSavingEditor] = React.useState(false);

  const apiKeysField = React.useMemo(() => ALL_CONFIG_FIELDS.find((field) => field.id === 'apiKeys'), []);

  const serverYaml = configQuery.data?.safe_yaml ?? '';
  const serverRevision = configQuery.data?.revision ?? '';
  /** The document CPA holds now; every write is computed against it, never against a stale copy. */
  const serverDoc: Document | null = React.useMemo(() => {
    if (!configQuery.data) return null;
    try {
      return parseDocument(serverYaml);
    } catch {
      return null;
    }
  }, [configQuery.data, serverYaml]);

  const currentApiKeys: string[] = React.useMemo(() => {
    if (!apiKeysField || !serverDoc) return [];
    const value = getFieldSemanticValue(serverDoc, apiKeysField);
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string' && value) return [value];
    return [];
  }, [apiKeysField, serverDoc]);

  const invalidateKeyReaders = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['management-client-keys'] }),
      queryClient.invalidateQueries({ queryKey: ['usage-events'] }),
      queryClient.invalidateQueries({ queryKey: ['usage-facets'] }),
      queryClient.invalidateQueries({ queryKey: ['usage-event'] }),
    ]);
  }, [queryClient]);

  /**
   * Names the given keys through the alias endpoint, once CPA holds them.
   *
   * A name is keyed by the server's usage fingerprint, which exists only for a key CPA has
   * accepted - so a new key is written first and named second, from a fresh read. Resolves to
   * whether every name landed.
   */
  const applyAliases = React.useCallback(async (aliases: Record<string, string>): Promise<boolean> => {
    if (Object.keys(aliases).length === 0) return true;
    try {
      const fresh = await api.getClientAPIKeys(true);
      for (const item of fresh.keys) {
        const name = aliases[item.key];
        if (name !== undefined && item.usage_fingerprint) {
          await api.setClientKeyAlias(item.usage_fingerprint, name, item.alias_version);
        }
      }
      return true;
    } catch (err: unknown) {
      toast.error(describeError(err) || t('keys.alias_save_failed'));
      return false;
    }
  }, [toast, t]);

  const saveMutation = useMutation({
    mutationFn: ({ changes, revision }: { changes: ConfigChange[]; revision: string }) => {
      return api.patchConfig(changes, revision);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['management-config'] });
    },
    onError: (err: unknown) => {
      if (
        err instanceof ApiError &&
        (err.status === 409 || (err.data as Record<string, unknown>)?.code === 'config_conflict')
      ) {
        // Another writer moved the document. Nothing was written here, so the honest answer is
        // the current list and an invitation to repeat the change against it.
        toast.warning(t('keys.conflict_reloaded'));
        void configQuery.refetch();
        return;
      }
      const msg = describeConfigSaveError(err, t);
      toast.error(msg);
      // Part of the write landed, so the list shown is no longer CPA's.
      if (apiErrorCode(err) === 'config_partially_applied') void configQuery.refetch();
    },
  });

  /**
   * Writes a new key list to CPA, computed against the document CPA holds now, then names the
   * keys it was given names for.
   *
   * `failed` means nothing was written, so the dialog that asked stays open with the operator's
   * input intact. `unnamed` means the list landed but a name did not: the key exists in CPA now,
   * so asking for the same write again would only collide with it.
   */
  const commitKeys = React.useCallback(
    async (next: string[], aliases: Record<string, string> = {}): Promise<'saved' | 'unnamed' | 'failed'> => {
      if (saveMutation.isPending) {
        toast.warning(t('keys.applying'));
        return 'failed';
      }
      if (!apiKeysField || !serverDoc) return 'failed';
      let draft: Document;
      try {
        draft = parseDocument(serverYaml);
      } catch {
        toast.error(t('cfg.yaml_syntax_error'));
        return 'failed';
      }
      updateFieldWithBaseline(draft, serverDoc, apiKeysField, next);
      // Only the key list is sent, so a setting another session changed meanwhile
      // is not written back; the revision still refuses a list computed from a
      // document that has moved.
      const changes = computeConfigChanges(serverDoc, draft);
      if (changes.length > 0) {
        try {
          await saveMutation.mutateAsync({ changes, revision: serverRevision });
        } catch {
          return 'failed';
        }
      }
      const isNamed = await applyAliases(aliases);
      await invalidateKeyReaders();
      return isNamed ? 'saved' : 'unnamed';
    },
    [apiKeysField, serverDoc, serverYaml, serverRevision, saveMutation, applyAliases, invalidateKeyReaders, toast, t],
  );

  const closeEditor = React.useCallback(() => {
    setEditor(CLOSED_EDITOR);
    setKeyInput('');
    setAliasInput('');
    setIsKeyVisible(false);
  }, []);

  useOverlayHistory({ isOpen: editor.isOpen, onClose: closeEditor });

  // A new key starts from a generated value, shown, because generating is what almost every
  // operator does next - and a value they typed themselves can still replace it.
  const openAddEditor = React.useCallback(() => {
    setEditor({ isOpen: true, index: null, originalKey: '' });
    setKeyInput(generateGatewayKey());
    setAliasInput('');
    setIsKeyVisible(true);
  }, []);

  const openKeyEditor = React.useCallback(
    (index: number) => {
      const key = currentApiKeys[index] ?? '';
      const stored = keysQuery.data?.keys?.find((item) => item.key === key);
      setEditor({ isOpen: true, index, originalKey: key });
      setKeyInput(key);
      setAliasInput(stored?.alias ?? '');
      setIsKeyVisible(false);
    },
    [currentApiKeys, keysQuery.data],
  );

  /**
   * Writes a key's name through the alias endpoint.
   *
   * The name is this console's own metadata and never touches CPA's document, so a name-only
   * edit writes nothing there. Returns false when the write failed, which leaves the editor open
   * rather than closing over a change that was not saved.
   */
  const saveKeyAlias = React.useCallback(
    async (key: string, alias: string): Promise<boolean> => {
      const stored = keysQuery.data?.keys?.find((item) => item.key === key);
      if (!stored?.usage_fingerprint) {
        toast.error(t('keys.alias_save_failed'));
        return false;
      }
      try {
        await api.setClientKeyAlias(stored.usage_fingerprint, alias, stored.alias_version);
        toast.success(alias ? t('keys.renamed') : t('keys.rename_cleared'));
        await invalidateKeyReaders();
        return true;
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 409 || (error.data as Record<string, unknown>)?.code === 'alias_version_conflict')
        ) {
          toast.warning(t('keys.rename_conflict'));
          await queryClient.invalidateQueries({ queryKey: ['management-client-keys'] });
          return false;
        }
        toast.error(describeError(error) || t('keys.rename_control'));
        return false;
      }
    },
    [keysQuery.data, toast, queryClient, t, invalidateKeyReaders],
  );

  const handleSaveKey = async () => {
    const trimmedKey = keyInput.trim();
    const trimmedAlias = aliasInput.trim();
    if (!trimmedKey) {
      toast.warning(t('cfg.api_key_empty_warning'));
      return;
    }
    if (trimmedAlias.length > MAX_ALIAS_LENGTH) {
      toast.error(t('keys.rename_too_long', { n: MAX_ALIAS_LENGTH }));
      return;
    }
    if (currentApiKeys.some((key, index) => key === trimmedKey && index !== editor.index)) {
      toast.error(t('keys.duplicate'));
      return;
    }

    setIsSavingEditor(true);
    try {
      if (editor.index !== null && editor.originalKey === trimmedKey) {
        // The name is the only thing that can have changed. Nothing about the key's value
        // moves, so CPA's configuration document is not touched at all.
        const stored = keysQuery.data?.keys?.find((item) => item.key === trimmedKey);
        if (trimmedAlias !== (stored?.alias ?? '')) {
          if (!(await saveKeyAlias(trimmedKey, trimmedAlias))) return;
        }
        closeEditor();
        return;
      }

      const next = [...currentApiKeys];
      if (editor.index !== null) next[editor.index] = trimmedKey;
      else next.push(trimmedKey);
      // A new value is a different key to CPA, so its name is bound to it after the write.
      const aliases: Record<string, string> = trimmedAlias ? { [trimmedKey]: trimmedAlias } : {};
      const outcome = await commitKeys(next, aliases);
      if (outcome === 'failed') return;
      if (outcome === 'unnamed') {
        // The key is in CPA now; only its name is missing. The dialog becomes an edit of that
        // key, so pressing Save again retries the name alone.
        setEditor({ isOpen: true, index: next.indexOf(trimmedKey), originalKey: trimmedKey });
        return;
      }
      toast.success(editor.index === null ? t('keys.created') : t('keys.saved'));
      closeEditor();
    } finally {
      setIsSavingEditor(false);
    }
  };

  const handleDeleteRecord = React.useCallback(
    async (record: ApiKeyRecord) => {
      if ((await commitKeys(currentApiKeys.filter((_, position) => position !== record.index))) !== 'failed') {
        toast.success(t('keys.deleted'));
      }
    },
    [currentApiKeys, commitKeys, toast, t],
  );

  const viewRequestsFor = React.useCallback(
    (record: ApiKeyRecord) => {
      if (!record.usageFingerprint) return;
      const search = new URLSearchParams();
      search.set('preset', '24h');
      search.append('api_key', record.usageFingerprint);
      navigate(`/usage/events?${search.toString()}`);
    },
    [navigate],
  );

  const usageByFingerprint = React.useMemo(() => {
    const indexed: Record<string, ClientKeyUsageItem> = {};
    for (const entry of usageQuery.data?.usage ?? []) indexed[entry.key_fingerprint] = entry;
    return indexed;
  }, [usageQuery.data]);

  const formatUsageTime = React.useCallback((ms: number) => dayjs(ms).format('YYYY-MM-DD HH:mm:ss'), [timeZone]);

  const refreshAll = () => {
    void configQuery.refetch();
    void keysQuery.refetch();
    void usageQuery.refetch();
  };

  const keyCount = currentApiKeys.length;
  // The summary reads the same window the list's counts do, so the two never disagree.
  const activeFingerprints = new Set(
    (keysQuery.data?.keys ?? [])
      .filter((item) => currentApiKeys.includes(item.key) && item.usage_fingerprint)
      .map((item) => item.usage_fingerprint as string),
  );
  const activeCount = [...activeFingerprints].filter((fp) => (usageByFingerprint[fp]?.requests ?? 0) > 0).length;
  const windowRequests = [...activeFingerprints].reduce((sum, fp) => sum + (usageByFingerprint[fp]?.requests ?? 0), 0);
  const isEditing = editor.index !== null;
  const isValueChanged = isEditing && keyInput.trim() !== '' && keyInput.trim() !== editor.originalKey;

  return (
    <div className="terminal-page terminal-page-stack keys-page">
      <PageHeader
        title={t('keys.title')}
        mobileActions={(
          <>
            <ActionMenu><RefreshButton isRefreshing={configQuery.isFetching || keysQuery.isFetching || usageQuery.isFetching} onRefresh={refreshAll} /></ActionMenu>
            <Button type="primary" icon={<PlusOutlined />} disabled={isDemo || !apiKeysField || !serverDoc} title={isDemo ? t('demo.blocked') : undefined} onClick={openAddEditor}>{t('cfg.api_keys_add')}</Button>
          </>
        )}
        actions={(
          <>
            <RefreshButton
              isRefreshing={configQuery.isFetching || keysQuery.isFetching || usageQuery.isFetching}
              onRefresh={refreshAll}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={isDemo || !apiKeysField || !serverDoc}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={openAddEditor}
            >
              {t('cfg.api_keys_add')}
            </Button>
          </>
        )}
      />

      {/* One container for the whole list: its head, its rule and the rows are one surface
          rather than a card holding another card holding a toolbar (design.md: prefer
          border-separated open rows over nested card wrappers). The card keeps its own 20px
          inset, which is what makes this list exactly as wide as every other list. */}
      <Card className={styles['keys-panel']}>
        <div className={styles['keys-head']}>
          <div className={styles['keys-head-title']}>
            <h2 className={styles['keys-head-name']}>{t('cfg.api_keys_list')}</h2>
            <div className={styles['keys-summary']}>
              <span data-testid="keys-count">{t('cfg.api_keys_count', { n: keyCount })}</span>
              {keyCount > 0 && usageQuery.data && (
                <>
                  <span className={styles['keys-summary-divider']} aria-hidden="true">·</span>
                  <span>{t('keys.summary_active', { n: activeCount })}</span>
                  <span className={styles['keys-summary-divider']} aria-hidden="true">·</span>
                  <span>{t('keys.summary_requests', { n: windowRequests.toLocaleString() })}</span>
                </>
              )}
              {saveMutation.isPending && (
                <span className={styles['keys-summary-saving']} role="status">
                  <SyncOutlined spin /> {t('keys.applying')}
                </span>
              )}
            </div>
          </div>
          {keyCount > 0 && (
            <Input
              allowClear
              placeholder={t('keys.search_placeholder')}
              prefix={<SearchOutlined className={styles['keys-search-icon']} />}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className={styles['keys-search']}
              aria-label={t('keys.search_placeholder')}
            />
          )}
        </div>

        {configQuery.isPending ? (
          <div className={styles['keys-state']}>
            <PageLoading variant="block" />
          </div>
        ) : configQuery.isError && !configQuery.data ? (
          <div className={styles['keys-state']}>
            <LoadFailure
              title={t('cfg.load_failed')}
              detail={t('cfg.load_failed_desc')}
              onRetry={() => void configQuery.refetch()}
            />
          </div>
        ) : (
          <ApiKeysList
            apiKeys={currentApiKeys}
            metadata={keysQuery.data?.keys}
            usage={usageByFingerprint}
            formatTime={formatUsageTime}
            searchQuery={searchQuery}
            isBusy={saveMutation.isPending}
            isReadOnly={isDemo}
            onAdd={openAddEditor}
            onEdit={openKeyEditor}
            onDelete={(record) => void handleDeleteRecord(record)}
            onViewRequests={viewRequestsFor}
          />
        )}
      </Card>

      {/* One editor for both of a key's editable parts: the secret CPA authenticates it with,
          and the name this console shows it by. */}
      <Modal
        title={isEditing ? t('keys.modal_title_edit') : t('keys.modal_title_add')}
        open={editor.isOpen}
        onOk={() => void handleSaveKey()}
        confirmLoading={isSavingEditor}
        okButtonProps={{ disabled: !keyInput.trim() }}
        onCancel={closeEditor}
        okText={isEditing ? t('common.save') : t('keys.create')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <div className="keys-key-editor">
          <label className="keys-key-editor-label" htmlFor="gateway-key-value">
            <KeyOutlined /> {t('keys.modal_label')}
          </label>
          <SecretInput
            id="gateway-key-value"
            placeholder={t('cfg.api_keys_placeholder')}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onPressEnter={() => void handleSaveKey()}
            isVisible={isKeyVisible}
            onVisibleChange={setIsKeyVisible}
            className="config-mono-input"
            autoFocus
          />
          <div className="keys-key-editor-actions">
            <Button
              size="small"
              icon={<SyncOutlined />}
              onClick={() => {
                setKeyInput(generateGatewayKey());
                setIsKeyVisible(true);
              }}
            >
              {t('cfg.api_keys_generate')}
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              disabled={!keyInput.trim()}
              onClick={async () => {
                if (await copyText(keyInput.trim())) {
                  toast.success(t('cfg.source_copy_success'));
                  return;
                }
                toast.error(t('cfg.copy_failed'));
              }}
            >
              {t('cfg.api_keys_copy')}
            </Button>
          </div>
          {isValueChanged && (
            <Notice tone="warning" icon={<WarningOutlined />} title={t('keys.value_change_warning')} />
          )}

          <label className="keys-key-editor-label" htmlFor="gateway-key-alias">
            <TagOutlined /> {t('keys.modal_alias_label')}
          </label>
          <Input
            id="gateway-key-alias"
            placeholder={t('keys.modal_alias_placeholder')}
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            onPressEnter={() => void handleSaveKey()}
            maxLength={MAX_ALIAS_LENGTH}
            showCount
            className="config-alias-input"
          />
        </div>
      </Modal>
    </div>
  );
};
