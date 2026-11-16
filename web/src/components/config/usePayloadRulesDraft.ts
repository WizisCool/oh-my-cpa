import React, { useEffect, useRef, useState } from 'react';

import type { Document } from 'yaml';

import { useT } from '../../i18n';
import {
  appendReplacePositionTokens,
  areModelItemsEqual,
  buildPayloadProtocolOptions,
  buildUnresolvedPendingIssues,
  generateDynamicId,
  parseFilterRules,
  parseRawRules,
  parseReplaceRules,
  parseTypedRules,
  readPayloadCategory,
  reconcileFilterRules,
  reconcileRawRules,
  reconcileReplaceRules,
  reconcileTypedRules,
  serializeFilterRules,
  serializeRawRules,
  serializeReplaceRules,
  serializeTypedRules,
  validateAllPayloadRules,
  writePayloadCategory,
  type PayloadCategoryKey,
  type PayloadFilterRule,
  type PayloadRawRule,
  type PayloadReplaceRule,
  type PayloadModelItem,
  type PayloadTypedRule,
  type PayloadValidationIssue,
  type UnresolvedReplacePendingEntry,
} from './payloadRules';

/**
 * The payload-rule editor's draft: one rule list per category, the validation of
 * all of them, and the mutations each panel performs.
 *
 * The draft is per-category local state rather than a projection of the YAML
 * document, and that is the point: re-parsing the document on every keystroke is
 * what used to lose input focus mid-word. The document is only read when it is a
 * new instance, and each mutation serialises its own category back through
 * `commitCategory`.
 *
 * The draft also owns the validation gating the panels display: an error is
 * hidden until the field is touched or a save was attempted, which is why the
 * touched set and the show-all flag belong to the same state as the rules they
 * describe.
 */
