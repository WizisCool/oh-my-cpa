import React from 'react';
import { Select } from '@/components/ui/select';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NumberInput } from '../common/NumberInput';
import { ReorderHandle, RowReorder, useReorderRow } from '../common/RowReorder';
import { Switch } from '../common/Switch';
import { Tag } from '../common/Tag';
import { ToolButton } from '../common/ToolButton';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  DeleteOutlined,
  PlusOutlined,
  SettingOutlined,
} from '../icons';
import { applyKeyOrder, moveKey, type DropSide } from '../../types/displayOrder';
import { ComposingTextarea, ComposingTextInput } from './ComposingTextInput';

import {
  appendReplacePositionTokens,
  generateDynamicId,
  isPayloadReplaceRole,
  isValidJson,
  type FilterParamItem,
  type ParamValueType,
  type PayloadCategoryKey,
  type PayloadModelItem,
  type PayloadProtocol,
  type PayloadReplacePathItem,
  type PayloadReplacePathsTarget,
  type PayloadReplaceRole,
  type PayloadReplaceRoleTarget,
  type PayloadReplaceTarget,
  type PayloadReplaceTargetMode,
  type PayloadReplacementItem,
  type RawParamItem,
  type TypedParamItem,
} from './payloadRules';
import type { PayloadRulesDraft } from './usePayloadRulesDraft';
import { ConfirmAction } from '../common/ConfirmAction';
import { Notice } from '../feedback';
import './config.css';


/**
 * The payload-rule panels: typed parameter defaults/overrides, raw JSON
 * parameter bags, ordered user-text replacements, and path filters.
 *
 * Each renderer takes the draft it reads and rewrites rather than closing over it,
 * because they compose each other and the panel a rule belongs to is a value: all
 * four rule categories share the per-model condition editor and advanced modal.
 *
 * They are render functions rather than components because the caller decides
 * which panels exist and whether they are expanded, and because a panel's draft is
 * the same object every other panel mutates.
 */

export function renderModelsSection(
  draft: PayloadRulesDraft,
  category: PayloadCategoryKey,
  ruleIndex: number,
  models: PayloadModelItem[],
  ruleId: string,
) {
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

  const sectionError = getTargetError(`${ruleId}_models`);

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
                    size="sm"
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
                    size="sm"
                    icon={<SettingOutlined />}
                    onClick={() =>
                      setAdvModalState({
                        open: true,
                        category,
                        ruleId,
                        modelId: m.id,
                        model: { ...m },
                      })
                    }
                  >
                    {t('cfg.payload_model_advanced')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
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

        {sectionError && (
          <span className="payload-field-error" role="alert">{sectionError}</span>
        )}

        <div className="payload-sub-actions">
          <Button
            size="sm"
            variant="dashed"
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
                    size="sm"
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
                      <NumberInput
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
                      <Input size="sm" disabled value="null" style={{ color: 'var(--muted)' }} />
                    ) : (
                      <Input
                        size="sm"
                        status={isJsonError ? 'error' : undefined}
                        placeholder={p.type === 'json' ? '{"key": "value"}' : t('cfg.payload_param_str_ph')}
                        value={String(p.value ?? '')}
                        onChange={(e) => updateParam(pIdx, { value: e.target.value })}
                        onBlur={() => markTouched(p.id)}
                      />
                    )}
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
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
          <Button size="sm" variant="dashed" icon={<PlusOutlined />} onClick={addParam}>
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
                    size="sm"
                    className="payload-param-path"
                    status={paramError && !isJsonError ? 'error' : undefined}
                    placeholder={t('cfg.payload_param_path_ph')}
                    value={p.path}
                    onChange={(e) => updateRawParam(pIdx, { path: e.target.value })}
                    onBlur={() => markTouched(p.id)}
                  />
                  <div className="payload-param-value-wrap">
                    <Textarea
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
                    size="sm"
                    variant="ghost"
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
          <Button size="sm" variant="dashed" icon={<PlusOutlined />} onClick={addRawParam}>
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
                    size="sm"
                    style={{ flex: 1 }}
                    status={paramError ? 'error' : undefined}
                    placeholder={t('cfg.payload_filter_path_ph')}
                    value={p.path}
                    onChange={(e) => updateFilterParam(pIdx, e.target.value)}
                    onBlur={() => markTouched(p.id)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
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
          <Button size="sm" variant="dashed" icon={<PlusOutlined />} onClick={addFilterParam}>
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
          <span className="text-muted-foreground">{t('cfg.payload_no_rules')}</span>
          <Button
            size="sm"
            variant="primary"
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
              <ConfirmAction
                title={t('cfg.payload_delete_rule_confirm')}
                confirmLabel={t('common.delete')}
                isDanger
                onConfirm={() => deleteTypedRule(category, rIdx)}
              >
                <Button size="sm" variant="ghost" danger icon={<DeleteOutlined />}>
                  {t('cfg.payload_delete_rule')}
                </Button>
              </ConfirmAction>
            </div>

            <div className="payload-rule-card-body">
              {renderModelsSection(draft, category, rIdx, r.models, r.id)}
              {renderTypedParamsSection(draft, category, rIdx, r.params)}
            </div>
          </div>
        ))}

        <div className="payload-add-rule-footer">
          <Button
            size="sm"
            variant="dashed"
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
          <span className="text-muted-foreground">{t('cfg.payload_no_rules')}</span>
          <Button
            size="sm"
            variant="primary"
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
              <ConfirmAction
                title={t('cfg.payload_delete_rule_confirm')}
                confirmLabel={t('common.delete')}
                isDanger
                onConfirm={() => deleteRawRule(category, rIdx)}
              >
                <Button size="sm" variant="ghost" danger icon={<DeleteOutlined />}>
                  {t('cfg.payload_delete_rule')}
                </Button>
              </ConfirmAction>
            </div>

            <div className="payload-rule-card-body">
              {renderModelsSection(draft, category, rIdx, r.models, r.id)}
              {renderRawParamsSection(draft, category, rIdx, r.params)}
            </div>
          </div>
        ))}

        <div className="payload-add-rule-footer">
          <Button
            size="sm"
            variant="dashed"
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
          <span className="text-muted-foreground">{t('cfg.payload_no_rules')}</span>
          <Button
            size="sm"
            variant="primary"
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
              <ConfirmAction
                title={t('cfg.payload_delete_rule_confirm')}
                confirmLabel={t('common.delete')}
                isDanger
                onConfirm={() => deleteFilterRule(rIdx)}
              >
                <Button size="sm" variant="ghost" danger icon={<DeleteOutlined />}>
                  {t('cfg.payload_delete_rule')}
                </Button>
              </ConfirmAction>
            </div>

            <div className="payload-rule-card-body">
              {renderModelsSection(draft, 'filter', rIdx, r.models, r.id)}
              {renderFilterParamsSection(draft, rIdx, r.params)}
            </div>
          </div>
        ))}

        <div className="payload-add-rule-footer">
          <Button
            size="sm"
            variant="dashed"
            icon={<PlusOutlined />}
            onClick={addFilterRule}
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      </div>
    );
}

