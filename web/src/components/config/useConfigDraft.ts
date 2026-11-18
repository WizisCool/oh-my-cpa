import React from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseDocument, type Document } from 'yaml';

import { api, ApiError, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { getFieldSemanticValue, updateFieldWithBaseline, isConfigSemanticallyEqual } from './configDirty';
import { computeConfigChanges, rebaseDraft } from './configPatch';
import { describeConfigSaveError } from './configSaveErrors';
import { ALL_CONFIG_FIELDS, type ConfigFieldDefinition, type ConfigSectionId } from '../../types/configSchema';
import type { ConfigScalarsResponse } from '../../types/configManagement';
import {
  isBlockingPayloadIssue,
  validatePayloadDocument,
  type PayloadValidationIssue,
  type SavedInactiveReplaceTargetEntry,
  type UnresolvedReplacePendingEntry,
} from './payloadRules';
import {
  formatPatternRulesIssue,
  type PatternRulesDraftState,
  type PatternRulesValidationIssue,
} from './PatternRulesEditor';
import { formatStringMapIssue, type StringMapDraftState, type StringMapValidationIssue } from './StringMapEditor';
import type { YamlSourceEditorRef } from './YamlSourceEditor';
import { useConfirmModal, useToast } from '../feedback';

/**
 * The configuration draft and the transaction that saves it.
 *
 * It is one hook because a save is a write against a revision: the draft, the
 * baseline it is compared with, the conflict it can be refused with, the
 * in-flight guard and the discard confirmations are all readings of the same
 * transaction, and splitting them would only spread its invariants.
 *
 * The two views save differently. The visual editor sends only the settings the
 * draft changed (see configPatch), which CPA v8 writes in place; the source view
 * is the whole document by definition and replaces it. Either way the server
 * answers with the document CPA now stores, rendered in CPA's own layout, and
 * that answer becomes the next baseline rather than the text that was sent.
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
  const modal = useConfirmModal();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editorRef = React.useRef<YamlSourceEditorRef | null>(null);

  const [viewMode, setViewMode] = React.useState<'visual' | 'source'>('visual');
  const [activeSection, setActiveSectionState] = React.useState<ConfigSectionId>('connectivity');
  const [searchQuery, setSearchQueryState] = React.useState<string>('');

  const configQuery = useQuery<ConfigScalarsResponse>({
    queryKey: ['management-config'],
    queryFn: () => api.getConfigScalars(),
    staleTime: 60000,
  });

  const [rawYaml, setRawYaml] = React.useState<string>('');
  const [serverYaml, setServerYaml] = React.useState<string>('');
  const [serverRevision, setServerRevision] = React.useState<string>('');
  const [conflictState, setConflictState] = React.useState<{ currentRevision: string } | null>(null);
  const [stringMapDrafts, setStringMapDrafts] = React.useState<Record<string, StringMapDraftState>>({});
  const [stringMapIssues, setStringMapIssues] = React.useState<Record<string, StringMapValidationIssue>>({});
  const [patternRulesDrafts, setPatternRulesDrafts] = React.useState<Record<string, PatternRulesDraftState>>({});
  const [patternRulesIssues, setPatternRulesIssues] = React.useState<Record<string, PatternRulesValidationIssue>>({});
  const [hasPendingPayloadEdits, setHasPendingPayloadEdits] = React.useState(false);
  const [unresolvedReplacePending, setUnresolvedReplacePending] = React.useState<UnresolvedReplacePendingEntry[]>([]);
  const [payloadResetVersion, setPayloadResetVersion] = React.useState(0);

  const docRef = React.useRef<Document | null>(null);
  const serverDocRef = React.useRef<Document | null>(null);
  const rawYamlRef = React.useRef('');
  const serverYamlRef = React.useRef('');
  const serverRevisionRef = React.useRef('');
  const stringMapIssuesRef = React.useRef<Record<string, StringMapValidationIssue>>({});
  const patternRulesIssuesRef = React.useRef<Record<string, PatternRulesValidationIssue>>({});
  const hasLivePendingPositionsRef = React.useRef(false);
  const unresolvedReplacePendingRef = React.useRef<UnresolvedReplacePendingEntry[]>([]);
  const hasPendingPayloadEditsRef = React.useRef(false);
  const payloadEditorMountedRef = React.useRef(false);
  const flushPendingPayloadRef = React.useRef<(() => boolean) | null>(null);
  const clearPendingPayloadRef = React.useRef<(() => void) | null>(null);
  const savedReplaceInactiveTargetsRef = React.useRef<SavedInactiveReplaceTargetEntry[]>([]);
  const payloadIssuesRef = React.useRef<PayloadValidationIssue[]>([]);
  const firstFieldErrorMessageRef = React.useRef<string | undefined>(undefined);
  /** Guards against a second save starting before isPending propagates. */
  const saveInFlightRef = React.useRef(false);

  const setActiveSection = React.useCallback((next: React.SetStateAction<ConfigSectionId>) => {
    flushPendingPayloadRef.current?.();
    setActiveSectionState(next);
  }, []);

  const setSearchQuery = React.useCallback((next: React.SetStateAction<string>) => {
    flushPendingPayloadRef.current?.();
    setSearchQueryState(next);
  }, []);

  React.useEffect(() => {
    stringMapIssuesRef.current = stringMapIssues;
  }, [stringMapIssues]);

  React.useEffect(() => {
    patternRulesIssuesRef.current = patternRulesIssues;
  }, [patternRulesIssues]);

  const clearStringMapState = React.useCallback(() => {
    stringMapIssuesRef.current = {};
    setStringMapDrafts({});
    setStringMapIssues({});
  }, []);

  const clearPatternRulesState = React.useCallback(() => {
    patternRulesIssuesRef.current = {};
    setPatternRulesDrafts({});
    setPatternRulesIssues({});
  }, []);

  const setStringMapDraft = React.useCallback((fieldId: string, state: StringMapDraftState | null) => {
    setStringMapDrafts((prev) => {
      if (state === null) {
        if (!Object.prototype.hasOwnProperty.call(prev, fieldId)) return prev;
        const next = { ...prev };
        delete next[fieldId];
        return next;
      }
      return { ...prev, [fieldId]: state };
    });
  }, []);

  const setStringMapIssue = React.useCallback((fieldId: string, issue: StringMapValidationIssue | null) => {
    setStringMapIssues((prev) => {
      if (issue === null) {
        if (!Object.prototype.hasOwnProperty.call(prev, fieldId)) return prev;
        const next = { ...prev };
        delete next[fieldId];
        stringMapIssuesRef.current = next;
        return next;
      }
      const existing = prev[fieldId];
      if (existing && existing.kind === issue.kind && (existing.kind !== 'duplicate_key' || existing.key === (issue as { key: string }).key)) {
        return prev;
      }
      const next = { ...prev, [fieldId]: issue };
      stringMapIssuesRef.current = next;
      return next;
    });
  }, []);

  const setPatternRulesDraft = React.useCallback((fieldId: string, state: PatternRulesDraftState | null) => {
    setPatternRulesDrafts((prev) => {
      if (state === null) {
        if (!Object.prototype.hasOwnProperty.call(prev, fieldId)) return prev;
        const next = { ...prev };
        delete next[fieldId];
        return next;
      }
      return { ...prev, [fieldId]: state };
    });
  }, []);

  const setPatternRulesIssue = React.useCallback((fieldId: string, issue: PatternRulesValidationIssue | null) => {
    const prev = patternRulesIssuesRef.current;
    if (issue === null) {
      if (!Object.prototype.hasOwnProperty.call(prev, fieldId)) return;
      const next = { ...prev };
      delete next[fieldId];
      patternRulesIssuesRef.current = next;
      setPatternRulesIssues(next);
      return;
    }
    const existing = prev[fieldId];
    if (
      existing
      && existing.kind === issue.kind
      && ((existing.kind !== 'unsupported_re2' && existing.kind !== 'trailing_backslash')
        || existing.pattern === (issue as { pattern: string }).pattern)
    ) {
      return;
    }
    const next = { ...prev, [fieldId]: issue };
    patternRulesIssuesRef.current = next;
    setPatternRulesIssues(next);
  }, []);

  const viewModeRef = React.useRef(viewMode);
  viewModeRef.current = viewMode;

  /** replaceDraft makes `yaml` the operator's draft. */
  const replaceDraft = React.useCallback((yaml: string) => {
    setRawYaml(yaml);
    rawYamlRef.current = yaml;
    try {
      docRef.current = parseDocument(yaml);
    } catch {
      // A malformed document is expected here: the previous draft stays in place.
    }
  }, []);

  /**
   * adoptBaseline makes a document CPA stores the one the draft is compared
   * with. A draft with edits of its own is carried over onto it (see
   * rebaseDraft) instead of being replaced; `draftBase` is the document those
   * edits were made against.
   */
  const syncPendingPayloadFlag = React.useCallback(() => {
    const next = hasLivePendingPositionsRef.current || unresolvedReplacePendingRef.current.length > 0;
    hasPendingPayloadEditsRef.current = next;
    setHasPendingPayloadEdits(next);
  }, []);

  const clearPendingPayloadState = React.useCallback(() => {
    clearPendingPayloadRef.current?.();
    savedReplaceInactiveTargetsRef.current = [];
    hasLivePendingPositionsRef.current = false;
    unresolvedReplacePendingRef.current = [];
    setUnresolvedReplacePending([]);
    hasPendingPayloadEditsRef.current = false;
    setHasPendingPayloadEdits(false);
  }, []);

  const adoptBaseline = React.useCallback(
    (yaml: string, revision: string, draftBase: Document | null, hasLocalEdits: boolean): boolean => {
      const previousYaml = serverYamlRef.current;
      setServerYaml(yaml);
      serverYamlRef.current = yaml;
      setServerRevision(revision);
      serverRevisionRef.current = revision;
      try {
        serverDocRef.current = parseDocument(yaml);
      } catch {
        // A malformed document is expected here: the previous baseline stays in place.
      }
      if (!hasLocalEdits) {
        clearStringMapState();
        clearPatternRulesState();
        clearPendingPayloadState();
        replaceDraft(yaml);
        return true;
      }
      // The source view's draft is the operator's own text, comments included,
      // which a structural carry-over would re-render; it is left as typed.
      if (yaml === previousYaml || !docRef.current || viewModeRef.current === 'source') return false;
      const rebased = rebaseDraft(draftBase, docRef.current, yaml);
      if (rebased !== null) {
        replaceDraft(rebased);
        if (!payloadEditorMountedRef.current) {
          const recomputed = validatePayloadDocument(docRef.current, unresolvedReplacePendingRef.current);
          payloadIssuesRef.current = recomputed;
          setPayloadIssues(recomputed);
        }
        return true;
      }
      return false;
    },
    [clearPatternRulesState, clearPendingPayloadState, clearStringMapState, replaceDraft],
  );

  React.useEffect(() => {
    if (viewMode !== 'visual' || configQuery.data?.safe_yaml === undefined) return;
    // A refetch or an invalidation must never overwrite a draft the operator is
    // still writing: the draft's own edits are carried over onto the document
    // that arrived, and only a draft without edits is replaced by it.
    adoptBaseline(
      configQuery.data.safe_yaml,
      configQuery.data.revision || '',
      serverDocRef.current,
      rawYamlRef.current !== serverYamlRef.current
        || Object.keys(stringMapIssuesRef.current).length > 0
        || Object.keys(patternRulesIssuesRef.current).length > 0
        || hasPendingPayloadEditsRef.current,
    );
  }, [configQuery.data?.safe_yaml, configQuery.data?.revision, viewMode, adoptBaseline]);

  // Mirrored into refs so the hydration effect and saveConfig can read the current
  // values without being re-created on every keystroke.
  rawYamlRef.current = rawYaml;
  serverYamlRef.current = serverYaml;
  serverRevisionRef.current = serverRevision;

  const hasStringMapIssues = Object.keys(stringMapIssues).length > 0;
  const hasPatternRulesIssues = Object.keys(patternRulesIssues).length > 0;
  const hasFieldIssues = hasStringMapIssues || hasPatternRulesIssues;
  const firstStringMapErrorMessage = React.useMemo(() => {
    const first = Object.values(stringMapIssues)[0];
    return first ? formatStringMapIssue(first, t) : undefined;
  }, [stringMapIssues, t]);
  const firstPatternRulesErrorMessage = React.useMemo(() => {
    const first = Object.values(patternRulesIssues)[0];
    return first ? formatPatternRulesIssue(first, t) : undefined;
  }, [patternRulesIssues, t]);
  const firstFieldErrorMessage = firstStringMapErrorMessage ?? firstPatternRulesErrorMessage;
  firstFieldErrorMessageRef.current = firstFieldErrorMessage;

  const isDirty = rawYaml !== serverYaml || hasFieldIssues || hasPendingPayloadEdits;

  const syncDocChanges = React.useCallback(() => {
    if (!docRef.current) return;
    if (serverDocRef.current && isConfigSemanticallyEqual(docRef.current, serverDocRef.current, ALL_CONFIG_FIELDS)) {
      rawYamlRef.current = serverYamlRef.current;
      setRawYaml(serverYamlRef.current);
      docRef.current = parseDocument(serverYamlRef.current);
    } else {
      const nextYaml = docRef.current.toString();
      rawYamlRef.current = nextYaml;
      setRawYaml(nextYaml);
    }
  }, []);

  const updateFieldInDoc = React.useCallback(
    (field: ConfigFieldDefinition, value: unknown) => {
      let currentDoc = docRef.current;
      if (!currentDoc) {
        try {
          currentDoc = parseDocument(rawYamlRef.current || '');
          docRef.current = currentDoc;
        } catch {
          toast.error(t('cfg.yaml_syntax_error'));
          return;
        }
      }

      updateFieldWithBaseline(currentDoc, serverDocRef.current, field, value);

      // If after update, currentDoc is semantically identical to serverDoc across all fields and payload,
      // revert rawYaml completely back to serverYaml so no formatting artifacts trigger dirty!
      if (serverDocRef.current && isConfigSemanticallyEqual(currentDoc, serverDocRef.current, ALL_CONFIG_FIELDS)) {
        rawYamlRef.current = serverYamlRef.current;
        setRawYaml(serverYamlRef.current);
        docRef.current = parseDocument(serverYamlRef.current);
      } else {
        const nextYaml = currentDoc.toString();
        rawYamlRef.current = nextYaml;
        setRawYaml(nextYaml);
      }
    },
    [toast, t],
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
      return getFieldSemanticValue(docRef.current, field);
    },
    // rawYaml is a dependency on purpose: the document lives in a ref, so the
    // reader has to be re-created for its consumers to re-render.
    [rawYaml],
  );


  const saveMutation = useMutation({
    mutationFn: async ({ yamlToSave, revision }: { yamlToSave: string; revision: string }): Promise<{ yaml?: string; revision?: string }> => {
      setConflictState(null);
      if (viewMode === 'source') {
        const saved = await api.updateConfigSource(yamlToSave, revision);
        return { yaml: saved.yaml, revision: saved.revision };
      }
      const draftDoc = parseDocument(yamlToSave);
      const changes = computeConfigChanges(serverDocRef.current, draftDoc);
      // A draft that differs only in formatting has nothing to send.
      if (changes.length === 0) return { yaml: serverYamlRef.current, revision };
      const saved = await api.patchConfig(changes, revision);
      return { yaml: saved.safe_yaml, revision: saved.revision };
    },
    onSuccess: (saved, variables) => {
      toast.success(t('cfg.source_save_success'));
      // The operator may have kept typing while the save was in flight: those
      // newer edits are carried over onto what was saved.
      const hasNewerDraft =
        rawYamlRef.current !== variables.yamlToSave
        || Object.keys(stringMapIssuesRef.current).length > 0
        || Object.keys(patternRulesIssuesRef.current).length > 0
        || hasPendingPayloadEditsRef.current;
      let savedDraft: Document | null = null;
      try {
        savedDraft = parseDocument(variables.yamlToSave);
      } catch {
        // A malformed document is expected here: the newer draft is then kept as it is.
      }
      let didRebase = false;
      if (saved.yaml !== undefined && saved.revision) {
        didRebase = adoptBaseline(saved.yaml, saved.revision, savedDraft, hasNewerDraft);
      } else {
        // The write landed but CPA could not be re-read, so the stored document is
        // unknown: the sent text stands in until a reload replaces it.
        didRebase = adoptBaseline(variables.yamlToSave, '', savedDraft, hasNewerDraft);
        if (viewMode === 'source') {
          void api.getConfigSource().then(
            (source) => adoptBaseline(source.yaml, source.revision, serverDocRef.current, rawYamlRef.current !== serverYamlRef.current),
            () => undefined,
          );
        }
      }
      if (!hasNewerDraft || viewModeRef.current === 'source') {
        payloadIssuesRef.current = [];
        setPayloadIssues([]);
        if (!hasNewerDraft) {
          clearStringMapState();
          clearPatternRulesState();
          clearPendingPayloadState();
        }
      } else if (!payloadEditorMountedRef.current || didRebase) {
        const recomputed = validatePayloadDocument(docRef.current, unresolvedReplacePendingRef.current);
        payloadIssuesRef.current = recomputed;
        setPayloadIssues(recomputed);
      }
      setShowErrorFeedback(false);
      setValidateTrigger(0);
      void queryClient.invalidateQueries({ queryKey: ['management-config'] });
      void queryClient.invalidateQueries({ queryKey: ['management-config-backups'] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && apiErrorCode(err) === 'config_conflict') {
        const currentRev = String((err.data as Record<string, unknown>)?.current_revision || '');
        setConflictState({ currentRevision: currentRev });
        return;
      }
      const msg = describeConfigSaveError(err, t);
      toast.error(msg);
    },
  });

  const [validateTrigger, setValidateTrigger] = React.useState(0);
  const [showErrorFeedback, setShowErrorFeedback] = React.useState(false);

  const handleDiscardChanges = React.useCallback(() => {
    clearPendingPayloadState();
    rawYamlRef.current = serverYamlRef.current;
    setRawYaml(serverYamlRef.current);
    try {
      docRef.current = parseDocument(serverYamlRef.current);
      serverDocRef.current = parseDocument(serverYamlRef.current);
    } catch {
      // A malformed document is expected here: the previous baseline stays in place.
    }
    payloadIssuesRef.current = [];
    setPayloadIssues([]);
    clearStringMapState();
    clearPatternRulesState();
    setPayloadResetVersion((v) => v + 1);
    setShowErrorFeedback(false);
    setValidateTrigger(0);
  }, [clearPatternRulesState, clearPendingPayloadState, clearStringMapState]);

  const [payloadIssues, setPayloadIssues] = React.useState<PayloadValidationIssue[]>([]);

  const updatePayloadIssues = React.useCallback((next: PayloadValidationIssue[]) => {
    payloadIssuesRef.current = next;
    setPayloadIssues(next);
  }, []);

  const updateHasPendingPayloadEdits = React.useCallback((hasLivePending: boolean) => {
    hasLivePendingPositionsRef.current = hasLivePending;
    syncPendingPayloadFlag();
  }, [syncPendingPayloadFlag]);

  const updateUnresolvedReplacePending = React.useCallback(
    (next: React.SetStateAction<UnresolvedReplacePendingEntry[]>) => {
      const resolved = typeof next === 'function' ? next(unresolvedReplacePendingRef.current) : next;
      unresolvedReplacePendingRef.current = resolved;
      setUnresolvedReplacePending(resolved);
      syncPendingPayloadFlag();
      if (!payloadEditorMountedRef.current) {
        const recomputed = validatePayloadDocument(docRef.current, resolved);
        payloadIssuesRef.current = recomputed;
        setPayloadIssues(recomputed);
      }
    },
    [syncPendingPayloadFlag],
  );

  const setPayloadEditorMounted = React.useCallback((mounted: boolean) => {
    payloadEditorMountedRef.current = mounted;
  }, []);

  const hasYamlErrorsNow = React.useCallback(() => {
    try {
      const parsed = parseDocument(rawYamlRef.current);
      return Boolean(parsed.errors && parsed.errors.length > 0);
    } catch {
      return true;
    }
  }, []);

  const isDirtyNow = React.useCallback(
    () =>
      rawYamlRef.current !== serverYamlRef.current
      || Object.keys(stringMapIssuesRef.current).length > 0
      || Object.keys(patternRulesIssuesRef.current).length > 0
      || hasPendingPayloadEditsRef.current,
    [],
  );

  const hasYamlErrors = React.useMemo(() => {
    try {
      const doc = parseDocument(rawYaml);
      return Boolean(doc.errors && doc.errors.length > 0);
    } catch {
      return true;
    }
  }, [rawYaml]);

  const blockingPayloadIssuesCount = React.useMemo(
    () => payloadIssues.filter(isBlockingPayloadIssue).length,
    [payloadIssues],
  );

  const resolveSaveConfirmDescription = React.useCallback(
    (
      mode: 'visual' | 'source',
      issues: readonly PayloadValidationIssue[],
      baselineDoc: Document | null,
      draftDoc: Document | null,
    ): string => {
      if (mode === 'visual' && draftDoc) {
        const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
        if (warningCount > 0) {
          const touchesReplace = computeConfigChanges(baselineDoc, draftDoc).some((change) => {
            const p = change.path;
            return (
              !change.remove
              && ((p.length === 1 && p[0] === 'requests')
                || (p.length === 2 && p[0] === 'requests' && p[1] === 'payload')
                || (p.length >= 3 && p[0] === 'requests' && p[1] === 'payload' && p[2] === 'replace'))
            );
          });
          if (touchesReplace) {
            return t('cfg.source_save_confirm_regex_warn', { n: warningCount });
          }
        }
      }
      return t('cfg.source_save_confirm_desc');
    },
    [t],
  );

  const saveConfirmDescription = React.useMemo(() => {
    void rawYaml;
    void serverYaml;
    return resolveSaveConfirmDescription(viewMode, payloadIssues, serverDocRef.current, docRef.current);
  }, [payloadIssues, rawYaml, resolveSaveConfirmDescription, serverYaml, viewMode]);

  const hasConfigErrors = hasYamlErrors || blockingPayloadIssuesCount > 0 || hasFieldIssues;

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
    flushPendingPayloadRef.current?.();
    if (!isDirtyNow() || configQuery.isError) return Promise.resolve();
    // isPending lags a render, so a second activation in the same tick (a double
    // click, or Ctrl+S bubbling out of the editor) would start a second mutation
    // against the same revision and race the first one to the conflict check.
    if (saveInFlightRef.current || saveMutation.isPending) return Promise.resolve();
    if (hasYamlErrorsNow()) {
      setShowErrorFeedback(true);
      toast.error(t('cfg.dirty_bar_yaml_error'));
      return Promise.resolve();
    }
    const blockingPayloadIssues = payloadIssuesRef.current.filter(isBlockingPayloadIssue);
    if (viewModeRef.current === 'visual' && blockingPayloadIssues.length > 0) {
      setValidateTrigger((v) => v + 1);
      setShowErrorFeedback(true);
      toast.warning(t('cfg.dirty_bar_payload_issues', { n: blockingPayloadIssues.length }));
      return Promise.resolve();
    }
    if (firstFieldErrorMessageRef.current) {
      setShowErrorFeedback(true);
      return Promise.resolve();
    }
    saveInFlightRef.current = true;
    // The promise is returned so a Popconfirm can hold its own loading state, and
    // it is settled here rather than left to the caller: a keyboard handler has
    // nobody to catch a rejection, and the mutation's onError already reports it.
    return saveMutation
      .mutateAsync({ yamlToSave: rawYamlRef.current, revision: serverRevisionRef.current })
      .catch(() => undefined)
      .finally(() => {
        saveInFlightRef.current = false;
      });
  }, [
    configQuery.isError,
    hasYamlErrorsNow,
    isDirtyNow,
    saveMutation,
    toast,
    t,
  ]);

  const saveConfigRef = React.useRef(saveConfig);
  saveConfigRef.current = saveConfig;

  /**
   * requestSaveConfirmation is for entry points that have no confirmation UI of
   * their own - Ctrl+S and the editor's own save hook. It asks once and then
   * calls the same saveConfig, so the keyboard cannot drift from the buttons.
   */
  const requestSaveConfirmation = React.useCallback(() => {
    flushPendingPayloadRef.current?.();
    if (!isDirtyNow() || saveMutation.isPending) return;
    const hasCurrentFieldIssues =
      Object.keys(stringMapIssuesRef.current).length > 0
      || Object.keys(patternRulesIssuesRef.current).length > 0;
    if (
      hasYamlErrorsNow()
      || (viewModeRef.current === 'visual' && payloadIssuesRef.current.some(isBlockingPayloadIssue))
      || hasCurrentFieldIssues
      || configQuery.isError
    ) {
      void saveConfigRef.current();
      return;
    }
    modal.confirm({
      title: t('cfg.source_save_confirm'),
      content: resolveSaveConfirmDescription(
        viewModeRef.current,
        payloadIssuesRef.current,
        serverDocRef.current,
        docRef.current,
      ),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => {
        // Returning the promise keeps the confirm dialog open until the save
        // settles, so a failure cannot look like it already succeeded.
        return saveConfigRef.current();
      },
    });
  }, [configQuery.isError, hasYamlErrorsNow, isDirtyNow, modal, resolveSaveConfirmDescription, saveMutation.isPending, t]);

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
        if (!(
          rawYamlRef.current !== serverYamlRef.current
          || Object.keys(stringMapIssuesRef.current).length > 0
          || Object.keys(patternRulesIssuesRef.current).length > 0
          || hasPendingPayloadEditsRef.current
        )) {
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
        clearPendingPayloadState();
        payloadIssuesRef.current = [];
        setPayloadIssues([]);
        setShowErrorFeedback(false);
        setValidateTrigger(0);
        rawYamlRef.current = src.yaml;
        serverYamlRef.current = src.yaml;
        serverRevisionRef.current = src.revision;
        setRawYaml(src.yaml);
        setServerYaml(src.yaml);
        setServerRevision(src.revision);
        clearStringMapState();
        clearPatternRulesState();
        try {
          docRef.current = parseDocument(src.yaml);
          serverDocRef.current = parseDocument(src.yaml);
        } catch {
          // A malformed document is expected here: the previous baseline stays in place.
        }
        setViewMode('source');
      } catch (err) {
        const msg = describeError(err);
        toast.error(t('cfg.source_load_failed', { msg }));
      }
    } else {
      payloadIssuesRef.current = [];
      setPayloadIssues([]);
      setShowErrorFeedback(false);
      setValidateTrigger(0);
      setViewMode('visual');
      queryClient.removeQueries({ queryKey: ['management-config-source'] });
      void configQuery.refetch();
    }
  };

  /**
   * reloadAfterConflict answers the conflict dialog. The visual draft is a set of
   * edited settings, so they are carried over onto the latest document; the
   * source draft is whole text, which the latest document replaces (the dialog
   * offers to copy it first).
   */
  /**
   * reloadBaseline replaces the draft with the document CPA stores now, in the
   * current view. Callers only reach it with a draft that has nothing to lose:
   * the conflict dialog asked first, and a restore is refused while dirty.
   */
  const reloadBaseline = React.useCallback(async () => {
    if (viewModeRef.current === 'visual') {
      await configQuery.refetch();
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['management-config'] });
    try {
      const source = await api.getConfigSource();
      adoptBaseline(source.yaml, source.revision, null, false);
    } catch (err) {
      toast.error(t('cfg.source_load_failed', { msg: describeError(err) }));
    }
  }, [adoptBaseline, configQuery, queryClient, toast, t]);

  const reloadAfterConflict = React.useCallback(async () => {
    setConflictState(null);
    await reloadBaseline();
  }, [reloadBaseline]);

  return {
    storedLayout: configQuery.data?.stored_layout,
    reloadAfterConflict,
    reloadBaseline,
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
    docRef,
    serverDocRef,
    rawYamlRef,
    serverYamlRef,
    isDirty,
    syncDocChanges,
    updateFieldInDoc,
    getFieldValue,
    saveMutation,
    validateTrigger,
    setValidateTrigger,
    showErrorFeedback,
    setShowErrorFeedback,
    handleDiscardChanges,
    payloadIssues,
    blockingPayloadIssuesCount,
    setPayloadIssues,
    updatePayloadIssues,
    hasPendingPayloadEdits,
    updateHasPendingPayloadEdits,
    unresolvedReplacePending,
    updateUnresolvedReplacePending,
    setPayloadEditorMounted,
    flushPendingPayloadRef,
    clearPendingPayloadRef,
    savedReplaceInactiveTargetsRef,
    payloadResetVersion,
    stringMapDrafts,
    setStringMapDraft,
    stringMapIssues,
    setStringMapIssue,
    firstStringMapErrorMessage,
    patternRulesDrafts,
    setPatternRulesDraft,
    patternRulesIssues,
    setPatternRulesIssue,
    firstPatternRulesErrorMessage,
    firstFieldErrorMessage,
    hasYamlErrors,
    hasConfigErrors,
    saveConfirmDescription,
    saveConfig,
    requestSaveConfirmation,
    confirmDiscardDraft,
    handleViewModeChange,
  };
}
