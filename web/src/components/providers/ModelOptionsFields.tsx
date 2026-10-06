import { Checkbox, Input, InputNumber, Select } from 'antd';

import { useT } from '../../i18n';
import type { ProviderModelOptionField } from '../../types/providers';
import { MODALITY_SUGGESTIONS, type ModelOptionsDraft, type ModelOptionsProblem } from './modelOptions';
import styles from './ProviderEditorDrawer.module.css';

interface ModelOptionsFieldsProps {
  /** Prefixes the field ids, so each model row's labels stay bound to its own inputs. */
  idPrefix: string;
  options: ModelOptionsDraft;
  onChange: (patch: Partial<ModelOptionsDraft>) => void;
  fields: readonly ProviderModelOptionField[];
  /** The entry's current problem, shown as it arises: the save refuses it either way. */
  problem: ModelOptionsProblem | null;
}

type FlagName = 'forceMapping' | 'isCompat' | 'supportConfigurationUpdate' | 'useMaxCompletionTokens';

const FLAGS: { name: FlagName; field?: ProviderModelOptionField; labelKey: string; descKey: string }[] = [
  { name: 'forceMapping', labelKey: 'pro.model_force_mapping', descKey: 'pro.model_force_mapping_desc' },
  { name: 'isCompat', field: 'is_compat', labelKey: 'pro.model_is_compat', descKey: 'pro.model_is_compat_desc' },
  {
    name: 'supportConfigurationUpdate',
    field: 'support_configuration_update',
    labelKey: 'pro.model_configuration_update',
    descKey: 'pro.model_configuration_update_desc',
  },
  {
    name: 'useMaxCompletionTokens',
    field: 'use_max_completion_tokens',
    labelKey: 'pro.model_max_completion_tokens',
    descKey: 'pro.model_max_completion_tokens_desc',
  },
];

const PROBLEM_KEYS: Record<ModelOptionsProblem, string> = {
  context_length: 'pro.model_problem_context_length',
  thinking_bounds: 'pro.model_problem_thinking_bounds',
  thinking_order: 'pro.model_problem_thinking_order',
};

const MODALITY_OPTIONS = MODALITY_SUGGESTIONS.map((value) => ({ value, label: value }));

/**
 * A model entry's advanced settings: how the gateway presents the model and what it may assume
 * about it. Only the settings the provider family's entry has are offered.
 */
export function ModelOptionsFields({ idPrefix, options, onChange, fields, problem }: ModelOptionsFieldsProps) {
  const t = useT();
  const hasBoundsProblem = problem === 'thinking_bounds' || problem === 'thinking_order';

  return (
    <>
      <div className={styles['option-grid']}>
        <div>
          <label className={styles['item-field-label']} htmlFor={`${idPrefix}-display-name`}>
            {t('pro.model_display_name')}
          </label>
          <Input
            id={`${idPrefix}-display-name`}
            value={options.displayName}
            placeholder={t('pro.model_display_name_placeholder')}
            onChange={(event) => onChange({ displayName: event.target.value })}
          />
        </div>
        {fields.includes('max_context_length') && (
          <div>
            <label className={styles['item-field-label']} htmlFor={`${idPrefix}-context-length`}>
              {t('pro.model_context_length')}
            </label>
            <InputNumber
              id={`${idPrefix}-context-length`}
              className={styles['option-number']}
              value={options.maxContextLength}
              min={1}
              precision={0}
              status={problem === 'context_length' ? 'error' : undefined}
              placeholder={t('pro.model_number_unset')}
              onChange={(maxContextLength) => onChange({ maxContextLength })}
            />
          </div>
        )}
        <div>
          <label className={styles['item-field-label']} htmlFor={`${idPrefix}-thinking-min`}>
            {t('pro.model_thinking_min')}
          </label>
          <InputNumber
            id={`${idPrefix}-thinking-min`}
            className={styles['option-number']}
            value={options.thinkingMin}
            min={1}
            precision={0}
            status={hasBoundsProblem ? 'error' : undefined}
            placeholder={t('pro.model_number_unset')}
            onChange={(thinkingMin) => onChange({ thinkingMin })}
          />
        </div>
        <div>
          <label className={styles['item-field-label']} htmlFor={`${idPrefix}-thinking-max`}>
            {t('pro.model_thinking_max')}
          </label>
          <InputNumber
            id={`${idPrefix}-thinking-max`}
            className={styles['option-number']}
            value={options.thinkingMax}
            min={1}
            precision={0}
            status={hasBoundsProblem ? 'error' : undefined}
            placeholder={t('pro.model_number_unset')}
            onChange={(thinkingMax) => onChange({ thinkingMax })}
          />
        </div>
        {fields.includes('modalities') && (
          <>
            <div>
              <label className={styles['item-field-label']} htmlFor={`${idPrefix}-input-modalities`}>
                {t('pro.model_input_modalities')}
              </label>
              <Select
                id={`${idPrefix}-input-modalities`}
                mode="tags"
                className={styles['option-select']}
                value={options.inputModalities}
                options={MODALITY_OPTIONS}
                tokenSeparators={[',', ' ']}
                placeholder={t('pro.model_modalities_placeholder')}
                onChange={(inputModalities) => onChange({ inputModalities })}
              />
            </div>
            <div>
              <label className={styles['item-field-label']} htmlFor={`${idPrefix}-output-modalities`}>
                {t('pro.model_output_modalities')}
              </label>
              <Select
                id={`${idPrefix}-output-modalities`}
                mode="tags"
                className={styles['option-select']}
                value={options.outputModalities}
                options={MODALITY_OPTIONS}
                tokenSeparators={[',', ' ']}
                placeholder={t('pro.model_modalities_placeholder')}
                onChange={(outputModalities) => onChange({ outputModalities })}
              />
            </div>
          </>
        )}
      </div>
      {problem && (
        <div className={styles['option-problem']} role="alert">
          {t(PROBLEM_KEYS[problem])}
        </div>
      )}

      <div className={styles['flag-list']}>
        <div className={styles['flag']}>
          <Checkbox
            checked={options.thinkingZeroAllowed}
            onChange={(event) => onChange({ thinkingZeroAllowed: event.target.checked })}
          >
            <span className={styles['flag-label']}>{t('pro.model_thinking_zero')}</span>
          </Checkbox>
          <div className={styles['flag-desc']}>{t('pro.model_thinking_zero_desc')}</div>
        </div>
        <div className={styles['flag']}>
          <Checkbox
            checked={options.thinkingDynamicAllowed}
            onChange={(event) => onChange({ thinkingDynamicAllowed: event.target.checked })}
          >
            <span className={styles['flag-label']}>{t('pro.model_thinking_dynamic')}</span>
          </Checkbox>
          <div className={styles['flag-desc']}>{t('pro.model_thinking_dynamic_desc')}</div>
        </div>
        {FLAGS.filter((flag) => !flag.field || fields.includes(flag.field)).map((flag) => (
          <div key={flag.name} className={styles['flag']}>
            <Checkbox
              checked={options[flag.name]}
              onChange={(event) => onChange({ [flag.name]: event.target.checked })}
            >
              <span className={styles['flag-label']}>{t(flag.labelKey)}</span>
            </Checkbox>
            <div className={styles['flag-desc']}>{t(flag.descKey)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