// ── Replace rules: target (role: user, all | positions) & ordered replacements ─

interface ReplacePositionsInputProps {
  id: string;
  ruleIndex: number;
  positions: number[];
  invalidPositions?: string[];
  draftText: string;
  onDraftTextChange: (text: string) => void;
  disabled?: boolean;
  hasError?: boolean;
  placeholder: string;
  ariaLabel: string;
  removeLabel: (pos: string) => string;
  onChange: (nextPositions: number[], nextInvalidPositions: string[]) => void;
  onBlur: () => void;
}

const ReplacePositionsInput: React.FC<ReplacePositionsInputProps> = ({
  id,
  ruleIndex,
  positions,
  invalidPositions = [],
  draftText,
  onDraftTextChange,
  disabled = false,
  hasError = false,
  placeholder,
  ariaLabel,
  removeLabel,
  onChange,
  onBlur,
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const commitTokens = React.useCallback(
    (tokens: string[]) => {
      const parsed = appendReplacePositionTokens(tokens.join(' '), positions, invalidPositions);
      if (parsed.changed) {
        onChange(parsed.positions, parsed.invalidPositions);
      }
    },
    [invalidPositions, onChange, positions],
  );

  const commitAllText = React.useCallback(
    (text: string) => {
      onDraftTextChange('');
      const parsed = appendReplacePositionTokens(text, positions, invalidPositions);
      if (parsed.changed) {
        onChange(parsed.positions, parsed.invalidPositions);
      }
    },
    [invalidPositions, onChange, onDraftTextChange, positions],
  );

  const removePositionAt = (index: number) => {
    onChange(
      positions.filter((_, idx) => idx !== index),
      invalidPositions,
    );
    onBlur();
  };

  const removeInvalidAt = (index: number) => {
    onChange(
      positions,
      invalidPositions.filter((_, idx) => idx !== index),
    );
    onBlur();
  };

  const hasChips = positions.length > 0 || invalidPositions.length > 0;

  return (
    <div
      className="payload-positions-box"
      data-disabled={disabled ? '' : undefined}
      data-invalid={hasError ? '' : undefined}
      data-testid={`payload-replace-positions-box-${ruleIndex}`}
      onClick={() => {
        if (!disabled) inputRef.current?.focus();
      }}
    >
      {positions.map((pos, idx) => {
        const isPosValid = Number.isInteger(pos) && pos >= 1;
        return (
          <Tag
            key={`pos-${idx}-${pos}`}
            size="small"
            tone={isPosValid ? 'neutral' : 'danger'}
            className="payload-positions-chip"
          >
            <span>{String(pos)}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={removeLabel(String(pos))}
              onClick={(e) => {
                e.stopPropagation();
                removePositionAt(idx);
              }}
              className="payload-positions-chip-remove"
              data-testid={`payload-replace-pos-remove-${ruleIndex}-${idx}`}
            >
              <CloseOutlined />
            </button>
          </Tag>
        );
      })}
      {invalidPositions.map((token, idx) => (
        <Tag
          key={`inv-${idx}-${token}`}
          size="small"
          tone="danger"
          className="payload-positions-chip"
        >
          <span>{token}</span>
          <button
            type="button"
            tabIndex={-1}
            aria-label={removeLabel(token)}
            onClick={(e) => {
              e.stopPropagation();
              removeInvalidAt(idx);
            }}
            className="payload-positions-chip-remove"
            data-testid={`payload-replace-invpos-remove-${ruleIndex}-${idx}`}
          >
            <CloseOutlined />
          </button>
        </Tag>
      ))}
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="numeric"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={hasError || undefined}
        value={disabled ? '' : draftText}
        placeholder={!hasChips ? placeholder : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          const composing = Boolean((e.nativeEvent as InputEvent).isComposing);
          if (!composing && /[\s,]/.test(raw)) {
            const endsWithSeparator = /[\s,]$/.test(raw);
            const parts = raw.split(/[\s,]+/);
            if (endsWithSeparator) {
              onDraftTextChange('');
              commitTokens(parts);
            } else {
              const trailing = parts.pop() ?? '';
              onDraftTextChange(trailing);
              commitTokens(parts);
            }
            return;
          }
          onDraftTextChange(raw);
        }}
        onKeyDown={(e) => {
          if (Boolean(e.nativeEvent.isComposing) || e.keyCode === 229) return;
          if (e.key === 'Enter' && draftText.trim() !== '') {
            e.preventDefault();
            commitAllText(draftText);
            onBlur();
          } else if (e.key === 'Backspace' && draftText === '') {
            if (invalidPositions.length > 0) {
              removeInvalidAt(invalidPositions.length - 1);
            } else if (positions.length > 0) {
              removePositionAt(positions.length - 1);
            }
          }
        }}
        onBlur={() => {
          if (draftText.trim() !== '') {
            commitAllText(draftText);
          } else if (draftText !== '') {
            onDraftTextChange('');
          }
          onBlur();
        }}
        className="payload-positions-input"
        data-testid={`payload-replace-positions-${ruleIndex}`}
      />
    </div>
  );
};

