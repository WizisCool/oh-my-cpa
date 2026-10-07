import React from 'react';
import { Select, Space } from 'antd';
import { useI18n } from '../../i18n';
import type { ClientAPIKeyItem } from '../../types/providers';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import type { GatewayModelItem } from '../../types/gatewayModels';
import { KeyOutlined } from '../icons';
import styles from './Workspace.module.css';

export interface TargetPickerProps {
  keys: ClientAPIKeyItem[];
  models: GatewayModelItem[];
  fingerprint: string;
  model: string;
  isKeysLoading: boolean;
  isModelsLoading: boolean;
  isDisabled: boolean;
  onFingerprintChange: (fingerprint: string) => void;
  onModelChange: (model: string) => void;
}

/**
 * The key and the model a conversation runs against, as one joined control.
 *
 * They are one decision - the model list is whatever the gateway serves to that key - so they are
 * drawn as one field rather than two unrelated selects. A key is named by its alias with the mask
 * beside it, the same identity every other surface prints (design §7, "Naming is a first-class
 * action"); an unnamed key falls back to its mask.
 */
export function TargetPicker({
  keys,
  models,
  fingerprint,
  model,
  isKeysLoading,
  isModelsLoading,
  isDisabled,
  onFingerprintChange,
  onModelChange,
}: TargetPickerProps) {
  const { t } = useI18n();
  const keyOptions = React.useMemo(() => keys
    .filter(key => Boolean(key.usage_fingerprint))
    .map(key => ({
      value: key.usage_fingerprint as string,
      // `title` is what a truncated selection shows on hover, and what the search matches.
      title: key.alias ? `${key.alias} (${key.key})` : key.key,
      label: (
        <span className={styles['key-option']}>
          {key.alias && <span className={styles['key-alias']}>{key.alias}</span>}
          <span className={styles['key-mask']}>{key.key}</span>
        </span>
      ),
    })), [keys]);
  // The closed control shows the name alone - the alias, or the mask for an unnamed key - because
  // the field is too narrow for both and the alias is the identifier the operator chose. The open
  // list shows both, which is where two keys with similar names are told apart.
  const selectedKeyLabel = React.useMemo(() => {
    const key = keys.find(item => item.usage_fingerprint === fingerprint);
    return key ? (key.alias || key.key) : undefined;
  }, [keys, fingerprint]);
  const modelOptions = React.useMemo(
    () => models.map(item => ({ value: gatewayCallPointOf(item), label: gatewayCallPointOf(item) })),
    [models],
  );

  return (
    <Space.Compact className={styles['target-picker']}>
      <Select
        className={styles['key-select']}
        aria-label={t('conversation.client_key')}
        placeholder={t('conversation.client_key')}
        prefix={<KeyOutlined aria-hidden="true" className={styles['target-icon']} />}
        value={fingerprint || undefined}
        loading={isKeysLoading}
        disabled={isDisabled}
        options={keyOptions}
        labelRender={() => selectedKeyLabel}
        showSearch={{ optionFilterProp: 'title' }}
        popupMatchSelectWidth={false}
        onChange={onFingerprintChange}
      />
      <Select
        className={styles['model-select']}
        aria-label={t('conversation.model')}
        placeholder={t('conversation.model')}
        value={model || undefined}
        loading={isModelsLoading}
        disabled={isDisabled || !fingerprint}
        options={modelOptions}
        showSearch={{ optionFilterProp: 'label' }}
        popupMatchSelectWidth={false}
        onChange={onModelChange}
      />
    </Space.Compact>
  );
}
