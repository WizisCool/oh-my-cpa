import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Skeleton,
  Space,
} from 'antd';
import {
  CopyOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  TagOutlined,
  UndoOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseDocument } from 'yaml';
import type { Document } from 'yaml';
import dayjs from 'dayjs';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useOverlayHistory } from '../hooks/useOverlayHistory';
import { copyText } from '../utils/clipboard';
import { ApiKeysList, type ApiKeyRecord } from '../components/keys/ApiKeysList';
import { updateFieldWithBaseline, isConfigSemanticallyEqual, getFieldSemanticValue } from '../components/config/configDirty';
import { ALL_CONFIG_FIELDS } from '../types/configSchema';
import type { ConfigScalarsResponse } from '../types/configManagement';
import type { ClientKeyUsageItem } from '../types/providers';
import styles from './ApiKeysPage.module.css';

/**
 * ApiKeysPage owns the gateway client API keys as their own surface.
 *
 * The keys are part of CPA's configuration document (`api-keys`), not a separate
 * store, so this page edits a draft of that document and saves it with the same
 * revision-guarded transaction the configuration workbench uses. It is the only
 * editor of that field: the configuration workbench points here instead of
 * carrying a second one (ADR 0010).
 *
 * A key has no disabled state to edit — CPA authenticates by presence in
 * `api-keys`, so removing a key is the only way to stop it, and that is what the
 * list offers.
 */