interface ReplaceEntryRowViewProps {
  ruleIndex: number;
  entry: PayloadReplacementItem;
  index: number;
  count: number;
  feedback?: { message: string; severity: 'error' | 'warning' };
  t: PayloadRulesDraft['t'];
  onChangeKind: (index: number, nextKind: 'literal' | 'regex') => void;
  onReplaceEntry: (index: number, nextEntry: PayloadReplacementItem) => void;
  onBlur: () => void;
  onStep: (id: string, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
}

const ReplaceEntryRowView: React.FC<ReplaceEntryRowViewProps> = ({
  ruleIndex,
  entry,
  index,
  count,
  feedback,
  t,
  onChangeKind,
  onReplaceEntry,
  onBlur,
  onStep,
  onRemove,
}) => {
  const { row, handle } = useReorderRow(entry.id);
  const rawLeft = entry.kind === 'regex' ? entry.pattern : entry.from;
  const handleLabel = rawLeft.trim() || t('cfg.payload_replace_entry_label', { n: index + 1 });
  const isError = feedback?.severity === 'error';
  const isWarning = feedback?.severity === 'warning';
  const isDestError = isError && entry._invalidReason === 'non_string_value';
  const isSourceError = isError && entry._invalidReason !== 'non_string_value';
  const feedbackId = feedback ? `payload-replace-feedback-${entry.id}` : undefined;
  const sourcePlaceholder = entry.kind === 'regex'
    ? t('cfg.payload_replace_pattern_ph')
    : t('cfg.payload_replace_from_ph');
  const destPlaceholder = entry.kind === 'regex'
    ? t('cfg.payload_replace_regex_to_ph')
    : t('cfg.payload_replace_to_ph');

  return (
    <div {...row} className="payload-replace-row-wrap">
      <div className="payload-replace-row" data-testid={`payload-replace-entry-row-${ruleIndex}-${index}`}>
        <ReorderHandle {...handle} name={handleLabel} variant="inline" />
        <Select
          size="small"
          className="payload-replace-kind-select"
          value={entry.kind}
          aria-label={t('cfg.payload_replace_kind_aria', { n: index + 1 })}
          options={[
            { value: 'literal', label: t('cfg.payload_replace_kind_literal') },
            { value: 'regex', label: t('cfg.payload_replace_kind_regex') },
          ]}
          onChange={(nextKind) => onChangeKind(index, nextKind as 'literal' | 'regex')}
          data-testid={`payload-replace-kind-${ruleIndex}-${index}`}
        />
        <ComposingTextarea
          rows={1}
          autoSize={{ minRows: 1, maxRows: 4 }}
          style={{ minHeight: '28px' }}
          aria-label={`${sourcePlaceholder} ${index + 1}`}
          aria-describedby={isWarning || isSourceError ? feedbackId : undefined}
          className="config-mono-input payload-replace-from payload-replace-textarea"
          placeholder={sourcePlaceholder}
          status={isWarning ? 'warning' : isSourceError ? 'error' : undefined}
          value={rawLeft}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          onCommit={(nextLeft) => {
            if (entry.kind === 'regex') {
              const rawRecord = entry._rawEntry && typeof entry._rawEntry === 'object' && !Array.isArray(entry._rawEntry)
                ? (entry._rawEntry as Record<string, unknown>)
                : undefined;
              const hasNonStringDest =
                entry._invalidReason === 'non_string_value'
                || (entry._invalidReason === 'non_string_pattern'
                  && rawRecord !== undefined
                  && Object.prototype.hasOwnProperty.call(rawRecord, 'replacement')
                  && typeof rawRecord.replacement !== 'string');
              if (hasNonStringDest) {
                const preservedReplacement = rawRecord && Object.prototype.hasOwnProperty.call(rawRecord, 'replacement')
                  ? rawRecord.replacement
                  : null;
                onReplaceEntry(index, {
                  id: entry.id,
                  kind: 'regex',
                  pattern: nextLeft,
                  replacement: entry.replacement,
                  _invalidReason: 'non_string_value',
                  _rawEntry: { pattern: nextLeft, replacement: preservedReplacement },
                });
                return;
              }
              onReplaceEntry(index, {
                id: entry.id,
                kind: 'regex',
                pattern: nextLeft,
                replacement: entry.replacement,
              });
              return;
            }
            if (entry._invalidReason === 'non_string_value') {
              const rawEntries = entry._rawEntry && typeof entry._rawEntry === 'object' && !Array.isArray(entry._rawEntry)
                ? Object.entries(entry._rawEntry as Record<string, unknown>)
                : [];
              const preservedDest = rawEntries.length > 0 ? rawEntries[0][1] : null;
              const nextRawEntry: Record<string, unknown> = {};
              Object.defineProperty(nextRawEntry, nextLeft, {
                value: preservedDest,
                enumerable: true,
                writable: true,
                configurable: true,
              });
              onReplaceEntry(index, {
                id: entry.id,
                kind: 'literal',
                from: nextLeft,
                to: entry.to,
                _invalidReason: 'non_string_value',
                _rawEntry: nextRawEntry,
              });
              return;
            }
            onReplaceEntry(index, {
              id: entry.id,
              kind: 'literal',
              from: nextLeft,
              to: entry.to,
            });
          }}
          onBlur={onBlur}
          data-testid={
            entry.kind === 'regex'
              ? `payload-replace-pattern-${ruleIndex}-${index}`
              : `payload-replace-from-${ruleIndex}-${index}`
          }
        />
        <span className="payload-replace-arrow" aria-hidden="true">
          →
        </span>
        <ComposingTextarea
          rows={1}
          autoSize={{ minRows: 1, maxRows: 4 }}
          style={{ minHeight: '28px' }}
          aria-label={`${destPlaceholder} ${index + 1}`}
          aria-describedby={isDestError ? feedbackId : undefined}
          className="config-mono-input payload-replace-to payload-replace-textarea"
          placeholder={destPlaceholder}
          status={isDestError ? 'error' : undefined}
          value={entry.kind === 'regex' ? entry.replacement : entry.to}
          spellCheck={false}
          onCommit={(nextRight) => {
            if (entry.kind === 'regex') {
              if (entry._invalidReason === 'non_string_pattern') {
                const rawRecord = entry._rawEntry && typeof entry._rawEntry === 'object' && !Array.isArray(entry._rawEntry)
                  ? (entry._rawEntry as Record<string, unknown>)
                  : {};
                onReplaceEntry(index, {
                  id: entry.id,
                  kind: 'regex',
                  pattern: entry.pattern,
                  replacement: nextRight,
                  _invalidReason: 'non_string_pattern',
                  _rawEntry: { pattern: rawRecord.pattern ?? null, replacement: nextRight },
                });
                return;
              }
              onReplaceEntry(index, {
                id: entry.id,
                kind: 'regex',
                pattern: entry.pattern,
                replacement: nextRight,
              });
              return;
            }
            onReplaceEntry(index, {
              id: entry.id,
              kind: 'literal',
              from: entry.from,
              to: nextRight,
            });
          }}
          onBlur={onBlur}
          data-testid={`payload-replace-to-${ruleIndex}-${index}`}
        />
        <div className="payload-replace-actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowUpOutlined />}
            disabled={index === 0}
            aria-label={t('cfg.payload_replace_entry_move_up', { n: index + 1 })}
            onClick={() => onStep(entry.id, -1)}
            data-testid={`payload-replace-up-${ruleIndex}-${index}`}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowDownOutlined />}
            disabled={index === count - 1}
            aria-label={t('cfg.payload_replace_entry_move_down', { n: index + 1 })}
            onClick={() => onStep(entry.id, 1)}
            data-testid={`payload-replace-down-${ruleIndex}-${index}`}
          />
          <Button
            size="sm"
            variant="ghost"
            danger
            icon={<DeleteOutlined />}
            disabled={count <= 1}
            aria-label={t('cfg.payload_replace_entry_remove', { n: index + 1 })}
            onClick={() => onRemove(index)}
            data-testid={`payload-replace-remove-${ruleIndex}-${index}`}
          />
        </div>
      </div>
      {feedback && (
        <span
          id={feedbackId}
          className={feedback.severity === 'warning' ? 'payload-field-warning' : 'payload-field-error'}
          role={feedback.severity === 'warning' ? 'status' : 'alert'}
          data-testid={
            feedback.severity === 'warning'
              ? `payload-replace-warning-${ruleIndex}-${index}`
              : undefined
          }
        >
          {feedback.message}
        </span>
      )}
    </div>
  );
};

