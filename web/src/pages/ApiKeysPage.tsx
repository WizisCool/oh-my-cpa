import React from 'react';
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
import { ReloadOutlined, SaveOutlined, UndoOutlined, WarningOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { ApiKeysEditor } from '../components/config/ApiKeysEditor';
import { updateFieldWithBaseline, isConfigSemanticallyEqual } from '../components/config/configDirty';
import { ALL_CONFIG_FIELDS } from '../types/configSchema';
import type { ConfigScalarsResponse } from '../types/configManagement';

const { Text } = Typography;

/**
 * ApiKeysPage owns the gateway client API keys as their own surface.
 *
 * The keys are part of CPA's configuration document (`api-keys`), not a separate
 * store. This page therefore edits a draft of that document and saves it with the
 * same revision-guarded transaction the configuration workbench uses, rather than
 * calling the immediate `/management/api-keys` mutations: those write through a
 * different path, and switching to them would change when and how unrelated
 * configuration is persisted. Nothing outside the key list is ever modified - the
 * draft starts as the server's own copy and only that one field is touched - so
 * the rest of the document, including its comments and unknown keys, survives.
 */
export const ApiKeysPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  const configQuery = useQuery<ConfigScalarsResponse>({
    queryKey: ['management-config'],
    queryFn: () => api.getConfigScalars(),
    staleTime: 60_000,
  });

  const [rawYaml, setRawYaml] = React.useState('');
  const [serverYaml, setServerYaml] = React.useState('');
  const [serverRevision, setServerRevision] = React.useState('');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [conflictRevision, setConflictRevision] = React.useState<string | null>(null);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editingIndex, setEditingIndex] = React.useState<number | null>(null);
  const [keyInput, setKeyInput] = React.useState('');

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
    // Same rule as the configuration workbench: adopt the server's copy as the
    // baseline, but never overwrite a draft that is already being edited.
    const hasDraft = rawYamlRef.current !== serverYamlRef.current;
    setServerYaml(safe);
    setServerRevision(revision);
    try {
      serverDocRef.current = parseDocument(safe);
    } catch {
      // A malformed document is expected here: the previous baseline stays.
    }
    if (hasDraft) return;
    setRawYaml(safe);
    try {
      docRef.current = parseDocument(safe);
    } catch {
      // A malformed document is expected here: the previous baseline stays.
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
    const value = docRef.current.getIn(apiKeysField.yamlPath);
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
    onSuccess: (data, variables) => {
      message.success(t('keys.saved'));
      setServerYaml(variables.yamlToSave);
      setServerRevision(data.revision);
      try {
        serverDocRef.current = parseDocument(variables.yamlToSave);
      } catch {
        // A malformed document is expected here: the previous baseline stays.
      }
      void queryClient.invalidateQueries({ queryKey: ['management-config'] });
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
      // A malformed document is expected here: the previous baseline stays.
    }
    setSaveError(null);
    setConflictRevision(null);
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
      // Reverting to the server's exact text when nothing changed keeps a
      // formatting artefact from presenting itself as an unsaved edit.
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
    const trimmed = keyInput.trim();
    if (!trimmed) {
      message.warning(t('cfg.api_key_empty_warning'));
      return;
    }
    const next = [...currentApiKeys];
    if (editingIndex !== null && editingIndex >= 0) next[editingIndex] = trimmed;
    else next.push(trimmed);
    writeKeys(next);
    setModalOpen(false);
    setKeyInput('');
    setEditingIndex(null);
  };

  const handleGenerateKey = () => {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    setKeyInput(`sk-cpa-${randomHex}`);
  };

  const handleReloadServerVersion = () => {
    setConflictRevision(null);
    setRawYaml(serverYaml);
    try {
      docRef.current = parseDocument(serverYaml);
    } catch {
      // A malformed document is expected here: the previous baseline stays.
    }
  };

  return (
    <div className="terminal-page keys-page">
      <header className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('keys.title')}</h1>
          <p className="terminal-subtitle">{t('keys.subtitle')}</p>
        </div>
        <div className="request-actions">
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
            <Button size="small" icon={<UndoOutlined />} disabled={saveMutation.isPending} onClick={discardChanges}>
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
        <>
          <Card size="small" className="config-card">
            <ApiKeysEditor
              apiKeys={currentApiKeys}
              onChange={writeKeys}
              onAdd={() => {
                setEditingIndex(null);
                setKeyInput('');
                setModalOpen(true);
              }}
              onEdit={(index, key) => {
                setEditingIndex(index);
                setKeyInput(key);
                setModalOpen(true);
              }}
            />
          </Card>
          <p className="terminal-subtitle" style={{ marginTop: 12 }}>
            <Text type="secondary">{t('keys.persist_note')}</Text>
          </p>
        </>
      )}

      <Modal
        title={editingIndex !== null ? t('cfg.api_keys_edit') : t('cfg.api_keys_add')}
        open={modalOpen}
        onOk={handleSaveKey}
        onCancel={() => {
          setModalOpen(false);
          setKeyInput('');
          setEditingIndex(null);
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnHidden
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <Input.Password
            placeholder="sk-..."
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onPressEnter={handleSaveKey}
            className="config-mono-input"
            autoFocus
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button size="small" type="dashed" onClick={handleGenerateKey}>
              {t('cfg.api_keys_generate')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
