import React from 'react';

import { App as AntdApp } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseDocument, type Document } from 'yaml';

import { api, ApiError, apiErrorCode } from '../../api/client';
import { useT } from '../../i18n';
import { updateFieldWithBaseline, isConfigSemanticallyEqual } from './configDirty';
import { ALL_CONFIG_FIELDS, type ConfigFieldDefinition, type ConfigSectionId } from '../../types/configSchema';
import type { ConfigScalarsResponse } from '../../types/configManagement';
import type { PayloadValidationIssue } from './payloadRules';
import type { YamlSourceEditorRef } from './YamlSourceEditor';

/**
 * The configuration draft and the transaction that saves it.
 *
 * It is one hook because a save is a whole-document write against a revision:
 * the draft, the baseline it is compared with, the conflict it can be refused
 * with, the in-flight guard and the discard confirmations are all readings of the
 * same transaction, and splitting them would only spread its invariants.
 *
 * Two invariants are load-bearing and stated here rather than discovered:
 *
 * - The document is re-parsed from the server's YAML only when the *baseline*
 *   changes, so an in-flight save cannot clobber the operator's typing.
 * - A draft is never replaced without asking, which is why the mode switch awaits
 *   `confirmDiscardDraft` before it starts loading the other view.
 */
export function useConfigDraft() {
  const t = useT();
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const editorRef = React.useRef<YamlSourceEditorRef | null>(null);

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

  return {
    editorRef,
    viewMode,
    setViewMode,
    activeSection,
    setActiveSection,
    searchQuery,
    setSearchQuery,
    configQuery,
    rawYaml,
    setRawYaml,
    serverYaml,
    setServerYaml,
    serverRevision,
    conflictState,
    setConflictState,
    saveError,
    setSaveError,
    docRef,
    serverDocRef,
    rawYamlRef,
    serverYamlRef,
    isDirty,
    updateFieldInDoc,
    getFieldValue,
    saveMutation,
    validateTrigger,
    setValidateTrigger,
    showErrorFeedback,
    setShowErrorFeedback,
    handleDiscardChanges,
    payloadIssues,
    setPayloadIssues,
    hasYamlErrors,
    hasConfigErrors,
    saveConfig,
    requestSaveConfirmation,
    confirmDiscardDraft,
    handleViewModeChange,
  };
}
