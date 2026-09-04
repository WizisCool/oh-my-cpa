import React, { useRef } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  FormatPainterOutlined,
  GlobalOutlined,
  KeyOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  ProfileOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseDocument, type Document } from 'yaml';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { useThemeMode } from '../theme/ThemeContext';
import { ConfigDirtyBar } from '../components/config/ConfigDirtyBar';
import { PayloadRulesEditor, type PayloadValidationIssue } from '../components/config/PayloadRulesEditor';
import { updateFieldWithBaseline, isConfigSemanticallyEqual } from '../components/config/configDirty';
import { maskKeyText } from '../utils/maskKey';
import type { YamlSourceEditorRef } from '../components/config/YamlSourceEditor';

const YamlSourceEditor = React.lazy(() => import('../components/config/YamlSourceEditor'));
import {
  ALL_CONFIG_FIELDS,
  CONFIG_SECTIONS,
  CONFIG_GROUPS,
  getGroupsForSection,
  type ConfigFieldDefinition,
  type ConfigGroupDefinition,
  type ConfigSectionId,
} from '../types/configSchema';
import type { ConfigScalarsResponse } from '../types/configManagement';

const { Text } = Typography;

interface ApiKeyRecord {
  id: string;
  index: number;
  key: string;
}

interface ApiKeysCardProps {
  apiKeys: string[];
  onAdd: () => void;
  onEdit: (index: number, key: string) => void;
  onDelete: (index: number) => void;
}