interface ReplaceEntriesListProps {
  draft: PayloadRulesDraft;
  ruleIndex: number;
  ruleId: string;
  replacements: PayloadReplacementItem[];
  hasInvalidShape?: boolean;
}

const ReplaceEntriesList: React.FC<ReplaceEntriesListProps> = ({
  draft,
  ruleIndex,
  ruleId,
  replacements,
  hasInvalidShape = false,
}) => {
  const { markTouched, getTargetError, getTargetFeedback, updateReplaceRules, t } = draft;

  const replaceEntry = (repIdx: number, nextEntry: PayloadReplacementItem) => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r) return rules;
      const next = [...r.replacements];
      next[repIdx] = nextEntry;
      rules[ruleIndex] = { ...r, replacements: next };
      return rules;
    });
  };

  const changeEntryKind = (repIdx: number, nextKind: 'literal' | 'regex') => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r) return rules;
      const current = r.replacements[repIdx];
      if (!current || current.kind === nextKind) return rules;
      const sourceText = current.kind === 'literal' ? current.from : current.pattern;
      const destText = current.kind === 'literal' ? current.to : current.replacement;
      const rawRecord =
        current._rawEntry && typeof current._rawEntry === 'object' && !Array.isArray(current._rawEntry)
          ? (current._rawEntry as Record<string, unknown>)
          : undefined;
      let hasNonStringDest = false;
      let preservedRawDest: unknown;
      if (current._invalidReason === 'non_string_value') {
        hasNonStringDest = true;
        if (current.kind === 'regex') {
          preservedRawDest =
            rawRecord && Object.prototype.hasOwnProperty.call(rawRecord, 'replacement')
              ? rawRecord.replacement
              : null;
        } else {
          const rawEntries = rawRecord ? Object.entries(rawRecord) : [];
          preservedRawDest = rawEntries.length > 0 ? rawEntries[0][1] : null;
        }
      } else if (
        current._invalidReason === 'non_string_pattern'
        && rawRecord
        && Object.prototype.hasOwnProperty.call(rawRecord, 'replacement')
        && typeof rawRecord.replacement !== 'string'
      ) {
        hasNonStringDest = true;
        preservedRawDest = rawRecord.replacement;
      }

      const next = [...r.replacements];
      if (nextKind === 'regex') {
        next[repIdx] = hasNonStringDest
          ? {
              id: current.id,
              kind: 'regex',
              pattern: sourceText,
              replacement: destText,
              _invalidReason: 'non_string_value',
              _rawEntry: { pattern: sourceText, replacement: preservedRawDest },
            }
          : {
              id: current.id,
              kind: 'regex',
              pattern: sourceText,
              replacement: destText,
            };
      } else if (hasNonStringDest) {
        const nextRawEntry: Record<string, unknown> = {};
        Object.defineProperty(nextRawEntry, sourceText, {
          value: preservedRawDest,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        next[repIdx] = {
          id: current.id,
          kind: 'literal',
          from: sourceText,
          to: destText,
          _invalidReason: 'non_string_value',
          _rawEntry: nextRawEntry,
        };
      } else {
        next[repIdx] = {
          id: current.id,
          kind: 'literal',
          from: sourceText,
          to: destText,
        };
      }
      rules[ruleIndex] = { ...r, replacements: next };
      return rules;
    });
  };

  const addReplacement = () => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r) return rules;
      rules[ruleIndex] = {
        ...r,
        invalidReplacements: undefined,
        replacements: [...r.replacements, { id: generateDynamicId('rep'), kind: 'literal', from: '', to: '' }],
      };
      return rules;
    });
  };

  const removeReplacement = (repIdx: number) => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r) return rules;
      rules[ruleIndex] = {
        ...r,
        replacements: r.replacements.filter((_, i) => i !== repIdx),
      };
      return rules;
    });
  };

  const rowIds = React.useMemo(() => replacements.map((rep) => rep.id), [replacements]);

  const moveRow = React.useCallback(
    (key: string, target: string, side: DropSide) => {
      const nextIds = moveKey(rowIds, key, target, side);
      if (nextIds === rowIds) return;
      updateReplaceRules((rules) => {
        const r = rules[ruleIndex];
        if (!r) return rules;
        rules[ruleIndex] = {
          ...r,
          replacements: applyKeyOrder(r.replacements, (rep) => rep.id, nextIds),
        };
        return rules;
      });
    },
    [rowIds, ruleIndex, updateReplaceRules],
  );

  const stepRow = React.useCallback(
    (key: string, direction: -1 | 1) => {
      const index = rowIds.indexOf(key);
      const neighbour = rowIds[index + direction];
      if (index >= 0 && neighbour !== undefined) {
        moveRow(key, neighbour, direction < 0 ? 'before' : 'after');
      }
    },
    [moveRow, rowIds],
  );

  const hasRegexEntry = replacements.some((rep) => rep.kind === 'regex');
  const sectionError = getTargetError(`${ruleId}_replacements`)
    ?? (hasInvalidShape ? t('cfg.payload_replace_list_invalid') : undefined);

  return (
    <div className="payload-sub-section">
      <div className="payload-sub-header">
        <span className="payload-sub-title">{t('cfg.payload_replace_entries_title')}</span>
      </div>

      <RowReorder items={rowIds} isEnabled onMove={moveRow} onStep={stepRow}>
        <div className="payload-replace-list" data-testid={`payload-replace-list-${ruleIndex}`}>
          {replacements.map((rep, repIdx) => (
            <ReplaceEntryRowView
              key={rep.id}
              ruleIndex={ruleIndex}
              entry={rep}
              index={repIdx}
              count={replacements.length}
              feedback={getTargetFeedback(rep.id)}
              t={t}
              onChangeKind={changeEntryKind}
              onReplaceEntry={replaceEntry}
              onBlur={() => markTouched(rep.id)}
              onStep={stepRow}
              onRemove={removeReplacement}
            />
          ))}
        </div>
      </RowReorder>

      {hasRegexEntry && (
        <span className="payload-replace-hint" data-testid={`payload-replace-regex-hint-${ruleIndex}`}>
          {t('cfg.payload_replace_regex_hint')}
        </span>
      )}

      {sectionError && (
        <span className="payload-field-error" role="alert">{sectionError}</span>
      )}

      <div className="payload-sub-actions">
        <Button
          size="sm"
          variant="dashed"
          icon={<PlusOutlined />}
          onClick={addReplacement}
          data-testid={`payload-replace-add-entry-${ruleIndex}`}
        >
          {t('cfg.payload_replace_entry_add')}
        </Button>
      </div>
    </div>
  );
};

