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
  Typography,
} from 'antd';
import {
  CopyOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
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
import { ApiKeysEditor, type ApiKeyRecord } from '../components/config/ApiKeysEditor';
import { updateFieldWithBaseline, isConfigSemanticallyEqual, getFieldSemanticValue } from '../components/config/configDirty';
import { ConfigDirtyBar } from '../components/config/ConfigDirtyBar';
import { usePreference } from '../hooks/usePreference';
import { ALL_CONFIG_FIELDS } from '../types/configSchema';
import type { ConfigScalarsResponse } from '../types/configManagement';
import type { ClientKeyUsageItem } from '../types/providers';
import styles from './ApiKeysPage.module.css';

const { Text } = Typography;

const parseStringArray = (raw: unknown): string[] | undefined => {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
  }
  return undefined;
};

/**
 * ApiKeysPage owns the gateway client API keys as their own surface.
 *
 * The keys are part of CPA's configuration document (`api-keys`), not a separate
 * store. This page edits a draft of that document and saves it with the
 * same revision-guarded transaction the configuration workbench uses.
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
    queryKey: ['management-client-keys'],
    queryFn: () => api.getClientAPIKeys(),
    staleTime: 30_000,
  });

  const usageQuery = useQuery({
    queryKey: ['management-client-key-usage'],
    queryFn: () => api.getClientKeyUsage('preset=24h'),
    staleTime: 60_000,
  });

  const { value: disabledKeys, set: setDisabledKeys } = usePreference<string[]>(
    'omc_disabled_client_keys',
    [],
    parseStringArray,
  );

  const [rawYaml, setRawYaml] = React.useState('');
  const [serverYaml, setServerYaml] = React.useState('');
  const [serverRevision, setServerRevision] = React.useState('');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflictRevision, setConflictRevision] = React.useState<string | null>(null);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [keyInput, setKeyInput] = React.useState('');
  const [aliasInput, setAliasInput] = React.useState('');
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
          const fresh = await api.getClientAPIKeys();
          for (const item of fresh.keys) {
            const pendingName = pendingAliases[item.key];
            if (pendingName !== undefined && item.usage_fingerprint) {
              await api.setClientKeyAlias(item.usage_fingerprint, pendingName, item.alias_version);
            }
          }
          setPendingAliases({});
        } catch {
          // ignore or log
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

  const handleSaveKey = () => {
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
    const next = [...currentApiKeys];
    if (editingIndex !== null && editingIndex >= 0) {
      const oldKey = next[editingIndex];
      next[editingIndex] = trimmedKey;
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
    setModalOpen(false);
    setKeyInput('');
    setAliasInput('');
    setEditingIndex(null);
  };

  const handleGenerateKey = () => {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    setKeyInput(`sk-cpa-${randomHex}`);
  };

  const handleToggleDisable = React.useCallback(
    (key: string, willBeDisabled: boolean) => {
      if (willBeDisabled) {
        // Move from active keys to disabled keys
        writeKeys(currentApiKeys.filter((k) => k !== key));
        if (!disabledKeys.includes(key)) {
          setDisabledKeys([...disabledKeys, key]);
        }
        message.info(t('keys.toggle_disabled_msg'));
      } else {
        // Move from disabled keys back to active keys
        setDisabledKeys(disabledKeys.filter((k) => k !== key));
        if (!currentApiKeys.includes(key)) {
          writeKeys([...currentApiKeys, key]);
        }
        message.success(t('keys.toggle_enabled_msg'));
      }
    },
    [currentApiKeys, disabledKeys, setDisabledKeys, writeKeys, message, t],
  );

  const handleDeleteRecord = React.useCallback(
    (record: ApiKeyRecord) => {
      if (record.disabled) {
        setDisabledKeys(disabledKeys.filter((k) => k !== record.key));
        setPendingAliases((prev) => {
          const clone = { ...prev };
          delete clone[record.key];
          return clone;
        });
      } else {
        writeKeys(currentApiKeys.filter((_, position) => position !== record.index));
        setPendingAliases((prev) => {
          const clone = { ...prev };
          delete clone[record.key];
          return clone;
        });
      }
    },
    [currentApiKeys, disabledKeys, setDisabledKeys, writeKeys],
  );

  const renameKey = React.useCallback(
    async (record: ApiKeyRecord, alias: string) => {
      // If it's a draft key without a server identity yet, remember locally
      if (!record.usageFingerprint) {
        setPendingAliases((prev) => ({ ...prev, [record.key]: alias }));
        message.success(alias ? t('keys.renamed') : t('keys.rename_cleared'));
        return;
      }
      if (alias.length > 64) {
        message.error(t('keys.rename_too_long', { n: 64 }));
        throw new Error('alias too long');
      }
      try {
        await api.setClientKeyAlias(record.usageFingerprint, alias, record.aliasVersion);
        message.success(alias ? t('keys.renamed') : t('keys.rename_cleared'));
        await queryClient.invalidateQueries({ queryKey: ['management-client-keys'] });
        await queryClient.invalidateQueries({ queryKey: ['usage-events'] });
        await queryClient.invalidateQueries({ queryKey: ['usage-facets'] });
        await queryClient.invalidateQueries({ queryKey: ['usage-event'] });
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 409 || (error.data as Record<string, unknown>)?.code === 'alias_version_conflict')
        ) {
          message.warning(t('keys.rename_conflict'));
          await queryClient.invalidateQueries({ queryKey: ['management-client-keys'] });
          throw error;
        }
        const detail = error instanceof ApiError ? error.message : String(error);
        message.error(detail || t('keys.rename_control'));
        throw error;
      }
    },
    [message, queryClient, t],
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

  return (
    <div className={`terminal-page keys-page ${styles['page-container']}`}>
      <header className={`terminal-page-head ${styles['header-row']}`}>
        <div>
          <h1 className="terminal-title">{t('keys.title')}</h1>
        </div>
        <div className={`request-actions ${styles['header-actions']}`}>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingIndex(null);
              setKeyInput('');
              setAliasInput('');
              setModalOpen(true);
            }}
          >
            {t('cfg.api_keys_add')}
          </Button>
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
        </div>
      </header>

      {saveError && (
        <Alert
          type="error"
          showIcon
          closable={{ onClose: () => setSaveError(null) }}
          description={saveError}
          style={{ marginBottom: 16 }}
        />
      )}

      {conflictRevision && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          description={t('cfg.dirty_bar_unsaved')}
          style={{ marginBottom: 16 }}
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

      {configQuery.isPending && !rawYaml ? (
        <Card size="small" className="config-card">
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      ) : configQuery.isError && !rawYaml ? (
        <Card size="small" className="config-card">
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
        </Card>
      ) : (
        <Card size="small" className="config-card">
          <ApiKeysEditor
            apiKeys={currentApiKeys}
            disabledKeys={disabledKeys}
            pendingAliases={pendingAliases}
            metadata={keysQuery.data?.keys}
            usage={usageByFingerprint}
            formatTime={formatUsageTime}
            usageRangeLabel={t('keys.usage_range')}
            onChange={writeKeys}
            onToggleDisable={handleToggleDisable}
            onDelete={handleDeleteRecord}
            onRename={renameKey}
            onViewRequests={viewRequestsFor}
            onAdd={() => {
              setEditingIndex(null);
              setKeyInput('');
              setAliasInput('');
              setModalOpen(true);
            }}
            onEdit={(index, key) => {
              setEditingIndex(index);
              setKeyInput(key);
              const existingAlias = pendingAliases[key] ?? keysQuery.data?.keys?.[index]?.alias ?? '';
              setAliasInput(existingAlias);
              setModalOpen(true);
            }}
          />
        </Card>
      )}

      {/* Floating Dirty Bar for unsaved drafts */}
      <ConfigDirtyBar
        isDirty={isDirty}
        isSaving={saveMutation.isPending}
        onSave={saveKeys}
        onDiscard={discardChanges}
      />

      {/* Add / Edit Key Modal */}
      <Modal
        title={editingIndex !== null ? t('cfg.api_keys_edit') : t('cfg.api_keys_add')}
        open={modalOpen}
        onOk={handleSaveKey}
        okButtonProps={{ disabled: !keyInput.trim() }}
        onCancel={() => {
          setModalOpen(false);
          setKeyInput('');
          setAliasInput('');
          setEditingIndex(null);
        }}
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

          <label className="keys-key-editor-label" htmlFor="gateway-key-value" style={{ marginTop: 8 }}>
            <KeyOutlined /> {t('keys.modal_label')}
          </label>
          <Input.Password
            id="gateway-key-value"
            placeholder="sk-..."
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onPressEnter={handleSaveKey}
            className="config-mono-input"
            autoFocus
          />
          <Text type="secondary" className="keys-key-editor-hint">{t('keys.modal_hint')}</Text>
          <div className="keys-key-editor-actions">
            <Button size="small" type="dashed" onClick={handleGenerateKey}>
              {t('cfg.api_keys_generate')}
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              disabled={!keyInput.trim()}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(keyInput.trim());
                  message.success(t('cfg.source_copy_success'));
                } catch {
                  message.error(t('cfg.copy_failed'));
                }
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
