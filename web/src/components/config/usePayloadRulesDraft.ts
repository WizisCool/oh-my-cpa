import React, { useEffect, useRef, useState } from 'react';

import type { Document } from 'yaml';

import { useT } from '../../i18n';
import {
  generateDynamicId,
  parseFilterRules,
  parseRawRules,
  parseTypedRules,
  readPayloadCategory,
  serializeFilterRules,
  serializeRawRules,
  serializeTypedRules,
  validateAllPayloadRules,
  writePayloadCategory,
  type PayloadCategoryKey,
  type PayloadFilterRule,
  type PayloadProtocol,
  type PayloadRawRule,
  type PayloadModelItem,
  type PayloadTypedRule,
  type PayloadValidationIssue,
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
  validateTrigger,
}: {
  doc: Document | null;
  onDocChange: () => void;
  onValidationChange?: (issues: PayloadValidationIssue[]) => void;
  validateTrigger?: number;
}) {
  const t = useT();

  const PROTOCOL_OPTIONS: { value: PayloadProtocol; label: string }[] = [
    { value: '', label: t('cfg.payload_model_default') },
    { value: 'openai', label: 'openai' },
    { value: 'gemini', label: 'gemini' },
    { value: 'claude', label: 'claude' },
    { value: 'codex', label: 'codex' },
    { value: 'antigravity', label: 'antigravity' },
  ];

  const [activePanels, setActivePanels] = useState<string[]>(['default']);

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
  const [filterRules, setFilterRules] = useState<PayloadFilterRule[]>(() =>
    parseFilterRules(readPayloadCategory(doc, 'filter'), 'filter')
  );

  // Track the doc instance to only sync external document changes
  const lastDocInstanceRef = useRef<Document | null>(doc);
  useEffect(() => {
    if (doc && doc !== lastDocInstanceRef.current) {
      lastDocInstanceRef.current = doc;
      setDefaultRules(parseTypedRules(readPayloadCategory(doc, 'default'), 'default'));
      setDefaultRawRules(parseRawRules(readPayloadCategory(doc, 'default-raw'), 'default-raw'));
      setOverrideRules(parseTypedRules(readPayloadCategory(doc, 'override'), 'override'));
      setOverrideRawRules(parseRawRules(readPayloadCategory(doc, 'override-raw'), 'override-raw'));
      setFilterRules(parseFilterRules(readPayloadCategory(doc, 'filter'), 'filter'));
    }
  }, [doc]);

  // Validate issues using centralized pure function
  const issues = React.useMemo(() => {
    return validateAllPayloadRules(
      defaultRules,
      defaultRawRules,
      overrideRules,
      overrideRawRules,
      filterRules
    );
  }, [defaultRules, defaultRawRules, overrideRules, overrideRawRules, filterRules]);

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

  useEffect(() => {
    setTouchedFields(new Set());
    setShowAllErrors(false);
  }, [doc]);

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
    ruleIndex: number;
    modelIndex: number;
    model: PayloadModelItem;
  } | null>(null);

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
    } else {
      updateFilterRules((rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.models[modelIndex] = { ...r.models[modelIndex], ...patch };
        return rules;
      });
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
    updateFilterRules,
    addFilterRule,
    deleteFilterRule,
    updateModelInRule,
    addModelToRule,
    deleteModelFromRule,
    PROTOCOL_OPTIONS,
    t,
  };
}

export type PayloadRulesDraft = ReturnType<typeof usePayloadRulesDraft>;
