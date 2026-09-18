import { Button, Input, InputNumber, Popconfirm, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';

import {
  generateDynamicId,
  isValidJson,
  type FilterParamItem,
  type ParamValueType,
  type PayloadCategoryKey,
  type PayloadModelItem,
  type PayloadProtocol,
  type RawParamItem,
  type TypedParamItem,
} from './payloadRules';
import type { PayloadRulesDraft } from './usePayloadRulesDraft';

const { Text } = Typography;

/**
 * The three payload-rule panels: the typed rules' parameters and per-model
 * overrides, the raw rules' parameter bags, and the filter rules' matchers.
 *
 * Each renderer takes the draft it reads and rewrites rather than closing over it,
 * because they compose each other and the panel a rule belongs to is a value: the
 * typed and raw panels share the per-model override editor, and the filter panel
 * reuses it for its own model list.
 *
 * They are render functions rather than components because the caller decides
 * which panels exist and whether they are expanded, and because a panel's draft is
 * the same object every other panel mutates.
 */

export function renderModelsSection(draft: PayloadRulesDraft, category: PayloadCategoryKey, ruleIndex: number, models: PayloadModelItem[]) {
  const {
    markTouched,
    getTargetError,
    setAdvModalState,
    updateModelInRule,
    addModelToRule,
    deleteModelFromRule,
    t,
    PROTOCOL_OPTIONS,
  } = draft;

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
}

export function renderTypedParamsSection(draft: PayloadRulesDraft, category: 'default' | 'override', ruleIndex: number, params: TypedParamItem[]) {
  const {
    markTouched,
    getTargetError,
    updateTypedRules,
    t,
  } = draft;

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
}

export function renderRawParamsSection(draft: PayloadRulesDraft, category: 'default-raw' | 'override-raw', ruleIndex: number, params: RawParamItem[]) {
  const {
    markTouched,
    getTargetError,
    updateRawRules,
    t,
  } = draft;

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
}

export function renderFilterParamsSection(draft: PayloadRulesDraft, ruleIndex: number, params: FilterParamItem[]) {
  const {
    markTouched,
    getTargetError,
    updateFilterRules,
    t,
  } = draft;

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
}

export function renderTypedCategoryContent(draft: PayloadRulesDraft, category: 'default' | 'override') {
  const {
    defaultRules,
    overrideRules,
    addTypedRule,
    deleteTypedRule,
    t,
  } = draft;

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
              {renderModelsSection(draft, category, rIdx, r.models)}
              {renderTypedParamsSection(draft, category, rIdx, r.params)}
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
}

export function renderRawCategoryContent(draft: PayloadRulesDraft, category: 'default-raw' | 'override-raw') {
  const {
    defaultRawRules,
    overrideRawRules,
    addRawRule,
    deleteRawRule,
    t,
  } = draft;

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
              {renderModelsSection(draft, category, rIdx, r.models)}
              {renderRawParamsSection(draft, category, rIdx, r.params)}
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
}

export function renderFilterCategoryContent(draft: PayloadRulesDraft) {
  const {
    filterRules,
    addFilterRule,
    deleteFilterRule,
    t,
  } = draft;

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
              {renderModelsSection(draft, 'filter', rIdx, r.models)}
              {renderFilterParamsSection(draft, rIdx, r.params)}
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
}
