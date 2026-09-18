import React, { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Tag,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  CodeOutlined,
  CopyOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  FormatPainterOutlined,
  GlobalOutlined,
  KeyOutlined,
  NodeIndexOutlined,
  ProfileOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseDocument, type Document } from 'yaml';
import { api, ApiError, apiErrorCode } from '../api/client';
import { useT } from '../i18n';
import { copyText } from '../utils/clipboard';
import { useThemeMode } from '../theme/ThemeContext';
import { ConfigDirtyBar } from '../components/config/ConfigDirtyBar';
import { PayloadRulesEditor, type PayloadValidationIssue } from '../components/config/PayloadRulesEditor';
import { updateFieldWithBaseline, isConfigSemanticallyEqual } from '../components/config/configDirty';
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

export const ConfigPage: React.FC = () => {
  const t = useT();
  const { message, modal } = AntdApp.useApp();
  const { themeId } = useThemeMode();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const editorRef = useRef<YamlSourceEditorRef | null>(null);

  const [viewMode, setViewMode] = React.useState<'visual' | 'source'>('visual');
  const [activeSection, setActiveSection] = React.useState<ConfigSectionId>('connectivity');
  const [searchQuery, setSearchQuery] = React.useState<string>('');

  const configQuery = useQuery<ConfigScalarsResponse>({
    queryKey: ['management-config'],
    queryFn: () => api.getConfigScalars(),
    staleTime: 60000,
  });

  const [rawYaml, setRawYaml] = React.useState<string>('');
  const [serverYaml, setServerYaml] = React.useState<string>('');
  const [serverRevision, setServerRevision] = React.useState<string>('');
  const [conflictState, setConflictState] = React.useState<{ currentRevision: string } | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const docRef = React.useRef<Document | null>(null);
  const serverDocRef = React.useRef<Document | null>(null);
  const rawYamlRef = React.useRef('');
  const serverYamlRef = React.useRef('');
  /** Guards against a second save starting before isPending propagates. */
  const saveInFlightRef = React.useRef(false);

  React.useEffect(() => {
    if (viewMode !== 'visual' || configQuery.data?.safe_yaml === undefined) return;
    const safe = configQuery.data.safe_yaml;
    const revision = configQuery.data.revision || '';
    // A refetch or an invalidation must never overwrite a draft the operator is
    // still writing. Saving snapshot A while they have already begun draft B has
    // to advance the saved baseline to A and leave B alone, so the baseline is
    // always adopted here and rawYaml is only replaced when there is no draft to
    // lose. Applying the server copy unconditionally was the bug: the save's own
    // invalidation would come back and silently discard the newer edits.
    const hasLocalEdits = rawYamlRef.current !== serverYamlRef.current;
    setServerYaml(safe);
    setServerRevision(revision);
    try {
      serverDocRef.current = parseDocument(safe);
    } catch {
      // A malformed document is expected here: the previous baseline stays in place.
    }
    if (hasLocalEdits) return;
    setRawYaml(safe);
    try {
      docRef.current = parseDocument(safe);
    } catch {
      // A malformed document is expected here: the previous baseline stays in place.
    }
  }, [configQuery.data?.safe_yaml, configQuery.data?.revision, viewMode]);

  // Mirrored into refs so the hydration effect and saveConfig can read the current
  // values without being re-created on every keystroke.
  rawYamlRef.current = rawYaml;
  serverYamlRef.current = serverYaml;

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
        // A malformed document is expected here: the previous baseline stays in place.
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
      // A configuration save shares the provider write gate, so it can now be
      // refused while a provider change is being written. The server's message for
      // that is English prose; the banner comes from the dictionary instead, like
      // every other user-visible string.
      const msg = apiErrorCode(err) === 'write_busy'
        ? t('cfg.save_busy')
        : err instanceof ApiError
          ? err.message
          : String(err);
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
      // A malformed document is expected here: the previous baseline stays in place.
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

  /**
   * saveConfig is the single save path for the whole page.
   *
   * Every entry point - the toolbar button, the bottom dirty bar and the keyboard
   * shortcut - ends here, so validation, the mutation, the conflict handling and
   * the baseline reset exist once. It reports validation problems itself rather
   * than returning silently, which is what lets a caller that owns its own
   * confirmation (a Popconfirm on the button) skip the extra global modal: the
   * operator already confirmed, so a second prompt would be asking the same
   * question twice.
   */
  const saveConfig = React.useCallback(() => {
    if (!isDirty || configQuery.isError) return Promise.resolve();
    // isPending lags a render, so a second activation in the same tick (a double
    // click, or Ctrl+S bubbling out of the editor) would start a second mutation
    // against the same revision and race the first one to the conflict check.
    if (saveInFlightRef.current || saveMutation.isPending) return Promise.resolve();
    if (hasYamlErrors) {
      setShowErrorFeedback(true);
      message.error(t('cfg.dirty_bar_yaml_error'));
      return Promise.resolve();
    }
    if (payloadIssues.length > 0) {
      setValidateTrigger((v) => v + 1);
      setShowErrorFeedback(true);
      message.warning(t('cfg.dirty_bar_payload_issues', { n: payloadIssues.length }));
      return Promise.resolve();
    }
    saveInFlightRef.current = true;
    // The promise is returned so a Popconfirm can hold its own loading state, and
    // it is settled here rather than left to the caller: a keyboard handler has
    // nobody to catch a rejection, and the mutation's onError already reports it.
    return saveMutation
      .mutateAsync({ yamlToSave: rawYaml, revision: serverRevision })
      .catch(() => undefined)
      .finally(() => {
        saveInFlightRef.current = false;
      });
  }, [
    isDirty,
    saveMutation,
    hasYamlErrors,
    payloadIssues.length,
    configQuery.isError,
    rawYaml,
    serverRevision,
    message,
    t,
  ]);

  /**
   * requestSaveConfirmation is for entry points that have no confirmation UI of
   * their own - Ctrl+S and the editor's own save hook. It asks once and then
   * calls the same saveConfig, so the keyboard cannot drift from the buttons.
   */
  const requestSaveConfirmation = React.useCallback(() => {
    if (!isDirty || saveMutation.isPending) return;
    if (hasYamlErrors || payloadIssues.length > 0 || configQuery.isError) {
      saveConfig();
      return;
    }
    modal.confirm({
      title: t('cfg.source_save_confirm'),
      content: t('cfg.source_save_confirm_desc'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => {
        // Returning the promise keeps the confirm dialog open until the save
        // settles, so a failure cannot look like it already succeeded.
        return saveConfig();
      },
    });
  }, [configQuery.isError, hasYamlErrors, isDirty, modal, payloadIssues.length, saveMutation.isPending, saveConfig, t]);

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

  /**
   * confirmDiscardDraft asks before a mode switch throws away unsaved edits.
   *
   * It resolves to whether the switch may proceed, so the caller can also use it
   * to decide when to *start* loading the other view: the source read must not
   * begin before the operator has accepted that its result replaces their draft.
   */
  const confirmDiscardDraft = React.useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        if (!(rawYamlRef.current !== serverYamlRef.current)) {
          resolve(true);
          return;
        }
        modal.confirm({
          title: t('cfg.source_switch_discard'),
          okText: t('common.confirm'),
          cancelText: t('common.cancel'),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [modal, t],
  );

  const handleViewModeChange = async (targetMode: 'visual' | 'source') => {
    // Disposition comes first: loading the other view and only then asking would
    // either discard silently or apply a stale response over a newer draft.
    if (!(await confirmDiscardDraft())) return;
    if (targetMode === 'source') {
      // Reading the raw source no longer demands the management key again: this
      // page is already behind the authenticated session, and the backend keeps
      // the audit and no-store boundary. A failure here is a real read failure.
      try {
        const src = await api.getConfigSource();
        setRawYaml(src.yaml);
        setServerYaml(src.yaml);
        setServerRevision(src.revision);
        try {
          docRef.current = parseDocument(src.yaml);
          serverDocRef.current = parseDocument(src.yaml);
        } catch {
          // A malformed document is expected here: the previous baseline stays in place.
        }
        setSaveError(null);
        setViewMode('source');
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        message.error(t('cfg.source_load_failed', { msg }));
      }
    } else {
      setViewMode('visual');
      queryClient.removeQueries({ queryKey: ['management-config-source'] });
      void configQuery.refetch();
    }
  };

  // ── API Keys ────────────────────────────────────────────
  // The key list is edited on its own page (/api-keys), which is the only editor
  // of that field (ADR 0010). What the configuration panel owns is the pointer to
  // it: a group that names the field, states how many keys are configured, and
  // leads there. Hiding the group instead - what this page did before - left the
  // panel silent about a field it owns. The `apiKeys` schema field itself stays:
  // the source view still renders the whole document, and semantic comparison of
  // that document still has to account for `api-keys`.
  const apiKeysField = React.useMemo(
    () => ALL_CONFIG_FIELDS.find((field) => field.id === 'apiKeys'),
    [],
  );

  const configuredKeyCount = React.useMemo(() => {
    if (!apiKeysField) return 0;
    if (!docRef.current) {
      try {
        docRef.current = parseDocument(rawYaml || '');
      } catch {
        return 0;
      }
    }
    const value = getFieldValue(apiKeysField);
    if (Array.isArray(value)) return value.length;
    return typeof value === 'string' && value ? 1 : 0;
  }, [apiKeysField, rawYaml, getFieldValue]);

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
  //
  // `context` says which heading the caller is already showing above this group,
  // because the Payload panel is the one variant whose group head restates its
  // section header. Under the section header the group head is therefore dropped:
  // the reader was shown the section's own title and description and then the
  // same panel named a second time underneath it. Under search results the header
  // names the search rather than the section, so the group head is the only
  // heading the panel has and must stay.
  const renderGroupPanel = (
    grp: ConfigGroupDefinition,
    visibleFieldIds?: string[],
    context: 'section' | 'search' = 'section',
  ) => {
    const rawFields = grp.fieldIds
      .map((fid) => ALL_CONFIG_FIELDS.find((f) => f.id === fid))
      .filter((f): f is ConfigFieldDefinition => Boolean(f));

    const groupFields = visibleFieldIds
      ? rawFields.filter((f) => visibleFieldIds.includes(f.id))
      : rawFields;

    if (groupFields.length === 0) return null;

    // Managed-elsewhere variant (the client API keys)
    //
    // This group points at the surface that owns the field rather than editing
    // it: one editor per field, and the operator who looks here is told where
    // that editor is. It renders in the search context too, so searching for the
    // field finds the panel that names it instead of nothing at all.
    if (grp.variant === 'managed-elsewhere') {
      return (
        <div key={grp.id} className="settings-group">
          <div className="settings-group-head">
            <div>
              <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
              {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
            </div>
          </div>
          <div className="settings-group-body">
            <div className="settings-managed-elsewhere">
              <span className="settings-managed-count">
                {t('cfg.api_keys_count', { n: configuredKeyCount })}
              </span>
              <Button size="small" type="primary" onClick={() => navigate('/api-keys')}>
                {t('cfg.api_keys_manage')}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // Payload Builder variant (structured JSON rules for models and parameters)
    if (grp.variant === 'payload-builder') {
      return (
        <div key={grp.id} className="settings-group payload-builder-group">
          {context === 'search' && (
            <div className="settings-group-head">
              <div>
                <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
                {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
              </div>
            </div>
          )}
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
      {/* Full-width sticky toolbar: the action group is pushed to the viewport's
          right edge so it lines up with the global header. */}
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

          {/* Discard needs no confirmation: it is the non-destructive direction. */}
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

          {/* Save. Blocking validation errors are reported by saveConfig itself,
              so that branch does not confirm first: there is nothing to confirm
              when the save cannot proceed. A valid document goes through the
              popconfirm and then straight to saveConfig - the bottom bar owns
              that confirmation, so it must not ask a second time through the
              global modal the keyboard path uses. */}
          {hasConfigErrors ? (
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              loading={saveMutation.isPending}
              disabled={!isDirty}
              onClick={saveConfig}
            >
              {t('cfg.source_save')}
            </Button>
          ) : (
            <Popconfirm
              title={t('cfg.source_save_confirm')}
              description={t('cfg.source_save_confirm_desc')}
              onConfirm={saveConfig}
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
        /* Visual mode: sticky section nav, settings canvas, and a balancing
           right gutter — a three-track grid, not two columns. */
        <div className="config-workbench">
          {/* Left: sticky section navigation in the 216px track */}
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
                {searchMatchedGroups.map((sg) => renderGroupPanel(sg.group, sg.matchedFieldIds, 'search'))}
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
                  if (await copyText(rawYaml)) {
                    message.success(t('cfg.source_copy_success'));
                    return;
                  }
                  message.error(t('cfg.copy_failed'));
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
                themeId={themeId}
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

      {/* Floating Bottom Dirty Action Bar.
          It owns its own confirmation, so it is handed the save itself rather
          than the confirming entry point: chaining the two produced a popconfirm
          followed by a second global modal asking the same question. */}
      <ConfigDirtyBar
        isDirty={isDirty}
        isSaving={saveMutation.isPending}
        yamlError={hasYamlErrors}
        payloadIssuesCount={payloadIssues.length}
        showErrorFeedback={showErrorFeedback}
        onSave={saveConfig}
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
            onClick={async () => {
              if (await copyText(rawYaml)) {
                message.success(t('cfg.source_copy_success'));
                return;
              }
              message.error(t('cfg.copy_failed'));
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

    </div>
  );
};
