import { useI18n } from '../../i18n';
import { ComposerPicker, ComposerPickerList } from './ComposerPicker';
import styles from './Workspace.module.css';

/** A stored provider-specific level stays selectable, without interpreting it as a higher rank. */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

type NamedEffort = (typeof REASONING_EFFORTS)[number];

function isNamedEffort(level: string): level is NamedEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(level);
}

export interface ReasoningEffortPickerProps {
  /** Empty for the model's own default. */
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
}

/** Explicitly named levels share the model picker's confirmation and focus behaviour. */
export function ReasoningEffortPicker({ value, onChange, isDisabled = false }: ReasoningEffortPickerProps) {
  const { t } = useI18n();
  const levels: readonly string[] = value && !isNamedEffort(value) ? [...REASONING_EFFORTS, value] : REASONING_EFFORTS;
  const labelOf = (level: string) => isNamedEffort(level) ? t(`conversation.effort.label.${level}`) : level;
  const parameterLabelOf = (level: string) => isNamedEffort(level) ? t(`conversation.effort.parameter.${level}`) : level;
  const accessibleLabelOf = (level: string) => isNamedEffort(level) ? t(`conversation.reasoning_effort.${level}`) : level;
  return (
    <ComposerPicker
      label={t('conversation.reasoning_effort')}
      valueLabel={value ? parameterLabelOf(value) : t('pg.default')}
      testId="effort-chip"
      contentTestId="effort-popover"
      isDisabled={isDisabled}
      className={styles['effort-chip']}
      surfaceClassName={styles['effort-surface']}
    >
      {close => (
        <>
          <div className={styles['picker-head']}><span>{t('conversation.reasoning_effort')}</span></div>
          <ComposerPickerList
            label={t('conversation.reasoning_effort')}
            value={value}
            shouldShowSelectionMark={false}
            options={[
              { value: '', label: t('conversation.model_default') },
              ...levels.map(level => ({
                value: level,
                label: parameterLabelOf(level),
                accessibleLabel: accessibleLabelOf(level),
                detail: labelOf(level) === parameterLabelOf(level) ? undefined : labelOf(level),
              })),
            ]}
            onSelect={next => { onChange(next); close(); }}
          />
        </>
      )}
    </ComposerPicker>
  );
}