interface ReplacePathRowViewProps {
  ruleIndex: number;
  item: PayloadReplacePathItem;
  index: number;
  count: number;
  errorMsg?: string;
  t: PayloadRulesDraft['t'];
  onUpdate: (index: number, nextPath: string) => void;
  onBlur: () => void;
  onStep: (id: string, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
}

const ReplacePathRowView: React.FC<ReplacePathRowViewProps> = ({
  ruleIndex,
  item,
  index,
  count,
  errorMsg,
  t,
  onUpdate,
  onBlur,
  onStep,
  onRemove,
}) => {
  const { row, handle } = useReorderRow(item.id);
  const handleLabel = item.path.trim() || t('cfg.payload_replace_path_label', { n: index + 1 });

  const rowErrorId = errorMsg ? `payload-replace-path-error-${item.id}` : undefined;

  return (
    <div {...row} className="payload-replace-row-wrap">
      <div className="payload-replace-path-row" data-testid={`payload-replace-path-row-${ruleIndex}-${index}`}>
        <ReorderHandle {...handle} name={handleLabel} variant="inline" />
        <ComposingTextInput
          size="sm"
          className="config-mono-input payload-replace-path-input"
          placeholder={t('cfg.payload_replace_path_ph')}
          aria-label={`${t('cfg.payload_replace_path_ph')} ${index + 1}`}
          aria-describedby={rowErrorId}
          status={errorMsg ? 'error' : undefined}
          value={item.path}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="none"
          onCommit={(nextPath) => onUpdate(index, nextPath)}
          onBlur={onBlur}
          data-testid={`payload-replace-path-${ruleIndex}-${index}`}
        />
        <div className="payload-replace-actions">
          <ToolButton
            size="sm"
            variant="ghost"
            icon={<ArrowUpOutlined />}
            disabled={index === 0}
            label={t('cfg.payload_replace_path_move_up', { n: index + 1 })}
            onClick={() => onStep(item.id, -1)}
            data-testid={`payload-replace-path-up-${ruleIndex}-${index}`}
          />
          <ToolButton
            size="sm"
            variant="ghost"
            icon={<ArrowDownOutlined />}
            disabled={index === count - 1}
            label={t('cfg.payload_replace_path_move_down', { n: index + 1 })}
            onClick={() => onStep(item.id, 1)}
            data-testid={`payload-replace-path-down-${ruleIndex}-${index}`}
          />
          <ToolButton
            size="sm"
            variant="ghost"
            danger
            icon={<DeleteOutlined />}
            disabled={count <= 1}
            label={t('cfg.payload_replace_path_remove', { n: index + 1 })}
            onClick={() => onRemove(index)}
            data-testid={`payload-replace-path-remove-${ruleIndex}-${index}`}
          />
        </div>
      </div>
      {errorMsg && (
        <span id={rowErrorId} className="payload-field-error" role="alert">{errorMsg}</span>
      )}
    </div>
  );
};

interface ReplacePathsEditorProps {
  draft: PayloadRulesDraft;
  ruleIndex: number;
  paths: PayloadReplacePathItem[];
}

const ReplacePathsEditor: React.FC<ReplacePathsEditorProps> = ({
  draft,
  ruleIndex,
  paths,
}) => {
  const { markTouched, getTargetError, updateReplaceRules, t } = draft;

  const updatePath = (pathIdx: number, nextPath: string) => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r || r.target.mode !== 'paths') return rules;
      const nextPaths = [...r.target.paths];
      nextPaths[pathIdx] = { id: nextPaths[pathIdx].id, path: nextPath };
      rules[ruleIndex] = {
        ...r,
        target: { ...r.target, paths: nextPaths },
      };
      return rules;
    });
  };

  const addPath = () => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r || r.target.mode !== 'paths') return rules;
      rules[ruleIndex] = {
        ...r,
        target: {
          ...r.target,
          invalidPaths: undefined,
          paths: [...r.target.paths, { id: generateDynamicId('rpath'), path: '' }],
        },
      };
      return rules;
    });
  };

  const removePath = (pathIdx: number) => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r || r.target.mode !== 'paths') return rules;
      rules[ruleIndex] = {
        ...r,
        target: {
          ...r.target,
          paths: r.target.paths.filter((_, idx) => idx !== pathIdx),
        },
      };
      return rules;
    });
  };

  const rowIds = React.useMemo(() => paths.map((item) => item.id), [paths]);

  const moveRow = React.useCallback(
    (key: string, target: string, side: DropSide) => {
      const nextIds = moveKey(rowIds, key, target, side);
      if (nextIds === rowIds) return;
      updateReplaceRules((rules) => {
        const r = rules[ruleIndex];
        if (!r || r.target.mode !== 'paths') return rules;
        rules[ruleIndex] = {
          ...r,
          target: {
            ...r.target,
            paths: applyKeyOrder(r.target.paths, (item) => item.id, nextIds),
          },
        };
        return rules;
      });
    },
    [rowIds, ruleIndex, updateReplaceRules],
  );

  const stepRow = React.useCallback(
    (key: string, direction: -1 | 1) => {
      const index = rowIds.indexOf(key);
      const neighbour = rowIds[index + direction];
      if (index >= 0 && neighbour !== undefined) {
        moveRow(key, neighbour, direction < 0 ? 'before' : 'after');
      }
    },
    [moveRow, rowIds],
  );

  return (
    <div className="payload-replace-paths-wrap">
      <RowReorder items={rowIds} isEnabled onMove={moveRow} onStep={stepRow}>
        <div className="payload-replace-list" data-testid={`payload-replace-paths-list-${ruleIndex}`}>
          {paths.map((item, pathIdx) => (
            <ReplacePathRowView
              key={item.id}
              ruleIndex={ruleIndex}
              item={item}
              index={pathIdx}
              count={paths.length}
              errorMsg={getTargetError(item.id)}
              t={t}
              onUpdate={updatePath}
              onBlur={() => markTouched(item.id)}
              onStep={stepRow}
              onRemove={removePath}
            />
          ))}
        </div>
      </RowReorder>

      <div className="payload-sub-actions">
        <Button
          size="sm"
          variant="dashed"
          icon={<PlusOutlined />}
          onClick={addPath}
          data-testid={`payload-replace-add-path-${ruleIndex}`}
        >
          {t('cfg.payload_replace_path_add')}
        </Button>
      </div>
    </div>
  );
};