export const ApiKeysPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
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

  const [rawYaml, setRawYaml] = React.useState('');
  const [serverYaml, setServerYaml] = React.useState('');
  const [serverRevision, setServerRevision] = React.useState('');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflictRevision, setConflictRevision] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [keyInput, setKeyInput] = React.useState('');
  const [aliasInput, setAliasInput] = React.useState('');
  const [isKeyVisible, setIsKeyVisible] = React.useState(false);
  const [isSavingEditor, setIsSavingEditor] = React.useState(false);
  const [pendingAliases, setPendingAliases] = React.useState<Record<string, string>>({});

  const docRef = React.useRef<Document | null>(null);
  const serverDocRef = React.useRef<Document | null>(null);
  const rawYamlRef = React.useRef('');
  const serverYamlRef = React.useRef('');
  const saveInFlightRef = React.useRef(false);

  const apiKeysField = React.useMemo(
    () => ALL_CONFIG_FIELDS.find((field) => field.id === 'apiKeys'),
    [],
  );

  React.useEffect(() => {
    const safe = configQuery.data?.safe_yaml;
    if (safe === undefined) return;
    const revision = configQuery.data?.revision || '';
    const hasDraft = rawYamlRef.current !== serverYamlRef.current;
    setServerYaml(safe);
    setServerRevision(revision);
    try {
      serverDocRef.current = parseDocument(safe);
    } catch {
      // Previous baseline remains on malformed document.
    }
    if (hasDraft) return;
    setRawYaml(safe);
    try {
      docRef.current = parseDocument(safe);
    } catch {
      // Previous baseline remains on malformed document.
    }
  }, [configQuery.data?.safe_yaml, configQuery.data?.revision]);

  rawYamlRef.current = rawYaml;
  serverYamlRef.current = serverYaml;

  const isDirty = rawYaml !== serverYaml;

  const currentApiKeys: string[] = React.useMemo(() => {
    if (!apiKeysField) return [];
    if (!docRef.current) {
      try {
        docRef.current = parseDocument(rawYaml || '');
      } catch {
        return [];
      }
    }
    const value = getFieldSemanticValue(docRef.current, apiKeysField);
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string' && value) return [value];
    return [];
  }, [apiKeysField, rawYaml]);

  const saveMutation = useMutation({
    mutationFn: async ({ yamlToSave, revision }: { yamlToSave: string; revision: string }) => {
      setSaveError(null);
      setConflictRevision(null);
      return api.updateConfigSource(yamlToSave, revision);
    },
    onSuccess: async (data, variables) => {
      message.success(t('keys.saved'));
      setServerYaml(variables.yamlToSave);
      setServerRevision(data.revision);
      try {
        serverDocRef.current = parseDocument(variables.yamlToSave);
      } catch {
        // Retain previous baseline
      }
      void queryClient.invalidateQueries({ queryKey: ['management-config'] });

      // Save any pending aliases now that keys are written to CPA
      if (Object.keys(pendingAliases).length > 0) {
        try {
          const fresh = await api.getClientAPIKeys(true);
          for (const item of fresh.keys) {
            const pendingName = pendingAliases[item.key];
            if (pendingName !== undefined && item.usage_fingerprint) {
              await api.setClientKeyAlias(item.usage_fingerprint, pendingName, item.alias_version);
            }
          }
          setPendingAliases({});
        } catch (err: unknown) {
          const detail = err instanceof ApiError ? err.message : String(err);
          message.error(detail || t('keys.alias_save_failed'));
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['management-client-keys'] });
    },
    onError: (err: unknown) => {
      if (
        err instanceof ApiError &&
        (err.status === 409 || (err.data as Record<string, unknown>)?.code === 'config_conflict')
      ) {
        setConflictRevision(String((err.data as Record<string, unknown>)?.current_revision || ''));
        return;
      }
      const msg = err instanceof ApiError ? err.message : String(err);
      setSaveError(msg);
      message.error(msg);
    },
  });

  const saveKeys = React.useCallback(() => {
    if (!isDirty || configQuery.isError) return Promise.resolve();
    if (saveInFlightRef.current || saveMutation.isPending) return Promise.resolve();
    saveInFlightRef.current = true;
    return saveMutation
      .mutateAsync({ yamlToSave: rawYaml, revision: serverRevision })
      .catch(() => undefined)
      .finally(() => {
        saveInFlightRef.current = false;
      });
  }, [isDirty, configQuery.isError, saveMutation, rawYaml, serverRevision]);

  const discardChanges = React.useCallback(() => {
    setRawYaml(serverYaml);
    try {
      docRef.current = parseDocument(serverYaml);
    } catch {
      // Baseline stays on error
    }
    setSaveError(null);
    setConflictRevision(null);
    setPendingAliases({});
  }, [serverYaml]);

  const writeKeys = React.useCallback(
    (next: string[]) => {
      if (!apiKeysField) return;
      let currentDoc = docRef.current;
      if (!currentDoc) {
        try {
          currentDoc = parseDocument(rawYaml || '');
          docRef.current = currentDoc;
        } catch {
          message.error(t('cfg.yaml_syntax_error'));
          return;
        }
      }
      updateFieldWithBaseline(currentDoc, serverDocRef.current, apiKeysField, next);
      if (
        serverDocRef.current &&
        isConfigSemanticallyEqual(currentDoc, serverDocRef.current, ALL_CONFIG_FIELDS)
      ) {
        setRawYaml(serverYaml);
        docRef.current = parseDocument(serverYaml);
        return;
      }
      setRawYaml(currentDoc.toString());
    },
    [apiKeysField, rawYaml, serverYaml, message, t],
  );

  const closeEditor = React.useCallback(() => {
    setModalOpen(false);
    setKeyInput('');
    setAliasInput('');
    setIsKeyVisible(false);
    setEditingIndex(null);
  }, []);

  useOverlayHistory({ isOpen: modalOpen, onClose: closeEditor });

  const openAddEditor = React.useCallback(() => {
    setEditingIndex(null);
    setKeyInput('');
    setAliasInput('');
    setIsKeyVisible(false);
    setModalOpen(true);
  }, []);

  const openKeyEditor = React.useCallback(
    (index: number) => {
      const key = currentApiKeys[index] ?? '';
      const stored = keysQuery.data?.keys?.find((item) => item.key === key);
      setEditingIndex(index);
      setKeyInput(key);
      setAliasInput(pendingAliases[key] ?? stored?.alias ?? '');
      setIsKeyVisible(false);
      setModalOpen(true);
    },
    [currentApiKeys, keysQuery.data, pendingAliases],
  );

  /**
   * Writes a key's name through the alias endpoint.
   *
   * The name is this console's own metadata and never touches CPA's document, so
   * a name-only edit must not open a configuration draft. Returns false when the
   * write failed, which leaves the editor open rather than closing over a change
   * that was not saved.
   */
  const saveKeyAlias = React.useCallback(
    async (key: string, alias: string): Promise<boolean> => {
      const stored = keysQuery.data?.keys?.find((item) => item.key === key);
      // A key that exists only in the draft has no server identity to name yet,
      // so the name waits for the save that creates it.
      if (!stored?.usage_fingerprint) {
        setPendingAliases((prev) => ({ ...prev, [key]: alias }));
        message.success(alias ? t('keys.renamed') : t('keys.rename_cleared'));
        return true;
      }
      if (alias.length > 64) {
        message.error(t('keys.rename_too_long', { n: 64 }));
        return false;
      }
      try {
        await api.setClientKeyAlias(stored.usage_fingerprint, alias, stored.alias_version);
        message.success(alias ? t('keys.renamed') : t('keys.rename_cleared'));
        await queryClient.invalidateQueries({ queryKey: ['management-client-keys'] });
        await queryClient.invalidateQueries({ queryKey: ['usage-events'] });
        await queryClient.invalidateQueries({ queryKey: ['usage-facets'] });
        await queryClient.invalidateQueries({ queryKey: ['usage-event'] });
        return true;
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 409 || (error.data as Record<string, unknown>)?.code === 'alias_version_conflict')
        ) {
          message.warning(t('keys.rename_conflict'));
          await queryClient.invalidateQueries({ queryKey: ['management-client-keys'] });
          return false;
        }
        const detail = error instanceof ApiError ? error.message : String(error);
        message.error(detail || t('keys.rename_control'));
        return false;
      }
    },
    [keysQuery.data, message, queryClient, t],
  );

  const handleSaveKey = async () => {
    const trimmedKey = keyInput.trim();
    const trimmedAlias = aliasInput.trim();
    if (!trimmedKey) {
      message.warning(t('cfg.api_key_empty_warning'));
      return;
    }
    const duplicate = currentApiKeys.some(
      (key, index) => key === trimmedKey && index !== editingIndex,
    );
    if (duplicate) {
      message.error(t('keys.duplicate'));
      return;
    }

    setIsSavingEditor(true);
    try {
      const editedKey = editingIndex !== null ? currentApiKeys[editingIndex] : undefined;
      if (editedKey !== undefined && editedKey === trimmedKey) {
        // The name is the only thing that changed. Nothing about the key's value
        // moves, so the configuration document is not touched at all.
        const stored = keysQuery.data?.keys?.find((item) => item.key === trimmedKey);
        const currentAlias = pendingAliases[trimmedKey] ?? stored?.alias ?? '';
        if (trimmedAlias !== currentAlias) {
          const saved = await saveKeyAlias(trimmedKey, trimmedAlias);
          if (!saved) return;
        }
        closeEditor();
        return;
      }

      const next = [...currentApiKeys];
      if (editingIndex !== null && editingIndex >= 0) {
        const oldKey = next[editingIndex];
        next[editingIndex] = trimmedKey;
        // A new value is a different key to CPA, so its name has to be re-bound
        // to it after the save that writes the value (see the save mutation).
        if (trimmedAlias) {
          setPendingAliases((prev) => ({ ...prev, [trimmedKey]: trimmedAlias }));
        } else if (oldKey && oldKey !== trimmedKey) {
          setPendingAliases((prev) => {
            const clone = { ...prev };
            delete clone[oldKey];
            return clone;
          });
        }
      } else {
        next.push(trimmedKey);
        if (trimmedAlias) {
          setPendingAliases((prev) => ({ ...prev, [trimmedKey]: trimmedAlias }));
        }
      }
      writeKeys(next);
      closeEditor();
    } finally {
      setIsSavingEditor(false);
    }
  };

  const handleGenerateKey = () => {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    setKeyInput(`sk-cpa-${randomHex}`);
    setIsKeyVisible(true);
  };

  const handleDeleteRecord = React.useCallback(
    (record: ApiKeyRecord) => {
      writeKeys(currentApiKeys.filter((_, position) => position !== record.index));
      setPendingAliases((prev) => {
        if (!(record.key in prev)) return prev;
        const clone = { ...prev };
        delete clone[record.key];
        return clone;
      });
    },
    [currentApiKeys, writeKeys],
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
    for (const entry of usageQuery.data?.usage ?? []) {
      indexed[entry.key_fingerprint] = entry;
    }
    return indexed;
  }, [usageQuery.data]);

  const formatUsageTime = React.useCallback(
    (ms: number) => dayjs(ms).format('MM-DD HH:mm:ss'),
    [],
  );

  const handleReloadServerVersion = () => {
    setConflictRevision(null);
    setRawYaml(serverYaml);
    try {
      docRef.current = parseDocument(serverYaml);
    } catch {
      // Baseline stays
    }
  };

  const keyCount = currentApiKeys.length;

  return (
    <div className={`terminal-page keys-page ${styles['page-container']}`}>
      <header className={`terminal-page-head ${styles['header-row']}`}>
        <div>
          <h1 className="terminal-title">{t('keys.title')}</h1>
          <p className="terminal-subtitle">{t('keys.subtitle')}</p>
        </div>
      </header>

      {saveError && (
        <Alert
          type="error"
          showIcon
          closable={{ onClose: () => setSaveError(null) }}
          description={saveError}
        />
      )}

      {conflictRevision && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          description={t('cfg.dirty_bar_unsaved')}
          action={
            <Space>
              <Button size="small" onClick={handleReloadServerVersion}>
                {t('cfg.conflict_reload')}
              </Button>
              <Button size="small" onClick={() => setConflictRevision(null)}>
                {t('common.cancel')}
              </Button>
            </Space>
          }
        />
      )}

      {/* One container for the whole page: the head row, its rule and the list are
          one surface rather than a card holding another card holding a toolbar
          (design.md: prefer border-separated open rows over nested card wrappers).
          The card keeps its own 20px inset, which is what makes this list exactly as
          wide as every other list the console renders. */}
      <Card className={styles['keys-panel']}>
        <div className={styles['keys-head']}>
          <div className={styles['keys-head-title']}>
            <KeyOutlined className={styles['keys-head-icon']} />
            <h2 className={styles['keys-head-name']}>{t('cfg.api_keys_list')}</h2>
            <span className={styles['keys-head-count']} data-testid="keys-count">
              {t('cfg.api_keys_count', { n: keyCount })}
            </span>
          </div>
          <div className={styles['keys-head-actions']}>
            {keyCount > 0 && (
              <Input
                size="small"
                allowClear
                placeholder={t('keys.search_placeholder')}
                prefix={<SearchOutlined style={{ color: 'var(--muted)' }} />}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className={styles['keys-search']}
                aria-label={t('keys.search_placeholder')}
              />
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void configQuery.refetch()}
              loading={configQuery.isFetching}
              disabled={isDirty}
            >
              {t('cfg.reload')}
            </Button>
            {isDirty && (
              <Button
                size="small"
                icon={<UndoOutlined />}
                disabled={saveMutation.isPending}
                onClick={discardChanges}
              >
                {t('cfg.dirty_bar_discard')}
              </Button>
            )}
            <Popconfirm
              title={t('keys.save_confirm')}
              description={t('cfg.source_save_confirm_desc')}
              onConfirm={saveKeys}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
              disabled={!isDirty || saveMutation.isPending}
            >
              <Button
                size="small"
                type="primary"
                icon={<SaveOutlined />}
                loading={saveMutation.isPending}
                disabled={!isDirty}
              >
                {t('keys.save')}
              </Button>
            </Popconfirm>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openAddEditor}>
              {t('cfg.api_keys_add')}
            </Button>
          </div>
        </div>

        {configQuery.isPending && !rawYaml ? (
          <div className={styles['keys-state']}>
            <Skeleton active paragraph={{ rows: 6 }} />
          </div>
        ) : configQuery.isError && !rawYaml ? (
          <div className={styles['keys-state']}>
            <Alert
              type="warning"
              showIcon
              description={t('cfg.load_failed_desc')}
              action={
                <Button size="small" type="primary" onClick={() => void configQuery.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          </div>
        ) : (
          <ApiKeysList
            apiKeys={currentApiKeys}
            pendingAliases={pendingAliases}
            metadata={keysQuery.data?.keys}
            usage={usageByFingerprint}
            formatTime={formatUsageTime}
            searchQuery={searchQuery}
            onAdd={openAddEditor}
            onEdit={openKeyEditor}
            onDelete={handleDeleteRecord}
            onViewRequests={viewRequestsFor}
          />
        )}
      </Card>

      {/* One editor for both of a key's editable parts: the name this console
          shows it by, and the secret CPA authenticates it with. */}
      <Modal
        title={editingIndex !== null ? t('cfg.api_keys_edit') : t('cfg.api_keys_add')}
        open={modalOpen}
        onOk={() => void handleSaveKey()}
        confirmLoading={isSavingEditor}
        okButtonProps={{ disabled: !keyInput.trim() }}
        onCancel={closeEditor}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <div className="keys-key-editor">
          <label className="keys-key-editor-label" htmlFor="gateway-key-alias">
            <TagOutlined /> {t('keys.modal_alias_label')}
          </label>
          <Input
            id="gateway-key-alias"
            placeholder={t('keys.modal_alias_placeholder')}
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            maxLength={64}
            className="config-alias-input"
          />
          <p className="keys-key-editor-hint terminal-muted">{t('keys.rename_hint')}</p>

          <label className="keys-key-editor-label" htmlFor="gateway-key-value">
            <KeyOutlined /> {t('keys.modal_label')}
          </label>
          <Input.Password
            id="gateway-key-value"
            placeholder={t('cfg.api_keys_placeholder')}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onPressEnter={() => void handleSaveKey()}
            visibilityToggle={{
              visible: isKeyVisible,
              onVisibleChange: setIsKeyVisible,
            }}
            className="config-mono-input"
            autoFocus
          />
          <div className="keys-key-editor-actions">
            <Button size="small" type="dashed" onClick={handleGenerateKey}>
              {t('cfg.api_keys_generate')}
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              disabled={!keyInput.trim()}
              onClick={async () => {
                if (await copyText(keyInput.trim())) {
                  message.success(t('cfg.source_copy_success'));
                  return;
                }
                message.error(t('cfg.copy_failed'));
              }}
            >
              {t('cfg.api_keys_copy')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};