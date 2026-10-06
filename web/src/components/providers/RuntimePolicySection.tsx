import React from 'react';
import { Checkbox, InputNumber, Segmented } from 'antd';

import { useT } from '../../i18n';
import type { ProviderBehaviorSwitch, ProviderOverride } from '../../types/providers';
import { ErrorRulesEditor } from '../policy/ErrorRulesEditor';
import type { BehaviorDraft, RuntimePolicyDraft } from './runtimePolicy';
import styles from './ProviderEditorDrawer.module.css';

interface RuntimePolicySectionProps {
  policy: RuntimePolicyDraft;
  onPolicyChange: React.Dispatch<React.SetStateAction<RuntimePolicyDraft>>;
  behavior: BehaviorDraft;
  onBehaviorChange: React.Dispatch<React.SetStateAction<BehaviorDraft>>;
  supportsErrorRules: boolean;
  behaviorSwitches: ProviderBehaviorSwitch[];
  showProblems: boolean;
}

const BOOLEAN_SWITCHES: { name: Exclude<ProviderBehaviorSwitch, 'codex_cloaking'>; labelKey: string; descKey: string }[] = [
  { name: 'alpha_search', labelKey: 'policy.alpha_search', descKey: 'policy.alpha_search_desc' },
  { name: 'rebuild_mid_system_message', labelKey: 'policy.rebuild_mid_system', descKey: 'policy.rebuild_mid_system_desc' },
  { name: 'support_prompt_cache_key', labelKey: 'policy.prompt_cache_key', descKey: 'policy.prompt_cache_key_desc' },
];

/**
 * The body of the provider editor's runtime policy group: how this provider departs from the
 * gateway's own retry, cooldown and request behaviour.
 *
 * A setting the gateway also has globally is a three-way choice with "inherit" first, because
 * that is what an untouched provider does; a setting only the provider has is a plain checkbox.
 */
export function RuntimePolicySection({
  policy,
  onPolicyChange,
  behavior,
  onBehaviorChange,
  supportsErrorRules,
  behaviorSwitches,
  showProblems,
}: RuntimePolicySectionProps) {
  const t = useT();

  const overrideOptions: { value: ProviderOverride; label: string }[] = [
    { value: 'inherit', label: t('policy.override_inherit') },
    { value: 'enabled', label: t('policy.override_enabled') },
    { value: 'disabled', label: t('policy.override_disabled') },
  ];
  const isRetryInvalid = showProblems && policy.requestRetry !== null && policy.requestRetry < 0;

  return (
    <div className={styles['policy']}>
      <div className={styles['policy-field']}>
        <div className={styles['item-field-label']} id="provider-policy-cooling">{t('policy.cooling')}</div>
        <Segmented
          aria-labelledby="provider-policy-cooling"
          value={policy.cooling}
          options={overrideOptions}
          onChange={(cooling) => onPolicyChange((prev) => ({ ...prev, cooling }))}
        />
        <div className={styles['policy-desc']}>{t('policy.cooling_desc')}</div>
      </div>

      <div className={styles['policy-field']}>
        <label className={styles['item-field-label']} htmlFor="provider-policy-retry">{t('policy.retry')}</label>
        <InputNumber
          id="provider-policy-retry"
          className={styles['policy-number']}
          value={policy.requestRetry}
          min={0}
          precision={0}
          status={isRetryInvalid ? 'error' : undefined}
          placeholder={t('policy.retry_placeholder')}
          onChange={(requestRetry) => onPolicyChange((prev) => ({ ...prev, requestRetry }))}
        />
        <div className={styles['policy-desc']}>{t('policy.retry_desc')}</div>
      </div>

      {behaviorSwitches.includes('codex_cloaking') && (
        <div className={styles['policy-field']}>
          <div className={styles['item-field-label']} id="provider-policy-cloaking">{t('policy.codex_cloaking')}</div>
          <Segmented
            aria-labelledby="provider-policy-cloaking"
            value={behavior.codex_cloaking}
            options={overrideOptions}
            onChange={(value) => onBehaviorChange((prev) => ({ ...prev, codex_cloaking: value }))}
          />
          <div className={styles['policy-desc']}>{t('policy.codex_cloaking_desc')}</div>
        </div>
      )}

      {BOOLEAN_SWITCHES.filter((item) => behaviorSwitches.includes(item.name)).map((item) => (
        <div key={item.name} className={styles['flag']}>
          <Checkbox
            checked={behavior[item.name]}
            onChange={(event) => onBehaviorChange((prev) => ({ ...prev, [item.name]: event.target.checked }))}
          >
            <span className={styles['flag-label']}>{t(item.labelKey)}</span>
          </Checkbox>
          <div className={styles['flag-desc']}>{t(item.descKey)}</div>
        </div>
      ))}

      {supportsErrorRules && (
        <div className={styles['policy-field']}>
          <div className={styles['item-field-label']}>{t('policy.rules')}</div>
          <ErrorRulesEditor
            rules={policy.errorRules}
            showProblems={showProblems}
            onChange={(errorRules) => onPolicyChange((prev) => ({ ...prev, errorRules }))}
          />
        </div>
      )}
    </div>
  );
}