export function renderReplaceTargetSection(
  draft: PayloadRulesDraft,
  ruleIndex: number,
  target: PayloadReplaceTarget,
  ruleId: string,
) {
  const {
    markTouched,
    getTargetError,
    updateReplaceRules,
    pendingPositions,
    setPendingPositionsText,
    REPLACE_ROLE_OPTIONS,
    t,
  } = draft;
  const targetId = `${ruleId}_target`;
  const targetError = getTargetError(targetId)
    ?? (target.mode === 'role'
      ? (target.invalidRole ? t('cfg.payload_replace_role_invalid') : undefined)
        ?? (target.invalidAll ? t('cfg.payload_replace_all_invalid') : undefined)
      : (target.conflictingRoleFields ? t('cfg.payload_replace_paths_conflict') : undefined)
        ?? (target.invalidPaths ? t('cfg.payload_replace_paths_invalid') : undefined));

  const roleSelectId = `payload-replace-role-${ruleId}`;
  const allSwitchId = `payload-replace-all-${ruleId}`;
  const positionsInputId = `payload-replace-positions-${ruleId}`;

  const updateRoleTarget = (patch: Partial<PayloadReplaceRoleTarget>) => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r || r.target.mode !== 'role') return rules;
      rules[ruleIndex] = {
        ...r,
        target: { ...r.target, _rawTarget: undefined, ...patch },
      };
      return rules;
    });
  };

  const updatePathsTarget = (patch: Partial<PayloadReplacePathsTarget>) => {
    updateReplaceRules((rules) => {
      const r = rules[ruleIndex];
      if (!r || r.target.mode !== 'paths') return rules;
      rules[ruleIndex] = {
        ...r,
        target: { ...r.target, ...patch },
      };
      return rules;
    });
  };

  const switchTargetMode = (nextMode: PayloadReplaceTargetMode) => {
    if (nextMode === target.mode) return;
    markTouched(targetId);
    if (nextMode === 'paths') {
      const pendingText = pendingPositions[ruleId] ?? '';
      let savedRoleTarget: PayloadReplaceRoleTarget | undefined;
      if (target.mode === 'role') {
        const parsedPending = pendingText.trim()
          ? appendReplacePositionTokens(pendingText, target.positions, target.invalidPositions)
          : undefined;
        const { _savedPathsTarget: _discarded, ...restRole } = target;
        savedRoleTarget = parsedPending?.changed
          ? {
              ...restRole,
              positions: parsedPending.positions,
              invalidPositions: parsedPending.invalidPositions.length > 0 ? parsedPending.invalidPositions : undefined,
            }
          : restRole;
      }
      setPendingPositionsText(ruleId, '');
      updateReplaceRules((rules) => {
        const r = rules[ruleIndex];
        if (!r || r.target.mode !== 'role') return rules;
        const preservedPaths = r.target._savedPathsTarget;
        const nextPathsTarget: PayloadReplacePathsTarget = preservedPaths
          ? {
              ...preservedPaths,
              ...(r.target._extra ? { _extra: r.target._extra } : {}),
              _savedRoleTarget: savedRoleTarget,
            }
          : {
              mode: 'paths',
              paths: [{ id: generateDynamicId('rpath'), path: '' }],
              ...(r.target._extra ? { _extra: r.target._extra } : {}),
              _savedRoleTarget: savedRoleTarget,
            };
        rules[ruleIndex] = {
          ...r,
          target: nextPathsTarget,
        };
        return rules;
      });
    } else {
      updateReplaceRules((rules) => {
        const r = rules[ruleIndex];
        if (!r || r.target.mode !== 'paths') return rules;
        const { _savedRoleTarget, ...restPaths } = r.target;
        const savedPathsTarget: PayloadReplacePathsTarget = restPaths;
        if (_savedRoleTarget) {
          rules[ruleIndex] = {
            ...r,
            target: {
              ..._savedRoleTarget,
              ...(r.target._extra ? { _extra: r.target._extra } : {}),
              _savedPathsTarget: savedPathsTarget,
            },
          };
          return rules;
        }
        const conflict = r.target.conflictingRoleFields;
        const hasValidRole = Boolean(conflict?.hasRole && isPayloadReplaceRole(conflict.role));
        const recoveredRole: PayloadReplaceRole = hasValidRole
          ? (conflict!.role as PayloadReplaceRole)
          : 'user';
        const recoveredInvalidRole = conflict?.hasRole && !hasValidRole
          ? { present: true, value: conflict.role }
          : undefined;
        const recoveredAll = Boolean(conflict?.hasAll && conflict.all === true);
        const recoveredInvalidAll = conflict?.hasAll && typeof conflict.all !== 'boolean'
          ? { value: conflict.all }
          : undefined;
        const recoveredPositions: number[] = [];
        const recoveredInvalidPositions: string[] = [];
        if (Array.isArray(conflict?.positions)) {
          for (const p of conflict.positions) {
            if (typeof p === 'number') {
              recoveredPositions.push(p);
            } else {
              recoveredInvalidPositions.push(String(p));
            }
          }
        } else if (conflict?.hasPositions && conflict.positions !== undefined && conflict.positions !== null) {
          recoveredInvalidPositions.push(String(conflict.positions));
        }
        rules[ruleIndex] = {
          ...r,
          target: {
            mode: 'role',
            role: recoveredRole,
            all: recoveredAll,
            positions: recoveredPositions,
            ...(recoveredInvalidRole ? { invalidRole: recoveredInvalidRole } : {}),
            ...(recoveredInvalidAll ? { invalidAll: recoveredInvalidAll } : {}),
            ...(recoveredInvalidPositions.length > 0 ? { invalidPositions: recoveredInvalidPositions } : {}),
            ...(r.target._extra ? { _extra: r.target._extra } : {}),
            _savedPathsTarget: savedPathsTarget,
          },
        };
        return rules;
      });
    }
  };

  return (
    <div className="payload-sub-section">
      <div className="payload-sub-header">
        <span className="payload-sub-title">{t('cfg.payload_replace_target_title')}</span>
        <Segmented
          size="small"
          aria-label={t('cfg.payload_replace_mode_aria')}
          value={target.mode}
          options={[
            { value: 'role', label: t('cfg.payload_replace_mode_role') },
            { value: 'paths', label: t('cfg.payload_replace_mode_paths') },
          ]}
          onChange={(val) => switchTargetMode(val as PayloadReplaceTargetMode)}
          data-testid={`payload-replace-mode-${ruleIndex}`}
        />
      </div>

      {target.mode === 'role' ? (
        <div className="payload-replace-target-box">
          <div className="payload-replace-role-row">
            <label htmlFor={roleSelectId} className="payload-replace-target-label">
              {t('cfg.payload_replace_role_label')}
            </label>
            <div className="payload-replace-role-group">
              <Select
                id={roleSelectId}
                size="small"
                className="payload-replace-role-select"
                value={target.invalidRole ? undefined : target.role}
                placeholder={
                  target.invalidRole
                    ? (target.invalidRole.present ? String(target.invalidRole.value) : '—')
                    : undefined
                }
                status={target.invalidRole ? 'error' : undefined}
                options={REPLACE_ROLE_OPTIONS}
                onChange={(val) => {
                  markTouched(targetId);
                  setPendingPositionsText(ruleId, '');
                  updateRoleTarget({ role: val as PayloadReplaceRole, invalidRole: undefined });
                }}
                data-testid={`payload-replace-role-select-${ruleIndex}`}
              />
              {target.invalidRole && (
                <>
                  <Tag
                    size="small"
                    tone="danger"
                    data-testid={`payload-replace-role-tag-${ruleIndex}`}
                  >
                    {target.invalidRole.present ? `role: ${String(target.invalidRole.value)}` : 'role: —'}
                  </Tag>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      markTouched(targetId);
                      updateRoleTarget({ role: 'user', invalidRole: undefined });
                    }}
                    data-testid={`payload-replace-fix-role-${ruleIndex}`}
                  >
                    {t('cfg.payload_replace_set_role_user')}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="payload-replace-all-row">
            <label htmlFor={allSwitchId} className="payload-replace-target-label">
              {t('cfg.payload_replace_target_all')}
            </label>
            <div className="payload-replace-role-group">
              <Switch
                id={allSwitchId}
                size="small"
                checked={target.all}
                onChange={(checked) => {
                  markTouched(targetId);
                  if (checked) {
                    setPendingPositionsText(ruleId, '');
                    updateRoleTarget({ all: true, invalidAll: undefined, positions: [], invalidPositions: undefined });
                  } else {
                    updateRoleTarget({ all: false, invalidAll: undefined });
                  }
                }}
                data-testid={`payload-replace-all-${ruleIndex}`}
              />
              {target.invalidAll && (
                <>
                  <Tag size="small" tone="danger" data-testid={`payload-replace-all-tag-${ruleIndex}`}>
                    {`all: ${String(target.invalidAll.value)}`}
                  </Tag>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      markTouched(targetId);
                      updateRoleTarget({ all: false, invalidAll: undefined });
                    }}
                    data-testid={`payload-replace-fix-all-${ruleIndex}`}
                  >
                    {t('cfg.payload_replace_set_all_false')}
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="payload-replace-positions-row">
            <label htmlFor={positionsInputId} className="payload-replace-target-label">
              {t('cfg.payload_replace_positions_label')}
            </label>
            <ReplacePositionsInput
              id={positionsInputId}
              ruleIndex={ruleIndex}
              positions={target.positions}
              invalidPositions={target.invalidPositions}
              draftText={pendingPositions[ruleId] ?? ''}
              onDraftTextChange={(text) => setPendingPositionsText(ruleId, text)}
              disabled={target.all}
              hasError={Boolean(targetError)}
              placeholder={t('cfg.payload_replace_positions_ph')}
              ariaLabel={t('cfg.payload_replace_positions_label')}
              removeLabel={(pos) => t('cfg.payload_replace_positions_remove', { pos })}
              onChange={(nextPositions, nextInvalid) => {
                markTouched(targetId);
                updateRoleTarget({
                  positions: nextPositions,
                  invalidPositions: nextInvalid.length > 0 ? nextInvalid : undefined,
                });
              }}
              onBlur={() => markTouched(targetId)}
            />
          </div>
          {target.role === 'system' && (
            <span className="payload-replace-hint">{t('cfg.payload_replace_positions_hint')}</span>
          )}
        </div>
      ) : (
        <div className="payload-replace-target-box">
          <div className="payload-replace-paths-header">
            <span className="payload-replace-target-label">
              {t('cfg.payload_replace_paths_label')}
            </span>
            <div className="payload-replace-role-group">
              {target.conflictingRoleFields && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    markTouched(targetId);
                    updatePathsTarget({ conflictingRoleFields: undefined });
                  }}
                  data-testid={`payload-replace-clear-role-fields-${ruleIndex}`}
                >
                  {t('cfg.payload_replace_clear_role_fields')}
                </Button>
              )}
              {target.invalidPaths && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    markTouched(targetId);
                    updatePathsTarget({
                      invalidPaths: undefined,
                      paths: [{ id: generateDynamicId('rpath'), path: '' }],
                    });
                  }}
                  data-testid={`payload-replace-reset-paths-${ruleIndex}`}
                >
                  {t('cfg.payload_replace_reset_paths')}
                </Button>
              )}
            </div>
          </div>

          {!target.invalidPaths && (
            <ReplacePathsEditor draft={draft} ruleIndex={ruleIndex} paths={target.paths} />
          )}

          <span className="payload-replace-hint">{t('cfg.payload_replace_paths_hint')}</span>
        </div>
      )}

      {targetError && (
        <span className="payload-field-error" role="alert">{targetError}</span>
      )}
    </div>
  );
}