const ConfigApiKeysCard: React.FC<ApiKeysCardProps> = ({
  apiKeys,
  onAdd,
  onEdit,
  onDelete,
}) => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const [revealedKeys, setRevealedKeys] = React.useState<Record<number, boolean>>({});

  const dataSource: ApiKeyRecord[] = apiKeys.map((key, index) => ({
    id: `${index}-${key}`,
    index,
    key,
  }));

  return (
    <div className="settings-group">
      <div className="settings-group-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KeyOutlined />
          <h3 className="settings-group-title">{t('cfg.api_keys_list')}</h3>
          <Tag style={{ margin: 0 }}>{t('cfg.api_keys_count', { n: apiKeys.length })}</Tag>
        </div>
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={onAdd}
          className="config-add-key-btn"
        >
          {t('cfg.api_keys_add')}
        </Button>
      </div>
      <Table<ApiKeyRecord>
        className="config-api-keys-table"
        size="small"
        rowKey="id"
        showHeader={false}
        dataSource={dataSource}
        pagination={false}
        locale={{ emptyText: t('cfg.api_keys_empty') }}
        columns={[
          {
            dataIndex: 'index',
            key: 'index',
            width: 70,
            render: (idx: number) => (
              <Text strong className="mono-num">
                #{idx + 1}
              </Text>
            ),
          },
          {
            dataIndex: 'key',
            key: 'key',
            render: (rawKey: string, record: ApiKeyRecord) => (
              <div className="config-key-box">
                <span className="config-key-text">
                  {revealedKeys[record.index] ? rawKey : maskKeyText(rawKey)}
                </span>
              </div>
            ),
          },
          {
            key: 'actions',
            width: 176,
            align: 'right' as const,
            render: (_: unknown, record: ApiKeyRecord) => (
              <Space size={6}>
                <Tooltip title={revealedKeys[record.index] ? t('common.hide_secret') : t('common.reveal_secret')}>
                  <button
                    type="button"
                    className="config-key-action"
                    onClick={() =>
                      setRevealedKeys((prev) => ({
                        ...prev,
                        [record.index]: !prev[record.index],
                      }))
                    }
                    aria-label={revealedKeys[record.index] ? t('common.hide_secret') : t('common.reveal_secret')}
                  >
                    {revealedKeys[record.index] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                  </button>
                </Tooltip>
                <Tooltip title={t('cfg.api_keys_copy')}>
                  <button
                    type="button"
                    className="config-key-action"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(record.key);
                        message.success(t('cfg.source_copy_success'));
                      } catch {
                        message.error(t('cfg.copy_failed'));
                      }
                    }}
                    aria-label={t('cfg.api_keys_copy')}
                  >
                    <CopyOutlined />
                  </button>
                </Tooltip>
                <Tooltip title={t('cfg.api_keys_edit')}>
                  <button
                    type="button"
                    className="config-key-action"
                    onClick={() => onEdit(record.index, record.key)}
                    aria-label={t('cfg.api_keys_edit')}
                  >
                    <EditOutlined />
                  </button>
                </Tooltip>
                <Popconfirm
                  title={t('cfg.api_keys_delete_confirm')}
                  onConfirm={() => onDelete(record.index)}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                >
                  <Tooltip title={t('cfg.api_keys_delete')}>
                    <button
                      type="button"
                      className="config-key-action is-danger"
                      aria-label={t('cfg.api_keys_delete')}
                    >
                      <DeleteOutlined />
                    </button>
                  </Tooltip>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
};

export const ConfigPage: React.FC = () => {
  const t = useT();
  const { message, modal } = AntdApp.useApp();
  const { themeMode } = useThemeMode();
  const queryClient = useQueryClient();
  const editorRef = useRef<YamlSourceEditorRef | null>(null);

  const [viewMode, setViewMode] = React.useState<'visual' | 'source'>('visual');
  const [activeSection, setActiveSection] = React.useState<ConfigSectionId>('connectivity');
  const [searchQuery, setSearchQuery] = React.useState<string>('');

  const configQuery = useQuery<ConfigScalarsResponse>({
    queryKey: ['management-config'],
    queryFn: () => api.getConfigScalars(),
    staleTime: 60000,
  });

  const [grantToken, setGrantToken] = React.useState<string | null>(null);
  const [grantExpiresAt, setGrantExpiresAt] = React.useState<number | null>(null);
  const [isReauthModalOpen, setIsReauthModalOpen] = React.useState(false);
  const [reauthPassword, setReauthPassword] = React.useState('');
  const [reauthLoading, setReauthLoading] = React.useState(false);

  const [rawYaml, setRawYaml] = React.useState<string>('');
  const [serverYaml, setServerYaml] = React.useState<string>('');
  const [serverRevision, setServerRevision] = React.useState<string>('');
  const [conflictState, setConflictState] = React.useState<{ currentRevision: string } | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const docRef = React.useRef<Document | null>(null);
  const serverDocRef = React.useRef<Document | null>(null);

  React.useEffect(() => {
    if (viewMode === 'visual' && configQuery.data?.safe_yaml !== undefined) {
      const safe = configQuery.data.safe_yaml;
      setRawYaml(safe);
      setServerYaml(safe);
      setServerRevision(configQuery.data.revision || '');
      try {
        docRef.current = parseDocument(safe);
        serverDocRef.current = parseDocument(safe);
      } catch {
        // syntax error in yaml
      }
    }
  }, [configQuery.data?.safe_yaml, configQuery.data?.revision, viewMode]);

  const isDirty = rawYaml !== serverYaml;

  const updateFieldInDoc = React.useCallback(
    (field: ConfigFieldDefinition, value: unknown) => {
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

      updateFieldWithBaseline(currentDoc, serverDocRef.current, field, value);

      // If after update, currentDoc is semantically identical to serverDoc across all fields and payload,
      // revert rawYaml completely back to serverYaml so no formatting artifacts trigger dirty!
      if (serverDocRef.current && isConfigSemanticallyEqual(currentDoc, serverDocRef.current, ALL_CONFIG_FIELDS)) {
        setRawYaml(serverYaml);
        docRef.current = parseDocument(serverYaml);
      } else {
        const nextYaml = currentDoc.toString();
        setRawYaml(nextYaml);
      }
    },
    [rawYaml, serverYaml, message, t],
  );

  const getFieldValue = React.useCallback(
    (field: ConfigFieldDefinition): unknown => {
      if (!docRef.current) {
        try {
          docRef.current = parseDocument(rawYaml || '');
        } catch {
          return field.defaultValue;
        }
      }
      const val = docRef.current.getIn(field.yamlPath);
      if (val === undefined || val === null) {
        return field.defaultValue;
      }
      if (typeof val === 'object' && 'toJSON' in val && typeof (val as { toJSON: () => unknown }).toJSON === 'function') {
        return (val as { toJSON: () => unknown }).toJSON();
      }
      return val;
    },
    [rawYaml],
  );

  const saveMutation = useMutation({
    mutationFn: async ({ yamlToSave, revision }: { yamlToSave: string; revision: string }) => {
      setSaveError(null);
      setConflictState(null);
      return api.updateConfigSource(yamlToSave, revision);
    },
    onSuccess: (data, variables) => {
      message.success(t('cfg.source_save_success'));
      setServerYaml(variables.yamlToSave);
      setServerRevision(data.revision);
      try {
        serverDocRef.current = parseDocument(variables.yamlToSave);
      } catch {
        // ignore
      }
      setPayloadIssues([]);
      setShowErrorFeedback(false);
      setValidateTrigger(0);
      void queryClient.invalidateQueries({ queryKey: ['management-config'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && (err.status === 409 || (err.data as Record<string, unknown>)?.code === 'config_conflict')) {
        const currentRev = String((err.data as Record<string, unknown>)?.current_revision || '');
        setConflictState({ currentRevision: currentRev });
        return;
      }
      const msg = err instanceof ApiError ? err.message : String(err);
      setSaveError(msg);
      message.error(msg);
    },
  });

  const [validateTrigger, setValidateTrigger] = React.useState(0);
  const [showErrorFeedback, setShowErrorFeedback] = React.useState(false);

  const handleDiscardChanges = React.useCallback(() => {
    setRawYaml(serverYaml);
    try {
      docRef.current = parseDocument(serverYaml);
      serverDocRef.current = parseDocument(serverYaml);
    } catch {
      // ignore
    }
    setSaveError(null);
    setPayloadIssues([]);
    setShowErrorFeedback(false);
    setValidateTrigger(0);
  }, [serverYaml]);

  const [payloadIssues, setPayloadIssues] = React.useState<PayloadValidationIssue[]>([]);

  const hasYamlErrors = React.useMemo(() => {
    try {
      const doc = parseDocument(rawYaml);
      return Boolean(doc.errors && doc.errors.length > 0);
    } catch {
      return true;
    }
  }, [rawYaml]);

  const hasConfigErrors = hasYamlErrors || payloadIssues.length > 0;

  const handleSaveChanges = React.useCallback(() => {
    if (isDirty && !saveMutation.isPending && !hasConfigErrors && !configQuery.isError) {
      saveMutation.mutate({ yamlToSave: rawYaml, revision: serverRevision });
    }
  }, [isDirty, hasConfigErrors, configQuery.isError, rawYaml, serverRevision, saveMutation]);

  const requestSaveConfirmation = React.useCallback(() => {
    if (!isDirty || saveMutation.isPending) return;

    if (hasYamlErrors) {
      setShowErrorFeedback(true);
      message.error(t('cfg.dirty_bar_yaml_error'));
      return;
    }

    if (payloadIssues.length > 0) {
      setValidateTrigger((v) => v + 1);
      setShowErrorFeedback(true);
      message.warning(t('cfg.dirty_bar_payload_issues', { n: payloadIssues.length }));
      return;
    }

    modal.confirm({
      title: t('cfg.source_save_confirm'),
      content: t('cfg.source_save_confirm_desc'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => {
        handleSaveChanges();
      },
    });
  }, [isDirty, saveMutation.isPending, hasYamlErrors, payloadIssues.length, handleSaveChanges, modal, message, t]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        requestSaveConfirmation();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestSaveConfirmation]);

  const handleViewModeChange = async (targetMode: 'visual' | 'source') => {
    if (targetMode === 'source') {
      if (!grantToken || (grantExpiresAt && Date.now() > grantExpiresAt)) {
        setIsReauthModalOpen(true);
        return;
      }
      try {
        const src = await api.getConfigSource(grantToken);
        setRawYaml(src.yaml);
        setServerYaml(src.yaml);
        setServerRevision(src.revision);
        try {
          docRef.current = parseDocument(src.yaml);
          serverDocRef.current = parseDocument(src.yaml);
        } catch {
          // ignore
        }
        setViewMode('source');
      } catch {
        setIsReauthModalOpen(true);
      }
    } else {
      setViewMode('visual');
      queryClient.removeQueries({ queryKey: ['management-config-source'] });
      void configQuery.refetch();
    }
  };

  const handleReauthConfirm = async () => {
    if (!reauthPassword.trim()) {
      message.warning(t('cfg.reveal_modal_password_placeholder'));
      return;
    }
    setReauthLoading(true);
    try {
      const res = await api.grantConfigSourceReveal(reauthPassword);
      setGrantToken(res.grant_token);
      setGrantExpiresAt(Date.now() + res.expires_in_seconds * 1000);
      setIsReauthModalOpen(false);
      setReauthPassword('');
      const src = await api.getConfigSource(res.grant_token);
      setRawYaml(src.yaml);
      setServerYaml(src.yaml);
      setServerRevision(src.revision);
      try {
        docRef.current = parseDocument(src.yaml);
        serverDocRef.current = parseDocument(src.yaml);
      } catch {
        // ignore
      }
      setViewMode('source');
      message.success(t('cfg.mode_source'));
    } catch {
      message.error(t('cfg.reveal_grant_failed'));
    } finally {
      setReauthLoading(false);
    }
  };

  // ── API Keys Management ──────────────────────────────────────────────────
  const [apiKeyModalOpen, setApiKeyModalOpen] = React.useState(false);
  const [editingKeyIndex, setEditingKeyIndex] = React.useState<number | null>(null);
  const [apiKeyInput, setApiKeyInput] = React.useState('');

  const currentApiKeys: string[] = React.useMemo(() => {
    const raw = getFieldValue(ALL_CONFIG_FIELDS.find((f) => f.id === 'apiKeys')!);
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string' && raw) return [raw];
    return [];
  }, [getFieldValue]);

  const handleSaveApiKey = () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      message.warning(t('cfg.api_key_empty_warning'));
      return;
    }
    const next = [...currentApiKeys];
    if (editingKeyIndex !== null && editingKeyIndex >= 0) {
      next[editingKeyIndex] = trimmed;
    } else {
      next.push(trimmed);
    }
    const apiKeysField = ALL_CONFIG_FIELDS.find((f) => f.id === 'apiKeys')!;
    updateFieldInDoc(apiKeysField, next);
    setApiKeyModalOpen(false);
    setApiKeyInput('');
    setEditingKeyIndex(null);
  };

  const handleDeleteApiKey = (index: number) => {
    const next = currentApiKeys.filter((_, i) => i !== index);
    const apiKeysField = ALL_CONFIG_FIELDS.find((f) => f.id === 'apiKeys')!;
    updateFieldInDoc(apiKeysField, next);
  };

  const handleGenerateKey = () => {
    const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    setApiKeyInput(`sk-cpa-${randomHex}`);
  };

  // Section icons helper
  const sectionIcon = (id: ConfigSectionId) => {
    switch (id) {
      case 'connectivity':
        return <KeyOutlined />;
      case 'network':
        return <GlobalOutlined />;
      case 'logging':
        return <ProfileOutlined />;
      case 'quota':
        return <FieldTimeOutlined />;
      case 'streaming':
        return <NodeIndexOutlined />;
      case 'advanced':
        return <ExperimentOutlined />;
      case 'payload':
        return <CodeOutlined />;
    }
  };

  const currentSectionDef = React.useMemo(() => {
    return CONFIG_SECTIONS.find((s) => s.id === activeSection) ?? CONFIG_SECTIONS[0];
  }, [activeSection]);

  // Matching fields grouped by semantic group for search view
  const searchMatchedGroups = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const results: { group: ConfigGroupDefinition; matchedFieldIds: string[] }[] = [];
    for (const grp of CONFIG_GROUPS) {
      const matched = grp.fieldIds.filter((fid) => {
        const f = ALL_CONFIG_FIELDS.find((item) => item.id === fid);
        if (!f) return false;
        const label = t(f.labelKey).toLowerCase();
        const desc = t(f.descKey).toLowerCase();
        const yamlKey = f.yamlPath.join('.').toLowerCase();
        const keywords = (f.keywords ?? []).join(' ').toLowerCase();
        return label.includes(q) || desc.includes(q) || yamlKey.includes(q) || keywords.includes(q);
      });
      if (matched.length > 0) {
        results.push({ group: grp, matchedFieldIds: matched });
      }
    }
    return results;
  }, [searchQuery, t]);

  const totalSearchMatches = React.useMemo(() => {
    return searchMatchedGroups.reduce((acc, g) => acc + g.matchedFieldIds.length, 0);
  }, [searchMatchedGroups]);

  // Render individual input/select/switch control
  const renderFieldControl = (field: ConfigFieldDefinition, disabled = false) => {
    const val = getFieldValue(field);

    if (field.type === 'switch') {
      return (
        <Switch
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          checked={Boolean(val)}
          disabled={disabled}
          onChange={(checked) => updateFieldInDoc(field, checked)}
        />
      );
    }

    if (field.type === 'string') {
      return (
        <Input
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          className="config-mono-input"
          allowClear
          disabled={disabled}
          placeholder={field.placeholderKey ? (field.placeholderKey.startsWith('cfg.') ? t(field.placeholderKey) : field.placeholderKey) : ''}
          value={String(val ?? '')}
          onChange={(e) => updateFieldInDoc(field, e.target.value)}
        />
      );
    }

    if (field.type === 'number') {
      return (
        <div className="settings-number-control">
          <InputNumber
            id={`cfg-${field.id}`}
            aria-describedby={`desc-${field.id}`}
            className="config-mono-input"
            min={field.min ?? 0}
            max={field.max}
            disabled={disabled}
            value={typeof val === 'number' ? val : Number(val) || 0}
            onChange={(num) => updateFieldInDoc(field, num ?? 0)}
          />
          {field.unitKey && (
            <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {t(field.unitKey)}
            </Text>
          )}
        </div>
      );
    }

    if (field.type === 'select') {
      return (
        <Select
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          disabled={disabled}
          value={String(val ?? field.defaultValue ?? '')}
          options={(field.options ?? []).map((opt) => ({
            value: opt.value,
            label: t(opt.labelKey),
          }))}
          onChange={(selected) => updateFieldInDoc(field, selected)}
        />
      );
    }

    if (field.type === 'json_editor') {
      return (
        <Input.TextArea
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          rows={2}
          className="config-mono-textarea"
          placeholder="{}"
          disabled={disabled}
          value={typeof val === 'object' && val !== null ? JSON.stringify(val, null, 2) : String(val ?? '')}
          onChange={(e) => {
            const str = e.target.value;
            try {
              const parsed = JSON.parse(str);
              updateFieldInDoc(field, parsed);
            } catch {
              updateFieldInDoc(field, str);
            }
          }}
        />
      );
    }

    if (field.type === 'textarea') {
      return (
        <Input.TextArea
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          rows={3}
          className="config-mono-textarea"
          disabled={disabled}
          placeholder={field.placeholderKey ? (field.placeholderKey.startsWith('cfg.') ? t(field.placeholderKey) : field.placeholderKey) : ''}
          value={String(val ?? '')}
          onChange={(e) => updateFieldInDoc(field, e.target.value)}
        />
      );
    }

    return null;
  };

  // Variant 1: Grid Field (Label on top, input below)
  const renderGridField = (field: ConfigFieldDefinition, disabled = false) => {
    const isFull =
      field.type === 'textarea' ||
      field.type === 'json_editor' ||
      field.id === 'proxyUrl' ||
      field.id === 'authDir' ||
      field.id === 'logDir' ||
      field.id === 'rmSecretKey' ||
      field.id === 'corsOrigins';

    return (
      <div key={field.id} className={`settings-field${isFull ? ' is-full' : ''}`}>
        <label htmlFor={`cfg-${field.id}`} className="settings-field-label">
          <span>{t(field.labelKey)}</span>
        </label>
        <div id={`desc-${field.id}`} className="settings-field-desc">
          {t(field.descKey)}
        </div>
        <div className={`settings-field-control is-${field.type}`}>
          {renderFieldControl(field, disabled)}
        </div>
      </div>
    );
  };

  // Variant 2: Toggle Row (Title/desc on left, control on right)
  const renderToggleRow = (field: ConfigFieldDefinition, disabled = false) => {
    return (
      <div key={field.id} className="settings-toggle-row">
        <div className="settings-toggle-info">
          <label htmlFor={`cfg-${field.id}`} className="settings-toggle-title">
            {t(field.labelKey)}
          </label>
          <div id={`desc-${field.id}`} className="settings-toggle-desc">
            {t(field.descKey)}
          </div>
        </div>
        <div className={`settings-toggle-control is-${field.type}`}>
          {renderFieldControl(field, disabled)}
        </div>
      </div>
    );
  };

  // Render a cohesive Setting Group Panel
  const renderGroupPanel = (grp: ConfigGroupDefinition, visibleFieldIds?: string[]) => {
    const rawFields = grp.fieldIds
      .map((fid) => ALL_CONFIG_FIELDS.find((f) => f.id === fid))
      .filter((f): f is ConfigFieldDefinition => Boolean(f));

    const groupFields = visibleFieldIds
      ? rawFields.filter((f) => visibleFieldIds.includes(f.id))
      : rawFields;

    if (groupFields.length === 0) return null;

    // Entity List variant (e.g. API Keys)
    if (grp.variant === 'entity-list') {
      return (
        <ConfigApiKeysCard
          key={grp.id}
          apiKeys={currentApiKeys}
          onAdd={() => {
            setEditingKeyIndex(null);
            setApiKeyInput('');
            setApiKeyModalOpen(true);
          }}
          onEdit={(idx, k) => {
            setEditingKeyIndex(idx);
            setApiKeyInput(k);
            setApiKeyModalOpen(true);
          }}
          onDelete={handleDeleteApiKey}
        />
      );
    }

    // Payload Builder variant (structured JSON rules for models and parameters)
    if (grp.variant === 'payload-builder') {
      return (
        <div key={grp.id} className="settings-group payload-builder-group">
          <div className="settings-group-head">
            <div>
              <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
              {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
            </div>
          </div>
          <div className="settings-group-body">
            <PayloadRulesEditor
              doc={docRef.current}
              onDocChange={() => {
                if (docRef.current) {
                  // Check semantic equality with serverDocRef before setting rawYaml
                  if (serverDocRef.current && isConfigSemanticallyEqual(docRef.current, serverDocRef.current, ALL_CONFIG_FIELDS)) {
                    setRawYaml(serverYaml);
                    docRef.current = parseDocument(serverYaml);
                  } else {
                    setRawYaml(docRef.current.toString());
                  }
                }
              }}
              onValidationChange={setPayloadIssues}
              validateTrigger={validateTrigger}
            />
          </div>
        </div>
      );
    }

    // TLS Accordion variant
    if (grp.variant === 'tls-accordion') {
      const tlsEnableField = ALL_CONFIG_FIELDS.find((f) => f.id === 'tlsEnable');
      const tlsCertField = ALL_CONFIG_FIELDS.find((f) => f.id === 'tlsCert');
      const tlsKeyField = ALL_CONFIG_FIELDS.find((f) => f.id === 'tlsKey');
      const tlsEnabled = tlsEnableField ? Boolean(getFieldValue(tlsEnableField)) : false;

      // If user searched for cert or key directly, open the panel
      const isSearchActive = Boolean(visibleFieldIds);
      const isOpen = isSearchActive ? true : tlsEnabled;

      return (
        <div key={grp.id} className="settings-group">
          <div className="settings-group-head">
            <div>
              <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
              {grp.descKey && (
                <p id="desc-tlsEnable" className="settings-group-desc">
                  {t(grp.descKey)}
                </p>
              )}
            </div>
            {tlsEnableField && (!visibleFieldIds || visibleFieldIds.includes('tlsEnable')) && (
              <div className="settings-toggle-control is-switch">
                {renderFieldControl(tlsEnableField)}
              </div>
            )}
          </div>
          <div className={`settings-tls-body${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
            <div className="settings-tls-inner">
              <div className="settings-form-grid">
                {tlsCertField && (!visibleFieldIds || visibleFieldIds.includes('tlsCert')) && renderGridField(tlsCertField, !isOpen)}
                {tlsKeyField && (!visibleFieldIds || visibleFieldIds.includes('tlsKey')) && renderGridField(tlsKeyField, !isOpen)}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Settings List variant (toggle switches and flags)
    if (grp.variant === 'settings-list') {
      return (
        <div key={grp.id} className="settings-group">
          <div className="settings-group-head">
            <div>
              <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
              {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
            </div>
          </div>
          <div className="settings-list-rows">
            {groupFields.map((f) => renderToggleRow(f))}
          </div>
        </div>
      );
    }

    // Default: Form Grid variant
    const hasHost = groupFields.some((f) => f.id === 'host');
    const hasPort = groupFields.some((f) => f.id === 'port');
    const hostField = ALL_CONFIG_FIELDS.find((f) => f.id === 'host');
    const portField = ALL_CONFIG_FIELDS.find((f) => f.id === 'port');
    const combineHostPort = hasHost && hasPort && !visibleFieldIds;

    return (
      <div key={grp.id} className="settings-group">
        <div className="settings-group-head">
          <div>
            <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
            {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
          </div>
        </div>
        <div className="settings-group-body">
          <div className="settings-form-grid">
            {combineHostPort && hostField && portField && (
              <div key="host-port-combo" className="settings-field-host-port">
                <div className="settings-field">
                  <label htmlFor="cfg-host" className="settings-field-label">
                    <span>{t(hostField.labelKey)}</span>
                  </label>
                  <div id="desc-host" className="settings-field-desc">
                    {t(hostField.descKey)}
                  </div>
                  <div className="settings-field-control">{renderFieldControl(hostField)}</div>
                </div>
                <div className="settings-field">
                  <label htmlFor="cfg-port" className="settings-field-label">
                    <span>{t(portField.labelKey)}</span>
                  </label>
                  <div id="desc-port" className="settings-field-desc">
                    {t(portField.descKey)}
                  </div>
                  <div className="settings-field-control">{renderFieldControl(portField)}</div>
                </div>
              </div>
            )}
            {groupFields
              .filter((f) => (combineHostPort ? f.id !== 'host' && f.id !== 'port' : true))
              .map((f) => renderGridField(f))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="terminal-page config-page">
      {/* ── Full-Width Sticky Toolbar (贯通全屏，右侧按钮对齐视口右边界) ─── */}
      <div className="config-toolbar">
        <div className="config-toolbar-left">
          <h1 className="terminal-title">{t('nav.config')}</h1>
          {configQuery.isPending && !rawYaml ? (
            <Tag className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.status_loading') })}</Tag>
          ) : configQuery.isError && !rawYaml ? (
            <Tag color="error" className="config-sync-badge">{t('cfg.status_error')}</Tag>
          ) : configQuery.isError && rawYaml ? (
            <Tag color="warning" className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.status_stale') })}</Tag>
          ) : isDirty ? (
            <Tag color="warning" className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.source_dirty') })}</Tag>
          ) : (
            <Tag color="success" className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.source_clean') })}</Tag>
          )}
          <Segmented
            size="small"
            value={viewMode}
            onChange={(val) => void handleViewModeChange(val as 'visual' | 'source')}
            options={[
              { value: 'visual', label: t('cfg.mode_visual'), icon: <AppstoreOutlined /> },
              { value: 'source', label: t('cfg.mode_source'), icon: <CodeOutlined /> },
            ]}
          />
        </div>

        <div className="config-toolbar-actions">
          {viewMode === 'visual' && (
            <Input
              size="small"
              className="config-search-input"
              prefix={<SearchOutlined />}
              allowClear
              placeholder={t('cfg.search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
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

          {/* 放弃更改按钮：不需要二次验证，直接执行 handleDiscardChanges */}
          {isDirty && (
            <Button
              size="small"
              icon={<UndoOutlined />}
              disabled={saveMutation.isPending}
              onClick={handleDiscardChanges}
            >
              {t('cfg.dirty_bar_discard')}
            </Button>
          )}

          {/* 保存配置按钮：需要二次验证 */}
          {hasConfigErrors ? (
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              loading={saveMutation.isPending}
              disabled={!isDirty}
              onClick={requestSaveConfirmation}
            >
              {t('cfg.source_save')}
            </Button>
          ) : (
            <Popconfirm
              title={t('cfg.source_save_confirm')}
              description={t('cfg.source_save_confirm_desc')}
              onConfirm={handleSaveChanges}
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
                {t('cfg.source_save')}
              </Button>
            </Popconfirm>
          )}
        </div>
      </div>

      {saveError && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setSaveError(null)}
          description={saveError}
          style={{ marginBottom: 16 }}
        />
      )}

      {configQuery.isError && (
        <Alert
          type="error"
          showIcon
          description={t('cfg.load_failed') + ' — ' + t('cfg.load_failed_desc')}
          action={
            <Button size="small" type="primary" onClick={() => void configQuery.refetch()}>
              {t('common.retry')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {configQuery.isPending && !rawYaml ? (
        <Card size="small" className="config-card">
          <Skeleton active paragraph={{ rows: 10 }} />
        </Card>
      ) : configQuery.isError && !rawYaml ? (
        <Card size="small" className="config-card">
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Alert type="warning" showIcon description={t('cfg.load_failed_desc')} />
          </div>
        </Card>
      ) : viewMode === 'visual' ? (
        /* ── Visual Mode: Two-column Setting Group Panels ───────────────── */
        <div className="config-workbench">
          {/* Left: Fixed Vertical Navigation (216px) */}
          <aside className="config-section-nav" aria-label={t('cfg.nav_aria')}>
            {CONFIG_SECTIONS.map((sec) => {
              const isActive = !searchQuery && activeSection === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  className={`config-nav-btn${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => {
                    setSearchQuery('');
                    setActiveSection(sec.id);
                  }}
                >
                  <span className="config-nav-btn-left">
                    {sectionIcon(sec.id)}
                    <span>{t(sec.labelKey)}</span>
                  </span>
                </button>
              );
            })}
          </aside>

          {/* Right: Focused Settings Group Canvas (max-width: 920px) */}
          <main className="config-main">
            <div className="config-section-header">
              <h2 className="config-section-title">
                {searchQuery
                  ? t('cfg.search_results', { n: totalSearchMatches, q: searchQuery })
                  : t(currentSectionDef.labelKey)}
              </h2>
              <p className="config-section-desc">
                {searchQuery ? t('cfg.search_placeholder') : t(currentSectionDef.descKey)}
              </p>
            </div>

            {searchQuery ? (
              /* Search Results: Grouped by semantic Setting Group Panels */
              <div className="settings-stack">
                {searchMatchedGroups.map((sg) => renderGroupPanel(sg.group, sg.matchedFieldIds))}
              </div>
            ) : (
              /* Standard Section Group Panels */
              <div className="settings-stack">
                {getGroupsForSection(activeSection).map((grp) => renderGroupPanel(grp))}
              </div>
            )}
          </main>
        </div>
      ) : (
        /* ── Source Mode: YAML Editor ───────────────────────────────────── */
        <div className="config-source-container">
          <div className="config-source-toolbar">
            <Space size={12}>
              <Tag color={isDirty ? 'warning' : 'success'}>
                {isDirty ? t('cfg.source_dirty') : t('cfg.source_clean')}
              </Tag>
              {rawYaml && (
                <Text type="secondary" className="mono-num">
                  {(new Blob([rawYaml]).size / 1024).toFixed(1)} KB · {t('cfg.lines_count', { n: rawYaml.split('\n').length })}
                </Text>
              )}
            </Space>
            <Space size={8}>
              <Button
                size="small"
                icon={<SearchOutlined />}
                disabled={!rawYaml}
                onClick={() => editorRef.current?.find()}
              >
                {t('cfg.source_find')}
              </Button>
              <Button
                size="small"
                icon={<FormatPainterOutlined />}
                disabled={!rawYaml}
                onClick={() => {
                  if (!editorRef.current) return;
                  editorRef.current
                    .formatDocument()
                    .then(() => {
                      message.success(t('cfg.source_format_success'));
                    })
                    .catch((err: unknown) => {
                      const errMsg = err instanceof Error ? err.message : '';
                      message.error(
                        errMsg
                          ? `${t('cfg.source_format_error')}: ${errMsg}`
                          : t('cfg.source_format_error')
                      );
                    });
                }}
              >
                {t('cfg.source_format')}
              </Button>
              <Button
                size="small"
                icon={<CopyOutlined />}
                disabled={!rawYaml}
                onClick={async () => {
                  await navigator.clipboard.writeText(rawYaml);
                  message.success(t('cfg.source_copy_success'));
                }}
              >
                {t('cfg.source_copy')}
              </Button>
            </Space>
          </div>

          <div className="config-editor-wrap">
            <React.Suspense
              fallback={
                <div className="config-monaco-loading">
                  <Skeleton active paragraph={{ rows: 14 }} />
                </div>
              }
            >
              <YamlSourceEditor
                value={rawYaml}
                onChange={(val) => {
                  setRawYaml(val);
                  try {
                    docRef.current = parseDocument(val);
                  } catch {
                    // user is still editing invalid YAML
                  }
                }}
                onSave={requestSaveConfirmation}
                themeMode={themeMode}
                editorRef={editorRef}
                loadingText={t('cfg.source_editor_loading')}
              />
            </React.Suspense>
          </div>

          <div className="config-source-hint">
            <Text type="secondary" style={{ fontSize: 11 }}>
              <kbd>Ctrl+S</kbd> / <kbd>Cmd+S</kbd> {t('cfg.save_shortcut', { key: '' })}
            </Text>
          </div>
        </div>
      )}

      {/* API Key Modal */}
      <Modal
        title={editingKeyIndex !== null ? t('cfg.api_keys_edit') : t('cfg.api_keys_add')}
        open={apiKeyModalOpen}
        onOk={handleSaveApiKey}
        onCancel={() => {
          setApiKeyModalOpen(false);
          setApiKeyInput('');
          setEditingKeyIndex(null);
        }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <Input.Password
            placeholder="sk-..."
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
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

      {/* Floating Bottom Dirty Action Bar */}
      <ConfigDirtyBar
        isDirty={isDirty}
        isSaving={saveMutation.isPending}
        yamlError={hasYamlErrors}
        payloadIssuesCount={payloadIssues.length}
        showErrorFeedback={showErrorFeedback}
        onSave={requestSaveConfirmation}
        onDiscard={handleDiscardChanges}
      />

      {/* ── Conflict Modal ────────────────────────────────────────────── */}
      <Modal
        open={Boolean(conflictState)}
        title={t('cfg.conflict_title')}
        footer={[
          <Button
            key="copy"
            icon={<CopyOutlined />}
            onClick={() => {
              void navigator.clipboard.writeText(rawYaml);
              message.success(t('cfg.api_keys_copy'));
            }}
          >
            {t('cfg.conflict_copy')}
          </Button>,
          <Button
            key="reload"
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => {
              setConflictState(null);
              void configQuery.refetch();
            }}
          >
            {t('cfg.conflict_reload')}
          </Button>,
        ]}
        onCancel={() => setConflictState(null)}
      >
        <Alert type="error" showIcon description={t('cfg.conflict_desc')} style={{ marginBottom: 16 }} />
      </Modal>

      {/* ── Source Mode Reauthentication Modal ──────────────────────────── */}
      <Modal
        open={isReauthModalOpen}
        title={t('cfg.reveal_modal_title')}
        onOk={() => void handleReauthConfirm()}
        onCancel={() => {
          setIsReauthModalOpen(false);
          setReauthPassword('');
        }}
        confirmLoading={reauthLoading}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <Alert type="warning" showIcon description={t('cfg.reveal_modal_desc')} style={{ marginBottom: 16 }} />
        <Input.Password
          placeholder={t('cfg.reveal_modal_password_placeholder')}
          value={reauthPassword}
          onChange={(e) => setReauthPassword(e.target.value)}
          onPressEnter={() => void handleReauthConfirm()}
          autoFocus
        />
      </Modal>
    </div>
  );
};