export function usePayloadRulesDraft({
  doc,
  onDocChange,
  onValidationChange,
  onPendingChange,
  unresolvedPending: unresolvedPendingProp,
  onUnresolvedPendingChange,
  onMountChange,
  flushPendingRef,
  clearPendingRef,
  resetVersion,
  validateTrigger,
}: {
  doc: Document | null;
  onDocChange: () => void;
  onValidationChange?: (issues: PayloadValidationIssue[]) => void;
  onPendingChange?: (hasPending: boolean) => void;
  unresolvedPending?: UnresolvedReplacePendingEntry[];
  onUnresolvedPendingChange?: React.Dispatch<React.SetStateAction<UnresolvedReplacePendingEntry[]>>;
  onMountChange?: (mounted: boolean) => void;
  flushPendingRef?: React.MutableRefObject<(() => boolean) | null>;
  clearPendingRef?: React.MutableRefObject<(() => void) | null>;
  resetVersion?: number;
  validateTrigger?: number;
}) {
  const t = useT();

  const PROTOCOL_OPTIONS = React.useMemo(
    () => buildPayloadProtocolOptions(t('cfg.payload_model_default')),
    [t],
  );

  const [activePanels, setActivePanels] = useState<string[]>([]);

  // Local state for each category to guarantee ZERO input focus loss
  const [defaultRules, setDefaultRules] = useState<PayloadTypedRule[]>(() =>
    parseTypedRules(readPayloadCategory(doc, 'default'), 'default')
  );
  const [defaultRawRules, setDefaultRawRules] = useState<PayloadRawRule[]>(() =>
    parseRawRules(readPayloadCategory(doc, 'default-raw'), 'default-raw')
  );
  const [overrideRules, setOverrideRules] = useState<PayloadTypedRule[]>(() =>
    parseTypedRules(readPayloadCategory(doc, 'override'), 'override')
  );
  const [overrideRawRules, setOverrideRawRules] = useState<PayloadRawRule[]>(() =>
    parseRawRules(readPayloadCategory(doc, 'override-raw'), 'override-raw')
  );
  const [replaceRules, setReplaceRules] = useState<PayloadReplaceRule[]>(() =>
    parseReplaceRules(readPayloadCategory(doc, 'replace'), 'replace')
  );
  const [filterRules, setFilterRules] = useState<PayloadFilterRule[]>(() =>
    parseFilterRules(readPayloadCategory(doc, 'filter'), 'filter')
  );
  const [pendingPositions, setPendingPositions] = useState<Record<string, string>>({});
  const [localUnresolvedPending, setLocalUnresolvedPending] = useState<UnresolvedReplacePendingEntry[]>([]);
  const unresolvedPending = unresolvedPendingProp ?? localUnresolvedPending;
  const unresolvedPendingRef = useRef<UnresolvedReplacePendingEntry[]>(unresolvedPending);
  unresolvedPendingRef.current = unresolvedPending;

  const defaultRulesRef = useRef(defaultRules);
  defaultRulesRef.current = defaultRules;
  const defaultRawRulesRef = useRef(defaultRawRules);
  defaultRawRulesRef.current = defaultRawRules;
  const overrideRulesRef = useRef(overrideRules);
  overrideRulesRef.current = overrideRules;
  const overrideRawRulesRef = useRef(overrideRawRules);
  overrideRawRulesRef.current = overrideRawRules;
  const replaceRulesRef = useRef(replaceRules);
  replaceRulesRef.current = replaceRules;
  const filterRulesRef = useRef(filterRules);
  filterRulesRef.current = filterRules;
  const pendingPositionsRef = useRef<Record<string, string>>({});
  const docRef = useRef<Document | null>(doc);
  docRef.current = doc;
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  const onValidationChangeRef = useRef(onValidationChange);
  onValidationChangeRef.current = onValidationChange;
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;
  const onUnresolvedPendingChangeRef = useRef(onUnresolvedPendingChange);
  onUnresolvedPendingChangeRef.current = onUnresolvedPendingChange;
  const onMountChangeRef = useRef(onMountChange);
  onMountChangeRef.current = onMountChange;

  const updateUnresolvedPending = (
    updater: (prev: UnresolvedReplacePendingEntry[]) => UnresolvedReplacePendingEntry[],
  ) => {
    const next = updater(unresolvedPendingRef.current);
    unresolvedPendingRef.current = next;
    if (onUnresolvedPendingChangeRef.current) {
      onUnresolvedPendingChangeRef.current(next);
    } else {
      setLocalUnresolvedPending(next);
    }
  };

  const dismissUnresolvedPending = (id: string) => {
    updateUnresolvedPending((prev) => prev.filter((entry) => entry.id !== id));
  };

  const emitPendingChange = (map: Record<string, string>) => {
    onPendingChangeRef.current?.(Object.values(map).some((text) => text.trim() !== ''));
  };

  const setPendingPositionsText = (ruleId: string, text: string) => {
    const current = pendingPositionsRef.current;
    if (!text) {
      if (!Object.prototype.hasOwnProperty.call(current, ruleId)) return;
      const next = { ...current };
      delete next[ruleId];
      pendingPositionsRef.current = next;
      setPendingPositions(next);
      emitPendingChange(next);
      return;
    }
    if (current[ruleId] === text) return;
    const next = { ...current, [ruleId]: text };
    pendingPositionsRef.current = next;
    setPendingPositions(next);
    emitPendingChange(next);
  };

  // Track doc & explicit reset version so background rebases preserve pending positions
  // while explicit discards/resets clear transient draft state.
  const lastDocInstanceRef = useRef<Document | null>(doc);
  const lastResetVersionRef = useRef<number | undefined>(resetVersion);
  useEffect(() => {
    const docChanged = Boolean(doc && doc !== lastDocInstanceRef.current);
    const resetChanged = resetVersion !== undefined && resetVersion !== lastResetVersionRef.current;
    if (!docChanged && !resetChanged) return;

    if (resetVersion !== undefined) {
      lastResetVersionRef.current = resetVersion;
    }

    const previousReplaceRules = replaceRulesRef.current;

    if (docChanged && doc) {
      lastDocInstanceRef.current = doc;
      const parsedDefault = parseTypedRules(readPayloadCategory(doc, 'default'), 'default');
      const parsedDefaultRaw = parseRawRules(readPayloadCategory(doc, 'default-raw'), 'default-raw');
      const parsedOverride = parseTypedRules(readPayloadCategory(doc, 'override'), 'override');
      const parsedOverrideRaw = parseRawRules(readPayloadCategory(doc, 'override-raw'), 'override-raw');
      const parsedReplace = parseReplaceRules(readPayloadCategory(doc, 'replace'), 'replace');
      const parsedFilter = parseFilterRules(readPayloadCategory(doc, 'filter'), 'filter');
      const nextDefault = resetChanged ? parsedDefault : reconcileTypedRules(parsedDefault, defaultRulesRef.current);
      const nextDefaultRaw = resetChanged ? parsedDefaultRaw : reconcileRawRules(parsedDefaultRaw, defaultRawRulesRef.current);
      const nextOverride = resetChanged ? parsedOverride : reconcileTypedRules(parsedOverride, overrideRulesRef.current);
      const nextOverrideRaw = resetChanged ? parsedOverrideRaw : reconcileRawRules(parsedOverrideRaw, overrideRawRulesRef.current);
      const nextReplace = resetChanged ? parsedReplace : reconcileReplaceRules(parsedReplace, replaceRulesRef.current);
      const nextFilter = resetChanged ? parsedFilter : reconcileFilterRules(parsedFilter, filterRulesRef.current);
      defaultRulesRef.current = nextDefault;
      defaultRawRulesRef.current = nextDefaultRaw;
      overrideRulesRef.current = nextOverride;
      overrideRawRulesRef.current = nextOverrideRaw;
      replaceRulesRef.current = nextReplace;
      filterRulesRef.current = nextFilter;
      setDefaultRules(nextDefault);
      setDefaultRawRules(nextDefaultRaw);
      setOverrideRules(nextOverride);
      setOverrideRawRules(nextOverrideRaw);
      setReplaceRules(nextReplace);
      setFilterRules(nextFilter);
    }

    if (resetChanged) {
      if (Object.keys(pendingPositionsRef.current).length > 0) {
        pendingPositionsRef.current = {};
        setPendingPositions({});
        onPendingChangeRef.current?.(false);
      }
      if (unresolvedPendingRef.current.length > 0) {
        updateUnresolvedPending(() => []);
      }
      setTouchedFields(new Set());
      setShowAllErrors(false);
      if (advModalStateRef.current) {
        setAdvModalState(null);
      }
    } else {
      if (Object.keys(pendingPositionsRef.current).length > 0) {
        const validRulesById = new Map(replaceRulesRef.current.map((r) => [r.id, r]));
        const nextPending: Record<string, string> = {};
        const newlyUnresolved: UnresolvedReplacePendingEntry[] = [];
        for (const [ruleId, text] of Object.entries(pendingPositionsRef.current)) {
          if (text.trim() === '') continue;
          const targetRule = validRulesById.get(ruleId);
          if (targetRule && !targetRule.target.all) {
            nextPending[ruleId] = text;
          } else {
            const prevIdx = previousReplaceRules.findIndex((r) => r.id === ruleId);
            newlyUnresolved.push({
              id: generateDynamicId('unresolved_pos'),
              ruleNumber: prevIdx >= 0 ? prevIdx + 1 : 1,
              text: text.trim(),
            });
          }
        }
        if (newlyUnresolved.length > 0) {
          updateUnresolvedPending((prev) => [...prev, ...newlyUnresolved]);
        }
        pendingPositionsRef.current = nextPending;
        setPendingPositions(nextPending);
        emitPendingChange(nextPending);
      }
      const openModal = advModalStateRef.current;
      if (openModal && docChanged) {
        const findModalTarget = (): PayloadModelItem | undefined => {
          const byCategory: Record<
            PayloadCategoryKey,
            ReadonlyArray<{ id: string; models: PayloadModelItem[] }>
          > = {
            default: defaultRulesRef.current,
            'default-raw': defaultRawRulesRef.current,
            override: overrideRulesRef.current,
            'override-raw': overrideRawRulesRef.current,
            replace: replaceRulesRef.current,
            filter: filterRulesRef.current,
          };
          return byCategory[openModal.category]
            .find((r) => r.id === openModal.ruleId)
            ?.models.find((m) => m.id === openModal.modelId);
        };
        const currentTarget = findModalTarget();
        const isTargetUnchanged = Boolean(
          currentTarget && areModelItemsEqual(currentTarget, openModal.model),
        );
        if (!isTargetUnchanged) {
          setAdvModalState((prev) => (prev ? { ...prev, isTargetStale: true } : null));
        } else if (openModal.isTargetStale) {
          setAdvModalState((prev) => (prev ? { ...prev, isTargetStale: false } : null));
        }
      }
    }
  }, [doc, resetVersion]);

  // Validate issues using centralized pure function
  const issues = React.useMemo(() => {
    return [
      ...validateAllPayloadRules(
        defaultRules,
        defaultRawRules,
        overrideRules,
        overrideRawRules,
        filterRules,
        replaceRules,
      ),
      ...buildUnresolvedPendingIssues(unresolvedPending),
    ];
  }, [defaultRules, defaultRawRules, overrideRules, overrideRawRules, filterRules, replaceRules, unresolvedPending]);

  useEffect(() => {
    onValidationChange?.(issues);
  }, [issues, onValidationChange]);

  // Touch tracking: only show red error states on fields after they are blurred,
  // or after the user attempts a save (validateTrigger)
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [showAllErrors, setShowAllErrors] = useState(false);

  const markTouched = (id: string) => {
    setTouchedFields((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (validateTrigger && validateTrigger > 0) {
      setShowAllErrors(true);
      if (issues.length > 0) {
        const firstCat = issues[0].category;
        setActivePanels((panels) => (panels.includes(firstCat) ? panels : [...panels, firstCat]));
      }
    }
  }, [validateTrigger, issues]);

  const issuesByTarget = React.useMemo(() => {
    const map = new Map<string, PayloadValidationIssue>();
    for (const issue of issues) {
      if (!map.has(issue.targetId)) {
        map.set(issue.targetId, issue);
      }
    }
    return map;
  }, [issues]);

  const getTargetError = (targetId: string): string | undefined => {
    const issue = issuesByTarget.get(targetId);
    if (!issue) return undefined;
    const isVisible = showAllErrors || touchedFields.has(targetId);
    return isVisible ? t(issue.messageKey) : undefined;
  };

  // Sync back helper
  const commitCategory = (category: PayloadCategoryKey, serialized: unknown[]) => {
    if (!doc) return;
    writePayloadCategory(doc, category, serialized);
    onDocChange();
  };

  // State for Advanced Model Modal
  const [advModalState, setAdvModalState] = useState<{
    open: boolean;
    category: PayloadCategoryKey;
    ruleId: string;
    modelId: string;
    model: PayloadModelItem;
    isTargetStale?: boolean;
  } | null>(null);
  const advModalStateRef = useRef(advModalState);
  advModalStateRef.current = advModalState;

  // ── Mutators for Typed Rules (default, override) ───────────────────────────
  const updateTypedRules = (
    category: 'default' | 'override',
    updater: (prev: PayloadTypedRule[]) => PayloadTypedRule[]
  ) => {
    const isDef = category === 'default';
    const current = isDef ? defaultRules : overrideRules;
    const next = updater([...current]);
    if (isDef) setDefaultRules(next);
    else setOverrideRules(next);
    commitCategory(category, serializeTypedRules(next));
  };

  const addTypedRule = (category: 'default' | 'override') => {
    updateTypedRules(category, (rules) => [
      ...rules,
      {
        id: generateDynamicId(`${category}_rule`),
        models: [{ id: generateDynamicId('m'), name: '' }],
        params: [{ id: generateDynamicId('p'), path: '', type: 'string', value: '' }],
      },
    ]);
  };

  const deleteTypedRule = (category: 'default' | 'override', ruleIndex: number) => {
    updateTypedRules(category, (rules) => rules.filter((_, idx) => idx !== ruleIndex));
  };

  // ── Mutators for Raw Rules (default-raw, override-raw) ──────────────────────
  const updateRawRules = (
    category: 'default-raw' | 'override-raw',
    updater: (prev: PayloadRawRule[]) => PayloadRawRule[]
  ) => {
    const isDef = category === 'default-raw';
    const current = isDef ? defaultRawRules : overrideRawRules;
    const next = updater([...current]);
    if (isDef) setDefaultRawRules(next);
    else setOverrideRawRules(next);
    commitCategory(category, serializeRawRules(next));
  };

  const addRawRule = (category: 'default-raw' | 'override-raw') => {
    updateRawRules(category, (rules) => [
      ...rules,
      {
        id: generateDynamicId(`${category}_rule`),
        models: [{ id: generateDynamicId('m'), name: '' }],
        params: [{ id: generateDynamicId('raw_p'), path: '', rawJson: '' }],
      },
    ]);
  };

  const deleteRawRule = (category: 'default-raw' | 'override-raw', ruleIndex: number) => {
    updateRawRules(category, (rules) => rules.filter((_, idx) => idx !== ruleIndex));
  };

  // ── Mutators for Replace Rules ─────────────────────────────────────────────
  const updateReplaceRules = (updater: (prev: PayloadReplaceRule[]) => PayloadReplaceRule[]) => {
    const next = updater([...replaceRulesRef.current]);
    replaceRulesRef.current = next;
    setReplaceRules(next);
    const nextIssues = [
      ...validateAllPayloadRules(
        defaultRulesRef.current,
        defaultRawRulesRef.current,
        overrideRulesRef.current,
        overrideRawRulesRef.current,
        filterRulesRef.current,
        next,
      ),
      ...buildUnresolvedPendingIssues(unresolvedPendingRef.current),
    ];
    onValidationChange?.(nextIssues);
    commitCategory('replace', serializeReplaceRules(next));
  };

  const addReplaceRule = () => {
    updateReplaceRules((rules) => [
      ...rules,
      {
        id: generateDynamicId('replace_rule'),
        models: [{ id: generateDynamicId('m'), name: '' }],
        target: { positions: [], all: false },
        replacements: [{ id: generateDynamicId('rep'), from: '', to: '' }],
      },
    ]);
  };

  const deleteReplaceRule = (ruleIndex: number) => {
    const removed = replaceRulesRef.current[ruleIndex];
    if (removed) {
      setPendingPositionsText(removed.id, '');
    }
    updateReplaceRules((rules) => rules.filter((_, idx) => idx !== ruleIndex));
  };

  const moveReplaceRule = (ruleIndex: number, direction: -1 | 1) => {
    const targetIndex = ruleIndex + direction;
    if (targetIndex < 0 || targetIndex >= replaceRulesRef.current.length) return;
    updateReplaceRules((rules) => {
      const next = [...rules];
      const [moved] = next.splice(ruleIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const applyPendingPositions = (): {
    hasEntries: boolean;
    anyCommitted: boolean;
    touchedIds: string[];
    nextRules: PayloadReplaceRule[];
  } => {
    const pendingEntries = Object.entries(pendingPositionsRef.current);
    if (pendingEntries.length === 0) {
      return {
        hasEntries: false,
        anyCommitted: false,
        touchedIds: [],
        nextRules: replaceRulesRef.current,
      };
    }

    const pendingByRuleId = new Map(pendingEntries);
    pendingPositionsRef.current = {};

    let anyCommitted = false;
    const touchedIds: string[] = [];
    const currentRules = replaceRulesRef.current;

    const nextRules = currentRules.map((rule) => {
      const rawText = pendingByRuleId.get(rule.id);
      if (rawText === undefined || rawText.trim() === '' || rule.target.all) {
        return rule;
      }
      const parsed = appendReplacePositionTokens(
        rawText,
        rule.target.positions,
        rule.target.invalidPositions,
      );
      touchedIds.push(`${rule.id}_target`);
      if (!parsed.changed) return rule;
      anyCommitted = true;
      return {
        ...rule,
        target: {
          ...rule.target,
          positions: parsed.positions,
          invalidPositions: parsed.invalidPositions.length > 0 ? parsed.invalidPositions : undefined,
        },
      };
    });

    return { hasEntries: true, anyCommitted, touchedIds, nextRules };
  };

  const flushPendingPositions = (): boolean => {
    const { hasEntries, anyCommitted, touchedIds, nextRules } = applyPendingPositions();
    if (!hasEntries) return false;

    setPendingPositions({});
    onPendingChangeRef.current?.(false);

    if (touchedIds.length > 0) {
      setTouchedFields((prev) => {
        const next = new Set(prev);
        for (const id of touchedIds) next.add(id);
        return next;
      });
    }

    if (anyCommitted) {
      updateReplaceRules(() => nextRules);
    }
    return anyCommitted;
  };

  const flushPendingPositionsRef = useRef(flushPendingPositions);
  flushPendingPositionsRef.current = flushPendingPositions;

  const commitPendingOnUnmountRef = useRef<() => void>(() => {});
  commitPendingOnUnmountRef.current = () => {
    const { hasEntries, anyCommitted, nextRules } = applyPendingPositions();
    if (!hasEntries) return;
    onPendingChangeRef.current?.(false);
    if (anyCommitted && docRef.current) {
      const nextIssues = [
        ...validateAllPayloadRules(
          defaultRulesRef.current,
          defaultRawRulesRef.current,
          overrideRulesRef.current,
          overrideRawRulesRef.current,
          filterRulesRef.current,
          nextRules,
        ),
        ...buildUnresolvedPendingIssues(unresolvedPendingRef.current),
      ];
      onValidationChangeRef.current?.(nextIssues);
      writePayloadCategory(docRef.current, 'replace', serializeReplaceRules(nextRules));
      onDocChangeRef.current();
    }
  };

  const clearPendingPositions = () => {
    if (Object.keys(pendingPositionsRef.current).length === 0) return;
    pendingPositionsRef.current = {};
    setPendingPositions({});
    onPendingChangeRef.current?.(false);
  };
  const clearPendingPositionsRef = useRef(clearPendingPositions);
  clearPendingPositionsRef.current = clearPendingPositions;

  useEffect(() => {
    if (!flushPendingRef) return;
    const runner = () => flushPendingPositionsRef.current();
    flushPendingRef.current = runner;
    return () => {
      if (flushPendingRef.current === runner) {
        flushPendingRef.current = null;
      }
    };
  }, [flushPendingRef]);

  useEffect(() => {
    if (!clearPendingRef) return;
    const runner = () => clearPendingPositionsRef.current();
    clearPendingRef.current = runner;
    return () => {
      if (clearPendingRef.current === runner) {
        clearPendingRef.current = null;
      }
    };
  }, [clearPendingRef]);

  useEffect(() => {
    onMountChangeRef.current?.(true);
    if (Object.values(pendingPositionsRef.current).some((text) => text.trim() !== '')) {
      onPendingChangeRef.current?.(true);
    }
    return () => {
      onMountChangeRef.current?.(false);
      commitPendingOnUnmountRef.current();
    };
  }, []);

  // ── Mutators for Filter Rules ──────────────────────────────────────────────
  const updateFilterRules = (updater: (prev: PayloadFilterRule[]) => PayloadFilterRule[]) => {
    const next = updater([...filterRules]);
    setFilterRules(next);
    commitCategory('filter', serializeFilterRules(next));
  };

  const addFilterRule = () => {
    updateFilterRules((rules) => [
      ...rules,
      {
        id: generateDynamicId('filter_rule'),
        models: [{ id: generateDynamicId('m'), name: '' }],
        params: [{ id: generateDynamicId('f_p'), path: '' }],
      },
    ]);
  };

  const deleteFilterRule = (ruleIndex: number) => {
    updateFilterRules((rules) => rules.filter((_, idx) => idx !== ruleIndex));
  };

  // ── Generic Model Manager ──────────────────────────────────────────────────
  const updateModelInRule = (
    category: PayloadCategoryKey,
    ruleIndex: number,
    modelIndex: number,
    patch: Partial<PayloadModelItem>
  ) => {
    if (category === 'default' || category === 'override') {
      updateTypedRules(category, (rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.models[modelIndex] = { ...r.models[modelIndex], ...patch };
        return rules;
      });
    } else if (category === 'default-raw' || category === 'override-raw') {
      updateRawRules(category, (rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.models[modelIndex] = { ...r.models[modelIndex], ...patch };
        return rules;
      });
    } else if (category === 'replace') {
      updateReplaceRules((rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.models[modelIndex] = { ...r.models[modelIndex], ...patch };
        return rules;
      });
    } else {
      updateFilterRules((rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.models[modelIndex] = { ...r.models[modelIndex], ...patch };
        return rules;
      });
    }
  };

  const updateModelById = (
    category: PayloadCategoryKey,
    ruleId: string,
    modelId: string,
    patch: Partial<PayloadModelItem>
  ) => {
    const patchModelList = <T extends { id: string; models: PayloadModelItem[] }>(rules: T[]): T[] => {
      const ruleIdx = rules.findIndex((r) => r.id === ruleId);
      if (ruleIdx === -1) return rules;
      const targetRule = rules[ruleIdx];
      const modelIdx = targetRule.models.findIndex((m) => m.id === modelId);
      if (modelIdx === -1) return rules;
      const nextModels = [...targetRule.models];
      nextModels[modelIdx] = { ...nextModels[modelIdx], ...patch };
      const nextRules = [...rules];
      nextRules[ruleIdx] = { ...targetRule, models: nextModels };
      return nextRules;
    };

    if (category === 'default' || category === 'override') {
      updateTypedRules(category, patchModelList);
    } else if (category === 'default-raw' || category === 'override-raw') {
      updateRawRules(category, patchModelList);
    } else if (category === 'replace') {
      updateReplaceRules(patchModelList);
    } else {
      updateFilterRules(patchModelList);
    }
  };

  const addModelToRule = (category: PayloadCategoryKey, ruleIndex: number) => {
    const newModel: PayloadModelItem = { id: generateDynamicId('m'), name: '' };
    if (category === 'default' || category === 'override') {
      updateTypedRules(category, (rules) => {
        rules[ruleIndex]?.models.push(newModel);
        return rules;
      });
    } else if (category === 'default-raw' || category === 'override-raw') {
      updateRawRules(category, (rules) => {
        rules[ruleIndex]?.models.push(newModel);
        return rules;
      });
    } else if (category === 'replace') {
      updateReplaceRules((rules) => {
        rules[ruleIndex]?.models.push(newModel);
        return rules;
      });
    } else {
      updateFilterRules((rules) => {
        rules[ruleIndex]?.models.push(newModel);
        return rules;
      });
    }
  };

  const deleteModelFromRule = (
    category: PayloadCategoryKey,
    ruleIndex: number,
    modelIndex: number
  ) => {
    if (category === 'default' || category === 'override') {
      updateTypedRules(category, (rules) => {
        if (rules[ruleIndex]) {
          rules[ruleIndex].models = rules[ruleIndex].models.filter((_, i) => i !== modelIndex);
        }
        return rules;
      });
    } else if (category === 'default-raw' || category === 'override-raw') {
      updateRawRules(category, (rules) => {
        if (rules[ruleIndex]) {
          rules[ruleIndex].models = rules[ruleIndex].models.filter((_, i) => i !== modelIndex);
        }
        return rules;
      });
    } else if (category === 'replace') {
      updateReplaceRules((rules) => {
        if (rules[ruleIndex]) {
          rules[ruleIndex].models = rules[ruleIndex].models.filter((_, i) => i !== modelIndex);
        }
        return rules;
      });
    } else {
      updateFilterRules((rules) => {
        if (rules[ruleIndex]) {
          rules[ruleIndex].models = rules[ruleIndex].models.filter((_, i) => i !== modelIndex);
        }
        return rules;
      });
    }
  };

  // ── Render Model List ──────────────────────────────────────────────────────

  return {
    activePanels,
    setActivePanels,
    defaultRules,
    defaultRawRules,
    overrideRules,
    overrideRawRules,
    replaceRules,
    pendingPositions,
    setPendingPositionsText,
    unresolvedPending,
    dismissUnresolvedPending,
    filterRules,
    issues,
    touchedFields,
    showAllErrors,
    markTouched,
    getTargetError,
    commitCategory,
    advModalState,
    setAdvModalState,
    updateTypedRules,
    addTypedRule,
    deleteTypedRule,
    updateRawRules,
    addRawRule,
    deleteRawRule,
    updateReplaceRules,
    addReplaceRule,
    deleteReplaceRule,
    moveReplaceRule,
    updateFilterRules,
    addFilterRule,
    deleteFilterRule,
    updateModelInRule,
    updateModelById,
    addModelToRule,
    deleteModelFromRule,
    PROTOCOL_OPTIONS,
    t,
  };
}

export type PayloadRulesDraft = ReturnType<typeof usePayloadRulesDraft>;