export function renderReplaceCategoryContent(draft: PayloadRulesDraft) {
  const {
    replaceRules,
    unresolvedPending,
    dismissUnresolvedPending,
    addReplaceRule,
    deleteReplaceRule,
    moveReplaceRule,
    t,
  } = draft;

  const unresolvedBanner = unresolvedPending.length > 0 ? (
    <Notice
      tone="warning"
      title={t('cfg.payload_replace_pending_unresolved_title')}
      description={(
        <div className="payload-replace-unresolved-list">
          <span>{t('cfg.payload_replace_pending_unresolved')}</span>
          {unresolvedPending.map((entry) => (
            <div
              key={entry.id}
              className="payload-replace-unresolved-item"
              data-testid={`payload-replace-unresolved-item-${entry.id}`}
            >
              <span className="payload-replace-unresolved-meta">
                {t('cfg.payload_rule_num', { n: entry.ruleNumber })}:{' '}
                <code className="payload-replace-unresolved-code">{entry.text}</code>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dismissUnresolvedPending(entry.id)}
                data-testid={`payload-replace-unresolved-discard-${entry.id}`}
              >
                {t('cfg.payload_replace_pending_discard')}
              </Button>
            </div>
          ))}
        </div>
      )}
      data-testid="payload-replace-unresolved-notice"
    />
  ) : null;

  if (replaceRules.length === 0) {
    return (
      <div className="payload-rules-stack">
        {unresolvedBanner}
        <div className="payload-empty-box">
          <span className="text-muted-foreground">{t('cfg.payload_no_rules')}</span>
          <Button
            size="sm"
            variant="primary"
            icon={<PlusOutlined />}
            onClick={addReplaceRule}
            data-testid="payload-replace-add-rule"
          >
            {t('cfg.payload_add_rule')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="payload-rules-stack">
      {unresolvedBanner}
      {replaceRules.map((r, rIdx) => (
        <div key={r.id} className="payload-rule-card" data-testid={`payload-replace-rule-card-${rIdx}`}>
          <div className="payload-rule-card-header">
            <span className="payload-rule-card-title">
              {t('cfg.payload_rule_num', { n: rIdx + 1 })}
            </span>
            <div className="payload-rule-card-actions">
              <Button
                size="sm"
                variant="ghost"
                icon={<ArrowUpOutlined />}
                disabled={rIdx === 0}
                aria-label={t('cfg.payload_replace_rule_move_up', { n: rIdx + 1 })}
                onClick={() => moveReplaceRule(rIdx, -1)}
                data-testid={`payload-replace-rule-up-${rIdx}`}
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<ArrowDownOutlined />}
                disabled={rIdx === replaceRules.length - 1}
                aria-label={t('cfg.payload_replace_rule_move_down', { n: rIdx + 1 })}
                onClick={() => moveReplaceRule(rIdx, 1)}
                data-testid={`payload-replace-rule-down-${rIdx}`}
              />
              <ConfirmAction
                title={t('cfg.payload_delete_rule_confirm')}
                confirmLabel={t('common.delete')}
                isDanger
                onConfirm={() => deleteReplaceRule(rIdx)}
              >
                <Button size="sm" variant="ghost" danger icon={<DeleteOutlined />}>
                  {t('cfg.payload_delete_rule')}
                </Button>
              </ConfirmAction>
            </div>
          </div>

          <div className="payload-rule-card-body">
            {renderModelsSection(draft, 'replace', rIdx, r.models, r.id)}
            {renderReplaceTargetSection(draft, rIdx, r.target, r.id)}
            <ReplaceEntriesList
              draft={draft}
              ruleIndex={rIdx}
              ruleId={r.id}
              replacements={r.replacements}
              hasInvalidShape={Boolean(r.invalidReplacements)}
            />
          </div>
        </div>
      ))}

      <div className="payload-add-rule-footer">
        <Button
          size="sm"
          variant="dashed"
          icon={<PlusOutlined />}
          onClick={addReplaceRule}
          data-testid="payload-replace-add-rule"
        >
          {t('cfg.payload_add_rule')}
        </Button>
      </div>
    </div>
  );
}
