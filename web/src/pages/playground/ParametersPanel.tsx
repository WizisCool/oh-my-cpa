import React from 'react';
import { AutoComplete, Button, Input, InputNumber, Slider, Tooltip } from 'antd';
import { clsx } from 'clsx';
import { UndoOutlined } from '../../components/icons';
import { REASONING_EFFORTS } from '../../components/workspace/ReasoningEffortPicker';
import workspace from '../../components/workspace/Workspace.module.css';
import { useI18n } from '../../i18n';
import { hasCustomParameters, readCustomBody } from './state';
import type { PlaygroundParameters } from './state';
import styles from './PlaygroundPage.module.css';

interface NumberParameterProps {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  /** Where the slider rests while the value is unset; it is drawn muted there, never read as a value. */
  restingValue: number;
  onChange: (value: number | null) => void;
}

/**
 * A bounded number as a slider and an exact field.
 *
 * Unset is a real state - the parameter is left out and the model decides - so the field shows
 * "Default" rather than a number, and the slider is drawn muted at a resting point until it is
 * moved. The reset control returns it to unset; it is only drawn once there is something to undo.
 */
function NumberParameter({ id, label, value, min, max, step, restingValue, onChange }: NumberParameterProps) {
  const { t } = useI18n();
  const isUnset = value === null;
  return (
    <div className={workspace['field']}>
      <div className={workspace['field-label']}>
        <label htmlFor={id}>{label}</label>
        {!isUnset && (
          <Tooltip title={t('conversation.model_default')}>
            <Button type="text" size="small" aria-label={`${t('conversation.model_default')}: ${label}`} icon={<UndoOutlined />} onClick={() => onChange(null)} />
          </Tooltip>
        )}
      </div>
      <div className={styles['number-row']}>
        <Slider
          className={clsx(styles['slider'], isUnset && styles['is-unset'])}
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value ?? restingValue}
          tooltip={{ open: false }}
          onChange={next => onChange(next)}
        />
        <InputNumber
          id={id}
          className={styles['number-input']}
          min={min}
          max={max}
          step={step}
          value={value}
          placeholder={t('pg.default')}
          onChange={next => onChange(typeof next === 'number' ? next : null)}
        />
      </div>
    </div>
  );
}

export interface ParametersPanelProps {
  parameters: PlaygroundParameters;
  defaultUserAgent: string;
  onChange: (patch: Partial<PlaygroundParameters>) => void;
  onReset: () => void;
}

/** What the next request is built from. Edits apply to the next message; a retry replays its own snapshot. */
export const ParametersPanel = React.memo(function ParametersPanel({ parameters, defaultUserAgent, onChange, onReset }: ParametersPanelProps) {
  const { t } = useI18n();
  const reasoningOptions = React.useMemo(
    () => REASONING_EFFORTS.map(value => ({ value, label: t(`conversation.reasoning_effort.${value}`) })),
    [t],
  );
  const isCustomBodyValid = readCustomBody(parameters.customBody).ok;

  return (
    <div className={workspace['panel']}>
      <section className={workspace['panel-section']}>
        <div className={workspace['section-head']}>
          <h2 className={workspace['section-title']}>{t('pg.generation')}</h2>
          <Button size="small" type="text" disabled={!hasCustomParameters(parameters)} icon={<UndoOutlined />} onClick={onReset}>
            {t('pg.reset')}
          </Button>
        </div>
        <div className={workspace['field']}>
          <label className={workspace['field-label']} htmlFor="playground-system">{t('pg.system')}</label>
          <Input.TextArea
            id="playground-system"
            value={parameters.systemPrompt}
            autoSize={{ minRows: 3, maxRows: 10 }}
            onChange={event => onChange({ systemPrompt: event.target.value })}
          />
        </div>
        <NumberParameter
          id="playground-temperature"
          label={t('pg.temperature')}
          value={parameters.temperature}
          min={0}
          max={2}
          step={0.01}
          restingValue={1}
          onChange={temperature => onChange({ temperature })}
        />
        <NumberParameter
          id="playground-top-p"
          label={t('pg.top_p')}
          value={parameters.topP}
          min={0}
          max={1}
          step={0.01}
          restingValue={1}
          onChange={topP => onChange({ topP })}
        />
        <div className={workspace['field']}>
          <label className={workspace['field-label']} htmlFor="playground-max-tokens">{t('pg.max_tokens')}</label>
          <InputNumber
            id="playground-max-tokens"
            min={1}
            max={2147483647}
            precision={0}
            value={parameters.maxTokens}
            placeholder={t('conversation.model_default')}
            onChange={next => onChange({ maxTokens: typeof next === 'number' ? next : null })}
          />
        </div>
        <div className={workspace['field']}>
          <label className={workspace['field-label']} htmlFor="playground-reasoning-effort">{t('conversation.reasoning_effort')}</label>
          {/* Free text as well as the presets: providers name effort levels their own way, and a
              value this list does not know is still forwarded as typed. */}
          <AutoComplete
            id="playground-reasoning-effort"
            aria-label={t('conversation.reasoning_effort')}
            allowClear
            value={parameters.reasoningEffort}
            placeholder={t('conversation.model_default')}
            options={reasoningOptions}
            onChange={next => onChange({ reasoningEffort: (next ?? '').trim() })}
          />
        </div>
      </section>
      <section className={workspace['panel-section']}>
        <div className={workspace['section-head']}>
          <h2 className={workspace['section-title']}>{t('pg.request')}</h2>
        </div>
        <div className={workspace['field']}>
          <label className={workspace['field-label']} htmlFor="playground-user-agent">{t('pg.user_agent')}</label>
          <Input
            id="playground-user-agent"
            value={parameters.userAgent}
            placeholder={defaultUserAgent}
            onChange={event => onChange({ userAgent: event.target.value })}
          />
        </div>
        <div className={workspace['field']}>
          <label className={workspace['field-label']} htmlFor="playground-custom-body">{t('pg.custom_body')}</label>
          <Input.TextArea
            id="playground-custom-body"
            className={styles['json-input']}
            value={parameters.customBody}
            status={isCustomBodyValid ? undefined : 'error'}
            aria-invalid={!isCustomBodyValid}
            aria-describedby={isCustomBodyValid ? undefined : 'playground-custom-body-error'}
            placeholder={'{\n  "seed": 42\n}'}
            autoSize={{ minRows: 3, maxRows: 10 }}
            spellCheck={false}
            onChange={event => onChange({ customBody: event.target.value })}
          />
          {!isCustomBodyValid && <p id="playground-custom-body-error" className={workspace['field-error']}>{t('pg.invalid_json')}</p>}
        </div>
        <p className={workspace['field-hint']}>{t('pg.next_request')}</p>
      </section>
    </div>
  );
});
