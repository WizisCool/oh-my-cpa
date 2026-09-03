import React, { useEffect, useState, useRef } from 'react';
import {
  Button,
  Collapse,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { Document } from 'yaml';
import { useT } from '../../i18n';
import {
  generateDynamicId,
  isValidJson,
  parseFilterRules,
  parseRawRules,
  parseTypedRules,
  readPayloadCategory,
  serializeFilterRules,
  serializeRawRules,
  serializeTypedRules,
  validateAllPayloadRules,
  writePayloadCategory,
  type FilterParamItem,
  type ParamValueType,
  type PayloadCategoryKey,
  type PayloadFilterRule,
  type PayloadKVCondition,
  type PayloadModelItem,
  type PayloadProtocol,
  type PayloadRawRule,
  type PayloadTypedRule,
  type PayloadValidationIssue,
  type RawParamItem,
  type TypedParamItem,
} from './payloadRules';

const { Text } = Typography;

export type { PayloadValidationIssue };

export interface PayloadRulesEditorProps {
  doc: Document | null;
  onDocChange: () => void;
  onValidationChange?: (issues: PayloadValidationIssue[]) => void;
  validateTrigger?: number;
}

export const PayloadRulesEditor: React.FC<PayloadRulesEditorProps> = ({
  doc,
  onDocChange,
  onValidationChange,
  validateTrigger,
}) => {
  const t = useT();

  const PROTOCOL_OPTIONS: { value: PayloadProtocol; label: string }[] = [
    { value: '', label: t('cfg.payload_model_default') },
    { value: 'openai', label: 'openai' },
    { value: 'gemini', label: 'gemini' },
    { value: 'claude', label: 'claude' },
    { value: 'codex', label: 'codex' },
    { value: 'antigravity', label: 'antigravity' },
  ];

  // Active accordion keys
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
  const renderModelsSection = (
    category: PayloadCategoryKey,
    ruleIndex: number,
    models: PayloadModelItem[]
  ) => {
    return (
      <div className="payload-sub-section">
        <div className="payload-sub-header">
          <span className="payload-sub-title">{t('cfg.payload_models_title')}</span>
        </div>

        <div className="payload-models-list">
          {models.map((m, mIdx) => {
            const modelError = getTargetError(m.id);
            return (
              <div key={m.id} className="payload-model-row-wrap">
                <div className="payload-model-row">
                  <Input
                    size="small"
                    className="payload-model-input"
                    status={modelError ? 'error' : undefined}
                    placeholder={t('cfg.payload_model_name_ph')}
                    value={m.name}
                    onChange={(e) =>
                      updateModelInRule(category, ruleIndex, mIdx, { name: e.target.value })
                    }
                    onBlur={() => markTouched(m.id)}
                  />
                  <Select
                    size="small"
                    className="payload-protocol-select"
                    value={m.protocol ?? ''}
                    options={PROTOCOL_OPTIONS}
                    onChange={(val) =>
                      updateModelInRule(category, ruleIndex, mIdx, {
                        protocol: val as PayloadProtocol,
                      })
                    }
                  />
                  <Button
                    size="small"
                    icon={<SettingOutlined />}
                    onClick={() =>
                      setAdvModalState({
                        open: true,
                        category,
                        ruleIndex,
                        modelIndex: mIdx,
                        model: { ...m },
                      })
                    }
                  >
                    {t('cfg.payload_model_advanced')}
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => deleteModelFromRule(category, ruleIndex, mIdx)}
                    disabled={models.length <= 1}
                  />
                </div>
                {modelError && (
                  <span className="payload-field-error">{modelError}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="payload-sub-actions">
          <Button
            size="small"
            type="dashed"
            icon={<PlusOutlined />}
            onClick={() => addModelToRule(category, ruleIndex)}
          >
            {t('cfg.payload_models_add')}
          </Button>
        </div>
      </div>
    );
  };

  // ── Render Typed Params List (default, override) ───────────────────────────
  const renderTypedParamsSection = (
    category: 'default' | 'override',
    ruleIndex: number,
    params: TypedParamItem[]
  ) => {
    const pathCounts = new Map<string, number>();
    params.forEach((p) => {
      const trimmed = p.path.trim();
      if (trimmed) pathCounts.set(trimmed, (pathCounts.get(trimmed) || 0) + 1);
    });

    const updateParam = (pIdx: number, patch: Partial<TypedParamItem>) => {
      updateTypedRules(category, (rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.params[pIdx] = { ...r.params[pIdx], ...patch };
        return rules;
      });
    };

    const addParam = () => {
      updateTypedRules(category, (rules) => {
        rules[ruleIndex]?.params.push({
          id: generateDynamicId('p'),
          path: '',
          type: 'string',
          value: '',
        });
        return rules;
      });
    };

    const deleteParam = (pIdx: number) => {
      updateTypedRules(category, (rules) => {
        if (rules[ruleIndex]) {
          rules[ruleIndex].params = rules[ruleIndex].params.filter((_, i) => i !== pIdx);
        }
        return rules;
      });
    };

    const PARAM_TYPES: { value: ParamValueType; label: string }[] = [
      { value: 'string', label: t('cfg.payload_type_string') },
      { value: 'number', label: t('cfg.payload_type_number') },
      { value: 'boolean', label: t('cfg.payload_type_boolean') },
      { value: 'null', label: t('cfg.payload_type_null') },
      { value: 'json', label: t('cfg.payload_type_json') },
    ];

    return (
      <div className="payload-sub-section">
        <div className="payload-sub-header">
          <span className="payload-sub-title">{t('cfg.payload_params_title')}</span>
        </div>

        <div className="payload-params-list">
          {params.map((p, pIdx) => {
            const paramError = getTargetError(p.id);
            const isJsonError = paramError && p.type === 'json' && !isValidJson(String(p.value ?? ''));

            return (
              <div key={p.id} className="payload-param-row-wrap">
                <div className="payload-param-row">
                  <Input
                    size="small"
                    className="payload-param-path"
                    status={paramError && !isJsonError ? 'error' : undefined}
                    placeholder={t('cfg.payload_param_path_ph')}
                    value={p.path}
                    onChange={(e) => updateParam(pIdx, { path: e.target.value })}
                    onBlur={() => markTouched(p.id)}
                  />
                  <Select
                    size="small"
                    className="payload-param-type-select"
                    value={p.type}
                    options={PARAM_TYPES}
                    onChange={(newType) => {
                      const fallbackVal =
                        newType === 'number'
                          ? 0
                          : newType === 'boolean'
                          ? true
                          : newType === 'null'
                          ? null
                          : newType === 'json'
                          ? '{}'
                          : '';
                      updateParam(pIdx, { type: newType as ParamValueType, value: fallbackVal });
                    }}
                  />

                  {/* Typed Value Control */}
                  <div className="payload-param-value-wrap">
                    {p.type === 'number' ? (
                      <InputNumber
                        size="small"
                        style={{ width: '100%' }}
                        value={Number(p.value) || 0}
                        onChange={(val) => updateParam(pIdx, { value: val ?? 0 })}
                        onBlur={() => markTouched(p.id)}
                      />
                    ) : p.type === 'boolean' ? (
                      <Select
                        size="small"
                        style={{ width: '100%' }}
                        value={Boolean(p.value)}
                        options={[
                          { value: true, label: 'true' },
                          { value: false, label: 'false' },
                        ]}
                        onChange={(val) => updateParam(pIdx, { value: val })}
                        onBlur={() => markTouched(p.id)}
                      />
                    ) : p.type === 'null' ? (
                      <Input size="small" disabled value="null" style={{ color: 'var(--muted)' }} />
                    ) : (
                      <Input
                        size="small"
                        status={isJsonError ? 'error' : undefined}
                        placeholder={p.type === 'json' ? '{"key": "value"}' : t('cfg.payload_param_str_ph')}
                        value={String(p.value ?? '')}
                        onChange={(e) => updateParam(pIdx, { value: e.target.value })}
                        onBlur={() => markTouched(p.id)}
                      />
                    )}
                  </div>

                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => deleteParam(pIdx)}
                    disabled={params.length <= 1}
                  />
                </div>
                {paramError && (
                  <span className="payload-field-error">{paramError}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="payload-sub-actions">
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addParam}>
            {t('cfg.payload_param_add')}
          </Button>
        </div>
      </div>
    );
  };

  // ── Render Raw Params List (default-raw, override-raw) ──────────────────────
  const renderRawParamsSection = (
    category: 'default-raw' | 'override-raw',
    ruleIndex: number,
    params: RawParamItem[]
  ) => {
    const pathCounts = new Map<string, number>();
    params.forEach((p) => {
      const trimmed = p.path.trim();
      if (trimmed) pathCounts.set(trimmed, (pathCounts.get(trimmed) || 0) + 1);
    });

    const updateRawParam = (pIdx: number, patch: Partial<RawParamItem>) => {
      updateRawRules(category, (rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.params[pIdx] = { ...r.params[pIdx], ...patch };
        return rules;
      });
    };

    const addRawParam = () => {
      updateRawRules(category, (rules) => {
        rules[ruleIndex]?.params.push({
          id: generateDynamicId('raw_p'),
          path: '',
          rawJson: '',
        });
        return rules;
      });
    };

    const deleteRawParam = (pIdx: number) => {
      updateRawRules(category, (rules) => {
        if (rules[ruleIndex]) {
          rules[ruleIndex].params = rules[ruleIndex].params.filter((_, i) => i !== pIdx);
        }
        return rules;
      });
    };

    return (
      <div className="payload-sub-section">
        <div className="payload-sub-header">
          <span className="payload-sub-title">{t('cfg.payload_params_title')}</span>
        </div>

        <div className="payload-params-list">
          {params.map((p, pIdx) => {
            const paramError = getTargetError(p.id);
            const isJsonError = paramError && !isValidJson(p.rawJson);

            return (
              <div key={p.id} className="payload-param-row-wrap">
                <div className="payload-param-row is-raw">
                  <Input
                    size="small"
                    className="payload-param-path"
                    status={paramError && !isJsonError ? 'error' : undefined}
                    placeholder={t('cfg.payload_param_path_ph')}
                    value={p.path}
                    onChange={(e) => updateRawParam(pIdx, { path: e.target.value })}
                    onBlur={() => markTouched(p.id)}
                  />
                  <div className="payload-param-value-wrap">
                    <Input.TextArea
                      rows={1}
                      autoSize={{ minRows: 1, maxRows: 4 }}
                      className="config-mono-input"
                      status={isJsonError ? 'error' : undefined}
                      placeholder={t('cfg.payload_param_raw_ph')}
                      value={p.rawJson}
                      onChange={(e) => updateRawParam(pIdx, { rawJson: e.target.value })}
                      onBlur={() => markTouched(p.id)}
                    />
                  </div>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => deleteRawParam(pIdx)}
                    disabled={params.length <= 1}
                  />
                </div>
                {paramError && (
                  <span className="payload-field-error">{paramError}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="payload-sub-actions">
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addRawParam}>
            {t('cfg.payload_param_add')}
          </Button>
        </div>
      </div>
    );
  };

  // ── Render Filter Params List (filter) ─────────────────────────────────────
  const renderFilterParamsSection = (ruleIndex: number, params: FilterParamItem[]) => {
    const pathCounts = new Map<string, number>();
    params.forEach((p) => {
      const trimmed = p.path.trim();
      if (trimmed) pathCounts.set(trimmed, (pathCounts.get(trimmed) || 0) + 1);
    });

    const updateFilterParam = (pIdx: number, path: string) => {
      updateFilterRules((rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        r.params[pIdx] = { ...r.params[pIdx], path };
        return rules;
      });
    };

    const addFilterParam = () => {
      updateFilterRules((rules) => {
        rules[ruleIndex]?.params.push({
          id: generateDynamicId('f_p'),
          path: '',
        });
        return rules;
      });
    };

    const deleteFilterParam = (pIdx: number) => {
      updateFilterRules((rules) => {
        if (rules[ruleIndex]) {
          rules[ruleIndex].params = rules[ruleIndex].params.filter((_, i) => i !== pIdx);
        }
        return rules;
      });
    };

    return (
      <div className="payload-sub-section">
        <div className="payload-sub-header">
          <span className="payload-sub-title">{t('cfg.payload_params_title')}</span>
        </div>

        <div className="payload-params-list">
          {params.map((p, pIdx) => {
            const paramError = getTargetError(p.id);

            return (
              <div key={p.id} className="payload-param-row-wrap">
                <div className="payload-param-row is-filter">
                  <Input
                    size="small"
                    style={{ flex: 1 }}
                    status={paramError ? 'error' : undefined}
                    placeholder={t('cfg.payload_filter_path_ph')}
                    value={p.path}
                    onChange={(e) => updateFilterParam(pIdx, e.target.value)}
                    onBlur={() => markTouched(p.id)}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => deleteFilterParam(pIdx)}
                    disabled={params.length <= 1}
                  />
                </div>
                {paramError && <span className="payload-field-error">{paramError}</span>}
              </div>
            );
          })}
        </div>

        <div className="payload-sub-actions">
          <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addFilterParam}>
            {t('cfg.payload_filter_add')}
          </Button>
        </div>
      </div>
    );
  };

  // ── Render Panel Content for Each Category ─────────────────────────────────
  const renderTypedCategoryContent = (category: 'default' | 'override') => {
    const rules = category === 'default' ? defaultRules : overrideRules;
    if (rules.length === 0) {
      return (
        <div className="payload-empty-box">
          <Text type="secondary">{t('cfg.payload_no_rules')}</Text>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => addTypedRule(category)}
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      );
    }

    return (
      <div className="payload-rules-stack">
        {rules.map((r, rIdx) => (
          <div key={r.id} className="payload-rule-card">
            <div className="payload-rule-card-header">
              <span className="payload-rule-card-title">
                {t('cfg.payload_rule_num', { n: rIdx + 1 })}
              </span>
              <Popconfirm
                title={t('cfg.payload_delete_rule_confirm')}
                onConfirm={() => deleteTypedRule(category, rIdx)}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />}>
                  {t('cfg.payload_delete_rule')}
                </Button>
              </Popconfirm>
            </div>

            <div className="payload-rule-card-body">
              {renderModelsSection(category, rIdx, r.models)}
              {renderTypedParamsSection(category, rIdx, r.params)}
            </div>
          </div>
        ))}

        <div className="payload-add-rule-footer">
          <Button
            size="small"
            type="dashed"
            icon={<PlusOutlined />}
            onClick={() => addTypedRule(category)}
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      </div>
    );
  };

  const renderRawCategoryContent = (category: 'default-raw' | 'override-raw') => {
    const rules = category === 'default-raw' ? defaultRawRules : overrideRawRules;
    if (rules.length === 0) {
      return (
        <div className="payload-empty-box">
          <Text type="secondary">{t('cfg.payload_no_rules')}</Text>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => addRawRule(category)}
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      );
    }

    return (
      <div className="payload-rules-stack">
        {rules.map((r, rIdx) => (
          <div key={r.id} className="payload-rule-card">
            <div className="payload-rule-card-header">
              <span className="payload-rule-card-title">
                {t('cfg.payload_rule_num', { n: rIdx + 1 })}
              </span>
              <Popconfirm
                title={t('cfg.payload_delete_rule_confirm')}
                onConfirm={() => deleteRawRule(category, rIdx)}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />}>
                  {t('cfg.payload_delete_rule')}
                </Button>
              </Popconfirm>
            </div>

            <div className="payload-rule-card-body">
              {renderModelsSection(category, rIdx, r.models)}
              {renderRawParamsSection(category, rIdx, r.params)}
            </div>
          </div>
        ))}

        <div className="payload-add-rule-footer">
          <Button
            size="small"
            type="dashed"
            icon={<PlusOutlined />}
            onClick={() => addRawRule(category)}
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      </div>
    );
  };

  const renderFilterCategoryContent = () => {
    if (filterRules.length === 0) {
      return (
        <div className="payload-empty-box">
          <Text type="secondary">{t('cfg.payload_no_rules')}</Text>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={addFilterRule}
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      );
    }

    return (
      <div className="payload-rules-stack">
        {filterRules.map((r, rIdx) => (
          <div key={r.id} className="payload-rule-card">
            <div className="payload-rule-card-header">
              <span className="payload-rule-card-title">
                {t('cfg.payload_rule_num', { n: rIdx + 1 })}
              </span>
              <Popconfirm
                title={t('cfg.payload_delete_rule_confirm')}
                onConfirm={() => deleteFilterRule(rIdx)}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />}>
                  {t('cfg.payload_delete_rule')}
                </Button>
              </Popconfirm>
            </div>

            <div className="payload-rule-card-body">
              {renderModelsSection('filter', rIdx, r.models)}
              {renderFilterParamsSection(rIdx, r.params)}
            </div>
          </div>
        ))}

        <div className="payload-add-rule-footer">
          <Button
            size="small"
            type="dashed"
            icon={<PlusOutlined />}
            onClick={addFilterRule}
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      </div>
    );
  };

  // ── Build Collapse Items ───────────────────────────────────────────────────
  const items = [
    {
      key: 'default',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_default')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_default_desc')}</span>
          </div>
          {defaultRules.length > 0 && (
            <Tag className="payload-count-badge">{defaultRules.length}</Tag>
          )}
        </div>
      ),
      children: renderTypedCategoryContent('default'),
    },
    {
      key: 'default-raw',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_default_raw')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_default_raw_desc')}</span>
          </div>
          {defaultRawRules.length > 0 && (
            <Tag className="payload-count-badge">{defaultRawRules.length}</Tag>
          )}
        </div>
      ),
      children: renderRawCategoryContent('default-raw'),
    },
    {
      key: 'override',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_override')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_override_desc')}</span>
          </div>
          {overrideRules.length > 0 && (
            <Tag className="payload-count-badge">{overrideRules.length}</Tag>
          )}
        </div>
      ),
      children: renderTypedCategoryContent('override'),
    },
    {
      key: 'override-raw',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_override_raw')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_override_raw_desc')}</span>
          </div>
          {overrideRawRules.length > 0 && (
            <Tag className="payload-count-badge">{overrideRawRules.length}</Tag>
          )}
        </div>
      ),
      children: renderRawCategoryContent('override-raw'),
    },
    {
      key: 'filter',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_filter')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_filter_desc')}</span>
          </div>
          {filterRules.length > 0 && (
            <Tag className="payload-count-badge">{filterRules.length}</Tag>
          )}
        </div>
      ),
      children: renderFilterCategoryContent(),
    },
  ];

  // ── Advanced Model Modal ───────────────────────────────────────────────────
  const [advDraft, setAdvDraft] = useState<PayloadModelItem | null>(null);

  useEffect(() => {
    if (advModalState?.model) {
      setAdvDraft(JSON.parse(JSON.stringify(advModalState.model)));
    } else {
      setAdvDraft(null);
    }
  }, [advModalState]);

  const handleSaveAdvanced = () => {
    if (!advModalState || !advDraft) return;
    updateModelInRule(
      advModalState.category,
      advModalState.ruleIndex,
      advModalState.modelIndex,
      advDraft
    );
    setAdvModalState(null);
  };

  const renderKvEditor = (
    label: string,
    items: PayloadKVCondition[] = [],
    onChange: (items: PayloadKVCondition[]) => void
  ) => {
    return (
      <div className="payload-adv-field">
        <div className="payload-adv-kv-header">
          <label className="payload-adv-label">{label}</label>
          <Button
            size="small"
            type="link"
            icon={<PlusOutlined />}
            onClick={() =>
              onChange([
                ...items,
                { id: generateDynamicId('kv'), key: '', value: '' },
              ])
            }
          >
            {t('cfg.payload_adv_add_condition')}
          </Button>
        </div>
        <div className="payload-adv-kv-list">
          {items.map((it, idx) => (
            <div key={it.id} className="payload-adv-kv-row">
              <Input
                size="small"
                placeholder={t('cfg.payload_adv_kv_key')}
                value={it.key}
                onChange={(e) => {
                  const copy = [...items];
                  copy[idx] = { ...copy[idx], key: e.target.value };
                  onChange(copy);
                }}
              />
              <Input
                size="small"
                placeholder={t('cfg.payload_adv_kv_val')}
                value={it.value !== undefined && it.value !== null ? String(it.value) : ''}
                onChange={(e) => {
                  const copy = [...items];
                  copy[idx] = { ...copy[idx], value: e.target.value };
                  onChange(copy);
                }}
              />
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="payload-rules-container">
      <Collapse
        activeKey={activePanels}
        onChange={(keys) => setActivePanels(Array.isArray(keys) ? keys : [keys])}
        items={items}
        className="payload-collapse"
      />

      {/* Advanced Model Conditions Modal */}
      <Modal
        title={`${t('cfg.payload_adv_title')} - ${advDraft?.name || t('cfg.payload_models_title')}`}
        open={Boolean(advModalState?.open)}
        onOk={handleSaveAdvanced}
        onCancel={() => setAdvModalState(null)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnClose
        width={600}
      >
        {advDraft && (
          <div className="payload-adv-modal-body">
            {/* from-protocol */}
            <div className="payload-adv-field">
              <label className="payload-adv-label">{t('cfg.payload_adv_from_proto')}</label>
              <Select
                size="small"
                style={{ width: '100%' }}
                allowClear
                placeholder="openai / responses / gemini / claude"
                value={advDraft.fromProtocol}
                options={[
                  { value: 'openai', label: 'openai' },
                  { value: 'responses', label: 'responses' },
                  { value: 'gemini', label: 'gemini' },
                  { value: 'claude', label: 'claude' },
                ]}
                onChange={(val) => setAdvDraft({ ...advDraft, fromProtocol: val })}
              />
            </div>

            {/* headers */}
            {renderKvEditor(
              t('cfg.payload_adv_headers'),
              advDraft.headers,
              (hdrs) => setAdvDraft({ ...advDraft, headers: hdrs })
            )}

            {/* match */}
            {renderKvEditor(
              t('cfg.payload_adv_match'),
              advDraft.match,
              (m) => setAdvDraft({ ...advDraft, match: m })
            )}

            {/* not-match */}
            {renderKvEditor(
              t('cfg.payload_adv_not_match'),
              advDraft.notMatch,
              (nm) => setAdvDraft({ ...advDraft, notMatch: nm })
            )}

            {/* exist paths */}
            <div className="payload-adv-field">
              <label className="payload-adv-label">{t('cfg.payload_adv_exist')}</label>
              <Select
                mode="tags"
                size="small"
                style={{ width: '100%' }}
                placeholder={t('cfg.payload_adv_add_path')}
                value={advDraft.exist ?? []}
                onChange={(tags) => setAdvDraft({ ...advDraft, exist: tags })}
              />
            </div>

            {/* not-exist paths */}
            <div className="payload-adv-field">
              <label className="payload-adv-label">{t('cfg.payload_adv_not_exist')}</label>
              <Select
                mode="tags"
                size="small"
                style={{ width: '100%' }}
                placeholder={t('cfg.payload_adv_add_path')}
                value={advDraft.notExist ?? []}
                onChange={(tags) => setAdvDraft({ ...advDraft, notExist: tags })}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default PayloadRulesEditor;
